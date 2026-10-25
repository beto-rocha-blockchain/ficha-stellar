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
from urllib.parse import quote, urlsplit

import uvicorn
from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, HTMLResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles

import config
import escrow
import freeminutes
import meter as meter_mod
import portal
import qr
import registry_check
import relay as relay_mod
import supervisor
from session import SessionLog, State, Station
from stellar import HorizonWatcher, Payment, format_amount

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)-7s %(name)s: %(message)s")
log = logging.getLogger("ficha")

try:
    cfg = config.load()
    # With STATION_ID set: refuse to start unless this station matches its
    # entry in the signed registry, the one the app shows and pays. On the
    # public network, also unless the registry could be checked at all.
    registry_health = registry_check.startup(cfg)
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
# Each poll Horizon answers reaches the station: on the public network, until
# the first and when none has for a while, the screen shows no pay QR (a real
# payment made then would not be seen). The payments the host sends reach it
# too, apart: a refund paid back marks the refund due as paid.
watcher = (HorizonWatcher(cfg, on_payment=lambda p: handle_payment(p), on_read=station.on_horizon,
                          on_sent=lambda p: handle_sent(p))
           if cfg.host_public_key else None)
if watcher:
    station.watch_horizon()
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

# Free emergency minutes (docs/free-minutes.md): what each device used today,
# by its id of the day, never its MAC. None with WIFI_PORTAL=off.
free = freeminutes.FreeMinutes(cfg) if cfg.free_on else None
# The device whose free charge is the one running (if a free charge runs at
# all: one at a time), so its portal page counts it down. Its id of the day.
free_owner: str | None = None
# How the portal finds a device's MAC: this computer's neighbour (ARP) table.
neighbour = portal.neighbour_mac

clients: set[WebSocket] = set()
server: uvicorn.Server | None = None

# A screen that takes longer than this to take one snapshot is dropped.
SEND_TIMEOUT = 1.0
_background_tasks: set[asyncio.Task] = set()
# Custody and the public network (cfg.rechecks_registry): how often the
# registry (and, custody, the station's terms on the contract) are read again
# while it runs (recheck()). A registry published with another contract or
# other terms makes the app pay where this station never looks, or promise
# what it does not sell: at most this long passes before the pay QR goes.
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
        # Direct mode: the newest refund the host owes, its QR and the Ficha
        # site's page that signs it with Freighter.
        "refund_due": qr.refund_qr(cfg, snap["refund_due"]),
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
        # The startup check, or (custody, public) a later read that no longer matches.
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
    # Free emergency minutes and the numbers to call: only when set, so a
    # station without them sends exactly what it always did.
    if cfg.emergency_numbers:
        snap["emergency"] = [{"label": label, "number": number} for label, number in cfg.emergency_numbers]
    if cfg.free_on:
        snap["free"] = {
            "portal": cfg.wifi_portal,
            "charge_seconds": cfg.free_charge_seconds,
            "internet_seconds": cfg.free_internet_seconds,
            "charging": station.state == State.COURTESY and station.session.free_charge,
        }
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


def handle_sent(p: Payment) -> None:
    station.on_host_payment(p)
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
    """Custody and the public network: the signed registry and, custody,
    this station's terms on the contract read again, as at startup
    (registry_check.recheck, escrow.recheck). What no longer matches puts the
    station out of service, its pay QR hidden, until a later read matches
    again (Station.on_recheck); a read that cannot be made changes nothing.
    Never raises (but can be cancelled)."""
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
    if cfg.custody:
        try:
            problems = await asyncio.to_thread(escrow.recheck, cfg, _recheck_ledger)
        except Exception as exc:
            log.info("escrow: the station's terms could not be read again (%s); nothing changes",
                     type(exc).__name__)
        else:
            if not problems:
                escrow_health = {"status": "ok", "detail": "contract"}
            station.on_recheck("escrow", "; ".join(problems) or None, started)
    broadcast()


# How often the free minutes' day is checked: a running station deletes the
# old day's salt within this long after local midnight.
FREE_ROLL_SECONDS = 60.0


async def free_days() -> None:
    """Free minutes: the daily reset also when no phone opens the portal
    (freeminutes.py otherwise rolls the day only when a device is looked
    up), so yesterday's salt does not stay on disk next to yesterday's ids.
    Its own task, on the event loop like the portal: a failure here never
    touches the heartbeat (the countdown, the relay)."""
    while True:
        try:
            free.rollover()
        except Exception:
            log.exception("free minutes: the daily reset failed; trying again in %ss", FREE_ROLL_SECONDS)
        await asyncio.sleep(FREE_ROLL_SECONDS)


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
    if cfg.free_on:
        log.info("free emergency minutes (WIFI_PORTAL=%s): %ss of charge and %ss of internet per phone per day, "
                 "reset at local midnight; the station screen and its keys answer only to this computer",
                 cfg.wifi_portal, cfg.free_charge_seconds, cfg.free_internet_seconds)
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
    if cfg.rechecks_registry:
        tasks.append(asyncio.create_task(recheck()))
    if free is not None:
        tasks.append(asyncio.create_task(free_days()))
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


def operator_peer(client) -> bool:
    """With the Wi-Fi portal on, the station listens on the router's network,
    where every phone on its Wi-Fi is: the station screen, its keys (ESC, C,
    E) and /debug then answer only to this computer. Portal off: anyone the
    server answers to, as always."""
    return not cfg.free_on or portal.is_loopback(client.host if client else None)


@app.get("/")
async def index(request: Request):
    if not operator_peer(request.client):
        # A phone on the station's Wi-Fi that opens the station's address
        # gets the portal, never the operator's screen.
        return RedirectResponse("/portal", status_code=303)
    # no-store: after an update, a reload must show the new screen, never a
    # copy the browser kept (FileResponse alone lets it cache by heuristics).
    return FileResponse(config.BASE_DIR / "static" / "index.html", headers={"Cache-Control": "no-store"})


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
    if not operator_peer(ws.client):
        log.warning("refused /ws from another device on the network (the Wi-Fi portal is on)")
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
        if not same_origin(request.headers) or not operator_peer(request.client):
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
            if not same_origin(request.headers) or not operator_peer(request.client):
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


# -- the Wi-Fi portal: free emergency minutes (docs/free-minutes.md) ---------------
if cfg.free_on:
    def portal_params(params: dict[str, str]) -> dict[str, str]:
        """What the portal carries to its next page; a test MAC only in a demo."""
        kept = portal.carried(params)
        if cfg.wifi_portal != "simulate":
            kept.pop("clientmac", None)
        return kept

    async def identify(request: Request, params: dict[str, str]) -> tuple[str | None, str | None]:
        """(the device's MAC, None), or (None, why not). The MAC lives in
        memory for this request only: freeminutes.py keeps its hash of the day."""
        peer = portal.peer_ip(request.client.host if request.client else None)
        if cfg.wifi_portal == "simulate" and portal.is_loopback(peer):
            # This computer, in a demo without a router: a test MAC, or its own.
            if params.get("clientmac"):
                mac = freeminutes.normalise_mac(params["clientmac"])
                return (mac, None) if mac else (None, "bad_mac")
            return portal.SIMULATED_MAC, None
        if cfg.wifi_portal == "opennds":
            # Only a phone on the router's LAN. With HOST=0.0.0.0 the station
            # also answers on any other network this computer is on (a
            # venue's Wi-Fi, a private network), where its neighbours could
            # otherwise close the relay without ever joining Ficha's Wi-Fi.
            # The router's sign-in names its gateway (authaction); the phone
            # and this computer's address the request came in on must be on
            # that gateway's /24. Never logged: no address is kept.
            lan = portal.router_lan(params.get("authaction", ""))
            if lan is None:
                return None, "no_gateway"
            server = request.scope.get("server") or (None,)
            if not portal.on_lan(lan, peer, server[0]):
                log.warning("portal: a request from outside the router's LAN refused")
                return None, "not_lan"
        claimed = portal.client_ip(params)
        if claimed and claimed != peer:
            # The router saw the phone at another address: this station is
            # not on the router's LAN, and would see the router (or a NAT)
            # instead of each phone. Never logged: no address is kept.
            log.warning("portal: a request from another address than the phone's (is the station behind a NAT?)")
            return None, "not_direct"
        mac = await asyncio.to_thread(neighbour, peer)
        return (mac, None) if mac else (None, "unknown_device")

    def portal_pay_link(uri: str) -> str:
        """The portal's "Pay with Ficha" link to the pay link on the station
        screen. Direct mode: a web+stellar: link opens only in an app that
        handles it, so not in a phone's sign-in window, nor on a phone
        without the Ficha app (whose store is outside the walled garden);
        with APP_URL, the web app's /pay?uri=<that link> instead, which any
        browser opens (its host is in the router's walled garden). Custody:
        the screen's link already is APP_URL/p?..."""
        if cfg.app_url and uri.startswith("web+stellar:"):
            return f"{cfg.app_url}/pay?uri={quote(uri, safe='')}"
        return uri

    def portal_view(params: dict[str, str], lang: str, mac: str | None, message: str | None) -> portal.View:
        snap = snapshot()
        state = station.state
        used = free.used_today(mac) if mac else {"charge": False, "internet": False}
        yours = (snap["courtesy_seconds_left"] if mac and state == State.COURTESY and station.session.free_charge
                 and free_owner == free.device_id(mac) else None)
        # The pay link whenever the station screen shows its pay QR.
        if state == State.FINISHED:
            pay_block = "finishing"
        elif not snap["relay"]["healthy"] or snap["out_of_service"]:
            pay_block = "oos"
        elif state == State.CHARGING and not snap["can_add"]:
            pay_block = "full"
        else:
            pay_block = None
        return portal.View(
            lang=lang, mode=cfg.wifi_portal, station_name=cfg.station_name, station_id=cfg.station_id,
            emergency=cfg.emergency_numbers, charge_seconds=cfg.free_charge_seconds,
            internet_seconds=cfg.free_internet_seconds, device_known=mac is not None,
            charge_used=used["charge"], internet_used=used["internet"],
            charge_block=None if yours is not None else station.free_charge_refusal(), charge_yours_left=yours,
            pay_uri=None if pay_block else portal_pay_link(snap["uri"]), pay_add=state == State.CHARGING,
            pay_block=pay_block,
            ficha_minutes=cfg.ficha_minutes, ficha_price=snap["ficha_price"], asset=cfg.asset_label,
            session_id=snap["session_id"], message=message, carried=portal_params(params))

    @app.get("/portal")
    async def portal_page(request: Request):
        """The page openNDS sends a phone to (FAS level 0), or a phone opens."""
        if not local_host(request.headers.get("host", "").lower()):
            raise HTTPException(400, "open the portal by the station's address")
        params = {k: v for k, v in request.query_params.items()}
        lang = portal.lang_of(params.get("lang"), request.headers.get("accept-language"))
        mac, why = await identify(request, params)
        message = params.get("m") if params.get("m") in portal.TEXT["en"]["msg"] else None
        if why in ("not_direct", "bad_mac", "not_lan", "no_gateway"):
            message = why
        return HTMLResponse(portal.page(portal_view(params, lang, mac, message)),
                            headers={"Cache-Control": "no-store"})

    async def portal_form(request: Request) -> dict[str, str]:
        """The portal page's form. A page on another site cannot post it: a
        browser sends that page's Origin, which is not this station."""
        if request.headers.get("content-type", "").split(";")[0].strip().lower() \
                != "application/x-www-form-urlencoded":
            raise HTTPException(415, "send the portal page's form")
        if not same_origin(request.headers):
            raise HTTPException(403, "only the station's own portal page may ask for free minutes")
        declared = request.headers.get("content-length") or "0"
        if not declared.isdigit() or int(declared) > portal.FORM_MAX_BYTES:
            raise HTTPException(413, "form too large")
        body = await request.body()
        if len(body) > portal.FORM_MAX_BYTES:
            raise HTTPException(413, "form too large")
        return portal.parse_form(body)

    def portal_back(params: dict[str, str], code: str) -> RedirectResponse:
        """Back to the portal page, saying what happened (post, redirect, get:
        a reload never asks twice)."""
        return RedirectResponse(portal.portal_url(portal_params(params), m=code), status_code=303)

    @app.post("/portal/charge")
    async def portal_charge(request: Request):
        """This device's free emergency charge of the day: the station's relay
        closes for FREE_CHARGE_SECONDS, as for a courtesy."""
        global free_owner
        params = await portal_form(request)
        mac, why = await identify(request, params)
        if mac is None:
            return portal_back(params, why)
        if cfg.free_charge_seconds <= 0:
            return portal_back(params, "charge_off")
        if free.used_today(mac)["charge"]:
            return portal_back(params, "charge_used")
        refusal = station.free_charge_refusal()
        if refusal:
            return portal_back(params, refusal)
        try:
            device, seconds = free.grant(mac, "charge")
        except freeminutes.Refused as exc:
            return portal_back(params, f"charge_{exc.code}")
        except OSError as exc:
            log.error("free charge not given: the day's file cannot be written (%s)", exc.strerror or exc)
            return portal_back(params, "record_failed")
        # Nothing ran since free_charge_refusal(): one event loop, no await.
        station.free_charge()
        station.record_free_grant(device, "charge", seconds)
        free_owner = device
        broadcast()
        return portal_back(params, "charge_started")

    @app.post("/portal/internet")
    async def portal_internet(request: Request):
        """This device's free internet of the day. opennds: the browser goes on
        to openNDS's auth URL with its token, and the router opens the
        internet (its binauth script holds the per-MAC daily quota of the
        sign-in, whatever the station says; a courtesy limit, not a hard one:
        openwrt/README.md). simulate: recorded, and said so."""
        params = await portal_form(request)
        mac, why = await identify(request, params)
        if mac is None:
            return portal_back(params, why)
        if cfg.free_internet_seconds <= 0:
            return portal_back(params, "internet_off")
        target = None
        if cfg.wifi_portal == "opennds":
            lang = portal.lang_of(params.get("lang"), request.headers.get("accept-language"))
            fallback = f"http://{request.headers.get('host')}/portal?m=internet_on&lang={lang}"
            target = portal.auth_redirect(params, fallback)
            if target is None:
                return portal_back(params, "no_gateway")
        try:
            device, seconds = free.grant(mac, "internet")
        except freeminutes.Refused as exc:
            return portal_back(params, f"internet_{exc.code}")
        except OSError as exc:
            log.error("free internet not given: the day's file cannot be written (%s)", exc.strerror or exc)
            return portal_back(params, "record_failed")
        simulated = cfg.wifi_portal == "simulate"
        station.record_free_grant(device, "internet", seconds, simulated=simulated)
        if simulated:
            log.info("free internet granted (simulated): %s s for a device on the portal", seconds)
            station.say(f"Free internet granted (simulated): {portal.duration(seconds)} for a phone on the Wi-Fi")
            broadcast()
            return portal_back(params, "internet_simulated")
        station.say(f"Free internet: {portal.duration(seconds)} for a phone on the Wi-Fi")
        broadcast()
        return RedirectResponse(target, status_code=303)


def run() -> None:
    global server
    server = uvicorn.Server(uvicorn.Config(app, host=cfg.host, port=cfg.port, log_level="warning"))
    print(f"\n  Ficha station: http://{cfg.host}:{cfg.port}\n")
    if cfg.free_on:
        print(f"  Wi-Fi portal ({cfg.wifi_portal}): http://{cfg.host}:{cfg.port}/portal"
              " (the station screen answers only to this computer)\n")
    server.run()


if __name__ == "__main__":
    run()
