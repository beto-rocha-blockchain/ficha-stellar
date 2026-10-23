"""Ficha station: web server, screen, keys, and the one-second heartbeat.

Run:  python main.py
"""

from __future__ import annotations

import asyncio
import atexit
import ipaddress
import json
import logging
import re
import secrets
import sys
from contextlib import asynccontextmanager
from decimal import Decimal, InvalidOperation
from urllib.parse import urlsplit

import uvicorn
from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

import config
import escrow
import meter as meter_mod
import qr
import registry_check
import relay as relay_mod
import supervisor
from session import SessionLog, Station
from stellar import HorizonWatcher, Payment, format_amount

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)-7s %(name)s: %(message)s")
log = logging.getLogger("ficha")

try:
    cfg = config.load()
    # With STATION_ID set: refuse to start unless this station matches its
    # entry in the signed registry, the one the app shows and pays.
    registry_health = registry_check.check(cfg)
    # Custody: and its terms on the escrow contract, read with no key.
    escrow_health = escrow.check(cfg)
except config.ConfigError as exc:
    print(f"\nConfiguration error: {exc}\n", file=sys.stderr)
    sys.exit(2)

# With a real relay, this process becomes the supervisor and the station runs
# as its child: however the child dies, the supervisor opens the relay.
if __name__ == "__main__" and not cfg.mock and not supervisor.is_child():
    sys.exit(supervisor.run(cfg, sys.argv))

# The relay is opened inside Station() before anything else happens.
relay = relay_mod.from_config(cfg)
atexit.register(relay.shutdown)
station = Station(cfg, relay, SessionLog(cfg.session_log))
meter = meter_mod.from_config(cfg, powered=lambda: not relay.is_open)
sampler = meter_mod.Sampler(meter)
watcher = HorizonWatcher(cfg, on_payment=lambda p: handle_payment(p)) if cfg.host_public_key else None
# Custody: the contract's deposit and settle events. The Horizon watcher keeps
# running: a classic payment with this station's memo is logged for refund.
# Each poll that succeeds gives the station ledger time, and says the contract
# can be read: until the first, and when none has for a while, the screen
# shows no pay QR (a deposit made then would not be seen).
escrow_watcher = (escrow.EscrowWatcher(cfg, on_event=lambda e: handle_escrow(e), tracked=station.escrow_sessions,
                                       on_read=station.on_ledger)
                  if cfg.custody else None)
if escrow_watcher:
    station.watch_escrow()

clients: set[WebSocket] = set()
server: uvicorn.Server | None = None

# A screen that takes longer than this to take one snapshot is dropped.
SEND_TIMEOUT = 1.0
_background_tasks: set[asyncio.Task] = set()
# Custody: how often the registry and the station's terms on the contract are
# read again while it runs (recheck()). A registry published with another
# contract makes the app pay where this station never looks: at most this
# long passes before the pay QR goes.
RECHECK_SECONDS = 60.0


# -- state to the screen ------------------------------------------------------
def snapshot() -> dict:
    snap = station.snapshot()
    custody = snap["custody"]
    uri, pay = qr.pay_qr(cfg, snap["session_id"], custody["anchor"] if custody else None)
    wifi = qr.wifi_qr(cfg)
    key = cfg.host_public_key
    snap.update({
        "qr": pay,
        "uri": uri,
        # The password travels only inside the QR image, never as text.
        "wifi": {"ssid": cfg.wifi_ssid, "qr": wifi} if wifi else None,
        # FINISHED screen of a paid session only; the pay QR is gone by then.
        "receipt": qr.receipt_qr(cfg, snap),
        # Custody: the last session's receipt, smaller, while waiting.
        "last_receipt": qr.last_receipt_qr(cfg, snap["last_receipt"]),
        "station_id": cfg.station_id,
        "station_name": cfg.station_name,
        "network": cfg.network,
        "topology": cfg.topology,
        "mock": cfg.mock,
        "mock_payment": cfg.mock_payment,
        "meter_kind": meter.describe(),
        "relay_kind": relay.describe(),
        "host_key": key,
        "host_key_short": f"{key[:4]}…{key[-4:]}" if key else "not set",
        "asset": cfg.asset_label,
        "ficha_price": format_amount(cfg.ficha_price),
        "ficha_minutes": cfg.ficha_minutes,
        "max_session_minutes": cfg.max_session_minutes,
        "min_current_ma": cfg.min_current_ma,
        "horizon": watcher.health() if watcher else {"status": "off", "detail": "no HOST_PUBLIC_KEY"},
        # The startup check, or (custody) a later read that no longer matches.
        "registry": ({"status": "mismatch", "detail": station.mismatch["registry"]}
                     if "registry" in station.mismatch else registry_health),
        # Custody: the events watcher, the check against the contract (at
        # startup, then every minute: "mismatch" with why), and the contract
        # itself, short: the footer names it.
        "escrow": (dict(escrow_watcher.health(), check="mismatch" if "escrow" in station.mismatch
                        else escrow_health["status"], mismatch=station.mismatch.get("escrow"),
                        contract=f"{cfg.escrow_contract[:4]}…{cfg.escrow_contract[-4:]}")
                   if escrow_watcher else None),
        # MOCK: where the simulated phone is plugged in (U changes it).
        "mock_plug": meter.plug if isinstance(meter, meter_mod.MockMeter) else None,
        "finished_seconds": cfg.finished_seconds,
    })
    return snap


def _background(coro) -> None:
    """Run coro without waiting for it (the loop only keeps a weak reference)."""
    task = asyncio.get_running_loop().create_task(coro)
    _background_tasks.add(task)
    task.add_done_callback(_background_tasks.discard)


def broadcast() -> None:
    """Send the state to every screen without waiting for any of them. A
    client that stops reading (a hung tab, a socket nobody reads) blocks its
    own send once its buffers fill: if the heartbeat waited on that, the
    countdown would stop and the relay would stay closed past the paid time."""
    if not clients:
        return
    text = json.dumps(snapshot(), default=str)
    for ws in list(clients):
        _background(_send(ws, text))


async def _send(ws: WebSocket, text: str) -> None:
    try:
        await asyncio.wait_for(ws.send_text(text), SEND_TIMEOUT)
    except Exception as exc:
        if ws not in clients:
            return
        clients.discard(ws)
        if isinstance(exc, TimeoutError):
            log.warning("a screen stopped reading for %ss; dropped", SEND_TIMEOUT)
            # A page that was only hung gets the close once it reads again,
            # and reconnects instead of showing a frozen screen. The close
            # waits on the same full buffer, so it runs on its own.
            _background(_close(ws))


async def _close(ws: WebSocket) -> None:
    try:
        await ws.close()
    except Exception:
        pass


def handle_payment(p: Payment) -> None:
    station.on_payment(p)
    broadcast()


def handle_escrow(event: escrow.Event) -> None:
    station.on_escrow(event)
    broadcast()


# -- heartbeat ----------------------------------------------------------------
async def heartbeat() -> None:
    try:
        loop = asyncio.get_running_loop()
        next_at = loop.time()
        while True:
            station.tick(sampler.latest())
            broadcast()
            # Re-send the desired relay state now and then; reopens the port
            # after a replug. Off the event loop: serial I/O can block.
            await asyncio.to_thread(relay.maintain)
            next_at += 1.0
            await asyncio.sleep(max(0.0, next_at - loop.time()))
    except asyncio.CancelledError:
        raise
    except BaseException:
        # Open the relay before dying, then take the whole process down, even
        # when it was not started by run() (e.g. `uvicorn main:app`).
        log.critical("heartbeat crashed; opening relay and shutting down", exc_info=True)
        station.shutdown()
        relay.shutdown()
        supervisor.end_process(server)
        raise


_recheck_ledger = escrow.Ledger(cfg, timeout=escrow.CHECK_TIMEOUT) if cfg.custody else None


async def recheck_once() -> None:
    """Custody: the signed registry and this station's terms on the contract
    read again, as at startup (registry_check.recheck, escrow.recheck). What
    no longer matches puts the station out of service, its pay QR hidden,
    until a later read matches again (Station.on_recheck); a read that
    cannot be made changes nothing. Never raises (but can be cancelled)."""
    global registry_health, escrow_health
    station.recheck_due = False
    started = station.clock()
    try:
        health = await asyncio.to_thread(registry_check.recheck, cfg)
    except registry_check.Mismatch as exc:
        station.on_recheck("registry", exc.short, started)
    except Exception as exc:
        log.warning("registry: read again, but %s", exc)
    else:
        if health["status"] == "ok":
            registry_health = health
            station.on_recheck("registry", None, started)
    try:
        problems = await asyncio.to_thread(escrow.recheck, cfg, _recheck_ledger)
    except Exception as exc:
        log.info("escrow: the station's terms could not be read again (%s); nothing changes", type(exc).__name__)
    else:
        if not problems:
            escrow_health = {"status": "ok", "detail": "contract"}
        station.on_recheck("escrow", "; ".join(problems) or None, started)
    broadcast()


async def recheck() -> None:
    """recheck_once() every RECHECK_SECONDS, and at once when the station asks
    (a deposit came under terms that are not its own)."""
    loop = asyncio.get_running_loop()
    due = loop.time() + RECHECK_SECONDS
    while True:
        await asyncio.sleep(1.0)
        if station.recheck_due or loop.time() >= due:
            try:
                await recheck_once()
            except asyncio.CancelledError:
                raise
            except Exception:  # a bug here must not end the re-reads
                log.exception("re-reading the registry and the contract failed")
            due = loop.time() + RECHECK_SECONDS


def toggle_plug() -> None:
    """MOCK: the U key unplugs the simulated phone, or plugs it back into this
    station, so the demo's "unplug it and the clock stops" runs without
    hardware. A real meter ignores it."""
    if not isinstance(meter, meter_mod.MockMeter):
        return
    meter.plug = "none" if meter.plug == "station" else "station"
    log.info("simulated phone %s", "unplugged" if meter.plug == "none" else "plugged into this station")
    station.say("Simulated phone " + ("unplugged" if meter.plug == "none" else "plugged back into this station"))


@asynccontextmanager
async def lifespan(app: FastAPI):
    log.info("Ficha on %s, topology %s, relay %s, meter %s, %s per ficha = %s min",
             cfg.network, cfg.topology, relay.describe(), meter.describe(),
             f"{format_amount(cfg.ficha_price)} {cfg.asset_label}", cfg.ficha_minutes)
    if not cfg.charge_verify:
        log.warning("CHARGE_VERIFY=false: paid time counts from payment, even while the phone "
                    "charges somewhere else (bench tests only)")
    elif cfg.meter_source == "outlet":
        log.info("paid time counts only while the outlet meter sees current (METER_SOURCE=outlet)")
    else:
        log.info("paid time counts only while this station is verified to charge the phone: "
                 "probe %ss every %ss", cfg.probe_seconds, cfg.probe_every_seconds)
    if cfg.custody:
        log.info("custody mode: deposits into %s through %s (read only); refund unit %ss, grace %ss",
                 cfg.escrow_contract, cfg.rpc_url, cfg.refund_unit_seconds, cfg.escrow_grace_seconds)
    sampler.start()
    tasks = [asyncio.create_task(heartbeat())]
    if watcher:
        tasks.append(asyncio.create_task(watcher.run()))
    else:
        log.warning("HOST_PUBLIC_KEY not set: not watching the ledger (debug payments only)")
    if escrow_watcher:
        tasks.append(asyncio.create_task(escrow_watcher.run()))
        tasks.append(asyncio.create_task(recheck()))
    try:
        yield
    finally:
        for t in tasks:
            t.cancel()
        sampler.stop()
        station.shutdown()
        relay.shutdown()
        meter.close()
        log.info("relay open, bye")


app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)


@app.get("/")
async def index():
    return FileResponse(config.BASE_DIR / "static" / "index.html")


# The screen's fonts and logo come from here, never from a CDN: the station
# renders offline. html=False: a folder is a 404, never a listing.
app.mount("/static", StaticFiles(directory=config.BASE_DIR / "static", html=False), name="static")


_HOST_HEADER = re.compile(r"(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(:\d{1,5})?")


def local_host(host: str) -> bool:
    """A Host the station answers to: an IP address, localhost or HOST. A
    page served from any other name that resolves here (DNS rebinding) would
    be same-origin with itself, and pass for the station's own page."""
    m = _HOST_HEADER.fullmatch(host)
    if not m:
        return False
    name = m.group(1).strip("[]")
    if name in ("localhost", cfg.host.lower().strip("[]")):
        return True
    try:
        ipaddress.ip_address(name)
    except ValueError:
        return False
    return True


def same_origin(headers) -> bool:
    """Only the station's own page may use /ws and /debug/pay: any other page
    open in a browser on this computer could otherwise press ESC or C, open
    sockets it never reads, or make free payments. Browsers always send
    Origin on /ws; other clients send none."""
    host = headers.get("host", "").lower()
    if not local_host(host):
        return False
    origin = headers.get("origin")
    return origin is None or urlsplit(origin).netloc.lower() == host


@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    if not same_origin(ws.headers):
        log.warning("refused /ws from origin %r, host %r", ws.headers.get("origin"), ws.headers.get("host"))
        await ws.close(code=1008)
        return
    await ws.accept()
    clients.add(ws)
    try:
        await ws.send_text(json.dumps(snapshot(), default=str))
        while True:
            msg = json.loads(await ws.receive_text())
            key = str(msg.get("key", "")).lower()
            if key == "escape":
                station.emergency_open()
            elif key == "c":
                station.courtesy()
            elif key == "e":
                station.end_session()
            elif key == "u" and cfg.mock:
                toggle_plug()
            broadcast()
    except (WebSocketDisconnect, RuntimeError):
        pass
    finally:
        clients.discard(ws)


if cfg.mock_payment:
    @app.post("/debug/pay")
    async def debug_pay(request: Request):
        """Inject a fake payment. Body: {"amount": "2", "memo": "..."}.
        memo omitted -> current session; memo null -> no memo (orphan)."""
        # A page on another site can send a text/plain POST here without
        # asking first (no CORS preflight), but not an application/json one.
        if request.headers.get("content-type", "").split(";")[0].strip().lower() != "application/json":
            raise HTTPException(415, "send the body as application/json")
        if not same_origin(request.headers):
            raise HTTPException(403, "only the station itself may make debug payments")
        body = await request.json()
        try:
            amount = Decimal(str(body.get("amount", cfg.ficha_price)))
        except InvalidOperation:
            raise HTTPException(400, "amount is not a number")
        if cfg.custody:
            return debug_deposit(body, amount)
        memo = body["memo"] if "memo" in body else station.session.id
        p = Payment(
            tx_hash="debug-" + secrets.token_hex(8),
            op_id="debug",
            payer=body.get("payer", "DEBUG-PAYER"),
            amount=amount,
            asset=cfg.asset_label,
            memo=memo,
            created_at="",
            source="debug",
        )
        handle_payment(p)
        return {"ok": True, "memo": memo, "state": station.state.value}

    def debug_deposit(body: dict, amount: Decimal) -> dict:
        """Custody: the deposit event the app's payment would bring, with the
        session's own anchor. Body: {"fichas": 2} (or "amount"), and to try
        the refusals "anchor" (base64url, 43 characters), "memo" (another
        session) or "payer"."""
        fichas = body.get("fichas", int(amount // cfg.ficha_price) if amount > 0 else 0)
        memo = body.get("memo") or station.session.id
        if not isinstance(fichas, int) or isinstance(fichas, bool) or not 1 <= fichas <= cfg.max_fichas:
            raise HTTPException(400, f"fichas must be 1 to {cfg.max_fichas} (the contract refuses others: BadFichas)")
        if not isinstance(memo, str) or not memo:
            raise HTTPException(400, "memo must be a session id")
        try:
            anchor = escrow.from_b64url(body["anchor"]) if "anchor" in body else None
        except ValueError:
            raise HTTPException(400, "anchor must be 32 bytes in base64url (43 characters)")
        d = station.mock_deposit(fichas, session=memo, anchor=anchor, payer=str(body.get("payer") or "DEBUG-PAYER"))
        if d.total_fichas > cfg.max_fichas:
            raise HTTPException(400, f"the session would hold more than {cfg.max_fichas} fichas (BadFichas)")
        handle_escrow(d)
        return {"ok": True, "memo": f"{cfg.station_id}.{d.session}", "fichas": fichas, "state": station.state.value}

    if cfg.custody:
        @app.post("/debug/settle")
        async def debug_settle(request: Request):
            """Custody: the settle event a claim of the receipt on screen would
            bring. Body: {} (the receipt's units), {"unused_units": n}, or
            {"how": "deadline"} (release) or "host" (host_refund); "memo"
            names another receipt waiting to be claimed (two take turns)."""
            if request.headers.get("content-type", "").split(";")[0].strip().lower() != "application/json":
                raise HTTPException(415, "send the body as application/json")
            if not same_origin(request.headers):
                raise HTTPException(403, "only the station itself may make debug payments")
            body = await request.json()
            how = body.get("how", "proof")
            unused = body.get("unused_units")
            if how not in ("proof", "deadline", "host") or (
                    unused is not None and (not isinstance(unused, int) or isinstance(unused, bool) or unused < 0)):
                raise HTTPException(400, "how: proof, deadline or host; unused_units: a whole number")
            memo = body.get("memo")
            if memo is not None and not isinstance(memo, str):
                raise HTTPException(400, "memo must be a session id")
            e = station.mock_settle(unused, how, session=memo)
            if e is None:
                raise HTTPException(404, "no custody receipt on screen to settle")
            handle_escrow(e)
            return {"ok": True, "memo": f"{cfg.station_id}.{e.session}", "to_payer": e.to_payer,
                    "to_host": e.to_host}


def run() -> None:
    global server
    server = uvicorn.Server(uvicorn.Config(app, host=cfg.host, port=cfg.port, log_level="warning"))
    print(f"\n  Ficha station: http://{cfg.host}:{cfg.port}\n")
    server.run()


if __name__ == "__main__":
    run()
