"""Smoke test of the whole flow in simulated mode, on a fake clock.

Covers: payment, courtesy, extension, underpaid, orphan, session cap, ESC,
verdicts, cut confirmation, both topologies, restart after a crash, the
offered network QR, station IDs and memos, the signed registry and the
station's startup check against it, the public network's refusals (only a
real station, checked against the registry, starts there), the receipt QR, change and refund hints, payments in another asset, the robustness fixes
(cursor, log, relay out of service, held readings, transitions, notices,
config checks), main.py's screens socket (a client that stops reading,
other origins) and /debug/pay, and custody mode: the hash chain against the
contract's shared vectors, deposits, refusals, the refund proof, deadlines,
restarts, the escrow watcher and the startup check, the last receipt's rules,
a session settled while served, ledger time, the contract's health, the E
key, a testnet reset, the registry's custody rules, receipts that wait their
turn (and come back in order after a restart, in ledger time), the registry
and the contract read again while running, native XLM only, and the
simulated phone's U key. Runs in a few seconds.

    python smoke_test.py
"""

from __future__ import annotations

import asyncio
import contextlib
import importlib
import io
import json
import logging
import os
import random
import re
import signal
import stat
import sys
import tempfile
import time
from dataclasses import replace
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path
from urllib.parse import parse_qs, quote, urlsplit

import httpx
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect
import stellar_sdk
from stellar_sdk import Keypair, Network, scval
from stellar_sdk.exceptions import SorobanRpcErrorResponse
from stellar_sdk.soroban_rpc import EventInfo, GetEventsResponse, GetLatestLedgerResponse

import config
import escrow
import registry_check
import registry_format
from meter import MockMeter
from qr import last_receipt_qr, pay_qr, receipt_payload, receipt_qr, wifi_payload, wifi_qr
from relay import MockRelay
from session import SessionLog, State, Station, mmss
from stellar import HorizonWatcher, Payment, sep7_msg, sep7_uri, validate_memo
from supervisor import end_process
from tools import registry

# Any valid public key will do; this one is the Circle USDC issuer.
HOST = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN"
EPOCH = 1_790_000_000  # the fake clock's wall time starts here (2026-09-21)


class Clock:
    def __init__(self) -> None:
        self.t = 1000.0

    def __call__(self) -> float:
        return self.t

    def iso(self) -> str:
        """Wall clock in step with the fake one, as utc_now() writes it."""
        return datetime.fromtimestamp(EPOCH + self.t, timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


class Rig:
    """A station on a fake clock. The flows before test_verify were written
    for a countdown that starts at payment: they run with CHARGE_VERIFY=false,
    which must keep that behaviour exactly. test_verify and the ones after it
    pass charge_verify=True, the default of a real station."""

    def __init__(self, tmp: Path, **overrides) -> None:
        os.environ.update({"MOCK": "true", "MOCK_PAYMENT": "true", "HOST_PUBLIC_KEY": HOST})
        base = config.load(env_file=os.devnull)
        overrides.setdefault("charge_verify", False)
        self.cfg = replace(base, session_log=tmp / "sessions.jsonl", **overrides)
        config.validate(self.cfg)
        self.clock = Clock()
        self.relay = MockRelay()
        self.meter = MockMeter(self.cfg.mock_profile, self.cfg.topology, lambda: not self.relay.is_open,
                               clock=self.clock, rng=random.Random(7), plug=self.cfg.mock_plug,
                               source=self.cfg.meter_source)
        self.log = SessionLog(self.cfg.session_log)
        self.st = self.station(self.relay, self.log)
        self.n = 0

    def station(self, relay: MockRelay, log: SessionLog | None = None, **kw) -> Station:
        """A Station on this rig's clocks (custody deadlines are unix seconds)."""
        return Station(self.cfg, relay, log or SessionLog(self.cfg.session_log), clock=self.clock,
                       wallclock=self.clock.iso, unixclock=self.unix, **kw)

    def unix(self) -> float:
        return EPOCH + self.clock.t

    def tick(self, seconds: int = 1, meter=None) -> None:
        for _ in range(seconds):
            self.clock.t += 1
            self.st.tick(meter() if meter else self.meter.read())

    def pay(self, amount: str, memo: str | None = "current") -> Payment:
        self.n += 1
        memo = self.st.session.id if memo == "current" else memo
        p = Payment(f"tx{self.n}", "op", "GPAYER", Decimal(amount), "XLM", memo, "", "debug")
        self.st.on_payment(p)
        return p

    def records(self) -> list[dict]:
        return SessionLog(self.cfg.session_log).read()

    def snap(self) -> dict:
        return self.st.snapshot()


def check(cond: bool, what: str) -> None:
    print(("  ok   " if cond else "  FAIL ") + what)
    if not cond:
        raise SystemExit(1)


def refused(cfg: config.Config, what: str, says: str = "") -> None:
    """Refused, and (with says) for that reason, not an earlier one."""
    try:
        config.validate(cfg)
    except config.ConfigError as exc:
        if says in str(exc):
            return
        check(False, f"refused: {what}, saying {says!r} (it said: {exc})")
    check(False, f"refused: {what}")


# Stands for the public registry's key: this version pins none yet.
PUBLIC_REGISTRY_KEY = Keypair.random().public_key
ADB_SERIAL = "192.168.0.20:5555"


def on_public(cfg: config.Config, **over) -> config.Config:
    """cfg as a station on the public network must be (a real relay and
    phone, charge verification, a STATION_ID, a registry key), with these
    changes."""
    return replace(cfg, **{"network": "public", "horizon_url": config.HORIZON_URLS["public"], "mock": False,
                           "mock_payment": False, "charge_verify": True, "adb_serial": ADB_SERIAL,
                           "station_id": "K7M2QX", "registry_key": PUBLIC_REGISTRY_KEY, **over})


def load_env(**env: str) -> config.Config:
    """config.load() with these variables set, then the environment as it was."""
    saved = {k: os.environ.get(k) for k in env}
    os.environ.update(env)
    try:
        return config.load(env_file=os.devnull)
    finally:
        for k, v in saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v


def last_session(r: Rig) -> dict:
    return [x for x in r.records() if x["kind"] == "session"][-1]


def test_mains(tmp: Path) -> None:
    print("mains / fast")
    r = Rig(tmp)
    st = r.st
    check(st.state == State.AWAITING_PAYMENT and r.relay.is_open, "starts awaiting payment, relay open")
    uri = sep7_uri(r.cfg, st.session.id, r.cfg.ficha_price)
    check(uri.startswith(f"web+stellar:pay?destination={HOST}&amount=1&memo={st.session.id}"), "SEP-0007 uri, native omits asset")

    # courtesy, then payment: courtesy time is dropped, not added
    check(st.courtesy(), "C starts courtesy")
    check(st.state == State.COURTESY and not r.relay.is_open, "courtesy closes relay")
    r.tick(20)
    r.pay("2")
    check(st.state == State.CHARGING, "payment during courtesy -> CHARGING")
    check(r.snap()["remaining_seconds"] == 600, "2 fichas = 10:00, courtesy not added")

    r.tick(3)
    s = r.snap()
    check(2500 <= s["current_ma"] <= 4000 and 3900 <= s["voltage_mv"] <= 4300, f"fast profile reading {s['current_ma']} mA {s['voltage_mv']} mV")
    check(s["delivering"], "delivering badge on")
    check(abs(s["watts"] - s["current_ma"] * s["voltage_mv"] / 1e6) < 0.02, "watts = battery mA x mV")

    r.pay("3.7")
    check(r.snap()["remaining_seconds"] == 597 + 900 and r.snap()["fichas_left"] == 5, "extension: 3.7 buys 3 fichas, +15:00")

    r.pay("0.5000000")  # as Horizon writes amounts: always 7 decimals
    check(r.snap()["remaining_seconds"] == 1497, "underpaid top-up does not credit")
    check(r.records()[-1]["kind"] == "underpaid", "underpaid logged")
    check(r.snap()["notice"] == "Payment of 0.5 XLM is below 1 ficha: not credited",
          "the screen shows a Horizon amount as the price is shown (0.5, not 0.5000000)")

    r.pay("1", memo=None)
    r.pay("1", memo="FNOPE")
    check([x["reason"] for x in r.records()[-2:]] == ["no valid memo", "unknown session"], "orphans logged")

    sid = st.session.id
    r.tick(1497)
    check(st.state == State.FINISHED and r.relay.is_open, "time up -> FINISHED, relay open")
    r.tick(2)
    check(st.session.cut and st.session.cut["method"] == "current_drop", "cut confirmed by current drop")
    r.pay("1", memo=sid)
    check(r.records()[-1]["reason"] == "session already closed", "payment to finished session is orphan")
    check(f"1 XLM paid after session {sid} ended: not credited" in r.snap()["notice"],
          "payment on the FINISHED screen: the screen says it was not credited")
    r.tick(r.cfg.finished_seconds)
    check(st.state == State.AWAITING_PAYMENT and st.session.id != sid, "new session id after FINISHED")
    rec = [x for x in r.records() if x["kind"] == "session"][-1]
    check(rec["id"] == sid and rec["verdict"] == "delivered" and rec["fichas"] == 5, "session logged, verdict delivered")
    check(rec["paid_seconds"] == 1500 and rec["courtesy_used"] and rec["amount"] == "5.7", "paid seconds, courtesy flag, amount")
    check(rec["wh"] > 0 and rec["max_current_ma"] >= 2500, f"measured {rec['wh']} Wh, peak {rec['max_current_ma']} mA")
    r.pay("1.0000000", memo=sid)  # as Horizon writes it: "1.0000000 XLM ..." took two lines
    check(r.records()[-1]["kind"] == "orphan"
          and r.snap()["notice"] == f"1 XLM paid after session {sid} ended: not credited, logged for refund",
          "payment to the session that just ended, next session already up: said on screen too, in one short line")
    html = (Path(__file__).resolve().parent / "static" / "index.html").read_text(encoding="utf-8")
    check("white-space: nowrap" in re.search(r"\.notice \{[^}]*\}", html).group(0) and "notice(d.notice" in html,
          "the screen keeps any notice on one line (set smaller when too wide): it never squeezes the readings")
    r.tick(61)
    r.pay("1", memo=sid)
    check(r.records()[-1]["kind"] == "orphan" and r.snap()["notice"] is None,
          "a minute later a payment to it is only logged, not announced to the next customer")

    # courtesy without payment, cooldown, new id
    sid = st.session.id
    check(st.courtesy(), "courtesy on fresh session")
    r.tick(60)
    check(st.state == State.AWAITING_PAYMENT and r.relay.is_open, "courtesy expires -> relay open")
    check(not st.courtesy() and "available again" in r.snap()["notice"], "second courtesy refused during cooldown")
    r.tick(300)
    check(st.courtesy() and st.session.id != sid, "after cooldown, courtesy on a new session id")
    check(r.records()[-1]["end_reason"] == "courtesy_only", "courtesy-only session logged")
    r.tick(60)

    # cap and ESC
    r.pay("13")
    check(st.session.capped_seconds == 300 and r.snap()["remaining_seconds"] == 3600, "13 fichas capped at 60 min, 5 min logged")
    check("limit" in r.snap()["notice"], "(8) cap notice not covered by the fichas notice (first payment)")
    r.tick(10)
    st.emergency_open()
    check(st.state == State.FINISHED and r.relay.is_open, "ESC -> relay open, FINISHED")
    r.tick(r.cfg.finished_seconds)
    rec = r.records()[-1]
    check(rec["end_reason"] == "emergency_stop" and rec["unused_seconds"] == 3590, "ESC logged with unused time")

    # meter dead the whole session -> unverified
    r.pay("1")
    r.tick(300, meter=lambda: (0, 0, False))
    r.tick(r.cfg.finished_seconds, meter=lambda: (0, 0, False))
    check(r.records()[-1]["verdict"] == "unverified", "dead meter -> unverified")
    check(not r.records()[-1]["cut_confirmation"]["confirmed"], "dead meter: cut not claimed as confirmed")

    # meter healthy but nothing drawing -> no_current
    r.pay("1")
    r.tick(300, meter=lambda: (-200, 3900, True))
    r.tick(r.cfg.finished_seconds)
    check(r.records()[-1]["verdict"] == "no_current", "no current -> no_current")
    check(not r.records()[-1]["cut_confirmation"]["confirmed"], "no current before opening: cut not claimed")


class StuckRelay(MockRelay):
    """Takes CLOSE, then refuses OPEN: power keeps flowing."""
    stuck = False

    def _send_open(self) -> None:
        if self.stuck:
            raise RuntimeError("write timeout")
        super()._send_open()


def test_relay_fails(tmp: Path) -> None:
    print("relay refuses to open")
    r = Rig(tmp)
    relay = StuckRelay()
    st = Station(r.cfg, relay, SessionLog(r.cfg.session_log), clock=r.clock)
    st.on_payment(Payment("tx-s", "op", "GPAYER", Decimal("1"), "XLM", st.session.id, "", "debug"))
    for _ in range(5):
        r.clock.t += 1
        st.tick((3000, 4000, True))
    relay.stuck = True
    st.emergency_open()
    check("did NOT open" in st.snapshot()["notice"], "(9) ESC with a failed open says the relay did NOT open")
    for _ in range(r.cfg.finished_seconds):
        r.clock.t += 1
        st.tick((-100, 3900, True))  # a meter glitch that would look like a drop
    rec = [x for x in r.records() if x["kind"] == "session"][-1]
    check(not relay.is_open and not rec["cut_confirmation"]["confirmed"]
          and "open" in rec["cut_confirmation"]["reason"], "open command failed: cut never claimed as confirmed")

    # payment during courtesy, ESC before the next tick: the courtesy readings count
    (tmp / "b").mkdir()
    r2 = Rig(tmp / "b")
    st2 = r2.st
    st2.courtesy()
    r2.tick(10)
    r2.pay("1")
    st2.emergency_open()
    r2.tick(2)
    check(st2.session.cut and st2.session.cut["confirmed"], "courtesy, pay, ESC at once: cut still confirmed")


def test_usb_vbus(tmp: Path) -> None:
    print("usb_vbus / usb")
    r = Rig(tmp, topology="usb_vbus", adb_transport="usb", mock_profile="usb")
    st = r.st
    r.pay("1")
    check(r.snap()["waiting_for_device"] and r.snap()["remaining_seconds"] == 300, "waits for the phone before counting")
    r.tick(2)
    check(r.snap()["remaining_seconds"] == 300, "clock not running while ADB enumerates")
    r.tick(2)
    s = r.snap()
    check(not s["waiting_for_device"] and 450 <= s["current_ma"] <= 600, f"usb profile reading {s['current_ma']} mA {s['voltage_mv']} mV")
    r.tick(300)  # countdown started on the 4th tick, when the phone came back
    check(st.state == State.FINISHED and r.relay.is_open, "finished, relay open")
    r.tick(1)
    check(st.session.cut and st.session.cut["method"] == "device_gone", "cut confirmed by device vanishing")
    r.tick(r.cfg.finished_seconds)
    check(r.records()[-1]["verdict"] == "delivered", "verdict delivered")

    # the phone never showed up on USB: its absence proves nothing
    r.pay("1")
    r.tick(r.cfg.adb_wait_timeout + 30, meter=lambda: (0, 0, False))
    st.emergency_open()
    r.tick(r.cfg.finished_seconds, meter=lambda: (0, 0, False))
    rec = r.records()[-1]
    check(rec["verdict"] == "unverified" and not rec["cut_confirmation"]["confirmed"],
          "phone never seen: cut not claimed as confirmed")


def test_wifi(tmp: Path) -> None:
    print("offered network")
    check(wifi_payload("Café;Net", r"p@ss:w,rd\1", "WPA") == r"WIFI:T:WPA;S:Café\;Net;P:p@ss\:w\,rd\\1;;",
          "WiFi QR escapes ; , : and \\")
    check(wifi_payload("Open", "", "nopass") == "WIFI:T:nopass;S:Open;P:;;", "open network QR")
    r = Rig(tmp, wifi_ssid="Ficha", wifi_password="12345678", wifi_security="WPA")
    check(wifi_qr(r.cfg).startswith("data:image/svg+xml;base64,"), "WiFi QR is a data URI")
    check(wifi_qr(replace(r.cfg, wifi_ssid="")) is None, "no WIFI_SSID, no WiFi QR")
    for bad in ({"wifi_password": "short"}, {"wifi_security": "WEP"}, {"wifi_security": "nopass"}):
        try:
            config.validate(replace(r.cfg, **bad))
            check(False, f"refused {bad}")
        except config.ConfigError:
            pass
    check(True, "short WPA password, WEP, nopass with a password: refused")


def test_restart(tmp: Path) -> None:
    print("station dies mid-session")
    r = Rig(tmp)
    r.pay("2")
    check(r.records()[-1]["kind"] == "credited" and r.records()[-1]["payer"] == "GPAYER",
          "payment on disk the moment it is credited")
    r.tick(5)
    sid = r.st.session.id
    # No shutdown, no FINISHED: as if the process were killed. Start another.
    relay = MockRelay()
    st2 = Station(r.cfg, relay, SessionLog(r.cfg.session_log), clock=r.clock)
    rec = r.records()[-1]
    check(relay.is_open and st2.state == State.AWAITING_PAYMENT, "restart: relay open, awaiting payment")
    check(rec["kind"] == "session" and rec["id"] == sid and rec["end_reason"] == "interrupted"
          and rec["verify_mode"] == "off", "interrupted session logged at restart, with how time was checked")
    check(rec["payer"] == "GPAYER" and rec["fichas"] == 2 and rec["amount"] == "2" and rec["paid_seconds"] == 600,
          "payer, fichas, amount, paid seconds kept")
    check(rec["verdict"] == "delivered", "current seen before the crash -> delivered")
    check(rec["max_current_ma"] is None and rec["first_delivering_ma"] >= r.cfg.min_current_ma,
          "peak unknown (null), the first delivering reading kept under its own name")
    Station(r.cfg, MockRelay(), SessionLog(r.cfg.session_log), clock=r.clock)
    check(sum(x.get("id") == sid for x in r.records()) == 1, "second restart does not log it again")

    st2.on_payment(Payment("tx-late", "op", "GPAYER", Decimal("1"), "XLM", sid, "", "debug"))
    check(r.records()[-1]["reason"] == "session already closed", "payment to the interrupted session is orphan")

    # died before any current was seen
    st2.on_payment(Payment("tx-x", "op", "GPAYER", Decimal("1"), "XLM", st2.session.id, "", "debug"))
    sid = st2.session.id
    Station(r.cfg, MockRelay(), SessionLog(r.cfg.session_log), clock=r.clock)
    rec = r.records()[-1]
    check(rec["id"] == sid and rec["verdict"] == "unverified", "no current seen before the crash -> unverified")

    # Horizon delivers the same payment twice (cursor not saved, restart...)
    st4 = Station(r.cfg, MockRelay(), SessionLog(r.cfg.session_log), clock=r.clock)
    dup = Payment("tx-dup", "op-9", "GPAYER", Decimal("3"), "XLM", st4.session.id, "", "horizon")
    credits = lambda: sum(x["kind"] == "credited" and x["tx_hash"] == "tx-dup" for x in r.records())
    st4.on_payment(dup)
    st4.on_payment(dup)
    check(credits() == 1 and st4.session.fichas == 3, "same payment again: ignored, not credited twice")
    st4.on_payment(Payment("tx-dup", "op-10", "GPAYER", Decimal("1"), "XLM", st4.session.id, "", "horizon"))
    check(credits() == 2 and st4.session.fichas == 4, "another payment in the same transaction still counts")
    st5 = Station(r.cfg, MockRelay(), SessionLog(r.cfg.session_log), clock=r.clock)
    st5.on_payment(dup)
    check(credits() == 2 and st5.session.fichas == 0 and r.records()[-1]["end_reason"] == "interrupted",
          "after a restart the same payment is still ignored")
    orphan = Payment("tx-orph", "op-1", "GPAYER", Decimal("1"), "XLM", None, "", "horizon")
    st5.on_payment(orphan)
    n = len(r.records())
    st5.on_payment(orphan)
    check(len(r.records()) == n, "orphan delivered twice is logged once")

    # dies during the FINISHED screen: what was already known is kept
    st6 = Station(r.cfg, MockRelay(), SessionLog(r.cfg.session_log), clock=r.clock)
    st6.on_payment(Payment("tx-f", "op", "GPAYER", Decimal("12"), "XLM", st6.session.id, "", "debug"))
    sid = st6.session.id
    for _ in range(10):
        r.clock.t += 1
        st6.tick((3000, 4000, True))
    st6.emergency_open()
    Station(r.cfg, MockRelay(), SessionLog(r.cfg.session_log), clock=r.clock)
    rec = [x for x in r.records() if x["kind"] == "session" and x["id"] == sid]
    check(len(rec) == 1 and rec[0]["end_reason"] == "emergency_stop" and rec[0]["unused_seconds"] == 3590
          and rec[0]["verdict"] == "delivered" and rec[0]["max_current_ma"] == 3000
          and not rec[0]["cut_confirmation"]["confirmed"],
          "killed on the FINISHED screen: end reason, unused time and verdict kept")

    # ... after the cut was confirmed there (the receipt said c=1): the record says so too
    st8 = Station(r.cfg, MockRelay(), SessionLog(r.cfg.session_log), clock=r.clock)
    st8.on_payment(Payment("tx-c", "op", "GPAYER", Decimal("1"), "XLM", st8.session.id, "", "debug"))
    sid = st8.session.id
    for _ in range(5):
        r.clock.t += 1
        st8.tick((3000, 4000, True))
    st8.emergency_open()
    r.clock.t += 1
    st8.tick((-200, 3900, True))
    confirmed = st8.snapshot()["last"]["cut_confirmation"]
    Station(r.cfg, MockRelay(), SessionLog(r.cfg.session_log), clock=r.clock)
    rec = [x for x in r.records() if x["kind"] == "session" and x["id"] == sid]
    check(confirmed["confirmed"] and len(rec) == 1 and rec[0]["cut_confirmation"] == confirmed,
          "killed on the FINISHED screen after the cut was confirmed: logged as confirmed, like the receipt")

    # a memo with a Unicode line separator does not split its log line
    st7 = Station(r.cfg, MockRelay(), SessionLog(r.cfg.session_log), clock=r.clock)
    odd = Payment("tx-u", "op-u", "GPAYER", Decimal("1"), "XLM", "hi\u2028there", "", "horizon")
    st7.on_payment(odd)
    Station(r.cfg, MockRelay(), SessionLog(r.cfg.session_log), clock=r.clock).on_payment(odd)
    check(sum(x.get("tx_hash") == "tx-u" for x in r.records()) == 1, "orphan with U+2028 in the memo: logged once")

    # a line cut short by a power loss does not break the log
    with open(r.cfg.session_log, "a", encoding="utf-8") as f:
        f.write('{"kind": "credited", "sess')
    st3 = Station(r.cfg, MockRelay(), SessionLog(r.cfg.session_log), clock=r.clock)
    st3.on_payment(Payment("tx-y", "op", "GPAYER", Decimal("0.1"), "XLM", st3.session.id, "", "debug"))
    check(r.records()[-1]["kind"] == "underpaid", "unfinished last line skipped, next line intact")


ALPHABET = f"[{config.ID_ALPHABET}]"


def test_station_id(tmp: Path) -> None:
    print("station ID and memo")
    r = Rig(tmp, station_id="K7M2QX", station_name="Test bench")
    st = r.st
    memo = st.session.id
    check(re.fullmatch(rf"K7M2QX\.F{ALPHABET}{{7}}", memo) is not None and len(memo.encode()) <= 28,
          f"memo is <STATION_ID>.<SESSION> ({memo}), at most 28 bytes")
    uri = sep7_uri(r.cfg, memo, r.cfg.ficha_price)
    check(f"&memo={memo}&" in uri and uri.endswith("&msg=" + quote(f"Ficha Test bench · session {memo}")),
          "SEP-0007 msg names the station and the memo")
    check(parse_qs(uri.split("?", 1)[1])["network_passphrase"] == ["Test SDF Network ; September 2015"],
          "testnet SEP-0007 uri names its network (SEP-0007 reads none as the public network)")
    public_uri = sep7_uri(replace(r.cfg, network="public"), memo, r.cfg.ficha_price)
    check("network_passphrase" not in parse_qs(public_uri.split("?", 1)[1]), "public SEP-0007 uri omits it")
    check(sep7_msg(replace(r.cfg, station_name=""), "F2345678") == "Ficha charging · session F2345678",
          "no STATION_NAME: 'charging'")
    try:
        validate_memo("K7M2QX." + "F" * 22)
        check(False, "a 29-byte memo is refused")
    except ValueError:
        check(True, "a 29-byte memo is refused")
    check(load_env(STATION_ID="k7m2qx").station_id == "K7M2QX" and load_env().station_id == "",
          "STATION_ID read in capitals; empty = legacy")
    for bad in ("K7M2Q", "K7M2QXA", "K7M2Q0", "K7M2QI", "K7-2QX"):
        refused(replace(r.cfg, station_id=bad), f"STATION_ID={bad}")
    refused(replace(r.cfg, station_name="x" * 65), "STATION_NAME of 65 characters")
    check(True, "STATION_ID with a wrong length or 0/1/I/L/O/U refused, long STATION_NAME refused")
    html = (Path(__file__).resolve().parent / "static" / "index.html").read_text(encoding="utf-8")
    check("header > * { flex-shrink: 0; white-space: nowrap; }" in html and 'id="stname"' in html
          and re.search(r"\n  header \{[^}]*min-width: 0;", html) is not None
          and "#stname { min-width: 0; overflow: hidden; text-overflow: ellipsis; }" in html
          and "#stid { flex-shrink: 0; }" in html,
          "the screen header stays on one line: a long STATION_NAME is cut short, the STATION_ID stays")

    n = len(r.records())
    p = r.pay("1", memo="ABCDEF.F2345678")
    check(len(r.records()) == n and p.key in st.handled and st.state == State.AWAITING_PAYMENT,
          "another station's memo: not credited, not logged, marked handled")
    r.pay("1", memo="K7M2QX.F2345678")
    check(r.records()[-1]["kind"] == "orphan" and r.records()[-1]["reason"] == "unknown session",
          "own prefix, unknown session: orphan")
    r.pay("1", memo=memo.split(".")[1])
    check(r.records()[-1]["kind"] == "orphan" and st.state == State.AWAITING_PAYMENT,
          "bare session ID on a station with an ID: orphan, not credited")
    r.pay("1")
    check(st.state == State.CHARGING and r.records()[-1]["memo"] == memo, "payment with the full memo credited")

    (tmp / "legacy").mkdir()
    legacy = Rig(tmp / "legacy")
    check(re.fullmatch(rf"F{ALPHABET}{{7}}", legacy.st.session.id) is not None, "no STATION_ID: bare session memo")
    legacy.pay("1", memo="K7M2QX.F2345678")
    check(legacy.records() == [], "legacy station leaves prefixed memos to their station")


def test_registry(tmp: Path) -> None:
    print("station registry")
    root = Path(__file__).resolve().parent
    data = (root / "registry" / "stations.json").read_bytes()
    reg = registry.validate(data)
    check(reg["network"] == "testnet" and len(reg["stations"]) >= 1, "registry/stations.json is valid (testnet)")
    contract = (root / "docs" / "station-app-contract.md").read_text(encoding="utf-8")
    pinned = re.search(r"Registry key \(testnet\): (G[A-Z2-7]{55})", contract)
    committed = json.loads((root / "registry" / "stations.json.sig").read_text(encoding="utf-8"))
    check(pinned is not None and registry.verify_bytes(data, committed, pinned.group(1)) == pinned.group(1),
          "committed registry signed by the key pinned in the contract")

    kp = Keypair.random()
    sig = registry.sign_bytes(data, kp)
    check(registry.verify_bytes(data, sig, kp.public_key) == kp.public_key, "sign, then verify")
    for what, bad_data, bad_sig, pin in (
        ("a changed registry", data.replace(b'"ficha_price": "1"', b'"ficha_price": "9"'), sig, None),
        ("another key than the pinned one", data, sig, Keypair.random().public_key),
        ("a signature by another key", data, dict(sig, key=Keypair.random().public_key), None),
    ):
        try:
            registry.verify_bytes(bad_data, bad_sig, pin)
            check(False, f"verify rejects {what}")
        except registry.RegistryError:
            check(True, f"verify rejects {what}")

    st = json.loads(data)["stations"][0]
    for what, change in (("a duplicate id", lambda r: r["stations"].append(dict(st))),
                         ("a bad id", lambda r: r["stations"][0].update(id="K7M2Q0")),
                         ("a secret as host_key", lambda r: r["stations"][0].update(host_key=Keypair.random().secret)),
                         ("a price with 8 decimals", lambda r: r["stations"][0].update(ficha_price="0.00000001")),
                         ("a public network in stations.json", lambda r: r.update(network="public")),
                         # Prices Decimal() reads but the app does not: it would drop the station.
                         *((f"price {p!r}", lambda r, p=p: r["stations"][0].update(ficha_price=p))
                           for p in (".5", "1.", "0.50000000", "1e1", "5E-1", "+1", "1_0", " 1", "0", "0.0", chr(0x661), 1)),
                         ("an asset without an issuer key", lambda r: r["stations"][0].update(asset={"code": "XLM"})),
                         # The app shows these as text: an object there is nothing it can show.
                         ("hours per weekday", lambda r: r["stations"][0].update(hours={"mon-fri": "08:00-20:00"})),
                         ("hours as a number", lambda r: r["stations"][0].update(hours=8)),
                         ("a city as an object", lambda r: r["stations"][0]["location"].update(city={"name": "Rio"})),
                         ("an address as a list", lambda r: r["stations"][0]["location"].update(address=["Rua 1"]))):
        doc = json.loads(data)
        change(doc)
        try:
            registry.validate(json.dumps(doc).encode())
            check(False, f"validate rejects {what}")
        except registry.RegistryError:
            pass
    check(True, "validate rejects duplicate or bad ids, secret host keys, 8 decimals, wrong network")
    check(True, "validate rejects prices the app cannot read (.5, 1., 1e1, +1, 1_0, ...) and an asset without issuer")
    check(True, "validate rejects hours, address or city that are not text")
    doc = json.loads(data)
    del doc["stations"][0]["hours"]
    doc["stations"][0]["location"] = {"lat": 0, "lng": 0}
    registry.validate(json.dumps(doc).encode())
    check(True, "validate accepts a station without hours or address")
    for price in ("1", "0.25", "10", "0.0000001"):
        doc = json.loads(data)
        doc["stations"][0]["ficha_price"] = price
        registry.validate(json.dumps(doc).encode())
    check(True, "validate accepts prices the app reads: 1, 0.25, 10, 0.0000001")

    key_file = tmp / "not-a-key"
    key_file.write_text("SNOTASECRETATALL")
    try:
        registry.load_secret(str(key_file))
        check(False, "a bad key file is refused")
    except registry.RegistryError as exc:
        check("SNOTASECRETATALL" not in str(exc), "a bad key file is refused without echoing it")
    sid = registry.new_station_id({"K7M2QX"})
    check(re.fullmatch(rf"{ALPHABET}{{6}}", sid) is not None and sid != "K7M2QX", f"new-id gives an unused id ({sid})")


def test_registry_check(tmp: Path) -> None:
    print("station checks itself against the registry")
    root = Path(__file__).resolve().parent
    reg_file = root / "registry" / "stations.json"
    data = reg_file.read_bytes()
    sig = registry_format.sig_path(reg_file).read_bytes()
    demo = json.loads(data)["stations"][0]
    # The station as its entry says, in whichever payment mode it lists.
    mode = ({"payment_mode": "custody", "escrow_contract": demo["escrow"], "refund_unit_seconds": demo["unit_seconds"],
             "escrow_grace_seconds": demo["grace_seconds"], "charge_verify": True}
            if demo.get("mode") == "custody" else {})
    base = replace(Rig(tmp).cfg, station_id=demo["id"], host_public_key=demo["host_key"], **mode)
    check(base.registry_check and base.registry_file == reg_file
          and base.registry_url == "https://ficha-stellar.vercel.app/registry/stations.json"
          and base.registry_key == registry_format.verify_bytes(data, json.loads(sig)),
          "defaults: check on, the site's stations.json, then registry/stations.json, the pinned testnet key")

    fetched: list[str] = []

    def site(reg: bytes, signature: bytes):
        return lambda url: (fetched.append(url), (reg, signature))[1]

    def offline(url: str):
        fetched.append(url)
        raise registry_check.Unavailable("ConnectError")

    def refusal(cfg: config.Config, fetch=offline) -> str:
        try:
            registry_check.check(cfg, fetch)
        except config.ConfigError as exc:
            return str(exc)
        return ""

    warnings: list[str] = []

    class Grab(logging.Handler):
        def emit(self, record: logging.LogRecord) -> None:
            if record.levelno >= logging.WARNING:
                warnings.append(record.getMessage())

    grab = Grab()
    logging.getLogger("ficha.registry").addHandler(grab)
    try:
        check(registry_check.check(base, site(data, sig)) == {"status": "ok", "detail": "site"}
              and fetched == [base.registry_url], "match: checked against the site's copy first")
        check(registry_check.check(base, offline) == {"status": "ok", "detail": "local copy"},
              "site unreachable: checked against the local copy")
        check(registry_check.check(base, site(b"<html>Log in to WiFi</html>", b"<html>")) ==
              {"status": "ok", "detail": "local copy"}, "a login page instead of the site's copy: the local copy")
        check(registry_check.check(replace(base, ficha_price=Decimal("1.000")), offline)["status"] == "ok",
              "FICHA_PRICE=1.000 matches ficha_price \"1\" (compared as numbers)")

        usdc = ("USDC", "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5")
        other = Keypair.random().public_key
        for change, expect in (
            ({"ficha_minutes": 1}, "FICHA_MINUTES=1 here, ficha_minutes 5 in the registry"),
            ({"ficha_price": Decimal("2")}, "FICHA_PRICE=2 here, ficha_price 1 in the registry"),
            ({"max_session_minutes": 30}, "MAX_SESSION_MINUTES=30 here, max_session_minutes 60 in the registry"),
            ({"host_public_key": other}, f"HOST_PUBLIC_KEY={other} here, host_key {demo['host_key']} in the registry"),
            ({"host_public_key": ""}, f"HOST_PUBLIC_KEY=(empty) here, host_key {demo['host_key']}"),
            ({"asset_code": usdc[0], "asset_issuer": usdc[1]},
             f"PAYMENT_ASSET_CODE/PAYMENT_ASSET_ISSUER=USDC issued by {usdc[1]} here, asset XLM (native) in the registry"),
            ({"network": "public"}, "STELLAR_NETWORK=public here, network testnet in the registry"),
        ):
            msg = refusal(replace(base, **change))
            check(expect in msg and "Change .env" in msg and "tools/registry.py sign" in msg,
                  f"refused, says how to fix: {expect}")
        msg = refusal(replace(base, ficha_minutes=1, max_session_minutes=30, ficha_price=Decimal("0.5")))
        check(msg.count("\n  - ") == 3, "several differences: every one listed")
        msg = refusal(replace(base, ficha_minutes=1), site(data, sig))
        check("FICHA_MINUTES=1" in msg and base.registry_url in msg, "the site's copy disagrees: refused, naming it")
        msg = refusal(replace(base, station_id="K7M2QX"))
        check("STATION_ID=K7M2QX is not in the signed station registry" in msg, "a station not in the registry: refused")

        tampered = data.replace(b'"ficha_minutes": 5', b'"ficha_minutes": 1')
        (tmp / "tampered.json").write_bytes(tampered)
        (tmp / "tampered.json.sig").write_bytes(sig)
        msg = refusal(replace(base, ficha_minutes=1, registry_file=tmp / "tampered.json"))
        check("does not verify" in msg and "does NOT match" in msg, "a local copy edited after signing: refused")
        msg = refusal(replace(base, ficha_minutes=1), site(tampered, sig))
        check("does not verify" in msg, "a site copy that does not verify: refused, not skipped for the local one")
        kp = Keypair.random()
        forged = json.dumps(registry.sign_bytes(tampered, kp)).encode()
        msg = refusal(replace(base, ficha_minutes=1), site(tampered, forged))
        check(f"signed by {kp.public_key}, not by the pinned key" in msg, "a copy signed by another key: refused")
        not_text = json.dumps({"format": "ficha-registry-sig/1", "key": base.registry_key, "sig": 7}).encode()
        check("does not verify" in refusal(base, site(data, not_text)), "a signature that is not text: refused, no crash")

        def signed(name: str, doc: dict) -> Path:
            path = tmp / name
            raw = json.dumps(doc, indent=2).encode()
            path.write_bytes(raw)
            registry_format.sig_path(path).write_text(json.dumps(registry.sign_bytes(raw, kp)))
            return path

        doc = json.loads(data)
        doc["stations"][0]["active"] = False
        doc["stations"].append(dict(demo, id="K7M2QX", hours={"mon": "08-20"}))
        msg = refusal(replace(base, registry_key=kp.public_key, registry_file=signed("inactive.json", doc)))
        check("inactive (active: false)" in msg and "K7M2QX" not in msg,
              "inactive in the registry: refused (another station's broken entry is not this one's problem)")
        doc["stations"][0]["active"] = True
        check(registry_check.check(replace(base, registry_key=kp.public_key, registry_file=signed("other.json", doc)),
                                   offline)["status"] == "ok",
              "active again, with another station's entry broken: starts")

        warnings.clear()
        health = registry_check.check(replace(base, registry_file=tmp / "missing.json"), offline)
        check(health == {"status": "unchecked", "detail": "no copy found"} and any(
              "registry UNCHECKED" in w and "missing.json not found" in w and "ConnectError" in w for w in warnings),
              "no copy readable (offline, no file): starts, with a warning in the log and 'unchecked' on the footer")
        fetched.clear()
        check(registry_check.check(replace(base, station_id=""), offline) == {"status": "off", "detail": "no STATION_ID"}
              and fetched == [], "no STATION_ID: no check")
        check(registry_check.check(replace(base, registry_check=False), offline)
              == {"status": "off", "detail": "REGISTRY_CHECK=false"}
              and fetched == [] and load_env(REGISTRY_CHECK="false").registry_check is False,
              "REGISTRY_CHECK=false: no check")
    finally:
        logging.getLogger("ficha.registry").removeHandler(grab)

    pub = load_env(STELLAR_NETWORK="public", MOCK="false", MOCK_PAYMENT="false", ADB_SERIAL=ADB_SERIAL,
                   STATION_ID="K7M2QX", REGISTRY_KEY=PUBLIC_REGISTRY_KEY)
    check(pub.registry_url == "https://ficha-stellar.vercel.app/registry/stations.public.json"
          and pub.registry_file == root / "registry" / "stations.public.json" and config.REGISTRY_KEYS["public"] == ""
          and pub.registry_key == PUBLIC_REGISTRY_KEY
          and registry_check.check(pub, offline) == {"status": "unchecked", "detail": "no copy found"},
          "public: stations.public.json, no key pinned yet (REGISTRY_KEY gives it), no copy here: unchecked")
    try:
        load_env(STELLAR_NETWORK="public", MOCK="false", MOCK_PAYMENT="false", ADB_SERIAL=ADB_SERIAL,
                 STATION_ID="K7M2QX")
        check(False, "public with no key pinned and no REGISTRY_KEY: refused")
    except config.ConfigError as exc:
        check("needs REGISTRY_KEY" in str(exc), "public with no key pinned and no REGISTRY_KEY: refused")
    secret = Keypair.random().secret
    try:
        load_env(REGISTRY_KEY=secret)
        check(False, "REGISTRY_KEY holding a secret refused")
    except config.ConfigError as exc:
        check(secret not in str(exc), "REGISTRY_KEY holding a secret refused without echoing it")
    for url in ("http://ficha-stellar.vercel.app/registry/stations.json", "https://x.test/r.json?v=1"):
        try:
            load_env(REGISTRY_URL=url)
            check(False, f"REGISTRY_URL={url} refused")
        except config.ConfigError:
            pass
    check(True, "REGISTRY_URL that is not https, or has a query: refused")


def test_public(tmp: Path) -> None:
    print("the public network: a real station, checked against the registry, or no start")
    root = Path(__file__).resolve().parent
    r = Rig(tmp)
    env = {"STELLAR_NETWORK": "public", "MOCK": "false", "MOCK_PAYMENT": "false", "ADB_SERIAL": ADB_SERIAL,
           "HOST_PUBLIC_KEY": Keypair.random().public_key, "PAYMENT_ASSET_CODE": "XLM", "STATION_ID": "K7M2QX",
           "REGISTRY_KEY": PUBLIC_REGISTRY_KEY}
    pub = load_env(**env)
    check(pub.network == "public" and pub.horizon_url == "https://horizon.stellar.org" and pub.is_native
          and pub.payment_mode == "direct" and not pub.mock and not pub.mock_payment and pub.registry_check
          and pub.host_public_key == env["HOST_PUBLIC_KEY"] and pub.registry_key == PUBLIC_REGISTRY_KEY,
          "a correct public config validates: direct, a real relay and phone, native XLM, STATION_ID, REGISTRY_KEY")

    demo_hosts = {s["host_key"] for s in json.loads((root / "registry" / "stations.json").read_bytes())["stations"]}
    testnet_registry = config.REGISTRY_KEYS["testnet"]
    for what, over, says in (
        ("MOCK=true", {"mock": True}, "MOCK=true on the public network"),
        ("MOCK_PAYMENT=true", {"mock_payment": True}, "MOCK_PAYMENT=true on the public network"),
        ("REGISTRY_CHECK=false", {"registry_check": False}, "REGISTRY_CHECK=false on the public network"),
        ("no STATION_ID", {"station_id": ""}, "STELLAR_NETWORK=public needs STATION_ID"),
        ("no registry key", {"registry_key": ""}, "STELLAR_NETWORK=public needs REGISTRY_KEY"),
        ("the testnet registry key as REGISTRY_KEY", {"registry_key": testnet_registry}, "the testnet registry's key"),
        ("the testnet registry key as HOST_PUBLIC_KEY", {"host_public_key": testnet_registry},
         "the testnet registry's key"),
        *((f"the testnet demo host {h[:4]}… as HOST_PUBLIC_KEY", {"host_public_key": h}, "the testnet demo host's key")
          for h in demo_hosts),
        *((f"the testnet demo host {h[:4]}… as REGISTRY_KEY", {"registry_key": h}, "the testnet demo host's key")
          for h in demo_hosts),
    ):
        refused(on_public(r.cfg, **over), f"public: {what}", says)
    refused(on_public(r.cfg, registry_key=testnet_registry), "public: the testnet registry key, none pinned",
            "Put that key (none is pinned for public yet).")
    check(bool(demo_hosts), "public refuses MOCK, MOCK_PAYMENT, REGISTRY_CHECK=false, no STATION_ID, no registry key, and the "
          "testnet demo's host and registry keys as either key, each saying so")
    config.validate(replace(r.cfg, station_id="", registry_check=False, registry_key=testnet_registry,
                            host_public_key=next(iter(demo_hosts))))
    check(r.cfg.mock and r.cfg.mock_payment, "testnet unchanged: MOCK, MOCK_PAYMENT, no STATION_ID, "
                                             "REGISTRY_CHECK=false and the demo's keys still validate")
    for name in ("HOST_PUBLIC_KEY", "REGISTRY_KEY"):
        secret = Keypair.random().secret
        try:
            load_env(**dict(env, **{name: secret}))
            check(False, f"public: {name} holding a secret refused")
        except config.ConfigError as exc:
            check(secret not in str(exc) and "SECRET" in str(exc),
                  f"public: {name} holding a secret refused without echoing it")

    pinned = Keypair.random().public_key
    config.REGISTRY_KEYS["public"] = pinned
    try:
        refused(on_public(r.cfg), "public: a REGISTRY_KEY other than the pinned one", f"this version pins ({pinned})")
        refused(on_public(r.cfg, registry_key=testnet_registry), "public: the testnet registry key, one pinned",
                "leave REGISTRY_KEY empty for the pinned one")
        config.validate(on_public(r.cfg, registry_key=pinned))
        check(load_env(**{k: v for k, v in env.items() if k != "REGISTRY_KEY"}).registry_key == pinned,
              "once a public key is pinned: an empty REGISTRY_KEY takes it, another one is refused, and the "
              "testnet one's refusal offers the pinned one")
    finally:
        config.REGISTRY_KEYS["public"] = ""

    def offline(url: str):
        raise registry_check.Unavailable("ConnectError")

    def startup_refusal(cfg: config.Config) -> str:
        try:
            registry_check.startup(cfg, offline)
        except config.ConfigError as exc:
            return str(exc)
        return ""

    logging.disable(logging.WARNING)
    try:
        gone = on_public(r.cfg, registry_file=tmp / "stations.public.json")
        msg = startup_refusal(gone)
        check("registry unchecked (no copy found) on the public network" in msg and "stations.public.json" in msg,
              "public, no copy of the registry readable (offline, no file): the station does not start")
        for over, says in (({"station_id": ""}, "registry off (no STATION_ID)"),
                           ({"registry_check": False}, "registry off (REGISTRY_CHECK=false)"),
                           ({"registry_key": ""}, "registry unchecked (no REGISTRY_KEY)")):
            check(says in startup_refusal(replace(gone, **over)), f"public, {says}: the station does not start")
        kp = Keypair.random()
        doc = json.loads((root / "registry" / "stations.json").read_bytes())
        entry = {k: v for k, v in doc["stations"][0].items() if k not in ("mode", "escrow", "unit_seconds",
                                                                          "grace_seconds")}
        doc.update(network="public", stations=[dict(entry, id="K7M2QX", host_key=HOST)])
        raw = json.dumps(doc, indent=2).encode()
        (tmp / "stations.public.json").write_bytes(raw)
        (tmp / "stations.public.json.sig").write_text(json.dumps(registry.sign_bytes(raw, kp)))
        signed = replace(gone, registry_key=kp.public_key)
        check(registry_check.startup(signed, offline) == {"status": "ok", "detail": "local copy"},
              "public, the station matches its entry in a signed public registry: it starts")
        check("FICHA_MINUTES=1 here" in startup_refusal(replace(signed, ficha_minutes=1)),
              "public, a station that differs from its entry: refused as on testnet")
        testnet = replace(r.cfg, station_id="K7M2QX", registry_file=tmp / "missing.json")
        check(registry_check.startup(testnet, offline) == {"status": "unchecked", "detail": "no copy found"}
              and registry_check.startup(replace(testnet, station_id=""), offline)["status"] == "off",
              "testnet unchanged: unchecked or off, the station still starts")
    finally:
        logging.disable(logging.NOTSET)
    main_py = (root / "main.py").read_text(encoding="utf-8")
    check("registry_health = registry_check.startup(cfg)" in main_py, "main.py checks the registry with startup()")

    html = (root / "static" / "index.html").read_text(encoding="utf-8")
    on_card = re.search(r'<img id="qr" alt="Payment QR code"></div>\s*<div class="mainnet" id="mainnet" role="note">'
                        r'<span class="k">mainnet</span><span>real <span id="mainnetasset">XLM</span></span></div>\s*'
                        r'</figure>', html)
    check(on_card is not None and 'if (d.network === "public") body.classList.add("public");' in html
          and '$("mainnetasset").textContent = d.asset;' in html and "body.public .mainnet { display: flex; }" in html
          and ".mainnet { display: none;" in html,
          "the screen on the public network: a MAINNET banner on the pay QR's card, 'real XLM' (the station's asset); "
          "it goes with the card (no pay QR, no banner), and testnet shows none")


def test_horizon_public(tmp: Path) -> None:
    print("the public network: no pay QR while Horizon is failing")
    started = datetime(2026, 9, 29, 12, 0, 0, tzinfo=timezone.utc)
    (tmp / "pub").mkdir()
    r = Rig(tmp / "pub")
    r.cfg = on_public(r.cfg, cursor_dir=tmp / "pub")
    config.validate(r.cfg)
    st = r.st = r.station(r.relay, r.log)
    w = HorizonWatcher(r.cfg, st.on_payment, now=lambda: started, on_read=st.on_horizon)
    check(st.out_of_service() is None, "(Horizon not watched: nothing changes)")
    st.watch_horizon()
    poll_status(w, 503)
    check(st.out_of_service() == "horizon: not read yet" and r.snap()["out_of_service"] == "horizon: not read yet"
          and w.health()["status"] == "error", "public: no pay QR until Horizon first answers")
    before = [horizon_payment("100", "2026-09-29T10:00:00Z")]
    poll(w, before)
    check(st.out_of_service() is None and st.horizon_read_at == r.clock.t and w.health()["status"] == "ok",
          "public: Horizon answers, the pay QR is shown")
    r.clock.t += 5
    poll_status(w, 503)
    r.clock.t += 5
    check(st.out_of_service() is None, "public: Horizon failing for 10 s: still shown (a few polls)")
    r.clock.t += 1
    check(st.out_of_service() == "horizon: not read for 11 s" and r.snap()["out_of_service"] == st.out_of_service(),
          "public: Horizon failing for more than 10 s: out of service, the pay QR hidden")
    poll(w, before + [horizon_payment("200", "2026-09-29T12:00:30Z", st.session.id)])
    check(st.state == State.CHARGING and r.records()[-1]["kind"] == "credited" and st.out_of_service() is None,
          "public: Horizon answers again: a payment made meanwhile is credited (not refused), back in service")
    slow = Station(replace(r.cfg, horizon_poll_seconds=5.0), MockRelay(), SessionLog(tmp / "pub" / "slow.jsonl"),
                   clock=r.clock, wallclock=r.clock.iso, unixclock=r.unix)
    slow.watch_horizon()
    slow.on_horizon()
    r.clock.t += 15
    shown = slow.out_of_service() is None
    r.clock.t += 1
    check(shown and slow.out_of_service() == "horizon: not read for 16 s",
          "public, HORIZON_POLL_SECONDS=5: out of service after 3 polls missed (15 s), not 10 s")

    (tmp / "testnet").mkdir()
    t = Rig(tmp / "testnet", cursor_dir=tmp / "testnet")
    wt = HorizonWatcher(t.cfg, t.st.on_payment, now=lambda: started, on_read=t.st.on_horizon)
    t.st.watch_horizon()
    poll_status(wt, 503)
    t.clock.t += 600
    check(t.st.out_of_service() is None and t.snap()["out_of_service"] is None and wt.health()["status"] == "error",
          "testnet unchanged: Horizon failing shows in the footer only, the pay QR stays")
    main = sys.modules.get("main") or import_main(tmp)
    check(main.watcher.on_read == main.station.on_horizon and main.station.horizon_watched
          and main.cfg.network == "testnet" and main.snapshot()["out_of_service"] is None,
          "main.py: Horizon's reads reach the station (on testnet, the pay QR stays)")


def test_receipt(tmp: Path) -> None:
    print("receipt")
    r = Rig(tmp, station_id="K7M2QX", app_url="https://ficha.test")
    st = r.st
    check(config.load(env_file=os.devnull).finished_seconds == 20, "FINISHED_SECONDS defaults to 20")
    check(receipt_qr(r.cfg, r.snap()) is None, "no receipt while waiting for payment")
    r.pay("2.5")
    r.tick(3)
    check(receipt_qr(r.cfg, r.snap()) is None, "no receipt while charging")
    r.tick(600)
    snap = r.snap()
    rc = receipt_qr(r.cfg, snap)
    check(snap["state"] == "FINISHED" and rc is not None and rc["qr"].startswith("data:image/svg+xml;base64,"),
          "FINISHED of a paid session: receipt URI and QR data URI")
    last = snap["last"]
    check(rc["uri"].startswith(f"https://ficha.test/r?v=1&m={st.session.id}&n=t&h={HOST}&a=2.5&k=XLM&f=2&p=600&u=600&"),
          "receipt: APP_URL/r?v=1&m=<memo>&n&h&a&k&f&p&u in the contract's order")
    q = {k: v[0] for k, v in parse_qs(urlsplit(rc["uri"]).query).items()}
    finished_at = datetime.fromisoformat(last["timestamps"]["FINISHED"]).timestamp()
    check(q["wh"] == f"{last['wh']:.3f}" and q["x"] == str(last["max_current_ma"]) and q["vd"] == "d"
          and q["c"] == "1" and q["t"] == str(int(finished_at)), "receipt: wh (3 decimals), peak, verdict d, cut 1, time")
    check(receipt_payload(replace(r.cfg, app_url=""), last).startswith("ficha:/r?v=1&m="), "no APP_URL: ficha:/r?v=1&...")
    site = load_env(APP_URL="https://ficha-stellar.vercel.app/").app_url
    check(receipt_payload(replace(r.cfg, app_url=site), last).startswith("https://ficha-stellar.vercel.app/r?v=1&m="),
          "APP_URL=the Ficha site (a trailing / dropped): https://ficha-stellar.vercel.app/r?v=1&... (the App Link path)")
    r.tick(r.cfg.finished_seconds)
    check(receipt_qr(r.cfg, r.snap()) is None, "receipt gone with the next session")
    html = (Path(__file__).resolve().parent / "static" / "index.html").read_text(encoding="utf-8")
    check('last.fichas === 1 ? "ficha" : "fichas"' in html and 'id="sumfichasword"' in html,
          "FINISHED summary says '1 ficha', not '1 fichas'")
    for bad in ("http://ficha.test", "https://ficha.test/?a=1", "ficha.test"):
        refused(replace(r.cfg, app_url=bad), f"APP_URL={bad}")
    check(True, "APP_URL must be https without ? or #")


def test_money(tmp: Path) -> None:
    print("money: change and refund hints")
    r = Rig(tmp)
    st = r.st
    r.pay("3.7")
    check(r.records()[-1]["kind"] == "credited" and r.records()[-1]["change_due"] == "0.7",
          "credited line carries change_due (3.7 buys 3 fichas, 0.7 left)")
    r.pay("12.25")
    check(st.session.capped_seconds == 900 and "limit" in r.snap()["notice"],
          "(8) extension past the cap: 15 min capped, cap notice not covered by '+12 fichas'")
    r.tick(10)
    st.emergency_open()
    r.tick(r.cfg.finished_seconds)
    rec = last_session(r)
    check(rec["change_due"] == "0.95" and rec["unused_seconds"] == 3590, "session record carries change_due")
    check(rec["refund_hint"] == {"change": "0.9500000", "capped": "3.0000000", "unused": "11.9666667", "asset": "XLM"},
          f"refund_hint in the asset, 7 decimals: {rec['refund_hint']}")
    html = (Path(__file__).resolve().parent / "static" / "index.html").read_text(encoding="utf-8")
    check("asks for 1 ficha" in html and "logged for refund" in html, "screen price line explains 1 ficha, multiples, refunds")

    # At the session limit a payment is capped whole: the screen stops asking for one.
    (tmp / "cap").mkdir()
    rc = Rig(tmp / "cap", max_session_minutes=2, ficha_minutes=1)
    check(rc.snap()["can_add"], "(14) waiting: a ficha fits")
    rc.pay("1")
    check(rc.snap()["can_add"], "(14) 1 of 2 min paid: one more ficha fits")
    rc.pay("1")
    rc.tick(30)
    check(not rc.snap()["can_add"], "(14) at MAX_SESSION_MINUTES: can_add false")
    (tmp / "part").mkdir()
    rp = Rig(tmp / "part", max_session_minutes=7)
    rp.pay("1")
    check(not rp.snap()["can_add"], "(14) only part of a ficha fits (2 of 5 min): can_add false")
    (tmp / "usb").mkdir()
    ru = Rig(tmp / "usb", topology="usb_vbus", adb_transport="usb", mock_profile="usb")
    ru.pay("11")
    check(ru.snap()["waiting_for_device"] and ru.snap()["can_add"], "(14) usb_vbus, 55 of 60 min paid: a ficha fits")
    ru.pay("1")
    check(not ru.snap()["can_add"], "(14) usb_vbus before the countdown starts: paid time counts toward the limit")
    check("d.can_add === false" in html and "body.full .qrs" in html,
          "(14) the screen hides the pay QR and the price note at the session limit")


def horizon_mock(records: list[dict]) -> httpx.MockTransport:
    """A Horizon that pages /payments by paging_token, both orders."""
    def handler(request: httpx.Request) -> httpx.Response:
        q = request.url.params
        cursor = int(q.get("cursor") or 0)
        if q.get("order") == "desc":
            items = [x for x in reversed(records) if not q.get("cursor") or int(x["paging_token"]) < cursor]
        else:
            items = [x for x in records if int(x["paging_token"]) > cursor]
        return httpx.Response(200, json={"_embedded": {"records": items[:int(q.get("limit", 10))]}})
    return httpx.MockTransport(handler)


def horizon_payment(token: str, created: str, memo: str | None = None) -> dict:
    return {"id": token, "paging_token": token, "type": "payment", "to": HOST, "from": "GPAYER",
            "asset_type": "native", "amount": "1", "transaction_hash": "h" + token,
            "transaction_successful": True, "created_at": created,
            "transaction": {"memo_type": "text", "memo": memo} if memo else {"memo_type": "none"}}


def poll(watcher: HorizonWatcher, records: list[dict]) -> None:
    async def run():
        async with httpx.AsyncClient(transport=horizon_mock(records)) as client:
            await watcher.poll(client)
    asyncio.run(run())


def poll_status(watcher: HorizonWatcher, code: int) -> None:
    """One poll of a Horizon that answers every request with this HTTP status."""
    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(lambda request: httpx.Response(code))) as client:
            await watcher.poll(client)
    asyncio.run(run())


def test_wrong_asset(tmp: Path) -> None:
    print("payments in another asset")
    started = datetime(2026, 9, 29, 12, 0, 0, tzinfo=timezone.utc)
    fake_issuer = Keypair.random().public_key

    def paid_in(token: str, memo: str | None, code: str = "USDC", issuer: str = HOST) -> dict:
        rec = horizon_payment(token, "2026-09-29T12:00:30Z", memo)
        if code != "XLM":
            rec.update(asset_type="credit_alphanum4", asset_code=code, asset_issuer=issuer)
        return rec

    (tmp / "xlm").mkdir()
    r = Rig(tmp / "xlm", station_id="K7M2QX", cursor_dir=tmp / "xlm")
    w = HorizonWatcher(r.cfg, r.st.on_payment, now=lambda: started)
    memo = r.st.session.id
    records = [horizon_payment("100", "2026-09-29T10:00:00Z"),
               paid_in("200", memo), paid_in("300", None), paid_in("400", "ABCDEF.F2345678"),
               paid_in("500", "K7M2QX.F2345678")]
    poll(w, records)
    logged = [x for x in r.records() if x.get("tx_hash", "").startswith("h")]
    check([(x["kind"], x["reason"], x["asset"], x["asset_issuer"], x["memo"]) for x in logged]
          == [("refused", "wrong asset", "USDC", HOST, memo), ("refused", "wrong asset", "USDC", HOST, "K7M2QX.F2345678")]
          and logged[0]["payer"] == "GPAYER" and logged[0]["amount"] == "1",
          "XLM station paid in USDC with its memo: logged as refused (wrong asset, code and issuer) for refund")
    check(r.st.state == State.AWAITING_PAYMENT and r.st.session.fichas == 0 and "USDC" in r.snap()["notice"]
          and w.cursor == "500", "not credited; the screen says so; no memo or another station's memo: not logged")
    records.append(paid_in("600", memo, code="XLM"))
    poll(w, records)
    check(r.st.state == State.CHARGING and r.records()[-1]["kind"] == "credited", "the right asset is still credited")

    (tmp / "usdc").mkdir()
    r = Rig(tmp / "usdc", cursor_dir=tmp / "usdc", asset_code="USDC", asset_issuer=HOST)
    w = HorizonWatcher(r.cfg, r.st.on_payment, now=lambda: started)
    memo = r.st.session.id
    poll(w, [horizon_payment("100", "2026-09-29T10:00:00Z"), paid_in("200", memo, code="XLM"),
             paid_in("300", memo, issuer=fake_issuer), paid_in("400", memo)])
    logged = [x for x in r.records() if x.get("tx_hash", "").startswith("h")]
    check([(x["kind"], x.get("reason"), x["asset"], x.get("asset_issuer")) for x in logged]
          == [("refused", "wrong asset", "XLM", None), ("refused", "wrong asset", "USDC", fake_issuer),
              ("credited", None, "USDC", None)] and r.st.state == State.CHARGING,
          "USDC station: native XLM and USDC of another issuer refused and logged; the real USDC credited")


class FlakyLog(SessionLog):
    broken = False

    def _append(self, line: str) -> None:
        if self.broken:
            raise OSError(28, "No space left on device")
        super()._append(line)


def test_robustness(tmp: Path) -> None:
    print("robustness")
    r = Rig(tmp, cursor_dir=tmp)
    started = datetime(2026, 9, 29, 12, 0, 0, tzinfo=timezone.utc)
    records = [horizon_payment("100", "2026-09-29T10:00:00Z"),
               horizon_payment("200", "2026-09-29T11:59:59Z"),
               horizon_payment("300", "2026-09-29T12:00:30Z", "F2345678")]
    got: list[Payment] = []
    w = HorizonWatcher(r.cfg, got.append, now=lambda: started)
    poll(w, records)  # the first poll that works may come long after the start
    check([p.tx_hash for p in got] == ["h300"] and w.cursor == "300" and r.cfg.cursor_file.read_text() == "300",
          "(1) first run: history skipped, a payment made after the start still processed")

    gone = replace(r.cfg, cursor_dir=tmp / "gone")
    got2: list[Payment] = []
    w2 = HorizonWatcher(gone, got2.append, now=lambda: started)
    poll(w2, records)
    records.append(horizon_payment("400", "2026-09-29T12:01:00Z"))
    poll(w2, records)
    check([p.tx_hash for p in got2] == ["h300", "h400"] and w2.cursor == "400"
          and w2.health()["status"] == "error" and "cursor not saved" in w2.health()["detail"],
          "(2) cursor file not writable: cursor kept in memory, payments processed, Horizon marked error")
    for code, detail in ((503, "HTTP 503 Service Unavailable"), (429, "HTTP 429 Too Many Requests")):
        poll_status(w, code)
        check(w.health() == {"status": "error", "detail": detail} and w.cursor == "300",
              f"Horizon answers {code}: the footer says '{detail}', not httpx's two lines with the whole URL")
    poll(w, records)
    check(w.health() == {"status": "ok", "detail": ""} and w.cursor == "400", "Horizon answers again: ok")
    html = (Path(__file__).resolve().parent / "static" / "index.html").read_text(encoding="utf-8")
    footer = re.search(r"footer \{[^}]*\}", html).group(0)
    check("white-space: nowrap" in footer and "minmax(0, max-content)" in footer
          and "text-overflow: ellipsis" in re.search(r"\.h > span:last-child \{[^}]*\}", html).group(0),
          "the footer stays on one line: a long relay or Horizon error is cut short instead of squeezing the price")
    a_file = tmp / "a-file"
    a_file.write_text("x")
    refused(replace(r.cfg, cursor_dir=tmp / "gone"), "CURSOR_DIR missing")
    refused(replace(r.cfg, cursor_dir=a_file), "CURSOR_DIR is a file")
    check(True, "(2) CURSOR_DIR missing or not a directory refused at startup")

    read_only = tmp / "read-only.jsonl"
    read_only.write_text("")
    os.chmod(read_only, stat.S_IREAD)
    try:
        refused(replace(r.cfg, session_log=read_only), "SESSION_LOG read-only")
    finally:
        os.chmod(read_only, stat.S_IREAD | stat.S_IWRITE)
    refused(replace(r.cfg, session_log=tmp / "gone" / "sessions.jsonl"), "SESSION_LOG in a missing directory")
    refused(replace(r.cfg, session_log=tmp), "SESSION_LOG is a directory")
    config.validate(replace(r.cfg, session_log=tmp / "new.jsonl"))
    check(not (tmp / "new.jsonl").exists(), "SESSION_LOG read-only, in a missing directory or a directory: refused "
          "at startup; a new one in a writable directory is fine (and not created by the check)")

    flaky = FlakyLog(tmp / "flaky.jsonl")
    st = Station(r.cfg, MockRelay(), flaky, clock=r.clock)
    st.on_payment(Payment("tx-l", "op", "GPAYER", Decimal("1"), "XLM", st.session.id, "", "debug"))
    sid = st.session.id
    for _ in range(300):
        r.clock.t += 1
        st.tick((3000, 4000, True))
    flaky.broken = True
    for _ in range(r.cfg.finished_seconds + 2):
        r.clock.t += 1
        st.tick((-200, 3900, True))
    snap = st.snapshot()
    check(st.state == State.AWAITING_PAYMENT and snap["log"]["status"] == "error" and snap["log"]["pending"] == 2
          and "No space" in snap["log"]["detail"],
          "(3) log write fails at close: no crash, records kept (cut, session), log health error")
    flaky.broken = False
    r.clock.t += 1
    st.tick((0, 0, False))
    lines = [x["kind"] for x in flaky.read() if sid in (x.get("id"), x.get("session"))]
    check(lines == ["credited", "delivering", "finished", "cut", "session"] and st.snapshot()["log"]["status"] == "ok",
          "(3) retried on the next tick, written once, in order")

    # A line written while charging fails once (the log locked for a moment
    # by an antivirus, say): it waits like a closing record, and the station
    # is back in service as soon as the log takes it, not at the session's end.
    blip = FlakyLog(tmp / "blip.jsonl")
    sb = Station(r.cfg, MockRelay(), blip, clock=r.clock)
    sb.on_payment(Payment("tx-d", "op", "GPAYER", Decimal("3"), "XLM", sb.session.id, "", "debug"))
    blip.broken = True
    r.clock.t += 1
    sb.tick((3000, 4000, True))
    snap = sb.snapshot()
    check(snap["log"]["pending"] == 1 and "No space" in snap["out_of_service"],
          "(3) the delivering line cannot be written: kept, log health error, out of service meanwhile")
    blip.broken = False
    r.clock.t += 1
    sb.tick((3000, 4000, True))
    snap = sb.snapshot()
    check(sb.state == State.CHARGING and snap["out_of_service"] is None and snap["log"]["status"] == "ok"
          and [x["kind"] for x in blip.read()] == ["credited", "delivering"],
          "(3) log writable again: the delivering line is written on the next tick, back in service while charging")

    # The log breaks while waiting: the payment can be neither credited nor
    # logged, so it is not taken (Horizon hands it over again) and the pay QR goes.
    check(st.snapshot()["out_of_service"] is None, "log writable: in service")
    flaky.broken = True
    p = Payment("tx-lb", "op", "GPAYER", Decimal("1"), "XLM", st.session.id, "", "horizon")
    try:
        st.on_payment(p)
        check(False, "a payment that cannot be logged raises, so Horizon retries it")
    except OSError:
        pass
    snap = st.snapshot()
    check(p.key not in st.handled and st.state == State.AWAITING_PAYMENT and "No space" in snap["out_of_service"],
          "log not writable: payment not taken, station out of service (no pay QR)")
    flaky.broken = False
    st.on_payment(p)
    check(st.state == State.CHARGING and st.snapshot()["out_of_service"] is None,
          "log writable again: the payment handed over again is credited, back in service")
    html = (Path(__file__).resolve().parent / "static" / "index.html").read_text(encoding="utf-8")
    check("!!d.out_of_service" in html, "the screen hides the pay QR while out of service")

    # A power cut, then a restart on a log that cannot be written (disk full):
    # one session killed on the FINISHED screen, one killed while charging.
    cut = tmp / "cut.jsonl"
    sids = []
    for name, esc in (("cut-finished", True), ("cut-charging", False)):
        (tmp / name).mkdir()
        rx = Rig(tmp / name)
        rx.pay("1")
        rx.tick(3)
        if esc:
            rx.st.emergency_open()
        sids.append(rx.st.session.id)
        with cut.open("a", encoding="utf-8") as f:
            f.write(rx.cfg.session_log.read_text(encoding="utf-8"))
    full = FlakyLog(cut)
    full.broken = True
    st = Station(r.cfg, MockRelay(), full, clock=r.clock)
    snap = st.snapshot()
    check(snap["log"]["status"] == "error" and snap["log"]["pending"] == 2 and st.relay.is_open
          and all(s in st.closed_ids for s in sids), "(3) restart with interrupted sessions on an unwritable log: no crash, "
          "records kept, log health error")
    full.broken = False
    r.clock.t += 1
    st.tick((0, 0, False))
    closed = {x["id"]: x["end_reason"] for x in full.read() if x["kind"] == "session"}
    check(closed == {sids[0]: "emergency_stop", sids[1]: "interrupted"} and st.snapshot()["log"]["status"] == "ok",
          "(3) both written once the log is writable again")

    (tmp / "oos").mkdir()
    r4 = Rig(tmp / "oos")
    r4.relay.error = "open failed: port gone"
    check(not r4.st.courtesy() and r4.st.state == State.AWAITING_PAYMENT and not r4.snap()["courtesy_available"]
          and "Out of service" in r4.snap()["notice"] and r4.snap()["out_of_service"] == "relay: open failed: port gone",
          "(4) courtesy refused while the relay is out of service")
    p = r4.pay("2.0000000")
    rec = r4.records()[-1]
    check(rec["kind"] == "refused" and rec["reason"] == "station out of service" and rec["payer"] == "GPAYER"
          and rec["tx_hash"] == p.tx_hash and rec["op_id"] == "op" and rec["amount"] == "2"
          and r4.st.state == State.AWAITING_PAYMENT and r4.relay.is_open
          and r4.snap()["notice"] == "Out of service: payment of 2 XLM not credited, logged for refund",
          "(5) payment while out of service: not credited, logged as refused for refund")
    n = len(r4.records())
    Station(r4.cfg, MockRelay(), SessionLog(r4.cfg.session_log), clock=r4.clock).on_payment(p)
    check(len(r4.records()) == n, "(5) a refused payment delivered again after a restart is not logged twice")
    r4.relay.error = None
    r4.pay("1")
    check(r4.st.state == State.CHARGING, "(5) relay back: payments credited again")

    fail = lambda: (0, 0, False)  # noqa: E731
    r4.tick(5)
    r4.tick(1, meter=fail)
    s = r4.snap()
    check(s["held"] and s["current_ma"] and s["current_ma"] > 0, "(6) charging: a failed reading holds the last good one")
    r4.st.emergency_open()
    r4.tick(1, meter=fail)
    check(r4.snap()["current_ma"] is None and not r4.snap()["held"], "(6) relay open: nothing held")
    r4.tick(r4.cfg.finished_seconds, meter=fail)
    check(r4.st.state == State.AWAITING_PAYMENT and r4.snap()["current_ma"] is None, "(6) new session: nothing held")

    (tmp / "t").mkdir()
    r7 = Rig(tmp / "t")
    r7.st.courtesy()
    r7.tick(60)  # courtesy expires: back to AWAITING_PAYMENT, same session
    r7.tick(5)
    r7.pay("1")
    r7.tick(300 + r7.cfg.finished_seconds)
    rec = last_session(r7)
    states = [t[0] for t in rec["transitions"]]
    check(states == ["AWAITING_PAYMENT", "COURTESY", "AWAITING_PAYMENT", "CHARGING", "FINISHED"]
          and rec["timestamps"]["AWAITING_PAYMENT"] == rec["transitions"][0][1]
          and rec["transitions"][2][1] > rec["transitions"][0][1],
          "(7) timestamps keep the first time of each state; transitions keep every step")

    exits: list[int] = []

    class FakeServer:
        should_exit = False

    server = FakeServer()
    end_process(server, grace=0.01, hard_exit=exits.append).join()
    raised: list[int] = []
    end_process(None, grace=0.01, raise_signal=raised.append, hard_exit=exits.append).join()
    check(server.should_exit and raised == [signal.SIGTERM] and exits == [3, 3],
          "(10) heartbeat crash ends the process: via run()'s server, else SIGTERM; hard exit after a grace")

    for what, over in (("MIN_CURRENT_MA=0", {"min_current_ma": 0}),
                       ("FICHA_PRICE=NaN", {"ficha_price": Decimal("NaN")}),
                       ("FICHA_PRICE=Infinity", {"ficha_price": Decimal("Infinity")}),
                       ("FICHA_PRICE=0", {"ficha_price": Decimal("0")}),
                       ("FICHA_PRICE with 8 decimals", {"ficha_price": Decimal("0.00000001")}),
                       ("HORIZON_POLL_SECONDS=0.2", {"horizon_poll_seconds": 0.2}),
                       ("testnet with the public Horizon", {"horizon_url": "https://horizon.stellar.org"}),
                       ("HOST=0.0.0.0 with MOCK_PAYMENT", {"host": "0.0.0.0"}),
                       ("HOST=192.168.0.10 with MOCK_PAYMENT", {"host": "192.168.0.10"})):
        refused(replace(r.cfg, **over), what)
    refused(on_public(r.cfg, horizon_url="https://horizon-testnet.stellar.org/"), "public with the testnet Horizon",
            "is the testnet Horizon")
    for ok_over in ({"ficha_price": Decimal("0.0000001")}, {"ficha_price": Decimal("1.50000000")},
                    {"host": "localhost"}, {"host": "::1"}, {"host": "0.0.0.0", "mock_payment": False},
                    {"horizon_url": "https://horizon.example-node.test"}):
        config.validate(replace(r.cfg, **ok_over))
    try:
        load_env(FICHA_PRICE="NaN")
        check(False, "FICHA_PRICE=NaN in .env is a ConfigError")
    except config.ConfigError:
        pass
    check(True, "(11) MIN_CURRENT_MA, FICHA_PRICE, HORIZON_POLL_SECONDS, wrong-network HORIZON_URL, "
                "HOST beyond loopback with MOCK_PAYMENT: refused")

    (tmp / "c").mkdir()
    r12 = Rig(tmp / "c")
    r12.st.courtesy()
    r12.tick(60)
    r12.st.shutdown()
    rec = last_session(r12)
    check(rec["end_reason"] == "courtesy_only" and rec["courtesy_max_ma"] >= 2500 and rec["courtesy_wh"] > 0
          and rec["max_current_ma"] == 0 and rec["wh"] == 0 and rec["verdict"] is None,
          f"(12) courtesy-only record: {rec['courtesy_max_ma']} mA, {rec['courtesy_wh']} Wh measured in courtesy")
    (tmp / "c2").mkdir()
    r12 = Rig(tmp / "c2")
    r12.st.courtesy()
    r12.tick(10)
    r12.pay("1")
    r12.tick(300 + r12.cfg.finished_seconds, meter=fail)
    rec = last_session(r12)
    check(rec["verdict"] == "unverified" and rec["courtesy_max_ma"] > 0 and rec["max_current_ma"] == 0,
          "(12) courtesy current never counts toward the paid session's verdict")

    (tmp / "m").mkdir()
    r13 = Rig(tmp / "m")
    check(r13.snap()["time_text"] == "00:00", "(13) waiting: 00:00")
    r13.st.courtesy()
    check(r13.snap()["time_text"] == "01:00", "(13) courtesy: 01:00")
    r13.pay("2")
    r13.tick(5)
    check(r13.snap()["time_text"] == "09:55" and mmss(3600) == "60:00" and mmss(0.2) == "00:01",
          "(13) charging: mm:ss with two-digit minutes (09:55)")
    html = (Path(__file__).resolve().parent / "static" / "index.html").read_text(encoding="utf-8")
    check("d.time_text" in html and '(m < 10 ? "0" : "") + m' in html, "(13) the screen shows time_text; its own mm:ss pads too")
    check("--u: min(1vw, 1.7778vh)" in html and not re.search(r"font-size:[^;]*\dvw", html),
          "(15) type is sized by the width only up to a 16:9 box of the window's height (maximized windows fit)")


def phase(r: Rig) -> str | None:
    return r.snap()["charge"]["phase"]


def until(r: Rig, cond, limit: int = 400) -> int:
    """Tick until cond() holds; the number of ticks it took."""
    for n in range(1, limit + 1):
        r.tick()
        if cond():
            return n
    check(False, f"reached within {limit} ticks")
    return limit


def test_verify(tmp: Path) -> None:
    print("charge verification: paid time counts only while THIS station charges the phone")
    d = load_env()
    check(d.charge_verify and d.meter_source == "phone" and d.mock_plug == "station"
          and (d.plug_timeout_seconds, d.pause_grace_seconds, d.pause_timeout_seconds,
               d.probe_every_seconds, d.probe_seconds) == (180, 20, 600, 300, 3),
          "defaults: CHARGE_VERIFY on, METER_SOURCE=phone, plug 180 s, grace 20 s, pause 600 s, probe 3 s every 300 s")
    finished = d.finished_seconds

    # 1. Charging through the station: verified by a probe, then time is consumed.
    (tmp / "here").mkdir()
    r = Rig(tmp / "here", charge_verify=True)
    st = r.st
    r.pay("2")
    s = r.snap()
    check(st.state == State.CHARGING and not r.relay.is_open and s["charge"]["phase"] == "waiting"
          and s["waiting_for_device"] and s["remaining_seconds"] == 600 and s["charge"]["plug_seconds_left"] == 180,
          "paid: relay closed, countdown NOT started, the screen asks for the phone on this station")
    n = until(r, lambda: phase(r) == "checking")
    check(r.relay.is_open and r.snap()["remaining_seconds"] == 600 and not r.snap()["powered"],
          f"current seen after {n} s: a probe opens the relay; nothing consumed")
    until(r, lambda: phase(r) == "running", limit=r.cfg.probe_seconds)
    s = r.snap()
    check(not r.relay.is_open and s["charge"]["verified"] and st.session.verified_at and s["remaining_seconds"] == 600
          and (st.session.probes_passed, st.session.probes_failed) == (1, 0),
          "the current stopped while the relay was open: verified, relay closed again, countdown at 10:00")
    verified_at = r.clock.t
    n = until(r, lambda: st.session.running, limit=10)
    check(n == 2 and r.snap()["remaining_seconds"] == 600 and st.session.consumed(r.clock.t) == 0,
          "the charger restarts after the probe: the countdown starts at the first charging reading (2 s later)")
    counting_at = r.clock.t
    r.tick(60)
    s = r.snap()
    check(s["remaining_seconds"] == 540 and s["charge"]["consumed_seconds"] == 60 and s["delivering"],
          "charging here: 60 s consumed, delivering")
    until(r, lambda: phase(r) == "checking", limit=r.cfg.probe_every_seconds)
    left = r.snap()["remaining_seconds"]
    check(r.clock.t - verified_at == r.cfg.probe_every_seconds and r.relay.is_open
          and left == 600 - (r.clock.t - counting_at), "a probe again after PROBE_EVERY_SECONDS (300 s)")
    r.tick(r.cfg.probe_seconds)
    until(r, lambda: st.session.running, limit=10)
    check(phase(r) == "running" and r.snap()["remaining_seconds"] == left and not r.relay.is_open,
          "the probe's 3 s with the power off, and the charger restarting after it, are not consumed")
    until(r, lambda: st.state == State.FINISHED, limit=400)
    rec = st.snapshot()["last"]
    rc = receipt_qr(r.cfg, st.snapshot())
    # Three probes (the one that verified, two while counting), each followed
    # by 2 s of the charger restarting: all of it stood still, none consumed.
    check(r.relay.is_open and r.clock.t - verified_at == 600 + rec["paused_seconds"]
          and rec["paused_seconds"] == 3 * 2 + 2 * r.cfg.probe_seconds,
          f"time up after 600 s of verified charging, {rec['paused_seconds']} s standing still (probes, restarts)")
    check(rec["end_reason"] == "time_up" and rec["verified"] and rec["verify_mode"] == "probe"
          and rec["consumed_seconds"] == 600 and rec["unused_seconds"] == 0
          and rec["probes"] == {"passed": 3, "failed": 0} and rec["verdict"] == "delivered"
          and "&u=600&" in rc["uri"] and "&vd=d&" in rc["uri"],
          "record: verified, consumed 600, probes 3/0, delivered; receipt u=600")

    # 2. Charging from another charger from the start (a socket at home).
    (tmp / "elsewhere").mkdir()
    r = Rig(tmp / "elsewhere", charge_verify=True, mock_plug="elsewhere")
    st = r.st
    r.pay("1")
    paid_at = r.clock.t
    until(r, lambda: phase(r) == "checking")
    r.tick(r.cfg.probe_seconds)
    s = r.snap()
    check(s["charge"]["phase"] == "waiting" and s["charge"]["reason"] == "elsewhere" and not r.relay.is_open
          and s["current_ma"] > 1000 and not s["delivering"] and s["remaining_seconds"] == 300,
          f"the current kept flowing with the relay open ({s['current_ma']} mA): probe failed, nothing consumed")
    r.pay("1")
    check(phase(r) == "waiting" and r.snap()["remaining_seconds"] == 600, "a top-up while waiting adds time, starts nothing")
    consumed, opened = [], []
    until(r, lambda: (consumed.append(r.snap()["charge"]["consumed_seconds"]), opened.append(r.relay.is_open),
                      st.state == State.FINISHED)[2], limit=200)
    # Current still flowing when the time to plug in is up: one last check
    # (21), which fails, and the relay stays open from it on.
    check(r.clock.t - paid_at == r.cfg.plug_timeout_seconds + r.cfg.probe_seconds and r.relay.is_open
          and opened[-r.cfg.probe_seconds - 2:] == [False] + [True] * (r.cfg.probe_seconds + 1) and set(consumed) == {0},
          "never verified: after PLUG_TIMEOUT_SECONDS (180 s) one last check fails, the relay stays open, "
          "not one second consumed")
    rec = st.snapshot()["last"]
    rc = receipt_qr(r.cfg, st.snapshot())
    check(rec["end_reason"] == "not_plugged" and not rec["verified"] and rec["verified_at"] is None
          and rec["consumed_seconds"] == 0 and rec["unused_seconds"] == 600
          and rec["refund_hint"]["unused"] == "2.0000000" and rec["probes"]["passed"] == 0
          and rec["probes"]["failed"] >= 5 and rec["max_current_ma"] == 0 and rec["wh"] == 0
          and rec["verdict"] == "no_current" and "&u=0&" in rc["uri"],
          f"not_plugged: whole paid time in refund_hint.unused, {rec['probes']['failed']} failed probes, "
          "no energy counted as this station's, receipt u=0")
    r.tick(finished)
    check(last_session(r)["end_reason"] == "not_plugged", "logged as not_plugged")

    # 3. Unplugged mid-session: paused (the grace given back), then resumed.
    (tmp / "unplug").mkdir()
    r = Rig(tmp / "unplug", charge_verify=True)
    st = r.st
    r.pay("2")
    until(r, lambda: st.session.running)
    r.tick(100)
    r.meter.plug = "none"
    r.tick()
    left = r.snap()["remaining_seconds"]
    n = until(r, lambda: phase(r) == "paused", limit=30)
    s = r.snap()
    check(n == r.cfg.pause_grace_seconds + 1 and s["charge"]["reason"] == "no_current" and s["remaining_seconds"] == left
          and left == 499 and not r.relay.is_open and not s["delivering"],
          "no current for more than PAUSE_GRACE_SECONDS: paused, the 20 s of grace given back, relay still closed")
    r.tick(120)
    s = r.snap()
    check(s["remaining_seconds"] == left and s["charge"]["pause_seconds_left"] == 600 - 141,
          "paused: the countdown stands still, PAUSE_TIMEOUT_SECONDS counts down")
    r.meter.plug = "station"
    until(r, lambda: st.session.running, limit=10)
    check(r.snap()["remaining_seconds"] == left and st.session.probes_passed == 2, "plugged back: a probe passes, resumed")
    r.tick(10)
    check(r.snap()["remaining_seconds"] == left - 10, "counting again")
    st.emergency_open()
    rec = st.snapshot()["last"]
    rc = receipt_qr(r.cfg, st.snapshot())
    check(rec["consumed_seconds"] == 111 and rec["unused_seconds"] == 489 and rec["refund_hint"]["unused"] == "1.6300000"
          and rec["paused_seconds"] >= 140 and rec["end_reason"] == "emergency_stop" and "&u=111&" in rc["uri"],
          f"ESC: consumed 111, unused 489 (1.63 XLM refund hint), paused {rec['paused_seconds']} s, receipt u=111")

    # 4a. Moved to another charger: the dip, then a probe that fails.
    (tmp / "moved").mkdir()
    r = Rig(tmp / "moved", charge_verify=True)
    st = r.st
    r.pay("3")
    until(r, lambda: phase(r) == "running")
    r.tick(100)
    r.meter.plug = "none"
    r.tick(3)
    r.meter.plug = "elsewhere"
    until(r, lambda: phase(r) == "paused", limit=10)
    paused_at = r.clock.t
    s = r.snap()
    left = s["remaining_seconds"]
    check(s["charge"]["reason"] == "elsewhere" and 900 - 110 <= left <= 900 - 100 and not r.relay.is_open
          and st.session.probes_failed == 1,
          f"unplugged and plugged into another charger: checked when the current came back, probe failed, paused ({left} s left)")
    r.tick(200)
    check(r.snap()["remaining_seconds"] == left and phase(r) in ("paused", "checking")
          and st.session.probes_failed >= 3 and st.session.probe_gap >= 120,
          f"charging elsewhere: stays paused, nothing consumed; retries back off "
          f"({st.session.probes_failed} failed, now {st.session.probe_gap:.0f} s apart)")
    # 5. ... and the pause runs out.
    until(r, lambda: st.state == State.FINISHED, limit=r.cfg.pause_timeout_seconds)
    rec = st.snapshot()["last"]
    check(600 <= r.clock.t - (paused_at - r.cfg.probe_seconds) <= 600 + r.cfg.probe_seconds
          and rec["end_reason"] == "paused_too_long" and r.relay.is_open
          and rec["consumed_seconds"] == 900 - left and rec["unused_seconds"] == left
          and rec["refund_hint"]["unused"] == format(Decimal(left) / 300, ".7f") and rec["verdict"] == "delivered",
          f"paused for PAUSE_TIMEOUT_SECONDS: ended paused_too_long, the {left} s left in refund_hint.unused")

    # 4b. Moved with no dip the meter could see: the periodic probe catches it.
    (tmp / "moved2").mkdir()
    r = Rig(tmp / "moved2", charge_verify=True)
    st = r.st
    r.pay("12")
    until(r, lambda: phase(r) == "running")
    verified_at = r.clock.t
    until(r, lambda: st.session.running, limit=10)
    counted = r.cfg.probe_every_seconds - (r.clock.t - verified_at)  # counting until the next probe
    r.tick(50)
    r.meter.plug = "elsewhere"  # the current never dips
    until(r, lambda: phase(r) == "paused", limit=300)
    check(r.clock.t - verified_at == r.cfg.probe_every_seconds + r.cfg.probe_seconds
          and r.snap()["charge"]["reason"] == "elsewhere" and r.snap()["remaining_seconds"] == 3600 - counted,
          "moved with no dip: the probe every PROBE_EVERY_SECONDS fails and pauses the countdown")
    st.shutdown()
    rec = last_session(r)
    check(r.relay.is_open and rec["end_reason"] == "shutdown" and rec["consumed_seconds"] == counted
          and rec["unused_seconds"] == 3600 - counted, "shutdown while paused: relay open, logged with the time left unused")

    # 4c. Moved during the probe that verified it, or right after it: the
    # current comes back late, from another charger. Taken for the phone
    # recovering from the probe, it counted until the next periodic probe.
    for when in ("during", "after"):
        (tmp / f"moved-{when}").mkdir()
        r = Rig(tmp / f"moved-{when}", charge_verify=True)
        st = r.st
        r.pay("3")
        until(r, lambda: phase(r) == "checking")
        if when == "during":
            r.tick()
            r.meter.plug = "none"
        until(r, lambda: phase(r) == "running", limit=r.cfg.probe_seconds)
        r.meter.plug = "none"
        r.tick(8)
        r.meter.plug = "elsewhere"
        r.tick(240)
        s = st.session
        check(s.verified and s.consumed(r.clock.t) == 0 and s.probes_passed == 1 and s.probes_failed >= 1
              and phase(r) in ("paused", "checking") and s.reason == "elsewhere" and s.max_ma == 0,
              f"unplugged {when} the verifying probe, on another charger 8 s later: checked again when the "
              f"current came back, paused, 240 s later nothing consumed ({s.probes_failed} failed probes)")
        until(r, lambda: st.state == State.FINISHED, limit=r.cfg.pause_timeout_seconds)
        rec = st.snapshot()["last"]
        rc = receipt_qr(r.cfg, st.snapshot())
        check(rec["end_reason"] == "paused_too_long" and rec["consumed_seconds"] == 0 and rec["unused_seconds"] == 900
              and rec["verdict"] == "no_current" and rec["max_current_ma"] == 0
              and "&u=0&" in rc["uri"] and "&vd=n&" in rc["uri"],
              "... ended paused_too_long, all 900 s unused, the other charger's current not on the receipt (u=0, vd=n)")

    # 6. Courtesy is free: no probes, the relay never opens.
    (tmp / "courtesy").mkdir()
    r = Rig(tmp / "courtesy", charge_verify=True, mock_plug="elsewhere")
    check(r.st.courtesy(), "courtesy with verification on")
    opened = []
    for _ in range(r.cfg.courtesy_seconds - 1):
        r.tick()
        opened.append(r.relay.is_open)
    check(not any(opened) and r.snap()["charge"]["phase"] is None and r.st.state == State.COURTESY,
          "courtesy: no probe ever opens the relay, whatever the phone charges from")
    r.meter.plug = "station"
    r.pay("1")
    check(phase(r) == "waiting" and not r.relay.is_open, "paid during courtesy: waits for verification like any payment")
    until(r, lambda: phase(r) == "running", limit=10)
    check(True, "courtesy then payment: verified by a probe")

    # 7. usb_vbus: the probe passes when the phone vanishes with the cut VBUS.
    (tmp / "usb").mkdir()
    r = Rig(tmp / "usb", charge_verify=True, topology="usb_vbus", adb_transport="usb", mock_profile="usb")
    st = r.st
    r.pay("1")
    until(r, lambda: phase(r) == "checking")
    r.tick(r.cfg.probe_seconds)
    check(phase(r) == "running" and st.session.verified and st.session.probes_passed == 1,
          "usb_vbus: the phone vanished while the relay was open: probe passed")
    n = until(r, lambda: st.session.running, limit=10)
    check(n == 4 and r.snap()["remaining_seconds"] == 300 and phase(r) == "running",
          f"the phone enumerating again after the probe ({n} s) is the probe's: not consumed, no pause")
    r.tick(60)
    check(phase(r) == "running" and r.snap()["remaining_seconds"] == 240 and r.snap()["current_ma"] >= 450,
          "counting: 60 s consumed")
    r.meter.plug = "none"
    r.tick(2)
    check(phase(r) == "running" and r.snap()["held"] and r.snap()["current_ma"] >= 450,
          "usb_vbus unplugged, within the grace: the last reading is held")
    until(r, lambda: phase(r) == "paused", limit=30)
    check(r.snap()["charge"]["reason"] == "no_phone" and r.snap()["remaining_seconds"] == 239,
          "usb_vbus unplugged: the phone vanishes, paused (no_phone)")
    check(not r.snap()["held"] and r.snap()["current_ma"] is None,
          "paused, phone not readable: no stale reading held for the whole pause")
    st.emergency_open()

    # 8. CHARGE_VERIFY=false keeps the old behaviour (bench tests only).
    (tmp / "off").mkdir()
    r = Rig(tmp / "off", charge_verify=False, mock_plug="elsewhere")
    r.pay("1")
    check(phase(r) is None and not r.snap()["waiting_for_device"] and r.snap()["remaining_seconds"] == 300,
          "CHARGE_VERIFY=false: counting from the payment")
    opened = []
    for _ in range(300):
        r.tick()
        opened.append(r.relay.is_open)
    rec = r.st.snapshot()["last"]
    check(opened.count(True) == 1 and r.st.state == State.FINISHED and rec["verify_mode"] == "off"
          and not rec["verified"] and rec["consumed_seconds"] == 300 and rec["probes"] == {"passed": 0, "failed": 0},
          "CHARGE_VERIFY=false: no probes, all 300 s consumed even charging elsewhere (the old behaviour)")
    public = on_public(r.cfg, charge_verify=False)
    config.validate(replace(public, charge_verify=True))
    try:
        config.validate(public)
        check(False, "CHARGE_VERIFY=false refused on the public network")
    except config.ConfigError as exc:
        check("CHARGE_VERIFY=false" in str(exc), "CHARGE_VERIFY=false refused on the public network")

    # 9. METER_SOURCE=outlet: the meter sees only this station's current, no probes.
    (tmp / "outlet").mkdir()
    r = Rig(tmp / "outlet", charge_verify=True, meter_source="outlet")
    st = r.st
    r.pay("1")
    opened = []
    for _ in range(3):
        r.tick()
        opened.append(r.relay.is_open)
    check(phase(r) == "running" and not any(opened) and st.session.verified and st.session.probes_passed == 0,
          "outlet meter: current seen = this station's, verified without a probe")
    r.meter.plug = "elsewhere"
    until(r, lambda: phase(r) == "paused", limit=30)
    r.meter.plug = "station"
    until(r, lambda: phase(r) == "running", limit=5)
    check(not r.relay.is_open and st.session.probes_failed == 0, "outlet meter: moved elsewhere reads 0 mA, paused; back, resumed")
    st.emergency_open()
    check(st.snapshot()["last"]["verify_mode"] == "outlet", "record says verify_mode outlet")
    (tmp / "outlet2").mkdir()
    r = Rig(tmp / "outlet2", charge_verify=True, meter_source="outlet", mock_plug="elsewhere")
    r.pay("1")
    r.tick(r.cfg.plug_timeout_seconds)
    check(r.st.state == State.FINISHED and r.st.snapshot()["last"]["end_reason"] == "not_plugged",
          "outlet meter, phone charging elsewhere: never verified, not_plugged")

    # 10. MAX_SESSION_MINUTES caps consumed time, not the clock on the wall.
    (tmp / "cap").mkdir()
    r = Rig(tmp / "cap", charge_verify=True, max_session_minutes=10)
    st = r.st
    r.pay("3")
    check(st.session.capped_seconds == 300 and r.snap()["remaining_seconds"] == 600, "15 min paid, 10 min cap: 5 capped")
    until(r, lambda: phase(r) == "running")
    verified_at = r.clock.t
    r.tick(100)
    r.meter.plug = "none"
    r.tick(80)
    r.meter.plug = "station"
    until(r, lambda: st.state == State.FINISHED, limit=700)
    rec = st.snapshot()["last"]
    check(rec["end_reason"] == "max_session" and rec["consumed_seconds"] == 600 and rec["capped_seconds"] == 300
          and rec["unused_seconds"] == 0 and rec["refund_hint"]["capped"] == "1.0000000"
          and r.clock.t - verified_at >= 680,
          f"max_session after 600 s consumed, {r.clock.t - verified_at:.0f} s on the wall")

    # 11. ESC, crash: the relay opens as always.
    (tmp / "esc").mkdir()
    r = Rig(tmp / "esc", charge_verify=True)
    st = r.st
    r.pay("1")
    r.tick()
    st.emergency_open()
    r.tick(finished)
    rec = last_session(r)
    check(rec["end_reason"] == "emergency_stop" and rec["consumed_seconds"] == 0 and rec["unused_seconds"] == 300
          and rec["refund_hint"]["unused"] == "1.0000000", "ESC while waiting: all paid time unused")
    r.pay("1")
    until(r, lambda: phase(r) == "checking")
    st.emergency_open()
    closed = []
    for _ in range(finished):
        r.tick()
        closed.append(not r.relay.is_open)
    check(not any(closed) and last_session(r)["end_reason"] == "emergency_stop",
          "ESC during a probe: the relay stays open (the probe does not close it again)")
    r.pay("2")
    until(r, lambda: phase(r) == "running")
    r.tick(5)
    sid = st.session.id
    Station(r.cfg, MockRelay(), SessionLog(r.cfg.session_log), clock=r.clock)
    rec = last_session(r)
    check(rec["id"] == sid and rec["end_reason"] == "interrupted" and rec["verified"] is True
          and rec["verify_mode"] == "probe" and rec["verdict"] == "delivered" and rec["consumed_seconds"] is None,
          "killed after verification: the restart logs it verified (verify_mode probe), delivered, consumed unknown")

    # 13. The heartbeat ticks a few ms early: a 3 s probe stays 3 ticks.
    (tmp / "jitter").mkdir()
    r = Rig(tmp / "jitter", charge_verify=True)
    r.pay("1")
    open_ticks = 0
    for _ in range(20):
        r.clock.t += 0.997
        r.st.tick(r.meter.read())
        open_ticks += r.relay.is_open
        if phase(r) == "running":
            break
    check(phase(r) == "running" and open_ticks == r.cfg.probe_seconds,
          f"ticks 3 ms early: the probe keeps the relay open {open_ticks} ticks, not 4")

    # 12. Settings that cannot work are refused.
    base = r.cfg
    for what, over in (("PROBE_SECONDS=0", {"probe_seconds": 0}), ("PROBE_SECONDS=31", {"probe_seconds": 31}),
                       # Its one reading would be the first, which may predate the opening (16).
                       ("PROBE_SECONDS=1", {"probe_seconds": 1}),
                       ("PROBE_EVERY_SECONDS=20 with PROBE_SECONDS=3", {"probe_every_seconds": 20}),
                       ("PLUG_TIMEOUT_SECONDS=3", {"plug_timeout_seconds": 3}),
                       ("PAUSE_GRACE_SECONDS=2", {"pause_grace_seconds": 2}),
                       ("PAUSE_TIMEOUT_SECONDS=3", {"pause_timeout_seconds": 3}),
                       ("METER_SOURCE=outlet with MOCK=false", {"meter_source": "outlet", "mock": False,
                                                                 "adb_serial": "10.0.0.2:5555"}),
                       # Read over WiFi the phone never vanishes: a failed read passed a probe,
                       # and the cut was never confirmed.
                       ("TOPOLOGY=usb_vbus with ADB_TRANSPORT=tcp", {"topology": "usb_vbus", "adb_transport": "tcp",
                                                                     "mock": False, "adb_serial": "10.0.0.2:5555"})):
        refused(replace(base, **over), what)
    for ok_over in ({"probe_seconds": 2}, {"topology": "usb_vbus", "adb_transport": "usb", "mock": False},
                    {"topology": "mains", "adb_transport": "tcp", "mock": False, "adb_serial": "10.0.0.2:5555"}):
        config.validate(replace(base, **ok_over))
    for env in ({"METER_SOURCE": "usb"}, {"MOCK_PLUG": "wall"}, {"CHARGE_VERIFY": "maybe"}):
        try:
            load_env(**env)
            check(False, f"{env} refused")
        except config.ConfigError:
            pass
    check(load_env(CHARGE_VERIFY="false").charge_verify is False and load_env(MOCK_PLUG="none").mock_plug == "none",
          "CHARGE_VERIFY and MOCK_PLUG read from .env")
    check(True, "PROBE_SECONDS (1 too), PROBE_EVERY_SECONDS, PLUG_TIMEOUT_SECONDS, PAUSE_GRACE_SECONDS, "
                "PAUSE_TIMEOUT_SECONDS out of range, METER_SOURCE=outlet without its meter, usb_vbus read "
                "over WiFi: refused")

    # 14. A phone slow to charge again after a probe (12 s, under the grace):
    # the wait is the probe's. It could also be a phone moved to another
    # charger meanwhile (4c), so one more probe confirms it, and that one's
    # own wait is not checked again: no probe loop.
    (tmp / "slow").mkdir()
    r = Rig(tmp / "slow", charge_verify=True)
    st = r.st
    closed_at: list[float] = []

    def slow():  # mains: the charger restarts 12 s after the relay closes
        if r.relay.is_open:
            closed_at.clear()
            return (-250, 4000, True)
        if not closed_at:
            closed_at.append(r.clock.t)
        return (2500, 4100, True) if r.clock.t - closed_at[0] >= 12 else (-250, 4000, True)

    r.pay("2")
    idle = 0.0
    for _ in range(2000):
        before = st.session.consumed(r.clock.t)
        r.tick(meter=slow)
        if st.state != State.CHARGING:
            break
        if st.reading[0] < r.cfg.min_current_ma:
            idle += st.session.consumed(r.clock.t) - before
    rec = st.snapshot()["last"]
    check(rec["end_reason"] == "time_up" and rec["consumed_seconds"] == 600 and idle == 0
          and rec["probes"] == {"passed": 6, "failed": 0},
          "phone 12 s slow to charge again after each probe: not one second consumed without current, "
          "each of the 3 probes confirmed once (6 for 600 s), no probe loop")

    # 15. ... slower than PAUSE_GRACE_SECONDS: paused from the probe's end, and
    # passing probes do not restart PAUSE_TIMEOUT_SECONDS.
    (tmp / "slower").mkdir()
    r = Rig(tmp / "slower", charge_verify=True, topology="usb_vbus", adb_transport="usb", mock_profile="usb")
    st = r.st
    r.meter.ENUMERATION_SECONDS = 25.0
    r.pay("2")
    until(r, lambda: phase(r) == "running", limit=60)
    verified_at = r.clock.t
    until(r, lambda: phase(r) == "paused", limit=30)
    check(r.clock.t - verified_at == r.cfg.pause_grace_seconds + 1 and st.session.consumed(r.clock.t) == 0
          and st.session.stopped_since == verified_at,
          "phone not back within PAUSE_GRACE_SECONDS after a passing probe: paused from the probe's end, nothing consumed")
    # Checked while paused: at most a grace and a probe late (a last check
    # at the end of the pause, 21, passes, and the phone is not back within
    # the grace after it either).
    late = r.cfg.pause_grace_seconds + r.cfg.probe_seconds + 2
    until(r, lambda: st.state == State.FINISHED, limit=r.cfg.pause_timeout_seconds + late)
    rec = st.snapshot()["last"]
    check(rec["end_reason"] == "paused_too_long" and rec["probes"]["passed"] > 1
          and 0 <= r.clock.t - verified_at - r.cfg.pause_timeout_seconds <= late
          and rec["consumed_seconds"] == 0 and rec["unused_seconds"] == 600,
          f"it never charges long enough to count: paused_too_long {r.clock.t - verified_at:.0f} s after the first "
          f"verification despite {rec['probes']['passed']} passing probes, all 600 s unused")

    # 16. The probe is judged on every reading with the relay open, and the
    # current must fall clearly: one low reading proves nothing.
    for seed in range(3):
        (tmp / f"hover{seed}").mkdir()
        r = Rig(tmp / f"hover{seed}", charge_verify=True)
        rng = random.Random(seed)
        r.pay("2")  # a nearly full phone on another charger, around MIN_CURRENT_MA
        for _ in range(r.cfg.plug_timeout_seconds + r.cfg.probe_seconds):
            r.tick(meter=lambda: (rng.randint(60, 160), 4200, True))
            if r.st.state != State.CHARGING:
                break
        s = r.st.session
        check(s.end_reason == "not_plugged" and s.consumed_seconds == 0 and s.probes_passed == 0,
              f"phone on another charger at 60-160 mA (seed {seed}): no probe passes in "
              f"{s.probes_failed} tries, nothing consumed")
    (tmp / "weak").mkdir()
    r = Rig(tmp / "weak", charge_verify=True)
    rng = random.Random(1)
    r.pay("1")  # a nearly full phone on THIS station: 110-130 mA, discharging when cut
    r.tick(10, meter=lambda: (rng.randint(-120, -40), 4200, True) if r.relay.is_open
           else (rng.randint(110, 130), 4200, True))
    check(r.st.session.running and r.st.session.probes_passed == 1,
          "a weak phone on this station still passes (it discharges when cut)")
    (tmp / "stale").mkdir()
    r = Rig(tmp / "stale", charge_verify=True)
    opened: list[bool] = []

    def stale():  # the first reading with the relay open predates the opening
        opened.append(r.relay.is_open)
        return (2500, 4100, True) if opened[-2:] != [True, True] else (-200, 4000, True)

    r.pay("1")
    r.tick(10, meter=stale)
    check(r.st.session.running and (r.st.session.probes_passed, r.st.session.probes_failed) == (1, 0),
          "the first reading with the relay open is not judged (the meter reads on its own thread)")

    # 17. Dips: one low reading is noise, and probes that PROBE_EVERY_SECONDS
    # did not schedule stay PROBE_RETRY_SECONDS apart, in every phase.
    (tmp / "spiky").mkdir()
    r = Rig(tmp / "spiky", charge_verify=True, mock_plug="elsewhere")
    n = [0]

    def spiky():  # on another charger at 2 A, one low reading every 6 s
        n[0] += 1
        return (40, 4200, True) if n[0] % 6 == 0 else (2000, 4200, True)

    r.pay("2")
    starts = []
    for _ in range(170):
        was = phase(r)
        r.tick(meter=spiky)
        if phase(r) == "checking" and was != "checking":
            starts.append(r.clock.t)
    gaps = [b - a for a, b in zip(starts, starts[1:])]
    check(len(starts) <= 6 and min(gaps) >= 30, f"waiting, one low reading every 6 s: {len(starts)} probes, "
          f"at least {min(gaps):.0f} s apart (not one per dip)")
    (tmp / "noisy").mkdir()
    r = Rig(tmp / "noisy", charge_verify=True)
    n[0] = 0

    def noisy():  # on this station at 2.5 A, one low reading every 6 s
        n[0] += 1
        if r.relay.is_open:
            return (-200, 4000, True)
        return (40, 4100, True) if n[0] % 6 == 0 else (2500, 4100, True)

    r.pay("12")
    r.tick(r.cfg.probe_every_seconds - 10, meter=noisy)
    check(r.st.session.running and (r.st.session.probes_passed, r.st.session.probes_failed) == (1, 0),
          "counting, one low reading every 6 s: no probe but the one that verified")

    # 17b. A weak cable on this station (seen on the bench): the net battery
    # current hovers around MIN_CURRENT_MA, with dips of several seconds.
    # Probes back off instead of clicking the relay every half minute.
    (tmp / "weakcable").mkdir()
    r = Rig(tmp / "weakcable", charge_verify=True)
    n[0] = 0

    def weak():  # 400 mA for 25 s, then 6 s at 0 mA, on this station
        n[0] += 1
        if r.relay.is_open:
            return (-500, 3700, True)
        return (0, 3750, True) if n[0] % 31 >= 25 else (400, 3800, True)

    r.pay("12")
    starts, confirms = [], 0
    for _ in range(1200):
        was = phase(r)
        r.tick(meter=weak)
        if phase(r) == "checking" and was != "checking":
            # A probe that ends in a dip is confirmed once by another (4c).
            if r.st.session.confirming:
                confirms += 1
            else:
                starts.append(r.clock.t)
    gaps = [b - a for a, b in zip(starts, starts[1:])]
    check(len(starts) + confirms <= 10 and confirms <= len(starts) and gaps[-1] >= r.cfg.probe_every_seconds - 1,
          f"weak cable for 20 min: {len(starts) + confirms} probes (was one every ~35 s), {confirms} of them "
          f"confirming one that ended in a dip, the last ones {gaps[-1]:.0f} s apart")
    check(r.st.session.running and r.st.session.probes_failed == 0,
          "weak cable: every probe passes and the countdown keeps running")

    # 18. With an outlet meter the cut is a drop on usb_vbus too: the meter
    # stays readable after the relay opens.
    (tmp / "outletusb").mkdir()
    r = Rig(tmp / "outletusb", charge_verify=True, meter_source="outlet", topology="usb_vbus",
            adb_transport="usb", mock_profile="usb")
    r.pay("1")
    until(r, lambda: r.st.state == State.FINISHED, limit=400)
    r.tick(2)
    cut = r.st.session.cut or {}
    check(cut.get("confirmed") is True and cut.get("method") == "current_drop" and cut.get("to_ma") == 0,
          "outlet meter on usb_vbus: the cut is confirmed by the current dropping to 0 mA")

    # 19. The phone moved here after a failed probe, while waiting or paused:
    # its current is back before the next probe may run. The screen counts
    # down to that probe instead of asking for a phone already plugged in.
    for want in ("waiting", "paused"):
        (tmp / f"pending-{want}").mkdir()
        r = Rig(tmp / f"pending-{want}", charge_verify=True, mock_plug="elsewhere" if want == "waiting" else "station")
        st = r.st
        r.pay("2")
        if want == "paused":
            until(r, lambda: st.session.running)
            r.tick(30)
            r.meter.plug = "none"
            r.tick(3)
            r.meter.plug = "elsewhere"
        until(r, lambda: st.session.reason == "elsewhere", limit=40)
        c = r.snap()["charge"]
        check(c["phase"] == want and c["check_seconds_left"] == 30,
              f"{want}, probe failed on another charger: checked again in 30 s")
        r.meter.plug = "none"
        r.tick(4)
        left = r.snap()["remaining_seconds"]
        check(r.snap()["charge"]["reason"] == (None if want == "waiting" else "no_current"),
              f"{want}, unplugged: no current, nothing to check")
        r.meter.plug = "station"
        shown: list[dict] = []
        until(r, lambda: (shown.append(r.snap()), phase(r) == "checking")[1], limit=30)
        pend = [x for x in shown if x["charge"]["reason"] == "check_pending" and x["charge"]["phase"] == want]
        secs = [x["charge"]["check_seconds_left"] for x in pend]
        check(len(pend) >= len(shown) - 3 and secs == list(range(secs[0], 0, -1))
              and all(x["current_ma"] >= r.cfg.min_current_ma for x in pend)
              and all(x["remaining_seconds"] == left for x in shown),
              f"{want}, plugged in here: 'current detected, checking in {secs[0]}..1 s' while the current "
              "flows, not 'plug your phone in' (nothing consumed)")
        until(r, lambda: st.session.running, limit=10)
        check(st.session.reason is None and st.session.probes_passed == (1 if want == "waiting" else 2),
              f"{want}: the probe passes, counting")

    # 20. The heartbeat ticks a few ms early or late, and the countdown starts
    # and pauses on a tick: every second shows once on screen, none twice
    # (then one skipped).
    (tmp / "jitter2").mkdir()
    r = Rig(tmp / "jitter2", charge_verify=True)
    st = r.st
    rng = random.Random(5)
    grid = r.clock.t
    r.pay("2")
    seen: dict[str, list[tuple[int, int]]] = {"time": [], "pause": []}
    for k in range(1, 240):
        r.clock.t = grid + k + rng.uniform(-0.015, 0.015)
        if k == 120:
            r.meter.plug = "none"
        r.st.tick(r.meter.read())
        s = r.snap()
        if st.session.running:
            m, sec = s["time_text"].split(":")
            seen["time"].append((k, int(m) * 60 + int(sec)))
        if s["charge"]["pause_seconds_left"] is not None and phase(r) == "paused":
            seen["pause"].append((k, s["charge"]["pause_seconds_left"]))
    steps = {what: {b[1] - a[1] for a, b in zip(v, v[1:]) if b[0] == a[0] + 1} for what, v in seen.items()}
    check(len(seen["time"]) > 90 and len(seen["pause"]) > 90 and steps == {"time": {-1}, "pause": {-1}},
          f"ticks up to 15 ms early or late: the countdown ({len(seen['time'])} s) and the pause countdown "
          f"({len(seen['pause'])} s) each step down one second a tick, never repeat or skip one")

    # 21. The phone moved here after the last probe that fits in the time to
    # plug in (or in the pause), with the next one due after it: this station
    # charges the phone when that time is up. One last check decides, instead
    # of ending the session with all of its time logged for refund.
    for want in ("waiting", "paused"):
        (tmp / f"last-{want}").mkdir()
        r = Rig(tmp / f"last-{want}", charge_verify=True, mock_plug="elsewhere" if want == "waiting" else "station")
        st = r.st
        r.pay("2")
        if want == "paused":
            until(r, lambda: st.session.running)
            r.tick(30)
            r.meter.plug = "none"
            r.tick(3)
            r.meter.plug = "elsewhere"
        s = st.session
        key = "plug_seconds_left" if want == "waiting" else "pause_seconds_left"

        def end() -> float:  # when the time to plug in, or the pause, runs out
            if want == "waiting":
                return s.power_on_at + r.cfg.plug_timeout_seconds
            return s.stopped_since + r.cfg.pause_timeout_seconds

        until(r, lambda: phase(r) == want and s.reason == "elsewhere" and s.next_probe_at > end(), limit=700)
        moved = end() - r.clock.t
        left = r.snap()["remaining_seconds"]
        r.meter.plug = "none"
        r.tick(4)
        r.meter.plug = "station"
        shown: list[dict] = []
        until(r, lambda: (shown.append(r.snap()), phase(r) == "checking")[1], limit=300)
        pend = [x["charge"] for x in shown if x["charge"]["reason"] == "check_pending" and x["charge"]["phase"] == want]
        secs = [c["check_seconds_left"] for c in pend]
        check(r.clock.t == end() and len(pend) >= len(shown) - 3 and secs == list(range(secs[0], 0, -1))
              and all(c["check_seconds_left"] == c[key] for c in pend)
              and all(x["remaining_seconds"] == left for x in shown),
              f"{want}: on another charger at the last probe {moved:.0f} s before the end (the next one due after "
              f"it), then moved here: 'checking in {secs[0]}..1 s' counts down to the end, where one last check runs")
        until(r, lambda: st.session.running, limit=10)
        check(st.state == State.CHARGING and s.verified and s.reason is None and not r.relay.is_open,
              f"{want}: the last check passes, the session goes on (was: ended "
              f"{'not_plugged' if want == 'waiting' else 'paused_too_long'} while this station charged the phone)")
        r.tick(10)
        check(r.snap()["remaining_seconds"] == left - 10, f"{want}: counting from this station")
        st.emergency_open()

    html = (Path(__file__).resolve().parent / "static" / "index.html").read_text(encoding="utf-8")
    check(all(t in html for t in ('"check_pending"', "ch.check_seconds_left", "Current detected: checking ")),
          "the screen says current detected, checking in N s, while a check is pending")
    check(all(t in html for t in ("Plug your phone into this station", "Checking the charge", "Paused",
                                  "d.charge", "consumed_seconds", "not_plugged", "paused_too_long")),
          "the screen shows waiting for the phone, checking, paused, and why a session ended unused")
    check(all(t in html for t in ("last.unused_seconds", "last.capped_seconds", "logged for refund",
                                  'emergency_stop: "Stopped by the operator" + (refund')),
          "the screen says the paid time left is logged for refund, also after ESC")
    check(all(t in html for t in ('"the time left (" + mmss(unused)',
                                  '"the time paid beyond the session limit (" + mmss(capped)'))
          and "mmss(left)" not in html,
          "... the time left as on the countdown, the time beyond the session limit named apart (not summed as 'time left')")


# -- custody mode (docs/station-app-contract.md, section 7) ----------------------------
ESCROW = "CBRNN2W726PIWP7DLLCAOW663I2TBSMR6N7J7S4CGGUIWIXK4HYI6KYC"
XLM_SAC = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC"
VECTORS = json.loads((Path(__file__).resolve().parent / "contracts" / "escrow" / "test-vectors.json")
                     .read_text(encoding="utf-8"))
CUSTODY = {"payment_mode": "custody", "station_id": "ERZGCG", "escrow_contract": ESCROW, "charge_verify": True,
           "finished_seconds": 60, "app_url": "https://ficha.test"}


def custody_rig(tmp: Path, **overrides) -> Rig:
    tmp.mkdir(parents=True, exist_ok=True)
    return Rig(tmp, **{**CUSTODY, "cursor_dir": tmp, **overrides})


def deposit(r: Rig, fichas: int, st: Station | None = None, **kw) -> escrow.Deposit:
    """The deposit event a payment from the app brings: to the session on
    screen with its own anchor, unless told otherwise."""
    st = st or r.st
    d = st.mock_deposit(fichas, **{"payer": "GPAYER", **kw})
    st.on_escrow(d)
    return d


def query(uri: str) -> dict:
    return {k: v[0] for k, v in parse_qs(urlsplit(uri).query).items()}


def kinds(r: Rig, sid: str) -> list[str]:
    return [x["kind"] for x in r.records() if sid in (x.get("id"), x.get("session"))]


def seed_of(r: Rig, sid: str) -> bytes:
    return escrow.from_b64url(next(x["seed"] for x in r.records() if x["kind"] == "seed" and x["session"] == sid))


def test_custody_basics(tmp: Path) -> None:
    print("custody: settings, the contract's shared vectors, the registry")
    env = {"PAYMENT_MODE": "custody", "STATION_ID": "ERZGCG", "ESCROW_CONTRACT": ESCROW, "HOST_PUBLIC_KEY": HOST}
    c = load_env(**env)
    check(c.custody and c.finished_seconds == 60 and c.rpc_url == "https://soroban-testnet.stellar.org"
          and (c.refund_unit_seconds, c.escrow_grace_seconds, c.max_fichas, c.chain_len) == (30, 1680, 12, 120),
          "custody defaults: FINISHED_SECONDS 60, the testnet RPC, unit 30 s, grace 1680 s; N = 12 x 300 / 30 = 120")
    check(load_env().payment_mode == "direct" and load_env(FINISHED_SECONDS="8", **env).finished_seconds == 8
          and load_env(PAYMENT_MODE="CUSTODY", **{k: v for k, v in env.items() if k != "PAYMENT_MODE"}).custody,
          "direct is the default; an explicit FINISHED_SECONDS still wins; PAYMENT_MODE read in any case")
    base = custody_rig(tmp / "cfg").cfg
    name = base.escrow_cursor_file.name
    check(re.fullmatch(r"\.escrow_cursor\.testnet\.ERZGCG\.[0-9a-f]{16}", name) is not None
          and base.escrow_cursor_file.parent == tmp / "cfg"
          and replace(base, escrow_contract=XLM_SAC).escrow_cursor_file.name != name
          and replace(base, host_public_key=Keypair.random().public_key).escrow_cursor_file.name != name,
          f"the escrow cursor file is named per network, contract, host and station ({len(name)} characters: "
          "the contract and host as a digest, for the Windows path limit), in CURSOR_DIR")
    refused(on_public(base, station_id=base.station_id), "custody on the public network", "testnet only")
    for what, over in (("custody without STATION_ID", {"station_id": ""}),
                       ("custody without HOST_PUBLIC_KEY", {"host_public_key": ""}),
                       ("custody without ESCROW_CONTRACT", {"escrow_contract": ""}),
                       ("ESCROW_CONTRACT that is an account (G...)", {"escrow_contract": HOST}),
                       ("custody with CHARGE_VERIFY=false", {"charge_verify": False}),
                       ("REFUND_UNIT_SECONDS=7 (does not divide 300)", {"refund_unit_seconds": 7}),
                       ("REFUND_UNIT_SECONDS=0", {"refund_unit_seconds": 0}),
                       ("REFUND_UNIT_SECONDS=1 (3600 units, more than 256)", {"refund_unit_seconds": 1}),
                       ("ESCROW_GRACE_SECONDS=299", {"escrow_grace_seconds": 299}),
                       ("ESCROW_GRACE_SECONDS=90000", {"escrow_grace_seconds": 90000}),
                       ("ESCROW_GRACE_SECONDS=1000 (< 900 to claim + 180 to plug in)", {"escrow_grace_seconds": 1000}),
                       ("a session of 25 h", {"max_session_minutes": 1500, "refund_unit_seconds": 300}),
                       ("RPC_URL over http to another host", {"rpc_url": "http://rpc.example"}),
                       ("RPC_URL with a query", {"rpc_url": "https://rpc.example/?x=1"}),
                       ("PAYMENT_MODE=escrow", {"payment_mode": "escrow"}),
                       ("a price the contract cannot multiply", {"ficha_price": Decimal("1e30")})):
        refused(replace(base, **over), what)
    for ok_over in ({"payment_mode": "direct", "escrow_contract": "", "refund_unit_seconds": 7},
                    {"rpc_url": "http://127.0.0.1:8001"}, {"escrow_grace_seconds": 1080},
                    {"ficha_minutes": 1, "max_session_minutes": 5, "refund_unit_seconds": 15}):
        config.validate(replace(base, **ok_over))
    check(True, "custody refused: public, no STATION_ID/host/contract, CHARGE_VERIFY=false, a unit, grace, session "
                "or price outside the contract's bounds, a bad RPC_URL; direct ignores the custody settings")
    secret = Keypair.random().secret
    try:
        load_env(**dict(env, ESCROW_CONTRACT=secret))
        check(False, "ESCROW_CONTRACT holding a secret refused")
    except config.ConfigError as exc:
        check(secret not in str(exc) and "SECRET" in str(exc), "ESCROW_CONTRACT holding a secret refused without echoing it")

    # The contract's shared vectors: the station's chain, units, shares,
    # deadline, pay link and receipt are the contract's and the app's.
    for ch in VECTORS["chains"]:
        seed, n, anchor = bytes.fromhex(ch["seed_hex"]), ch["n"], bytes.fromhex(ch["anchor_hex"])
        check(escrow.anchor_of(seed, n) == anchor and escrow.b64url(seed) == ch["seed_b64url"]
              and escrow.b64url(anchor) == ch["anchor_b64url"]
              and all(escrow.proof(seed, n, p["u"]).hex() == p["proof_hex"]
                      and escrow.b64url(escrow.proof(seed, n, p["u"])) == p["proof_b64url"]
                      and escrow.hash_times(escrow.from_b64url(p["proof_b64url"]), p["u"]) == anchor
                      for p in ch["proofs"])
              and [escrow.hash_times(seed, i).hex() for i in range(n + 1)][:len(ch.get("chain_hex", []))]
              == ch.get("chain_hex", []),
              f"shared vector, chain of {n}: anchor c[N], every proof c[N-U] hashes U times to it, base64url")
    good = VECTORS["chains"][0]["anchor_b64url"]
    bad = (good[:-1], good + "A", good + "=", good[:-1] + "+", good[:-1] + "t", 7)
    rejected = 0
    for text in bad:
        try:
            escrow.from_b64url(text)
        except ValueError:
            rejected += 1
    check(rejected == len(bad) and escrow.from_b64url(good) == bytes.fromhex(VECTORS["chains"][0]["anchor_hex"]),
          "base64url: exactly 43 characters to 32 bytes; 42, 44, padding, +, a non-canonical last character refused")
    check(all(escrow.unused_units(v["paid_seconds"], v["consumed_seconds"], v["unit_seconds"]) == v["u"]
              and v["paid_seconds"] // v["unit_seconds"] == v["paid_units"] for v in VECTORS["unused_units"]),
          f"shared vector: U = min(paid units, ceil((paid - consumed) / unit)), {len(VECTORS['unused_units'])} cases")
    check(all(escrow.payer_share(int(v["amount"]), v["u"], v["paid_units"]) == int(v["to_payer"])
              and int(v["amount"]) - int(v["to_payer"]) == int(v["to_host"]) for v in VECTORS["payer_share"]),
          f"shared vector: the payer's share ceil(amount x U' / paid), {len(VECTORS['payer_share'])} cases")
    check(all(escrow.deadline(v["opened"], v["total_fichas"], v["ficha_seconds"], v["grace_seconds"]) == v["deadline"]
              for v in VECTORS["deadline"]), "shared vector: deadline = opened + fichas x ficha_secs + grace")
    pl = VECTORS["pay_link"]
    link_cfg = replace(base, app_url=pl["app_url"], host_public_key=pl["host"], station_id=pl["station"])
    anchor = escrow.from_b64url(pl["anchor_b64url"])
    check(escrow.pay_link(link_cfg, f"{pl['station']}.{pl['session']}", anchor) == pl["link"]
          and escrow.pay_link(replace(link_cfg, app_url=""), pl["session"], anchor) == pl["link_without_app_url"],
          "shared vector: the pay link <APP_URL>/p?v=1&n&h&s&x&a (ficha:/p?... without APP_URL)")
    rv = VECTORS["receipt_v2"]["params"]
    seed0 = bytes.fromhex(VECTORS["chains"][0]["seed_hex"])
    u = escrow.unused_units(int(rv["p"]), int(rv["u"]), 30)
    record = {"id": rv["m"], "network": "testnet", "host_key": rv["h"], "amount": "2", "asset": rv["k"], "fichas": 2,
              "paid_seconds": 600, "consumed_seconds": 400, "wh": 1.234, "max_current_ma": 1500,
              "verdict": "delivered", "cut_confirmation": {"confirmed": True},
              "timestamps": {"FINISHED": datetime.fromtimestamp(int(rv["t"]), timezone.utc).isoformat()},
              "custody": escrow.custody_block(escrow=ESCROW, session=rv["m"], anchor=escrow.anchor_of(seed0, 120),
                                              chain_len=120, unit_seconds=30, ficha_seconds=300, total_fichas=2,
                                              total_amount=20000000, deadline=None, payer=None, unused=u,
                                              proof_value=escrow.proof(seed0, 120, u))}
    check(receipt_payload(replace(base, app_url="https://ficha-stellar.vercel.app"), record)
          == VECTORS["receipt_v2"]["link"] and record["custody"]["to_payer"] == 7000000,
          "shared vector: receipt v2, q=7 and z=c[113] after t, from the station's own receipt builder")

    # The registry's custody fields (section 2).
    root = Path(__file__).resolve().parent
    data = (root / "registry" / "stations.json").read_bytes()
    entry = {k: v for k, v in json.loads(data)["stations"][0].items()
             if k not in registry_format.CUSTODY_FIELDS + ("mode",)}
    custody_entry = dict(entry, mode="custody", escrow=ESCROW, unit_seconds=30, grace_seconds=1680)

    def valid(st: dict) -> bool:
        doc = json.loads(data)
        doc["stations"] = [st]
        try:
            registry.validate(json.dumps(doc).encode())
        except registry.RegistryError:
            return False
        return True

    check(valid(custody_entry) and valid(dict(entry, mode="direct")) and valid(entry),
          "registry: a custody entry (mode, escrow, unit_seconds, grace_seconds) is valid; direct, or no mode, too")
    check(not any(valid(st) for st in (
        dict(custody_entry, mode="escrow"), {k: v for k, v in custody_entry.items() if k != "escrow"},
        dict(custody_entry, escrow=HOST), dict(custody_entry, unit_seconds=7), dict(custody_entry, unit_seconds=1),
        dict(custody_entry, unit_seconds=0), dict(custody_entry, unit_seconds="30"), dict(custody_entry, grace_seconds=299),
        {k: v for k, v in custody_entry.items() if k != "grace_seconds"}, dict(entry, escrow=ESCROW),
        dict(entry, mode="direct", unit_seconds=30), dict(custody_entry, max_session_minutes=1500, unit_seconds=300))),
        "registry refuses: another mode, custody without a contract (or a G key), a unit that does not divide the "
        "ficha or makes more than 256, grace outside 300..86400, custody fields on a direct entry, a 25 h session")

    kp = Keypair.random()

    def signed(name: str, st: dict) -> Path:
        doc = json.loads(data)
        doc["stations"] = [st]
        path = tmp / name
        raw = json.dumps(doc, indent=2).encode()
        path.write_bytes(raw)
        registry_format.sig_path(path).write_text(json.dumps(registry.sign_bytes(raw, kp)))
        return path

    def offline(url: str):
        raise registry_check.Unavailable("ConnectError")

    def refusal(cfg: config.Config, path: Path) -> str:
        try:
            registry_check.check(replace(cfg, registry_key=kp.public_key, registry_file=path), offline)
        except config.ConfigError as exc:
            return str(exc)
        return ""

    mine = replace(base, station_id=entry["id"], host_public_key=entry["host_key"])
    custody_file = signed("custody.json", custody_entry)
    check(refusal(mine, custody_file) == "", "registry check: a custody station matches its custody entry")
    for change, expect in (({"refund_unit_seconds": 15}, "REFUND_UNIT_SECONDS=15 here, unit_seconds 30 in the registry"),
                           ({"escrow_grace_seconds": 1200}, "ESCROW_GRACE_SECONDS=1200 here, grace_seconds 1680"),
                           ({"escrow_contract": XLM_SAC}, f"ESCROW_CONTRACT={XLM_SAC} here, escrow {ESCROW}")):
        check(expect in refusal(replace(mine, **change), custody_file), f"registry check refuses: {expect}")
    check("PAYMENT_MODE=custody here, mode direct (absent) in the registry" in refusal(mine, signed("direct.json", entry))
          and "PAYMENT_MODE=direct here, mode custody in the registry"
          in refusal(replace(mine, payment_mode="direct"), custody_file),
          "registry check refuses a custody station listed as direct, and a direct one listed as custody")

    # The startup check against the contract, with no key (section 7.5).
    class Contract:
        def __init__(self, terms, passphrase=Network.TESTNET_NETWORK_PASSPHRASE, fail=None):
            self.terms, self.passphrase, self.fail = terms, passphrase, fail

        def network_passphrase(self):
            if self.fail:
                raise self.fail
            return self.passphrase

        def station(self):
            return self.terms

    demo = {"active": True, "ficha_secs": 300, "grace_secs": 1680, "max_fichas": 12, "price": 10000000,
            "token": XLM_SAC, "unit_secs": 30}  # ERZGCG on testnet (section 7.1)
    check(escrow.expected_terms(base) == demo and escrow.check(base, Contract(dict(demo)))
          == {"status": "ok", "detail": "contract"},
          "startup check: this station's settings are the terms ERZGCG holds on the testnet contract")

    def contract_refusal(cfg: config.Config, ledger) -> str:
        try:
            escrow.check(cfg, ledger)
        except config.ConfigError as exc:
            return str(exc)
        return ""

    for change, expect in (({"price": 20000000}, "FICHA_PRICE=1 (10000000 stroops) here, price 20000000 on the contract"),
                           ({"unit_secs": 15}, "REFUND_UNIT_SECONDS=30 here, unit_secs 15 on the contract"),
                           ({"grace_secs": 1200}, "ESCROW_GRACE_SECONDS=1680 here, grace_secs 1200 on the contract"),
                           ({"max_fichas": 6}, "MAX_SESSION_MINUTES=60 (12 fichas) here, max_fichas 6"),
                           ({"ficha_secs": 60}, "FICHA_MINUTES=5 (300 s) here, ficha_secs 60"),
                           ({"token": ESCROW}, f"PAYMENT_ASSET_CODE/PAYMENT_ASSET_ISSUER=XLM (its contract {XLM_SAC})"),
                           ({"active": False}, "inactive (active: false)")):
        msg = contract_refusal(base, Contract(dict(demo, **change)))
        check(expect in msg and "Change .env" in msg, f"startup check refuses: {expect}")
    check("is not registered under HOST_PUBLIC_KEY" in contract_refusal(base, Contract(None))
          and "serves the network" in contract_refusal(base, Contract(demo, Network.PUBLIC_NETWORK_PASSPHRASE)),
          "startup check refuses a station the contract does not list, and an RPC of another network")
    check(escrow.check(base, Contract(demo, fail=httpx.ConnectError("down"))) == {"status": "unchecked",
                                                                                 "detail": "RPC unreachable"}
          and escrow.check(replace(base, payment_mode="direct")) == {"status": "off", "detail": "direct mode"},
          "startup check: an RPC it cannot reach starts the station 'escrow unchecked'; direct mode reads nothing")


def test_custody(tmp: Path) -> None:
    print("custody: deposits, refusals, the refund proof, deadlines")
    r = custody_rig(tmp / "main")
    st = r.st
    sid = st.session.id
    seed = seed_of(r, sid)
    s = r.snap()
    uri, _ = pay_qr(r.cfg, sid, s["custody"]["anchor"])
    check(r.records()[-1]["kind"] == "seed" and r.records()[-1]["session"] == sid and st.state == State.AWAITING_PAYMENT
          and s["custody"]["anchor"] == escrow.b64url(escrow.anchor_of(seed, 120)) and s["mode"] == "custody"
          and uri == f"https://ficha.test/p?v=1&n=t&h={HOST}&s=ERZGCG&x={escrow.bare(sid)}&a={s['custody']['anchor']}",
          "a new session's seed is on disk first; its QR is the pay link with the anchor c[120]")

    r.pay("1")
    check(r.records()[-1]["kind"] == "refused" and "pay with the Ficha app" in r.records()[-1]["reason"]
          and st.state == State.AWAITING_PAYMENT and "Ficha app" in r.snap()["notice"],
          "a classic payment with the session's memo: not credited, logged as refused for refund")

    # Someone deposits into the session's ID with a chain of their own: on the
    # contract that is a session of its own (section 7.5), so the station
    # neither credits it nor gives up its own session, QR or next payer.
    other = os.urandom(32)
    notice = r.snap()["notice"]
    deposit(r, 1, anchor=other)
    rec = r.records()
    check(rec[-1]["kind"] == "refused" and rec[-1]["reason"] == "anchor mismatch" and rec[-1]["memo"] == sid
          and rec[-1]["custody"]["anchor"] == escrow.b64url(other)
          and st.state == State.AWAITING_PAYMENT and r.relay.is_open and st.session.id == sid
          and r.snap()["custody"]["anchor"] == s["custody"]["anchor"] and r.snap()["notice"] == notice
          and not any(x["kind"] == "seed" and x["session"] != sid for x in rec),
          "a deposit with another anchor: not credited, logged refused (anchor mismatch); the session, its QR and "
          "its seed stay (nothing for a squatter to take)")
    deposit(r, 1, session=sid, anchor=other)
    check(r.records()[-1]["kind"] == "refused" and r.records()[-1]["reason"] == "anchor mismatch"
          and st.state == State.AWAITING_PAYMENT and st.session.id == sid,
          "its depositor tops up its own session: refused again, and still nothing changes here")

    # A paid session, the same ID: 2 fichas, 400 s charged here, ESC.
    seed = seed_of(r, sid)
    d = deposit(r, 2)
    line = r.records()[-1]
    check(st.state == State.CHARGING and not r.relay.is_open and line["kind"] == "credited"
          and line["fichas"] == 2 and line["amount"] == "2" and line["change_due"] == "0"
          and line["custody"]["seed"] == escrow.b64url(seed) and line["custody"]["total_fichas"] == 2
          and line["custody"]["deadline"] == d.deadline and line["op_id"] == d.event_id,
          "the deposit with its anchor: 2 fichas credited; the credited line carries the seed and the totals")
    until(r, lambda: st.session.running)
    until(r, lambda: st.session.consumed(r.clock.t) >= 400, limit=500)
    st.emergency_open()
    snap = r.snap()
    last = snap["last"]
    rc = receipt_qr(r.cfg, snap)
    q = query(rc["uri"])
    cps = [x["consumed_seconds"] for x in r.records() if x["kind"] == "consumed" and x["session"] == sid]
    check(last["consumed_seconds"] == 400 and last["custody"]["unused_units"] == 7
          and q["z"] == escrow.b64url(escrow.proof(seed, 120, 7)) and q["q"] == "7"
          and list(q) == ["v", "m", "n", "h", "a", "k", "f", "p", "u", "wh", "x", "vd", "c", "t", "q", "z"]
          and (q["v"], q["m"], q["a"], q["f"], q["p"], q["u"]) == ("2", sid, "2", "2", "600", "400"),
          "ESC after 400 s of 600: receipt v2 with q = ceil(200 / 30) = 7 and z = c[113], in the contract's order")
    check(last["refund_hint"] == {"automatic": True, "unused_units": 7, "to_payer": "0.7000000", "asset": "XLM"}
          and last["custody"]["to_payer"] == 7000000 and r.cfg.finished_seconds == 60,
          "refund_hint: automatic, U and the payer's share (0.7 of 2 XLM); FINISHED shows it for 60 s")
    check(len(cps) >= 12 and cps == sorted(cps) and cps[-1] <= 400 and all(b - a <= 30 for a, b in zip(cps, cps[1:])),
          f"consumed time on disk every 30 s while charging ({len(cps)} checkpoints, never ahead of the countdown)")

    # A top-up that lands as the session ends: the receipt returns it too.
    deposit(r, 1)
    q = query(receipt_qr(r.cfg, r.snap())["uri"])
    check(r.records()[-1]["kind"] == "orphan" and r.records()[-1]["reason"] == "session already closed"
          and (q["f"], q["p"], q["a"], q["q"]) == ("3", "900", "3", "17") and q["z"] == escrow.b64url(escrow.proof(seed, 120, 17))
          and "comes back with the receipt" in r.snap()["notice"],
          "a top-up on the FINISHED screen: not credited, and the receipt now refunds it too (q = 17 of 30)")
    r.tick(r.cfg.finished_seconds)
    snap = r.snap()
    shown = last_receipt_qr(r.cfg, snap["last_receipt"])
    check(st.state == State.AWAITING_PAYMENT and snap["last_receipt"]["id"] == sid and query(shown["uri"])["q"] == "17"
          and shown["to_payer"] == "1.7" and shown["deadline"] == d.deadline + 300,
          "after FINISHED the receipt stays on the waiting screen, smaller, with what it gives back and until when")
    # The other session under this ID settles: logged as not this station's, the receipt stays.
    e = st.mock_settle()
    theirs = replace(e, anchor=other, event_id="debug-theirs", tx_hash="debug-theirs", to_payer=10_000_000,
                     to_host=0, unused_units=10)
    st.on_escrow(theirs)
    foreign = r.records()[-1]
    check(foreign["kind"] == "settled" and foreign["foreign"] is True and foreign["anchor"] == escrow.b64url(other)
          and r.snap()["last_receipt"]["id"] == sid and (sid, s["custody"]["anchor"]) not in st.settled_keys,
          "a settle of the other session under this ID (its anchor): logged foreign, this receipt stays on screen")
    st.on_escrow(e)
    st.on_escrow(e)
    settled = [x for x in r.records() if x["kind"] == "settled" and not x.get("foreign")]
    check(len(settled) == 1 and settled[0]["id"] == sid and settled[0]["to_payer"] == "1.7000000"
          and settled[0]["to_host"] == "1.3000000" and settled[0]["unused_units"] == 17 and settled[0]["how"] == "proof"
          and settled[0]["anchor"] == s["custody"]["anchor"]
          and r.snap()["last_receipt"] is None and "settled" in r.snap()["notice"],
          "the settle event: logged once (settled: to_payer, to_host, units, how, tx, anchor), the receipt leaves "
          "the screen")

    # Out of service: a deposit that cannot buy energy gets c[0], a full refund.
    sid = st.session.id
    seed = seed_of(r, sid)
    r.relay.error = "open failed: port gone"
    deposit(r, 2)
    line = [x for x in r.records() if x.get("memo") == sid][-1]
    lr = r.snap()["last_receipt"]
    q = query(last_receipt_qr(r.cfg, lr)["uri"])
    check(line["kind"] == "refused" and line["reason"] == "station out of service"
          and line["custody"]["unused_units"] == 120 and line["custody"]["proof"] == escrow.b64url(seed)
          and st.state == State.AWAITING_PAYMENT and st.session.id != sid and lr["id"] == sid
          and (q["q"], q["z"], q["u"], q["a"]) == ("120", escrow.b64url(seed), "0", "2")
          and lr["custody"]["to_payer"] == 20000000 and "Out of service" in r.snap()["notice"],
          "out of service: not credited, the receipt reveals c[0] (q = N = 120, all 2 XLM back), a new session")
    r.relay.error = None

    # An amount that is not fichas x price: the same full refund.
    sid = st.session.id
    seed = seed_of(r, sid)
    deposit(r, 2, amount=15000000)
    line = [x for x in r.records() if x.get("memo") == sid][-1]
    check(line["kind"] == "refused" and line["reason"] == "amount does not match the price"
          and line["custody"]["proof"] == escrow.b64url(seed) and st.session.id != sid
          and r.snap()["last_receipt"]["id"] == sid, "a deposit whose amount is not fichas x price: c[0] and a new session")

    # Terms on the contract that are not this station's (the host changed them
    # after the startup check, and the payer signed those): the same refusal,
    # its share counted in the session's own units.
    sid = st.session.id
    seed = seed_of(r, sid)
    deposit(r, 2, terms=dict(escrow.station_terms(r.cfg), unit_secs=15))
    line = [x for x in r.records() if x.get("memo") == sid][-1]
    lr = r.snap()["last_receipt"]
    check(line["kind"] == "refused" and line["reason"] == "the session's terms on the contract are not this station's"
          and line["custody"]["proof"] == escrow.b64url(seed) and st.session.id != sid and lr["id"] == sid
          and lr["custody"]["unit_seconds"] == 15 and lr["custody"]["to_payer"] == 20000000,
          "a deposit under other terms (unit 15 s): not credited, c[0] (40 units paid: all back), a new session")
    check(escrow.station_terms(r.cfg) == {"token": XLM_SAC, "price": 10000000, "ficha_secs": 300, "max_fichas": 12,
                                          "unit_secs": 30, "grace_secs": 1680},
          "the terms a session of this station holds on the contract: StationCfg's but active")

    # A top-up while out of service: not credited, refunded by the receipt.
    sid = st.session.id
    seed = seed_of(r, sid)
    deposit(r, 1)
    r.relay.error = "open failed: port gone"
    deposit(r, 1)
    r.relay.error = None
    st.emergency_open()
    q = query(receipt_qr(r.cfg, r.snap())["uri"])
    check(r.snap()["last"]["fichas"] == 1 and (q["f"], q["q"], q["u"]) == ("2", "20", "0")
          and q["z"] == escrow.b64url(escrow.proof(seed, 120, 20)),
          "a top-up while out of service: not credited, but the receipt counts it (f = 2, q = 20: all back)")
    r.tick(r.cfg.finished_seconds)

    # The phone never charges here: every paid unit back, by the formula.
    (tmp / "np").mkdir()
    rn = custody_rig(tmp / "np", mock_plug="elsewhere")
    sid = rn.st.session.id
    seed = seed_of(rn, sid)
    deposit(rn, 1)
    until(rn, lambda: rn.st.state == State.FINISHED, limit=300)
    q = query(receipt_qr(rn.cfg, rn.snap())["uri"])
    check(rn.snap()["last"]["end_reason"] == "not_plugged" and (q["q"], q["u"], q["p"]) == ("10", "0", "300")
          and q["z"] == escrow.b64url(escrow.proof(seed, 120, 10)),
          "not_plugged: q = paid units (10 of 30 s), z = c[110]: the whole ficha back")

    # However long the pauses, the session ends 15 min before its deadline.
    rd = custody_rig(tmp / "deadline", pause_timeout_seconds=3000)
    sid = rd.st.session.id
    seed = seed_of(rd, sid)
    d = deposit(rd, 1)
    paid_at = rd.unix()
    until(rd, lambda: rd.st.session.running)
    rd.tick(100)
    rd.meter.plug = "none"
    until(rd, lambda: rd.st.state == State.FINISHED, limit=1200)
    last = rd.snap()["last"]
    check(last["end_reason"] == "deadline" and rd.relay.is_open and rd.unix() == d.deadline - 900
          and d.deadline == paid_at + 300 + 1680 and last["custody"]["unused_units"] == 7
          and query(receipt_qr(rd.cfg, rd.snap())["uri"])["z"] == escrow.b64url(escrow.proof(seed, 120, 7)),
          "paused past the contract's deadline less 15 min: the session ends there (end_reason deadline), q = 7")
    html = (Path(__file__).resolve().parent / "static" / "index.html").read_text(encoding="utf-8")
    check("deadline: \"Ended \"" in html and "before the contract's deadline" in html,
          "the FINISHED screen says why a session ended at its deadline")

    # Settled while its receipt is on the FINISHED screen: it says so, and
    # does not come back on the waiting screen.
    rs = custody_rig(tmp / "settled")
    deposit(rs, 1)
    until(rs, lambda: rs.st.session.running)
    rs.tick(60)
    rs.st.emergency_open()
    rs.st.on_escrow(rs.st.mock_settle())
    check(rs.snap()["last"]["custody"]["settled"]["to_payer"] == "0.8000000", "settled on the FINISHED screen: shown")
    rs.tick(rs.cfg.finished_seconds)
    check(rs.snap()["last_receipt"] is None and rs.st.receipts == [],
          "... and its receipt is not kept on the waiting screen")

    # A receipt nobody claims leaves the waiting screen at its deadline.
    rx = custody_rig(tmp / "expire")
    d = deposit(rx, 1)
    until(rx, lambda: rx.st.session.running)
    rx.st.emergency_open()
    rx.tick(rx.cfg.finished_seconds)
    check(rx.snap()["last_receipt"] is not None, "a receipt nobody claimed: on the waiting screen")
    rx.clock.t += d.deadline - rx.unix()
    rx.tick()
    check(rx.snap()["last_receipt"] is None, "... until the deadline passes (then the host gets everything at release)")

    # Direct mode is untouched.
    (tmp / "direct").mkdir()
    dr = Rig(tmp / "direct", station_id="K7M2QX", charge_verify=True)
    s = dr.snap()
    check(s["mode"] == "direct" and s["custody"] is None and s["last_receipt"] is None
          and pay_qr(dr.cfg, s["session_id"])[0].startswith("web+stellar:pay?destination=")
          and not any(x["kind"] == "seed" for x in dr.records()) and dr.cfg.finished_seconds == 20,
          "direct mode: a SEP-0007 QR, no seed, no custody fields, FINISHED 20 s")
    dr.pay("1")
    dr.st.emergency_open()
    rc = receipt_qr(dr.cfg, dr.snap())
    check(dr.st.state == State.FINISHED and query(rc["uri"])["v"] == "1" and "q" not in query(rc["uri"])
          and "automatic" not in dr.snap()["last"]["refund_hint"], "direct mode: receipt v1, the refund hint by hand")


def test_custody_restart(tmp: Path) -> None:
    print("custody: the station dies, the seed survives")
    # Killed mid-session: the last checkpoint makes the refund.
    r = custody_rig(tmp / "mid")
    sid = r.st.session.id
    seed = seed_of(r, sid)
    d = deposit(r, 2)
    until(r, lambda: r.st.session.running)
    until(r, lambda: r.st.session.consumed(r.clock.t) >= 95, limit=200)
    cp = max(x["consumed_seconds"] for x in r.records() if x["kind"] == "consumed")
    # No shutdown: as if killed. It comes back with another refund unit: the
    # session's refund still uses its own.
    st2 = Station(replace(r.cfg, refund_unit_seconds=15), MockRelay(), SessionLog(r.cfg.session_log), clock=r.clock,
                  wallclock=r.clock.iso, unixclock=r.unix)
    rec = last_session(r)
    u = escrow.unused_units(600, cp, 30)
    lr = st2.snapshot()["last_receipt"]
    q = query(last_receipt_qr(r.cfg, lr)["uri"])
    check(rec["id"] == sid and rec["end_reason"] == "interrupted" and rec["consumed_seconds"] == cp <= 95
          and rec["custody"]["unused_units"] == u >= escrow.unused_units(600, 95, 30)
          and rec["custody"]["proof"] == escrow.b64url(escrow.proof(seed, 120, u))
          and rec["refund_hint"]["automatic"] and lr["id"] == sid and (q["v"], q["q"], q["u"]) == ("2", str(u), str(cp)),
          f"killed after 95 s: closed as interrupted from the last checkpoint ({cp} s), q = {u} (the payer's favour, "
          "at the session's own 30 s unit), its receipt on the waiting screen")
    n = len(r.records())
    st2.on_escrow(d)
    check(len(r.records()) == n and st2.state == State.AWAITING_PAYMENT, "its deposit seen again after the restart: ignored")

    # Killed on the FINISHED screen: its receipt comes back.
    rf = custody_rig(tmp / "fin")
    sid = rf.st.session.id
    deposit(rf, 1)
    until(rf, lambda: rf.st.session.running)
    rf.tick(40)
    rf.st.emergency_open()
    want = query(receipt_qr(rf.cfg, rf.snap())["uri"])
    st3 = rf.station(MockRelay())
    got = query(last_receipt_qr(rf.cfg, st3.snapshot()["last_receipt"])["uri"])
    check(last_session(rf)["id"] == sid and last_session(rf)["custody"]["unused_units"] == 9
          and (got["q"], got["z"], got["u"]) == (want["q"], want["z"], want["u"]) == ("9", want["z"], "40"),
          "killed on the FINISHED screen: logged, and its receipt (q = 9) back on the waiting screen")
    st3.on_escrow(st3.mock_settle())
    check(rf.station(MockRelay()).snapshot()["last_receipt"] is None, "settled, then a restart: not shown again")

    # Killed while waiting for payment: a deposit made with that QR gets c[0].
    rw = custody_rig(tmp / "wait")
    sid0 = rw.st.session.id
    seed0 = seed_of(rw, sid0)
    st4 = rw.station(MockRelay())
    deposit(rw, 1, st=st4, session=sid0)
    line = [x for x in rw.records() if x.get("memo") == sid0][-1]
    lr = st4.snapshot()["last_receipt"]
    check(line["kind"] == "orphan" and line["reason"] == "session not served" and line["custody"]["proof"]
          == escrow.b64url(seed0) and st4.session.id != sid0 and lr["id"] == sid0 and lr["custody"]["unused_units"] == 120,
          "killed with a QR on screen, paid after the restart: not credited, its receipt reveals c[0] (all back)")
    # The next customer's receipt is never pushed off by such a refund: the
    # waiting screen takes turns with the two.
    served = st4.session.id
    deposit(rw, 1, st=st4)
    for _ in range(40):
        rw.clock.t += 1
        st4.tick(rw.meter.read())
    st4.emergency_open()
    for _ in range(rw.cfg.finished_seconds):
        rw.clock.t += 1
        st4.tick(rw.meter.read())
    deposit(rw, 1, st=st4, session=sid0)
    line = [x for x in rw.records() if x.get("memo") == sid0][-1]
    shown = []
    for _ in range(16):
        rw.clock.t += 1
        st4.tick(rw.meter.read())
        shown.append((st4.snapshot()["last_receipt"]["id"], tuple(st4.snapshot()["last_receipt_turn"])))
    check(served != sid0 and [e["record"]["id"] for e in st4._on_screen()] == [served, sid0]
          and {x for x, _ in shown} == {served, sid0} and {t for _, t in shown} == {(1, 2), (2, 2)}
          and line["reason"] == "session not served" and line["custody"]["proof"] == escrow.b64url(seed0)
          and next(e for e in st4.receipts if e["record"]["id"] == sid0)["record"]["custody"]["total_fichas"] == 2,
          "a stale QR topped up later: logged with c[0]; the last customer's receipt stays on screen, taking "
          "turns (8 s each, '1/2', '2/2') with that full refund")


def rpc_event_json(kind: str, session: str, data: dict, n: int, station: str = "ERZGCG",
                   ok: bool | None = True) -> dict:
    """A getEvents record of the escrow contract, as the RPC sends it (base64
    XDR). Stellar RPC 30 no longer sends inSuccessfulContractCall: ok=None
    leaves it out, as it does; True or False is an older RPC's record."""
    topic = [scval.to_symbol(kind).to_xdr(), scval.to_address(HOST).to_xdr(), scval.to_symbol(station).to_xdr(),
             scval.to_symbol(session).to_xdr()]
    value = scval.to_map({scval.to_symbol(k): v for k, v in sorted(data.items())}).to_xdr()
    record = {"type": "contract", "ledger": 1990 + n, "ledgerClosedAt": "2026-10-01T12:00:00Z", "contractId": ESCROW,
              "id": f"{n:019d}-0000000001", "topic": topic, "value": value,
              "operationIndex": 0, "transactionIndex": 0, "txHash": f"{n:064x}"}
    if ok is not None:
        record["inSuccessfulContractCall"] = ok
    return record


def rpc_event(kind: str, session: str, data: dict, n: int, station: str = "ERZGCG", ok: bool | None = True) -> EventInfo:
    """rpc_event_json, read by stellar-sdk."""
    return EventInfo.model_validate(rpc_event_json(kind, session, data, n, station, ok))


def rpc_page(events: list[dict], close_time: int = 0) -> dict:
    """A getEvents result as the RPC sends it (its close times are strings)."""
    return {"events": events, "latestLedger": 2000, "oldestLedger": 900, "latestLedgerCloseTime": str(close_time),
            "oldestLedgerCloseTime": "0", "cursor": events[-1]["id"] if events else "0000000000000000000-0"}


TERMS = {"token": XLM_SAC, "price": 10_000_000, "ficha_secs": 300, "max_fichas": 12, "unit_secs": 30,
         "grace_secs": 1680}  # ERZGCG's


def terms_val(t: dict):
    """A session's Terms as the contract's events carry them (a map, sorted keys)."""
    conv = {"token": scval.to_address, "price": scval.to_int128, "grace_secs": scval.to_uint64}
    return scval.to_map({scval.to_symbol(k): conv.get(k, scval.to_uint32)(t[k]) for k in sorted(t)})


def deposit_data(payer: str, fichas: int, total: int, anchor: bytes, deadline: int, terms: dict = TERMS) -> dict:
    return {"amount": scval.to_int128(fichas * 10_000_000), "anchor": scval.to_bytes(anchor),
            "deadline": scval.to_uint64(deadline), "fichas": scval.to_uint32(fichas), "payer": scval.to_address(payer),
            "terms": terms_val(terms), "total_amount": scval.to_int128(total * 10_000_000),
            "total_fichas": scval.to_uint32(total)}


def test_escrow_watch(tmp: Path) -> None:
    print("custody: the escrow events watcher")
    r = custody_rig(tmp / "w")
    st = r.st
    sid = escrow.bare(st.session.id)
    payer = Keypair.random().public_key
    deadline = int(r.unix()) + 600 + 1680

    class Rpc:
        """A Soroban RPC with these events and sessions; it records each call."""
        def __init__(self) -> None:
            self.events_list: list[EventInfo] = []
            self.calls: list[dict] = []
            self.sessions: dict[str, dict] = {}
            self.refuse_cursor = False
            self.down = False
            self.oldest = 900
            self.close_time = 0  # the latest ledger's close time; 0: not said

        def latest_ledger(self):
            return GetLatestLedgerResponse.model_validate({"id": "x", "protocolVersion": 29, "sequence": 2000,
                                                           "closeTime": int(w.started_at) + 50,
                                                           "headerXdr": "", "metadataXdr": ""})

        def events(self, *, start_ledger=None, cursor=None, limit=100):
            self.calls.append({"start_ledger": start_ledger, "cursor": cursor, "limit": limit})
            if self.down:
                raise httpx.ConnectError("RPC down")
            if cursor is not None and self.refuse_cursor:
                raise SorobanRpcErrorResponse(-32600, "cursor out of range")
            after = int(cursor.split("-")[0]) if cursor else -1
            got = [e for e in self.events_list if (int(e.id.split("-")[0]) > after if cursor
                                                   else e.ledger >= start_ledger)][:limit]
            last = got[-1].id if got else (cursor or "0000000000000000000-0")
            return GetEventsResponse.model_validate({"events": [e.model_dump(by_alias=True) for e in got],
                                                     "latestLedger": 2000, "oldestLedger": self.oldest,
                                                     "latestLedgerCloseTime": self.close_time,
                                                     "oldestLedgerCloseTime": 0,
                                                     "cursor": last})

        def session(self, session, anchor):
            return self.sessions.get((escrow.bare(session), anchor))

    rpc = Rpc()
    got: list = []
    w = escrow.EscrowWatcher(r.cfg, on_event=lambda e: (got.append(e), st.on_escrow(e)), tracked=st.escrow_sessions,
                             ledger=rpc)
    rpc.events_list = [
        rpc_event("deposit", sid, deposit_data(payer, 2, 2, st.session.anchor, deadline), 1),
        rpc_event("deposit", sid, deposit_data(payer, 1, 1, st.session.anchor, deadline), 2, station="ABCDEF"),
        rpc_event("deposit", sid, {"amount": scval.to_int128(5)}, 3),
        rpc_event("settle", "F2345678", {"anchor": scval.to_bytes(os.urandom(32)), "how": scval.to_symbol("deadline"),
                                         "payer": scval.to_address(payer), "to_host": scval.to_int128(10_000_000),
                                         "to_payer": scval.to_int128(0), "unused_units": scval.to_uint32(0)}, 4)]
    asyncio.run(w.poll())
    line = [x for x in r.records() if x["kind"] == "credited"][-1]
    saved = json.loads(r.cfg.escrow_cursor_file.read_text())
    check(rpc.calls[0] == {"start_ledger": 2000 - 10 - escrow.FIRST_RUN_MARGIN_LEDGERS, "cursor": None, "limit": 100}
          and [type(e).__name__ for e in got] == ["Deposit", "Settle"] and st.state == State.CHARGING
          and line["source"] == "escrow" and line["payer"] == payer and line["tx_hash"] == f"{1:064x}"
          and line["custody"]["event_id"] == rpc.events_list[0].id and got[0].terms == TERMS
          and saved == {"network": "testnet", "escrow": ESCROW, "host": HOST, "station": "ERZGCG",
                        "cursor": rpc.events_list[3].id, "ledger": 2000}
          and w.health() == {"status": "ok", "detail": ""},
          "first run: from about the station's start; its deposit credited (source escrow, payer, tx), another "
          "station's and an unreadable one skipped, a settle logged; the cursor saved with its ledger")
    check(any(x["kind"] == "settled" and x["id"] == "ERZGCG.F2345678" and x["how"] == "deadline" for x in r.records()),
          "a release (settle, how deadline) of another session: logged as settled")
    asyncio.run(w.poll())
    check(rpc.calls[-1]["cursor"] == rpc.events_list[3].id, "the next poll resumes from the cursor")
    rpc.close_time = int(r.unix()) - 3
    w.on_read = st.on_ledger
    asyncio.run(w.poll())
    check(st.escrow_read_at == r.clock.t and st.ledger_sample == (float(int(r.unix()) - 3), r.clock.t)
          and st.ledger_time() == int(r.unix()) - 3 and st.clock_skew is None,
          "a poll that succeeds gives the station ledger time (getEvents' latestLedgerCloseTime) and says the "
          "contract was read")

    path = r.cfg.escrow_cursor_file
    good = path.read_text()
    path.write_text(json.dumps(dict(json.loads(good), escrow=XLM_SAC)))
    probe = escrow.EscrowWatcher(r.cfg, on_event=st.on_escrow, ledger=rpc)
    probe._load_cursor()
    path.write_text(good)
    check(probe.cursor is None, "a cursor file that names another contract (or host, or station) is not used")
    w2 = escrow.EscrowWatcher(r.cfg, on_event=st.on_escrow, tracked=st.escrow_sessions, ledger=rpc)
    rpc.events_list.append(rpc_event("deposit", sid, deposit_data(payer, 1, 3, st.session.anchor, deadline + 300), 5))
    n = sum(x["kind"] == "credited" for x in r.records())
    asyncio.run(w2.poll())
    check(rpc.calls[-1]["cursor"] == rpc.events_list[3].id and st.session.fichas == 3
          and sum(x["kind"] == "credited" for x in r.records()) == n + 1,
          "a restarted watcher reads its cursor from disk: only the new top-up is credited")

    # Events missed (the RPC no longer keeps them): the sessions are read instead.
    rpc.refuse_cursor, rpc.oldest = True, 5000
    rpc.sessions[(sid, st.session.anchor)] = {"payer": payer, "fichas": 4, "amount": 40_000_000,
                                              "anchor": st.session.anchor, "deadline": deadline + 600, **TERMS}
    gone: list = []
    elsewhere = os.urandom(32)
    check(st.escrow_sessions()[0] == (st.session.id, st.session.anchor)
          and all(isinstance(a, bytes) and len(a) == 32 for _, a in st.escrow_sessions()),
          "the sessions to read after missed events are (ID, anchor): a session is both on the contract")
    w3 = escrow.EscrowWatcher(r.cfg, on_event=lambda e: (gone.append(e), st.on_escrow(e)),
                              tracked=lambda: [(st.session.id, st.session.anchor), ("ERZGCG.F3333333", elsewhere)],
                              ledger=rpc)
    asyncio.run(w3.poll())
    check(st.session.fichas == 4 and st.session.deadline == deadline + 600
          and [type(e).__name__ for e in gone] == ["Deposit", "Gone"] and gone[0].source == "session"
          and gone[0].terms == TERMS and gone[1].anchor == elsewhere
          and rpc.calls[-1]["start_ledger"] == 5000,
          "a cursor older than the RPC keeps: read from its oldest ledger, and the tracked sessions read instead "
          "(the missed top-up credited from the session's totals, a session gone reported)")
    n = len(r.records())
    st.on_escrow(gone[0])
    check(len(r.records()) == n and st.session.fichas == 4, "the same session read again: nothing more credited")
    rpc.down = True
    asyncio.run(w3.poll())
    check(w3.health()["status"] == "error" and "RPC down" in w3.health()["detail"], "RPC unreachable: escrow error")
    read_at = st.escrow_read_at
    r.clock.t += 5
    asyncio.run(w.poll())
    check(st.escrow_read_at == read_at and w.health()["status"] == "error",
          "a poll that fails tells the station nothing: the contract was not read")

    # A cursor saved before a testnet reset (the ledger started over from 1)
    # is far past the network's latest ledger: as on a first run.
    rpc.down, rpc.refuse_cursor, rpc.oldest = False, False, 900
    path.write_text(json.dumps({"network": "testnet", "escrow": ESCROW, "host": HOST, "station": "ERZGCG",
                                "cursor": f"{5_000_000 << 32:019d}-0000000001", "ledger": 5_000_000}))
    w5 = escrow.EscrowWatcher(r.cfg, on_event=st.on_escrow, tracked=st.escrow_sessions, ledger=rpc)
    asyncio.run(w5.poll())
    check(rpc.calls[-2]["cursor"] is not None and rpc.calls[-1]["cursor"] is None
          and rpc.calls[-1]["start_ledger"] < 2000 and w5.cursor_ledger == 2000 and w5.health()["status"] == "ok",
          "an escrow cursor far past the network's latest ledger (saved before a testnet reset): read as on a "
          "first run, from about the station's start")
    at_event: list = []
    rpc.close_time = int(r.unix()) - 1
    rpc.events_list.append(rpc_event("settle", "F3456789", {
        "anchor": scval.to_bytes(os.urandom(32)), "how": scval.to_symbol("deadline"), "payer": scval.to_address(payer),
        "to_host": scval.to_int128(10_000_000), "to_payer": scval.to_int128(0), "unused_units": scval.to_uint32(0)}, 6))
    w6 = escrow.EscrowWatcher(r.cfg, on_event=lambda e: at_event.append(st.ledger_sample), ledger=rpc,
                              on_read=st.on_ledger)
    asyncio.run(w6.poll())
    check(at_event == [(float(int(r.unix()) - 1), r.clock.t)],
          "the ledger time a page brings reaches the station before the page's events do")


def test_escrow_rpc30(tmp: Path) -> None:
    print("custody: getEvents as Stellar RPC 30 sends it (no inSuccessfulContractCall), and as older RPCs did")
    r = custody_rig(tmp / "w")
    st = r.st
    sid = escrow.bare(st.session.id)
    payer = Keypair.random().public_key
    deadline = int(r.unix()) + 600 + 1680
    anchor = st.session.anchor
    failed = rpc_event_json("deposit", sid, deposit_data(payer, 5, 5, anchor, deadline), 1, ok=False)
    rpc30 = rpc_event_json("deposit", sid, deposit_data(payer, 1, 1, anchor, deadline), 2, ok=None)
    older = rpc_event_json("deposit", sid, deposit_data(payer, 1, 2, anchor, deadline + 300), 3, ok=True)
    try:
        page = GetEventsResponse.model_validate(rpc_page([rpc30], close_time=int(r.unix())))
        why = ""
    except ValueError as exc:  # pydantic's ValidationError
        page, why = None, f": {str(exc).splitlines()[0]}"
    check(page is not None and len(page.events) == 1 and page.latest_ledger == 2000
          and "inSuccessfulContractCall" not in rpc30,
          f"stellar-sdk {stellar_sdk.__version__} reads a getEvents page whose records have no "
          f"inSuccessfulContractCall, as Stellar RPC 30 sends them (requirements.txt: 16.1.1 or later){why}")
    if page is None:
        return
    new, ok, bad = page.events[0], EventInfo.model_validate(older), EventInfo.model_validate(failed)
    got = [escrow.decode_event(r.cfg, e) for e in (new, ok, bad)]
    check(not escrow.failed_call(new) and not escrow.failed_call(ok) and escrow.failed_call(bad)
          and isinstance(got[0], escrow.Deposit) and got[0].tx_hash == f"{2:064x}" and got[0].total_fichas == 1
          and isinstance(got[1], escrow.Deposit) and got[2] is None,
          "a record that does not say (RPC 30) is a successful call's deposit, so is one that says true; only an "
          "explicit false (an older RPC's failed call) is skipped")

    class Rpc:
        """A Soroban RPC that sends these raw pages, one per call, read by stellar-sdk as the station reads them."""
        def __init__(self, *pages: list[dict]) -> None:
            self.pages = list(pages)

        def latest_ledger(self):
            return GetLatestLedgerResponse.model_validate({"id": "x", "protocolVersion": 29, "sequence": 2000,
                                                           "closeTime": int(time.time()), "headerXdr": "",
                                                           "metadataXdr": ""})

        def events(self, *, start_ledger=None, cursor=None, limit=100):
            return GetEventsResponse.model_validate(rpc_page(self.pages.pop(0) if self.pages else []))

    rpc = Rpc([failed, rpc30], [older])
    w = escrow.EscrowWatcher(r.cfg, on_event=st.on_escrow, tracked=st.escrow_sessions, ledger=rpc)
    asyncio.run(w.poll())
    credited = [x for x in r.records() if x["kind"] == "credited"]
    check(w.health() == {"status": "ok", "detail": ""} and st.state == State.CHARGING and st.session.fichas == 1
          and len(credited) == 1 and credited[0]["tx_hash"] == f"{2:064x}" and credited[0]["payer"] == payer,
          "the watcher on an RPC 30 page: its deposit credited (1 ficha, its tx), the failed call's before it "
          "skipped, health ok")
    asyncio.run(w.poll())
    credited = [x for x in r.records() if x["kind"] == "credited"]
    check(w.health()["status"] == "ok" and st.session.fichas == 2 and len(credited) == 2
          and credited[1]["tx_hash"] == f"{3:064x}" and json.loads(r.cfg.escrow_cursor_file.read_text())["cursor"]
          == older["id"],
          "... and a top-up in an older RPC's shape (inSuccessfulContractCall true) still credited, the cursor "
          "saved after it")


YX = {"ficha_minutes": 1, "max_session_minutes": 10, "refund_unit_seconds": 15}  # YX3DGE's terms (N = 40)


def test_custody_receipts(tmp: Path) -> None:
    print("custody: the last receipt on the waiting screen, and across a restart")
    # A session that used all its paid time refunds nothing: no "0 XLM back,
    # scan to claim it" on the waiting screen, and it gives way.
    r = custody_rig(tmp / "zero", **YX)
    st = r.st
    deposit(r, 1)
    until(r, lambda: st.state == State.FINISHED, limit=400)
    check(r.snap()["last"]["end_reason"] == "time_up" and r.snap()["last"]["custody"]["to_payer"] == 0,
          "a 1-ficha session to the end: nothing to refund")
    r.tick(r.cfg.finished_seconds)
    check(len(st.receipts) == 1 and st.receipts[0]["served"] and r.snap()["last_receipt"] is None,
          "... so no last receipt on the waiting screen (kept off it, for a top-up that would still refund)")
    sid = st.session.id
    seed = seed_of(r, sid)
    r.relay.error = "open failed: port gone"
    deposit(r, 2, payer="GPAYER2")
    r.relay.error = None
    lr = r.snap()["last_receipt"]
    check(lr is not None and lr["id"] == sid and lr["custody"]["proof"] == escrow.b64url(seed)
          and "scan the refund receipt" in r.snap()["notice"],
          "out of service, the next payer's full refund takes its place, and the notice points at it")

    # A served receipt that refunds something stays; a full refund made after
    # it takes turns with it on screen, and the notice points at it.
    r = custody_rig(tmp / "kept", **YX)
    st = r.st
    deposit(r, 3)
    until(r, lambda: st.session.running)
    r.tick(20)
    st.emergency_open()
    r.tick(r.cfg.finished_seconds)
    served = r.snap()["last_receipt"]["id"]
    unserved = st.session.id
    r.relay.error = "open failed: port gone"
    deposit(r, 2, payer="GPAYER2")
    r.relay.error = None
    notice = r.snap()["notice"]
    check([e["record"]["id"] for e in st._on_screen()] == [served, unserved] and "ask the operator" not in notice
          and "scan the refund receipt" in notice,
          "a served receipt with a refund stays on screen; an unserved deposit's full refund takes turns with it, "
          "and its notice points at it")

    # The unserved full refund is logged, and a restart shows it again.
    r = custody_rig(tmp / "restart", **YX)
    sid = r.st.session.id
    seed = seed_of(r, sid)
    r.relay.error = "open failed: port gone"
    deposit(r, 2)
    r.relay.error = None
    unserved = [x for x in r.records() if x["kind"] == "unserved"]
    st2 = r.station(MockRelay())
    lr = st2.snapshot()["last_receipt"]
    q = query(last_receipt_qr(r.cfg, lr)["uri"]) if lr else {}
    check(len(unserved) == 1 and unserved[0]["id"] == sid and unserved[0]["custody"]["proof"] == escrow.b64url(seed)
          and lr is not None and lr["id"] == sid
          and (q["q"], q["z"], q["u"], q["a"]) == ("40", escrow.b64url(seed), "0", "2"),
          "an out-of-service deposit's full refund is logged (kind unserved) and back on screen after a restart")
    deposit(r, 1, st=st2, session=sid)
    lr = st2.snapshot()["last_receipt"]
    check(lr["id"] == sid and lr["custody"]["total_fichas"] == 3 and lr["custody"]["to_payer"] == 30_000_000
          and lr["custody"]["proof"] == escrow.b64url(seed),
          "... and a top-up of it after the restart is in its proof too (q = N: all 3 XLM back)")
    st2.on_escrow(st2.mock_settle())
    check(r.station(MockRelay()).snapshot()["last_receipt"] is None, "settled, then a restart: not shown again")

    # At a restart the receipts are offered again in order, by the same rule:
    # a served one that refunds nothing gives way to a later unserved one.
    r = custody_rig(tmp / "order", **YX)
    st = r.st
    deposit(r, 1)
    until(r, lambda: st.state == State.FINISHED, limit=400)
    r.tick(r.cfg.finished_seconds)
    stale, stale_seed = st.session.id, seed_of(r, st.session.id)
    st3 = r.station(MockRelay())
    deposit(r, 2, st=st3, session=stale, payer="GPAYER2")
    lr = st3.snapshot()["last_receipt"]
    check(lr is not None and lr["id"] == stale and lr["custody"]["proof"] == escrow.b64url(stale_seed)
          and "scan the refund receipt" in st3.snapshot()["notice"]
          and r.station(MockRelay()).snapshot()["last_receipt"]["id"] == stale,
          "a stale QR paid after a restart: its full refund shows over a receipt that refunds nothing, and "
          "again after another restart")


def test_custody_edges(tmp: Path) -> None:
    print("custody: settled while served, more fichas than N, ledger time, the contract's health, E")
    # More fichas on the contract than this station's terms allow (the host
    # registered larger ones while the station ran on its old settings):
    # the proof stops at N, never a crash.
    r = custody_rig(tmp / "big")
    st = r.st
    seed = seed_of(r, st.session.id)
    d1 = deposit(r, 1)
    until(r, lambda: st.session.running)
    big = replace(d1, event_id="big", tx_hash="big", fichas=13, amount=130_000_000, total_fichas=14,
                  total_amount=140_000_000, deadline=d1.deadline + 13 * 300, source="event")
    st.on_escrow(big)
    r.tick(5)
    st.emergency_open()
    last = r.snap()["last"]
    check(st.state == State.FINISHED and last["custody"]["total_fichas"] == 14 and last["custody"]["unused_units"] == 120
          and last["custody"]["proof"] == escrow.b64url(seed) and last["custody"]["to_payer"] == 120_000_000,
          "a top-up beyond MAX_SESSION_MINUTES on the contract: refused, and U stops at N = 120 (z = c[0]), "
          "12 of 14 XLM back by proof, the rest by host_refund")
    st2 = r.station(MockRelay())
    check(st2.snapshot()["last_receipt"]["custody"]["unused_units"] == 120, "... and the station still starts again")
    r.tick(r.cfg.finished_seconds)
    big2 = replace(big, event_id="big2", tx_hash="big2", fichas=1, amount=10_000_000, total_fichas=15,
                   total_amount=150_000_000)
    for _ in range(3):
        st.on_escrow(big2)
    check(sum(x.get("op_id") == "big2" for x in r.records()) == 1
          and st.snapshot()["last_receipt"]["custody"]["unused_units"] == 120,
          "the same top-up to the last receipt's session, read three times: logged once, no error")
    entry_totals = st._entry_totals
    st._entry_totals = lambda entry, d: 1 / 0
    big3 = replace(big2, event_id="big3", tx_hash="big3", total_fichas=16, total_amount=160_000_000)
    logging.disable(logging.CRITICAL)
    try:
        st.on_escrow(big3)
        st.on_escrow(big3)
        raised = False
    except ZeroDivisionError:
        raised = True
    finally:
        logging.disable(logging.NOTSET)
        st._entry_totals = entry_totals
    check(not raised and sum(x.get("op_id") == "big3" for x in r.records()) == 1,
          "a deposit already logged is never read again, even when handling it fails after the log line "
          "(the watcher moves on)")

    # A host_refund of the session being served: it runs out its time, its
    # receipt is not offered, and a deposit under its ID and anchor (another
    # session on the contract now) gets c[0].
    r = custody_rig(tmp / "settled", **YX)
    st = r.st
    sid = st.session.id
    seed = seed_of(r, sid)
    d1 = deposit(r, 3)
    until(r, lambda: st.session.running)
    r.tick(10)
    st.on_escrow(escrow.Settle(event_id="h1", tx_hash="ab" * 32, ledger=0, closed_at="", session=escrow.bare(sid),
                               payer="GPAYER", to_host=0, to_payer=d1.total_amount, unused_units=12, how="host",
                               anchor=st.session.anchor))
    notice = r.snap()["notice"]
    check(st.state == State.CHARGING and st.session.settled["how"] == "host"
          and "3 XLM to the payer, 0 to the host" in notice and "tx abababab…" in notice,
          "a host_refund while charging: noted (with its transaction), the paid time runs on")
    d2 = replace(d1, event_id="n2", tx_hash="n2", payer="GOTHER", fichas=2, amount=20_000_000, total_fichas=2,
                 total_amount=20_000_000, deadline=d1.deadline + 500)
    d3 = replace(d2, event_id="n3", tx_hash="n3", fichas=3, amount=30_000_000, total_fichas=5,
                 total_amount=50_000_000, deadline=d1.deadline + 680)
    st.on_escrow(d2)
    st.on_escrow(d3)
    lines = [x for x in r.records() if x.get("op_id") in ("n2", "n3")]
    check([(x["kind"], x["reason"]) for x in lines] == [("refused", "session already settled")] * 2
          and all(x["custody"]["proof"] == escrow.b64url(seed) and x["custody"]["unused_units"] == 40 for x in lines)
          and st.session.fichas == 3 and st.session.chain_fichas == 3
          and "its refund receipt follows this session on screen" in r.snap()["notice"],
          "another wallet pays the settled session's QR (a new session on the contract): neither credited nor "
          "dropped silently, logged with c[0], whatever its total; its receipt shows after this session")
    st.emergency_open()
    check(r.snap()["last"]["custody"]["settled"]["how"] == "host", "the FINISHED screen says it settled")
    r.tick(r.cfg.finished_seconds)
    lr = r.snap()["last_receipt"]
    check(lr["id"] == sid and lr["end_reason"] == "not_served" and lr["custody"]["total_fichas"] == 5
          and lr["custody"]["to_payer"] == 50_000_000,
          "the settled session's receipt is never offered; the other wallet's full refund (5 XLM) is")
    # A claim on the FINISHED screen, then a deposit under the same ID and anchor.
    r = custody_rig(tmp / "claimed", **YX)
    st = r.st
    sid = st.session.id
    seed = seed_of(r, sid)
    d1 = deposit(r, 2)
    until(r, lambda: st.session.running)
    r.tick(20)
    st.emergency_open()
    st.on_escrow(st.mock_settle())
    st.on_escrow(replace(d1, event_id="late", tx_hash="late", fichas=1, amount=10_000_000, total_fichas=1,
                         total_amount=10_000_000))
    line = [x for x in r.records() if x.get("op_id") == "late"][-1]
    r.tick(r.cfg.finished_seconds)
    check((line["kind"], line["reason"]) == ("orphan", "session already settled")
          and line["custody"]["proof"] == escrow.b64url(seed) and r.snap()["last_receipt"]["id"] == sid
          and r.snap()["last_receipt"]["custody"]["to_payer"] == 10_000_000,
          "claimed on the FINISHED screen, then paid again under it: c[0], its 1 XLM back by proof")

    # Ledger time decides deadlines, not this computer's clock (15 min fast here).
    r = custody_rig(tmp / "clock", **YX)
    st = r.st
    st.unixclock = lambda: r.unix() + 900
    st.on_ledger(int(r.unix()))
    opened = int(r.unix())
    d = deposit(r, 1)
    until(r, lambda: st.session.running)
    check(st.state == State.CHARGING and d.deadline == opened + 60 + 1680 and not st._deadline_due()
          and r.snap()["custody"]["clock_skew"] == 900 and not st._expired({"custody": {"deadline": opened + 10}}),
          "a station clock 15 min fast: the session opens and charges in ledger time (its clock would have ended "
          "it at once), the skew shows")
    r.clock.t += d.deadline - config.CLAIM_WINDOW_SECONDS - st.ledger_time()
    check(st._deadline_due() and st._expired({"custody": {"deadline": int(st.ledger_time()) - 1}}),
          "... and it ends 15 min before its deadline in ledger time")
    st.unixclock = r.unix
    st.on_ledger(int(r.unix()))
    check(r.snap()["custody"]["clock_skew"] is None and r.snap()["custody"]["ledger_time"] == int(r.unix()),
          "the clock agrees with the ledger again: no warning")

    # Out of service while the contract cannot be read: no pay QR.
    r = custody_rig(tmp / "health")
    st = r.st
    check(st.out_of_service() is None, "a station whose contract is not watched (tests, MOCK) is in service")
    st.watch_escrow()
    check("escrow" in (st.out_of_service() or "") and r.snap()["out_of_service"],
          "watched, before the first read of the contract: out of service (no pay QR)")
    st.on_ledger(0)
    check(st.out_of_service() is None, "read: in service")
    r.tick(31)
    check("not read for 31 s" in (st.out_of_service() or ""),
          "no read for 30 s (the RPC unreachable from here): out of service again")
    st.on_ledger(int(r.unix()))
    deposit(r, 1)
    check(st.out_of_service() is None and st.state == State.CHARGING, "read again: in service")

    # E: the operator ends the session for its payer, no emergency.
    r = custody_rig(tmp / "end", **YX)
    st = r.st
    deposit(r, 2)
    until(r, lambda: st.session.running)
    r.tick(17)
    st.end_session()
    last = r.snap()["last"]
    u = escrow.unused_units(120, last["consumed_seconds"], 15)
    check(st.state == State.FINISHED and r.relay.is_open and last["end_reason"] == "stopped"
          and "forced open" not in r.snap()["notice"] and "comes back with the receipt" in r.snap()["notice"]
          and last["custody"]["unused_units"] == u
          and last["custody"]["to_payer"] == escrow.payer_share(20_000_000, u, 8),
          f"E after {last['consumed_seconds']} s of 120: ended as 'stopped', relay open, no 'forced open', "
          f"q = {u}, {last['custody']['to_payer'] / 1e7} XLM back")
    r.tick(r.cfg.finished_seconds)
    st.courtesy()
    st.end_session()
    check(st.state == State.AWAITING_PAYMENT and r.relay.is_open, "E during a courtesy ends it")
    st.end_session()
    check(st.state == State.AWAITING_PAYMENT, "E while waiting for a payment does nothing")
    html = (Path(__file__).resolve().parent / "static" / "index.html").read_text(encoding="utf-8")
    check('stopped: "Ended early"' in html and "<kbd>E</kbd>" in html and 'send("e")' in html,
          "the screen: E in the header, 'Ended early' on the FINISHED screen")


def finish_e(r: Rig, after: int) -> None:
    """The session on screen: charging verified, E after `after` s, then the
    FINISHED screen runs out."""
    until(r, lambda: r.st.session.running)
    r.tick(after)
    r.st.end_session()
    r.tick(r.cfg.finished_seconds)


def on_screen(st: Station) -> list[str]:
    """The receipts the waiting screen takes turns with, by session ID."""
    return [e["record"]["id"] for e in st._on_screen()]


def test_custody_waiting(tmp: Path) -> None:
    print("custody: receipts that wait their turn, and ledger time at a restart")
    # A receipt that refunds nothing never takes the place of one that does.
    r = custody_rig(tmp / "zero_after", **YX)
    st = r.st
    alice = st.session.id
    deposit(r, 3)
    finish_e(r, 20)
    bob = st.session.id
    deposit(r, 1, payer="GBOB")
    until(r, lambda: st.state == State.FINISHED, limit=400)
    check(r.snap()["last"]["end_reason"] == "time_up" and r.snap()["last"]["custody"]["to_payer"] == 0,
          "Alice: 3 fichas, E at 20 s; then Bob: 1 ficha to the end, nothing to refund")
    r.tick(r.cfg.finished_seconds)
    lr = r.snap()["last_receipt"]
    check(lr["id"] == alice and lr["custody"]["to_payer"] == 27_500_000 and on_screen(st) == [alice]
          and [e["record"]["id"] for e in st.receipts] == [alice, bob]
          and r.station(MockRelay()).snapshot()["last_receipt"]["id"] == alice,
          "Bob's receipt (0 XLM back) never takes the place of Alice's (2.75 XLM back): hers stays on screen, his "
          "waits off it (a top-up could still make it refund), also after a restart")
    r = custody_rig(tmp / "unserved_kept", **YX)
    st = r.st
    stale = st.session.id
    r.relay.error = "open failed: port gone"
    deposit(r, 2)
    r.relay.error = None
    deposit(r, 1, payer="GBOB")
    until(r, lambda: st.state == State.FINISHED, limit=400)
    r.tick(r.cfg.finished_seconds)
    check(r.snap()["last_receipt"]["id"] == stale and r.snap()["last_receipt"]["custody"]["to_payer"] == 20_000_000
          and r.station(MockRelay()).snapshot()["last_receipt"]["id"] == stale,
          "an unserved full refund (2 XLM) stays on screen when the next session runs to the end (0 back), also "
          "after a restart")
    # A deposit seen after its deadline (the RPC was down) never pushes off a
    # receipt that can still be claimed.
    first = st.session.id
    r.relay.error = "open failed: port gone"
    deposit(r, 2, payer="GCAROL")
    late = replace(st.mock_deposit(1, payer="GDAVE"), deadline=int(r.unix()) - 10)
    st.on_escrow(late)
    r.relay.error = None
    notice = r.snap()["notice"]
    r.tick()
    check(r.snap()["last_receipt"]["id"] == first and "ask the operator" in notice
          and all(e["record"]["custody"]["deadline"] > r.unix() for e in st.receipts),
          "a full refund whose deadline already passed: logged, never shown in place of a valid one (its notice "
          "says to ask the operator), and dropped at the next tick")

    # A stale QR paid during another session: its full refund follows that
    # session on screen, as the notice says, whatever the session refunds.
    for name, after in (("stale_refund", 20), ("stale_zero", None)):
        r = custody_rig(tmp / name, **YX)
        old = r.st.session.id
        st = r.st = r.station(r.relay)  # a restart: a new QR; the old one's seed is kept
        alice = st.session.id
        deposit(r, 3 if after else 1)
        until(r, lambda: st.session.running)
        r.tick(5)
        deposit(r, 2, session=old, payer="GBOB")  # Bob's pay page still shows the old QR
        notice = r.snap()["notice"]
        if after:
            r.tick(after - 5)
            st.end_session()
        else:
            until(r, lambda: st.state == State.FINISHED, limit=400)
        r.tick(r.cfg.finished_seconds)
        want = [alice, old] if after else [old]
        check("its refund receipt follows this session on screen" in notice and on_screen(st) == want
              and on_screen(r.station(MockRelay())) == want,
              f"a stale QR paid while Alice charges ({'she ends with a refund' if after else 'she uses it all'}): "
              f"its full refund follows her session on screen{', taking turns with hers' if after else ''}, "
              "also after a restart")
        if after:
            st.on_escrow(st.mock_settle(session=old))
            check(on_screen(st) == [alice] and r.snap()["last_receipt"]["id"] == alice
                  and r.snap()["last_receipt_turn"] is None,
                  "Bob claims his: Alice's alone on screen again")

    # A restart with the station's clock far off ledger time: the receipts
    # wait for the first read of the contract, which decides.
    r = custody_rig(tmp / "clock")
    sid = r.st.session.id
    d = deposit(r, 2)
    finish_e(r, 100)
    left = d.deadline - r.unix()
    for skew in (left + 100, -(left + 100)):
        st2 = Station(r.cfg, MockRelay(), SessionLog(r.cfg.session_log), clock=r.clock, wallclock=r.clock.iso,
                      unixclock=lambda skew=skew: r.unix() + skew)
        st2.watch_escrow()
        st2.tick(r.meter.read())
        before = st2.snapshot()["last_receipt"]
        st2.on_ledger(int(r.unix()))
        st2.tick(r.meter.read())
        check(before is not None and before["id"] == sid and st2.snapshot()["last_receipt"]["id"] == sid
              and st2.snapshot()["custody"]["clock_skew"] == int(skew),
              f"restarted with its clock {abs(int(skew))} s {'ahead' if skew > 0 else 'behind'} and "
              f"{int(left)} s left to claim: the receipt is kept until ledger time is read, and stays")
    st2.on_ledger(d.deadline + 5)
    check(st2.snapshot()["last_receipt"] is None and st2.receipts == [],
          "... and ledger time past its deadline drops it, whatever the station's clock says")

    # A deposit that opens a settled session again (its old pay link) gets
    # c[0], from the waiting screen as from the session on screen.
    r = custody_rig(tmp / "reopen", **YX)
    st = r.st
    x = st.session.id
    seed = seed_of(r, x)
    deposit(r, 3)
    finish_e(r, 20)
    st.on_escrow(st.mock_settle())  # Alice claims from the waiting screen
    anchor = escrow.anchor_of(seed, r.cfg.chain_len)
    check(st.receipts == [] and x not in st.seeds, "Alice claims from the waiting screen: her receipt goes")
    deposit(r, 2, session=x, anchor=anchor, payer="GBOB")
    line = [l for l in r.records() if l.get("memo") == x][-1]
    lr = r.snap()["last_receipt"]
    check((line["kind"], line["reason"]) == ("orphan", "session already settled")
          and line["custody"]["proof"] == escrow.b64url(seed) and lr["id"] == x and lr["end_reason"] == "not_served"
          and lr["custody"]["to_payer"] == 20_000_000,
          "Bob pays her settled session's old QR (a new session on the contract): c[0], his 2 XLM back by proof")
    st2 = r.st = r.station(r.relay)
    deposit(r, 1, session=x, anchor=anchor, payer="GBOB")
    lr = st2.snapshot()["last_receipt"]
    check(lr["id"] == x and lr["custody"]["total_fichas"] == 3 and lr["custody"]["to_payer"] == 30_000_000
          and [l for l in r.records() if l.get("memo") == x][-1]["custody"]["proof"] == escrow.b64url(seed),
          "... back on screen after a restart, and his top-up then is in its c[0] too (3 XLM back)")

    # Settled is per session on the contract (ID and anchor), and in order:
    # a session opened under the same ID and anchor after a settle stays.
    r = custody_rig(tmp / "claimed", **YX)
    st = r.st
    sid = st.session.id
    d1 = deposit(r, 2)
    until(r, lambda: st.session.running)
    r.tick(20)
    st.emergency_open()
    st.on_escrow(st.mock_settle())
    st.on_escrow(replace(d1, event_id="late", tx_hash="late", fichas=1, amount=10_000_000, total_fichas=1,
                         total_amount=10_000_000))
    r.tick(r.cfg.finished_seconds)
    # A settle seen while the station did not know the session's anchor: it
    # names another anchor, and settles nothing of this station's.
    r.log.write({"kind": "settled", "id": sid, "anchor": escrow.b64url(os.urandom(32)), "how": "proof",
                 "to_payer": "1", "to_host": "0", "unused_units": 4, "op_id": "x", "tx_hash": "x"})
    lr = r.station(MockRelay()).snapshot()["last_receipt"]
    check(lr is not None and lr["id"] == sid and lr["custody"]["to_payer"] == 10_000_000
          and lr["custody"]["total_fichas"] == 1,
          "claimed on the FINISHED screen, then paid again under it: its c[0] receipt (1 XLM) is back after a "
          "restart (the settle came before it), and a settle of another anchor under the ID does not hide it")
    stranger = escrow.Settle(event_id="s9", tx_hash="s9", ledger=0, closed_at="", session="FZZZZZZZ", payer="GX",
                             to_host=1, to_payer=0, unused_units=0, how="deadline", anchor=os.urandom(32))
    st.on_escrow(stranger)
    check(("ERZGCG.FZZZZZZZ", escrow.b64url(stranger.anchor)) in st.settled_keys
          and ("ERZGCG.FZZZZZZZ", None) not in st.settled_keys,
          "a settle of a session the station does not know is kept with its anchor, never as the whole ID")

    # E between two ticks: the time consumed rounds down, for the payer.
    r = custody_rig(tmp / "round", **YX)
    st = r.st
    deposit(r, 1)
    until(r, lambda: st.session.running)
    until(r, lambda: st.session.consumed(r.clock.t) >= 44)
    r.clock.t += 0.6  # E lands 0.6 s after a tick
    st.end_session()
    last = r.snap()["last"]
    check(last["consumed_seconds"] == 44 and last["custody"]["unused_units"] == 2
          and last["custody"]["to_payer"] == 5_000_000,
          "E 44.6 s into a 60 s ficha: 44 s consumed, q = ceil(16 / 15) = 2, 0.5 XLM back (rounding up would give 1)")

    # The receipt waiting on screen is a ficha: link, which phone cameras do
    # not open: someone who came to pay cannot land on it by mistake.
    r.tick(r.cfg.finished_seconds)
    rec = r.snap()["last_receipt"]
    finished, waiting = receipt_payload(r.cfg, rec), last_receipt_qr(r.cfg, rec)["uri"]
    check(finished.startswith("https://ficha.test/r?v=2&m=") and waiting.startswith("ficha:/r?v=2&m=")
          and query(waiting) == query(finished),
          "the FINISHED screen's receipt is the APP_URL link; the one left on the waiting screen is ficha:/r?..., "
          "the same receipt, for the Ficha app's Scan QR only")


def test_custody_rechecks(tmp: Path) -> None:
    print("custody: the registry and the contract read again while running; native XLM only")
    # A deposit under other terms: refused, and no pay QR until they match.
    r = custody_rig(tmp / "terms")
    st = r.st
    sid = st.session.id
    seed = seed_of(r, sid)
    before = r.clock.t
    r.tick()
    deposit(r, 12, terms=dict(escrow.station_terms(r.cfg), unit_secs=15))
    lr = r.snap()["last_receipt"]
    oos = st.out_of_service() or ""
    check(lr["id"] == sid and lr["custody"]["proof"] == escrow.b64url(seed) and lr["custody"]["unused_units"] == 120
          and lr["custody"]["to_payer"] == 60_000_000,
          "12 fichas under unit 15 s (240 units paid): refused, c[0] proves this station's N = 120, 6 of 12 XLM "
          "back by proof (the rest by host_refund)")
    check(oos.startswith("escrow: a deposit under other terms") and "unit_secs 15 on the contract, 30 here" in oos
          and st.recheck_due and r.snap()["out_of_service"] and st.session.id != sid,
          "... and the station goes out of service at once (no pay QR for the next payer), asking for a re-read")
    st.on_recheck("escrow", None, started=before)
    check(st.out_of_service() is not None, "a re-read that started before that deposit does not bring it back")
    st.on_recheck("escrow", "REFUND_UNIT_SECONDS=30 here, unit_secs 15 on the contract", started=r.clock.t)
    check("unit_secs 15 on the contract" in st.out_of_service(), "a re-read that finds the difference: still out")
    r.tick()
    st.on_recheck("escrow", None, started=r.clock.t)
    check(st.out_of_service() is None, "a re-read that matches: back in service")

    class Contract:
        def __init__(self, terms, passphrase=Network.TESTNET_NETWORK_PASSPHRASE):
            self.terms, self.passphrase = terms, passphrase

        def network_passphrase(self):
            return self.passphrase

        def station(self):
            return self.terms

    mine = dict(TERMS, active=True)
    check(escrow.recheck(r.cfg, Contract(mine)) == []
          and escrow.recheck(r.cfg, Contract(dict(mine, unit_secs=15))) == [
              "REFUND_UNIT_SECONDS=30 here, unit_secs 15 on the contract"]
          and "inactive" in escrow.recheck(r.cfg, Contract(dict(mine, active=False)))[0]
          and "not registered" in escrow.recheck(r.cfg, Contract(None))[0]
          and "another network" in escrow.recheck(r.cfg, Contract(mine, Network.PUBLIC_NETWORK_PASSPHRASE))[0],
          "escrow.recheck: the startup check again, short (other terms, inactive, not registered, another network)")

    # The registry read again: a registry published with another contract.
    kp = Keypair.random()
    root = Path(__file__).resolve().parent
    doc = json.loads((root / "registry" / "stations.json").read_bytes())
    entry = next(s for s in doc["stations"] if s["id"] == "ERZGCG")
    cfg = replace(r.cfg, host_public_key=entry["host_key"], registry_key=kp.public_key,
                  registry_file=tmp / "missing.json", escrow_contract=entry["escrow"])

    def site(escrow_id: str):
        raw = json.dumps(dict(doc, stations=[dict(entry, escrow=escrow_id)])).encode()
        return lambda url: (raw, json.dumps(registry.sign_bytes(raw, kp)).encode())

    def offline(url: str):
        raise registry_check.Unavailable("ConnectError")

    other = "CDC7XU5PNLVM7AJ6SPDDTPUGC67BJ72KKIZOFHG2GGLIL277BIZZGL4K"  # the retired deployment
    try:
        registry_check.recheck(cfg, site(other))
        short = ""
    except registry_check.Mismatch as exc:
        short = exc.short
    check(registry_check.recheck(cfg, site(entry["escrow"])) == {"status": "ok", "detail": "site"}
          and short == f"ESCROW_CONTRACT={entry['escrow']} here, escrow {other} in the registry"
          and registry_check.recheck(cfg, offline) == {"status": "unchecked", "detail": "no copy found"}
          and registry_check.recheck(replace(cfg, payment_mode="direct"), site(other))["status"] == "off",
          "registry_check.recheck: the startup check again; a registry naming another escrow is a mismatch (short, "
          "for the footer); offline, nothing new; direct mode is not re-read")

    # main.py runs both every minute, in a thread, and the footer says why.
    env = {"PAYMENT_MODE": "custody", "STATION_ID": "ERZGCG", "ESCROW_CONTRACT": ESCROW, "APP_URL": "https://ficha.test",
           "REGISTRY_CHECK": "false"}
    checked = escrow.check
    escrow.check = lambda cfg: {"status": "unchecked", "detail": "RPC unreachable"}
    try:
        main = import_main(tmp, env, reload=True)
    finally:
        escrow.check = checked
    saved = registry_check.recheck, escrow.recheck

    def run(reg, esc) -> dict:
        registry_check.recheck, escrow.recheck = reg, esc
        try:
            asyncio.run(main.recheck_once())
        finally:
            registry_check.recheck, escrow.recheck = saved
        return main.snapshot()

    def moved(cfg):
        raise registry_check.Mismatch("long", f"ESCROW_CONTRACT={ESCROW} here, escrow {other} in the registry")

    def down(cfg, ledger):
        raise httpx.ConnectError("down")

    main.station.on_ledger(int(time.time()))
    s = run(moved, lambda cfg, ledger: [])
    check(s["registry"] == {"status": "mismatch", "detail": f"ESCROW_CONTRACT={ESCROW} here, escrow {other} in the "
                                                            "registry"}
          and s["out_of_service"].startswith("registry: ESCROW_CONTRACT=") and s["escrow"]["check"] == "ok"
          and not main.station.recheck_due,
          "main.py: a registry re-read that names another contract puts the station out of service (no pay QR), "
          "the footer says why; the contract re-read that matches turns 'unchecked' into 'ok'")
    s = run(lambda cfg: {"status": "unchecked", "detail": "no copy found"}, down)
    check(s["registry"]["status"] == "mismatch" and s["out_of_service"],
          "a re-read that cannot reach the registry or the RPC changes nothing")
    s = run(lambda cfg: {"status": "ok", "detail": "site"},
            lambda cfg, ledger: ["FICHA_PRICE=1 (10000000 stroops) here, price 20000000 on the contract"])
    check(s["registry"] == {"status": "ok", "detail": "site"} and s["escrow"]["check"] == "mismatch"
          and "price 20000000" in s["escrow"]["mismatch"] and s["out_of_service"].startswith("escrow: FICHA_PRICE"),
          "the registry matches again; the contract now holds another price: out of service, the escrow item says it")
    s = run(lambda cfg: {"status": "ok", "detail": "site"}, lambda cfg, ledger: [])
    check(s["out_of_service"] is None and s["escrow"]["mismatch"] is None, "both match again: back in service")
    html = (Path(__file__).resolve().parent / "static" / "index.html").read_text(encoding="utf-8")
    check('rg.status === "mismatch" ? "bad"' in html and '"mismatch: " + es.mismatch' in html
          and "main.recheck" not in html and main.RECHECK_SECONDS == 60.0,
          "the screen: a registry or contract that no longer matches is a red footer item; re-read every 60 s")

    # MOCK: U unplugs the simulated phone and plugs it back in.
    client = TestClient(main.app, base_url="http://127.0.0.1:8000")
    with client.websocket_connect("/ws", headers={"host": "127.0.0.1:8000"}) as ws:
        first = ws.receive_json()
        ws.send_json({"key": "u"})
        out = ws.receive_json()
        ws.send_json({"key": "u"})
        back = ws.receive_json()
    check((first["mock_plug"], out["mock_plug"], back["mock_plug"]) == ("station", "none", "station")
          and "unplugged" in out["notice"] and "plugged back" in back["notice"]
          and "body.mock.s-CHARGING .keys .k-u" in html and '<kbd>U</kbd>' in html and 'send("u")' in html,
          "MOCK: the U key unplugs the simulated phone and plugs it back in (the demo's pause without hardware); "
          "shown in the header while charging")

    # Custody takes native XLM only: an issuer could freeze or claw back.
    custody_entry = dict(entry, asset={"code": "FCH", "issuer": entry["host_key"]})
    direct_entry = {k: v for k, v in custody_entry.items() if k not in registry_format.CUSTODY_FIELDS + ("mode",)}
    try:
        registry_format.validate_doc(dict(doc, stations=[custody_entry]))
        msg = ""
    except registry_format.RegistryError as exc:
        msg = str(exc)
    registry_format.validate_doc(dict(doc, stations=[direct_entry]))
    refused(replace(r.cfg, asset_code="USDC", asset_issuer=HOST), "custody with an issued asset")
    check("native XLM only" in msg, "custody takes native XLM only: an issued asset is refused in the registry and "
                                   "in .env (direct stations keep any asset)")


def test_ledger_reset(tmp: Path) -> None:
    print("a testnet reset: the saved Horizon cursor starts over")
    (tmp / "h").mkdir()
    r = Rig(tmp / "h", station_id="K7M2QX", cursor_dir=tmp / "h")
    started = datetime(2026, 12, 1, tzinfo=timezone.utc)
    r.cfg.cursor_file.write_text(str((5_000_000 << 32) | 4096))
    tokens = [str((40_000 << 32) | 4096), str((49_000 << 32) | 4096)]
    records = [horizon_payment(tokens[0], "2026-12-17T10:00:00Z"),
               horizon_payment(tokens[1], "2026-12-17T11:00:00Z", r.st.session.id)]
    inner = horizon_mock(records)
    roots: list[int] = []
    latest = 50_000

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/":
            roots.append(latest)
            return httpx.Response(200, json={"history_latest_ledger": latest})
        return inner.handle_request(request)

    def run(w: HorizonWatcher) -> None:
        async def go():
            async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
                await w.poll(client)
        asyncio.run(go())

    w = HorizonWatcher(r.cfg, r.st.on_payment, now=lambda: started)
    run(w)
    check(len(roots) == 1 and w.cursor == tokens[1] and r.cfg.cursor_file.read_text() == tokens[1]
          and r.st.state == State.CHARGING and r.records()[-1]["tx_hash"] == "h" + tokens[1],
          "a cursor in ledger 5 000 000, the network's latest 50 000 (reset): it starts over, and the payment "
          "made after the reset is credited")
    run(w)
    check(len(roots) == 1 and w.health()["status"] == "ok", "checked at most once a minute")
    near = str((50_500 << 32) | 4096)
    r.cfg.cursor_file.write_text(near)
    w2 = HorizonWatcher(r.cfg, r.st.on_payment, now=lambda: started)
    run(w2)
    check(len(roots) == 2 and w2.cursor == near, "a cursor a few hundred ledgers ahead (a lagging server): kept")


def test_registry_rules(tmp: Path) -> None:
    print("registry: custody on testnet only; the grace a station needs")
    root = Path(__file__).resolve().parent
    doc = json.loads((root / "registry" / "stations.json").read_bytes())
    custody_entry = doc["stations"][0]
    direct_entry = {k: v for k, v in custody_entry.items() if k not in registry_format.CUSTODY_FIELDS + ("mode",)}
    public = dict(doc, network="public")
    try:
        registry_format.validate_doc(dict(public, stations=[custody_entry]), "stations.public.json")
        msg = ""
    except registry_format.RegistryError as exc:
        msg = str(exc)
    registry_format.validate_doc(dict(public, stations=[direct_entry]), "stations.public.json")
    check(custody_entry["mode"] == "custody" and "testnet only" in msg,
          "a custody entry in the public registry is refused (no station could run it, no app could pay it); "
          "a direct one is valid")
    short = dict(custody_entry, grace_seconds=600)
    notes = registry_format.notes(dict(doc, stations=[short, custody_entry]))
    registry_format.validate_doc(dict(doc, stations=[short]))
    check(len(notes) == 1 and "1080" in notes[0] and config.DEFAULT_PLUG_TIMEOUT_SECONDS == 180
          and load_env().plug_timeout_seconds == 180,
          "grace_seconds 600: valid on the contract and in the registry, but noted: a station needs 900 + "
          "PLUG_TIMEOUT_SECONDS = 1080")
    path = tmp / "stations.json"
    raw = json.dumps(dict(doc, stations=[short]), indent=2).encode()
    path.write_bytes(raw)
    registry_format.sig_path(path).write_text(json.dumps(registry.sign_bytes(raw, Keypair.random())))
    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        code = registry.main(["verify", "--file", str(path)])
    check(code == 0 and "note: station" in out.getvalue() and "1080" in out.getvalue(),
          "tools/registry.py verify (and sign) prints the note")


def test_custody_screens(tmp: Path) -> None:
    print("custody: screens (main.py)")
    main = sys.modules.get("main") or import_main(tmp)
    s = main.snapshot()
    check(s["mode"] == "direct" and s["escrow"] is None and s["last_receipt"] is None
          and s["uri"].startswith("web+stellar:pay?destination="), "main.py in direct mode: SEP-0007, no escrow")
    env = {"PAYMENT_MODE": "custody", "STATION_ID": "ERZGCG", "ESCROW_CONTRACT": ESCROW, "APP_URL": "https://ficha.test",
           "REGISTRY_CHECK": "false"}
    checked = escrow.check
    escrow.check = lambda cfg: {"status": "unchecked", "detail": "RPC unreachable"}
    try:
        main = import_main(tmp, env, reload=True)
    finally:
        escrow.check = checked
    s = main.snapshot()
    st = main.station
    check(s["mode"] == "custody" and s["uri"] == escrow.pay_link(main.cfg, st.session.id, st.session.anchor)
          and s["escrow"] == {"status": "starting", "detail": "", "check": "unchecked", "mismatch": None,
                              "contract": "CBRN…6KYC"}
          and main.escrow_watcher and s["finished_seconds"] == 60,
          "main.py in custody: the pay link QR, the escrow footer ('unchecked', the contract's short ID)")
    client = TestClient(main.app, base_url="http://127.0.0.1:8000")
    post = lambda path, body: client.post(path, content=json.dumps(body), headers={"content-type": "application/json"})
    check(post("/debug/pay", {"fichas": 13}).status_code == 400 and post("/debug/pay", {"anchor": "x"}).status_code == 400
          and post("/debug/settle", {}).status_code == 404 and st.state == State.AWAITING_PAYMENT,
          "/debug/pay refuses what the contract refuses (13 fichas, a bad anchor); /debug/settle with no receipt: 404")
    resp = post("/debug/pay", {"fichas": 2})
    check(resp.status_code == 200 and st.state == State.CHARGING and st.session.chain_fichas == 2,
          "/debug/pay in custody: a deposit event with the session's anchor, credited")
    st.emergency_open()
    s = main.snapshot()
    check(query(s["receipt"]["uri"])["v"] == "2" and "q" in query(s["receipt"]["uri"]),
          "the FINISHED screen shows receipt v2")
    resp = post("/debug/settle", {})
    check(resp.status_code == 200 and resp.json()["to_payer"] == 20_000_000
          and main.snapshot()["last"]["custody"]["settled"]["how"] == "proof",
          "/debug/settle: the claim's settle event (nothing charged: all 2 XLM back)")
    html = (Path(__file__).resolve().parent / "static" / "index.html").read_text(encoding="utf-8")
    check(all(t in html for t in ('id="lastqr"', "has-last", 'dot("escrow"', "comes back with the receipt.",
                                  "Pay with the Ficha app", "custodyRefund(last, d)")),
          "the screen: the last receipt QR while waiting, the escrow dot, custody refund texts")
    check(all(t in html for t in ('"Previous customer: "', '"Not a pay QR: open it with Scan QR in the Ficha app. '
                                  'Only the wallet that paid "', "border-style: dashed")),
          "the last receipt is labelled the previous customer's, not a pay QR (open it with the app's Scan QR), "
          "and set apart (dashed)")
    check("getHours" not in html and "claimLeft(lr.deadline, d)" in html and "claimLeft(c.deadline, d)" in html
          and "d.custody.ledger_time" in html and isinstance(main.snapshot()["custody"]["ledger_time"], int),
          "deadlines as minutes left from ledger time, never a time of day (this computer's zone or clock)")
    check(all(t in html for t in ('id="sumchain"', '"on Stellar · escrow "', '" · deposit tx "', '" · settle tx "',
                                  "es.contract", '" min " + (skew > 0 ? "ahead" : "behind")')),
          "custody evidence on screen: the contract in the footer, the deposit and settle transactions on the "
          "FINISHED screen; a station clock off ledger time shows as a warning")
    check(main.station.escrow_watched and main.escrow_watcher.on_read == main.station.on_ledger
          and "escrow" in (main.snapshot()["out_of_service"] or ""),
          "main.py: the watcher's reads reach the station; no pay QR until the contract is read")


def import_main(tmp: Path, extra: dict | None = None, reload: bool = False):
    """main.py builds its station when imported, from config.load(): here it
    loads os.devnull instead of the real .env, with a mock relay and a log in tmp."""
    env = {"MOCK": "true", "MOCK_PAYMENT": "true", "HOST_PUBLIC_KEY": HOST,
           "SESSION_LOG": str(tmp / "main.jsonl"), "CURSOR_DIR": str(tmp), **(extra or {})}
    saved = {k: os.environ.get(k) for k in env}
    os.environ.update(env)
    load = config.load
    config.load = lambda env_file=None: load(env_file=os.devnull)
    try:
        main = importlib.reload(sys.modules["main"]) if reload and "main" in sys.modules \
            else importlib.import_module("main")
    finally:
        config.load = load
        for k, v in saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
    logging.getLogger().setLevel(logging.WARNING)  # main turns INFO on
    return main


def test_screens(tmp: Path) -> None:
    print("screens (main.py)")
    main = import_main(tmp)

    class Stalled:
        """A screen that stopped reading: its buffers are full, a send never ends."""
        closed = False

        async def send_text(self, text: str) -> None:
            await asyncio.Event().wait()

        async def close(self, code: int = 1000, reason: str | None = None) -> None:
            self.closed = True

    class Reader:
        got = 0

        async def send_text(self, text: str) -> None:
            self.got += 1

    stalled, reader = Stalled(), Reader()
    ticks: list[float] = []
    tick = main.station.tick
    main.station.tick = lambda reading: (ticks.append(1), tick(reading))

    async def run() -> None:
        main.clients.update({stalled, reader})
        main.SEND_TIMEOUT = 60.0
        hb = asyncio.create_task(main.heartbeat())
        await asyncio.sleep(1.3)
        hb.cancel()
        check(len(ticks) == 2 and reader.got == 2,
              "a screen that never reads does not stop the heartbeat (countdown, relay) or the other screens")
        main.SEND_TIMEOUT = 0.05
        main.broadcast()
        await asyncio.sleep(0.2)
        check(stalled not in main.clients and stalled.closed and reader in main.clients and reader.got == 3,
              "a screen that misses the send deadline is dropped and closed (a hung page reconnects)")

    try:
        asyncio.run(run())
    finally:
        del main.station.tick
        main.clients.clear()
        main.SEND_TIMEOUT = 1.0

    client = TestClient(main.app, base_url="http://127.0.0.1:8000")  # no lifespan: no heartbeat, no Horizon
    # Zero CDN: the screen renders offline, so all it loads comes from this station.
    html = (Path(__file__).resolve().parent / "static" / "index.html").read_text(encoding="utf-8")
    refs = re.findall(r"""(?:\b(?:src|href)=["']|url\(["']?)([^"')]*)""", html)
    local = [u for u in refs if u.startswith("/static/")]
    check(all(u.startswith(("/static/", "data:")) for u in refs) and "@import" not in html
          and all(client.get(u).status_code == 200 for u in local),
          f"the screen loads nothing from another host: {len(local)} files, all served from /static")
    check(all(client.get(p).status_code == 404 for p in ("/static/", "/static/fonts/", "/static/%2e%2e/main.py")),
          "/static lists no folder and serves nothing outside static/")
    for origin, host in (("https://evil.example", None), ("null", None), ("http://127.0.0.1:8000.evil.example", None),
                         # DNS rebinding: a name of the attacker's that resolves to 127.0.0.1
                         ("http://rebind.example:8000", "rebind.example:8000"), (None, "rebind.example:8000")):
        # websocket_connect() says Host: testserver unless told otherwise
        headers = {k: v for k, v in (("origin", origin), ("host", host or "127.0.0.1:8000")) if v}
        try:
            with client.websocket_connect("/ws", headers=headers):
                pass
            check(False, f"/ws with {headers} refused")
        except WebSocketDisconnect as exc:
            if exc.code != 1008:
                check(False, f"/ws with {headers} refused with 1008, not {exc.code}")
    check(main.station.state == State.AWAITING_PAYMENT, "/ws from another origin (or null), or to a Host that is "
          "not an IP address or localhost (DNS rebinding) refused: a page on another site cannot press ESC or C")
    for origin, host in (("http://127.0.0.1:8000", None), (None, None), ("http://localhost:8000", "localhost:8000"),
                         ("http://[::1]:8000", "[::1]:8000"), ("http://192.168.0.10:8000", "192.168.0.10:8000")):
        headers = {k: v for k, v in (("origin", origin), ("host", host or "127.0.0.1:8000")) if v}
        with client.websocket_connect("/ws", headers=headers) as ws:
            first = ws.receive_json()
            ws.send_json({"key": "c"})
            ws.receive_json()
            state = main.station.state
            ws.send_json({"key": "escape"})
            ws.receive_json()
        check(first["state"] == "AWAITING_PAYMENT" and state == State.COURTESY,
              f"/ws from {origin or 'no Origin (not a browser)'} to {host or '127.0.0.1:8000'}: accepted, keys work")
        main.station.cooldown_until = 0.0
    html = (Path(__file__).resolve().parent / "static" / "index.html").read_text(encoding="utf-8")
    check('(e.key === "c" || e.key === "C") && !e.ctrlKey && !e.metaKey && !e.altKey && !e.repeat' in html,
          "Ctrl+C on the page (copying the session ID), Alt/Cmd+C or a held C key does not start a courtesy")
    check(main.snapshot()["registry"] == {"status": "off", "detail": "no STATION_ID"}
          and 'id="d-registry"' in html and 'dot("registry"' in html,
          "the footer shows the registry check (off here: no STATION_ID)")

    body = '{"amount": "3"}'
    r = client.post("/debug/pay", content=body, headers={"content-type": "text/plain", "origin": "https://evil.example"})
    check(r.status_code == 415 and main.station.session.fichas == 0,
          "/debug/pay as text/plain (a cross-site POST with no preflight): refused, nothing credited")
    for headers in ({"host": "rebind.example:8000"}, {"origin": "https://evil.example"}):
        r = client.post("/debug/pay", content=body, headers={"content-type": "application/json", **headers})
        check(r.status_code == 403 and main.station.session.fichas == 0,
              f"/debug/pay with {headers}: refused, nothing credited")
    r = client.post("/debug/pay", content=body, headers={"content-type": "application/json; charset=utf-8"})
    check(r.status_code == 200 and main.station.session.fichas == 3, "/debug/pay as application/json: credited")
    with client.websocket_connect("/ws", headers={"host": "127.0.0.1:8000"}) as ws:
        ws.receive_json()
        ws.send_json({"key": "e"})
        ws.receive_json()
    check(main.station.state == State.FINISHED and main.station.session.end_reason == "stopped"
          and main.station.relay.is_open, "/ws key E: the session ends as 'stopped' (direct mode too)")
    main.station.emergency_open()


def test_meter_sign(tmp: Path) -> None:
    print("ADB meter: the current's sign is learned while discharging and holds under load")
    from meter import AdbMeter

    def bare_meter() -> AdbMeter:  # the normalization only; no adb behind it
        m = AdbMeter.__new__(AdbMeter)
        m.scale, m.unit_ua, m._sign_votes = None, None, 0
        return m

    m = bare_meter()  # a phone that reports positive while charging
    for _ in range(3):
        m._normalize(-500_000, "Discharging")  # the relay open at startup
    check(m.sign_known() and m._sign() == 1, "relay open at startup: the sign is learned (normal)")
    loaded = [m._normalize(-400_000, "Charging") for _ in range(60)]
    check(m._sign() == 1 and loaded[-1] == -400,
          "a minute of 'Charging' while net negative (screen recording on a weak charger): "
          "the sign never flips, the reading stays honestly negative")
    check(m._normalize(700_000, "Charging") == 700, "charging current reads positive")
    for _ in range(3):
        m._normalize(600_000, "Discharging")  # the gauge lags a probe by a few seconds
    check(m._sign() == 1, "a probe's few lagging readings cannot flip a known sign")

    inv = bare_meter()  # a phone that reports negative while charging
    for _ in range(3):
        inv._normalize(450_000, "Discharging")
    check(inv.sign_known() and inv._sign() == -1 and inv._normalize(-700_000, "Charging") == 700,
          "an inverted phone is learned while discharging, and its charging reads positive")

    cold = bare_meter()  # started while already on a charger: nothing to learn from
    for _ in range(20):
        cold._normalize(-800_000, "Charging")
    check(not cold.sign_known() and cold._sign() == 1,
          "'Charging' readings alone never calibrate the sign")


def test_charger_plugged(tmp: Path) -> None:
    print("charge verification from the phone's own charger status: net negative under load still charges here")

    def run_until(r: Rig, cond, meter, limit: int = 400) -> int:
        for n in range(1, limit + 1):
            r.tick(meter=meter)
            if cond():
                return n
        check(False, f"reached within {limit} ticks")
        return limit

    # 1. This station's charger, the battery net negative all along (a screen
    #    recording on a weak cable): the phone says a charger is attached
    #    exactly while this station's relay is closed.
    (tmp / "load").mkdir()
    r = Rig(tmp / "load", charge_verify=True)
    st = r.st
    here = lambda: (-300, 3900, True, not r.relay.is_open)
    r.pay("2")
    n = run_until(r, lambda: phase(r) == "checking", here)
    check(n <= 2, "plugged in at -300 mA net with a charger attached: the probe starts at once")
    run_until(r, lambda: st.session.running, here, limit=r.cfg.probe_seconds + 5)
    check(st.session.verified and (st.session.probes_passed, st.session.probes_failed) == (1, 0),
          "the charger went away while the relay was open: verified as this station's")
    r.tick(60, meter=here)
    s = r.snap()
    check(phase(r) == "running" and s["charge"]["consumed_seconds"] >= 59 and s["delivering"],
          "a minute at -300 mA net: counted, delivering, never paused")
    gone = lambda: (-900, 3800, True, False)
    r.tick(r.cfg.pause_grace_seconds + 2, meter=gone)
    check(phase(r) == "paused", "unplugged (no charger attached): paused after the grace")
    run_until(r, lambda: st.session.running, here)
    check(st.session.probes_passed >= 2, "plugged back in here: a probe passes and the countdown runs again")
    r.tick(10, meter=here)
    st.end_session()
    r.tick(3, meter=here)
    rec = st.snapshot()["last"]
    cut = st.session.cut or {}
    check(rec["verdict"] == "delivered" and cut.get("confirmed") and cut.get("method") == "charger_gone",
          "ended with E: delivered, the cut confirmed by the phone's charger going away")

    # 2. Another charger, also net negative: still attached with the relay
    #    open, so the probe fails and nothing is consumed.
    (tmp / "other").mkdir()
    r = Rig(tmp / "other", charge_verify=True)
    st = r.st
    other = lambda: (-300, 3900, True, True)
    r.pay("1")
    run_until(r, lambda: phase(r) == "checking", other)
    r.tick(r.cfg.probe_seconds + 1, meter=other)
    check(st.session.probes_failed == 1 and not st.session.verified and st.session.consumed(r.clock.t) == 0,
          "a charger still attached with the relay open: another charger's, the probe fails, nothing consumed")

    # 3. The gauge lagging a probe: current still reads high for the first
    #    seconds, but the phone already says its charger is gone.
    (tmp / "lag").mkdir()
    r = Rig(tmp / "lag", charge_verify=True)
    st = r.st
    lag = {"n": 0}

    def lagging():
        if r.relay.is_open:
            lag["n"] += 1
            return (600 if lag["n"] <= 2 else -500, 3900, True, False)
        lag["n"] = 0
        return (600, 3900, True, True)
    r.pay("1")
    run_until(r, lambda: st.session.running, lagging)
    check(st.session.probes_passed == 1 and st.session.probes_failed == 0,
          "a gauge still reading 600 mA in the probe's first seconds: the charger status decides, pass")

    # 4. A meter that cannot tell (3-field readings) keeps the current rules.
    (tmp / "old").mkdir()
    r = Rig(tmp / "old", charge_verify=True)
    st = r.st
    r.pay("1")
    r.tick(r.cfg.plug_timeout_seconds + 5, meter=lambda: (-300, 3900, True))
    check(st.state == State.FINISHED and st.snapshot()["last"]["end_reason"] == "not_plugged",
          "without a charger status, -300 mA is still 'not charging here': the plug-in time runs out")


# -- free emergency minutes and the Wi-Fi portal (docs/free-minutes.md) ------------------
MAC1, MAC2 = "aa:bb:cc:dd:ee:01", "aa:bb:cc:dd:ee:02"
PHONE1, PHONE2, ROUTER = "192.168.8.20", "192.168.8.21", "192.168.8.1"
STATION_LAN = "192.168.8.10:8030"
EMERGENCY = (("Emergency", "112"),)


def free_rig(tmp: Path, **overrides) -> Rig:
    return Rig(tmp, **{"wifi_portal": "simulate", "free_charge_seconds": 120, "free_internet_seconds": 120,
                       "emergency_numbers": EMERGENCY, "cursor_dir": tmp, **overrides})


def mac_forms(mac: str) -> list[str]:
    """Every way a MAC could be written into a file."""
    bare = mac.replace(":", "")
    return [mac, mac.upper(), mac.replace(":", "-"), mac.replace(":", "-").upper(), bare, bare.upper()]


def files_text(*dirs: Path) -> str:
    return "\n".join(p.read_text(encoding="utf-8", errors="replace")
                     for d in dirs for p in d.rglob("*") if p.is_file())


def test_free_off(tmp: Path) -> None:
    print("free emergency minutes: off by default, the station as before")
    cfg = load_env(MOCK="true", MOCK_PAYMENT="true", HOST_PUBLIC_KEY=HOST)
    check(cfg.wifi_portal == "off" and cfg.free_charge_seconds == 0 and cfg.free_internet_seconds == 0
          and cfg.free_reset == "midnight" and cfg.emergency_numbers == () and not cfg.free_on,
          "defaults: WIFI_PORTAL=off, no free charge, no free internet, no emergency numbers")
    r = Rig(tmp)
    st = r.st
    check(st.free_charge_refusal() == "charge_off" and not st.free_charge() and st.state == State.AWAITING_PAYMENT
          and r.relay.is_open, "no free charge when off: the relay stays open")
    check(st.courtesy() and st.state == State.COURTESY and not st.session.free_charge, "C: the courtesy as before")
    r.tick(60)
    check(st.state == State.AWAITING_PAYMENT and st.cooldown_until > r.clock.t,
          "the courtesy still starts the operator's cooldown")
    check(st.courtesy() is False and "available again" in r.snap()["notice"], "and C waits for it, as before")
    r.tick(300)
    st.courtesy()
    rec = [x for x in r.records() if x["kind"] == "session"][-1]
    check(rec["end_reason"] == "courtesy_only" and "free_charge" not in rec,
          "a courtesy-only session is logged exactly as before (no free_charge key)")
    check(not list(tmp.glob(".free_minutes*")), "no day file, no salt on disk when off")

    main = import_main(tmp, reload=True)
    snap = main.snapshot()
    client = TestClient(main.app, base_url="http://127.0.0.1:8000")
    lan = TestClient(main.app, base_url="http://192.168.0.10:8000", client=("192.168.0.30", 50000))
    check(main.free is None and "free" not in snap and "emergency" not in snap,
          "main.py off: no ledger, the screen's state has no free or emergency keys")
    check(client.get("/portal").status_code == 404 and client.post("/portal/charge").status_code == 404
          and client.post("/portal/internet").status_code == 404, "off: no /portal, /portal/charge, /portal/internet")
    check(lan.get("/").status_code == 200 and "<title>Ficha</title>" in lan.get("/").text,
          "off: the station screen answers any address it always did")
    html = (Path(__file__).resolve().parent / "static" / "index.html").read_text(encoding="utf-8")
    check("if (fr || em.length)" in html and 'body.sos-on .sos { display: flex; }' in html
          and ".sos { display: none;" in html,
          "the screen's emergency band shows only when the station sends free minutes or numbers")


def test_free_config(tmp: Path) -> None:
    print("free emergency minutes: configuration")
    base = {"MOCK": "true", "MOCK_PAYMENT": "true", "HOST_PUBLIC_KEY": HOST, "CURSOR_DIR": str(tmp)}
    cfg = load_env(**{**base, "WIFI_PORTAL": "simulate", "FREE_CHARGE_SECONDS": "120", "FREE_INTERNET_SECONDS": "120",
                      "EMERGENCY_NUMBERS": "Polícia 190; Ambulância 192, Bombeiros 193"})
    check(cfg.free_on and cfg.wifi_portal == "simulate" and (cfg.free_charge_seconds, cfg.free_internet_seconds)
          == (120, 120) and cfg.emergency_numbers == (("Polícia", "190"), ("Ambulância", "192"), ("Bombeiros", "193")),
          "WIFI_PORTAL=simulate, 120 s each, EMERGENCY_NUMBERS as 'label number' pairs (; or ,)")
    check(load_env(**{**base, "WIFI_PORTAL": "simulate", "EMERGENCY_NUMBERS": "112"}).emergency_numbers
          == (("", "112"),), "a bare number is accepted (no label)")

    def refused_env(what: str, **env: str) -> str:
        try:
            load_env(**{**base, **env})
        except config.ConfigError as exc:
            return str(exc)
        check(False, f"refused: {what}")
        return ""

    lan = {"MOCK_PAYMENT": "false", "HOST": "0.0.0.0", "EMERGENCY_NUMBERS": "Emergency 112"}
    cases = [
        ("free minutes with WIFI_PORTAL=off (a device is known only through the portal)",
         {"FREE_CHARGE_SECONDS": "120"}, "WIFI_PORTAL"),
        ("negative free seconds", {"WIFI_PORTAL": "simulate", "EMERGENCY_NUMBERS": "112",
                                   "FREE_CHARGE_SECONDS": "-1"}, "FREE_CHARGE_SECONDS"),
        ("more than an hour a day", {"WIFI_PORTAL": "simulate", "EMERGENCY_NUMBERS": "112",
                                     "FREE_INTERNET_SECONDS": "3601"}, "FREE_INTERNET_SECONDS"),
        ("an unknown WIFI_PORTAL", {"WIFI_PORTAL": "captive"}, "WIFI_PORTAL"),
        ("FREE_RESET=rolling (it would link a phone across two salts)", {"FREE_RESET": "rolling"}, "salt"),
        ("an unknown FREE_RESET", {"FREE_RESET": "noon"}, "FREE_RESET"),
        ("a portal without EMERGENCY_NUMBERS", {"WIFI_PORTAL": "simulate"}, "EMERGENCY_NUMBERS"),
        ("an entry with no number", {"WIFI_PORTAL": "simulate", "EMERGENCY_NUMBERS": "Emergency"}, "label number"),
        ("an entry with letters in the number", {"EMERGENCY_NUMBERS": "Police 19O"}, "label number"),
        ("seven numbers", {"EMERGENCY_NUMBERS": "; ".join(f"N{i} 11{i}" for i in range(7))}, "at most 6"),
        ("a label over 32 characters", {"EMERGENCY_NUMBERS": "x" * 33 + " 112"}, "32"),
        ("opennds on a loopback HOST (phones could not reach the portal)",
         {"WIFI_PORTAL": "opennds", "EMERGENCY_NUMBERS": "112"}, "HOST"),
        ("opennds without WIFI_SSID (the join QR)", {"WIFI_PORTAL": "opennds", **lan}, "WIFI_SSID"),
        ("opennds with MOCK_PAYMENT (free payments from the Wi-Fi)",
         {"WIFI_PORTAL": "opennds", **lan, "MOCK_PAYMENT": "true", "WIFI_SSID": "Ficha", "WIFI_SECURITY": "nopass"},
         "MOCK_PAYMENT"),
    ]
    for what, env, says in cases:
        msg = refused_env(what, **env)
        if says not in msg:
            check(False, f"refusing {what}, the message names {says!r}: {msg}")
    check(True, f"{len(cases)} nonsense settings refused, each saying what to change")
    cfg = load_env(**{**base, **lan, "WIFI_PORTAL": "opennds", "WIFI_SSID": "Ficha SOS", "WIFI_SECURITY": "nopass",
                      "FREE_CHARGE_SECONDS": "120", "FREE_INTERNET_SECONDS": "120"})
    check(cfg.wifi_portal == "opennds" and cfg.host == "0.0.0.0", "opennds on 0.0.0.0 with WIFI_SSID: accepted")

    from dotenv import dotenv_values
    root = Path(__file__).resolve().parent
    examples = {name: dotenv_values(root / name) for name in
                (".env.example", ".env.lisbon.example", ".env.mains.example", ".env.usbvbus.example")}
    check(all(e.get("WIFI_PORTAL") == "simulate" and e.get("FREE_CHARGE_SECONDS") == "120"
              and e.get("FREE_INTERNET_SECONDS") == "120" and e.get("EMERGENCY_NUMBERS") == "Emergency 112"
              for e in examples.values()),
          "the demo .env examples turn it on: simulate, 2 min + 2 min, Lisbon's 112")
    text = (root / ".env.example").read_text(encoding="utf-8")
    check("# EMERGENCY_NUMBERS='Polícia 190; SAMU 192; Bombeiros 193'" in text and "FREE_RESET=midnight" in text
          and "WIFI_PORTAL=opennds" in text, ".env.example: a commented Brazil example, the reset, the router mode")


def test_free_ledger(tmp: Path) -> None:
    print("free emergency minutes: the daily salt, the ledger, no MAC on disk")
    from freeminutes import FreeMinutes, Refused, local_day, normalise_mac
    check(normalise_mac("AA-BB-CC-DD-EE-01") == MAC1 == normalise_mac("aabb.ccdd.ee01") == normalise_mac(MAC1.upper()),
          "a MAC in any notation is one device")
    check(all(normalise_mac(m) is None for m in ("00:00:00:00:00:00", "ff:ff:ff:ff:ff:ff", "01:00:5e:00:00:01",
                                                 "aa:bb:cc:dd:ee", "zz:bb:cc:dd:ee:01", "", "aa:bb:cc:dd:ee:01:02")),
          "zero, broadcast, multicast and malformed addresses are no device")
    cfg = free_rig(tmp).cfg
    now = {"t": float(EPOCH)}
    salts = iter(bytes([i]) * 32 for i in range(1, 10))
    fm = FreeMinutes(cfg, clock=lambda: now["t"], salt_factory=lambda: next(salts))
    day1 = local_day(now["t"])
    id1 = fm.device_id(MAC1)
    check(re.fullmatch(r"[0-9a-f]{16}", id1) and id1 == fm.device_id(MAC1) and id1 != fm.device_id(MAC2),
          "a device's id of the day: 16 hex digits, the same all day, one per device")
    check(fm.grant(MAC1, "charge") == (id1, 120) and fm.used_today(MAC1) == {"charge": True, "internet": False},
          "the free charge granted: all 120 s at once")
    try:
        fm.grant(MAC1, "charge")
        check(False, "a second free charge the same day is refused")
    except Refused as exc:
        check(exc.code == "used", "a second free charge the same day: refused (used)")
    check(fm.grant(MAC1, "internet") == (id1, 120) and fm.grant(MAC2, "charge")[1] == 120,
          "the free internet is its own allowance; another device has its own")
    again = FreeMinutes(cfg, clock=lambda: now["t"], salt_factory=lambda: next(salts))
    check(again.used_today(MAC1) == {"charge": True, "internet": True} and again.device_id(MAC1) == id1,
          "a restart the same day: the same salt, nothing granted twice")
    path1 = fm.path()
    check(path1.exists() and path1.name == f".free_minutes.{day1}.json", "one file per day in CURSOR_DIR")

    now["t"] += 86_400
    id2 = again.device_id(MAC1)
    day2 = local_day(now["t"])
    files = sorted(p.name for p in tmp.glob(".free_minutes*"))
    check(id2 != id1 and files == [f".free_minutes.{day2}.json"],
          "the next day: a new salt, a new id for the same phone; the old day's file (its salt) deleted")
    check((bytes([1]) * 32).hex() not in files_text(tmp) and id1 not in files_text(tmp),
          "no file keeps yesterday's salt or ids: yesterday's ids can no longer be traced to a MAC, or linked to today's")
    check(again.used_today(MAC1) == {"charge": False, "internet": False} and again.grant(MAC1, "charge")[1] == 120,
          "the allowance starts over at the reset (local midnight)")
    text = files_text(tmp)
    check(not any(form in text for m in (MAC1, MAC2) for form in mac_forms(m)),
          "no raw MAC in any file, in any notation")

    broken = tmp / "broken"
    broken.mkdir()
    (broken / f".free_minutes.{day2}.json").write_text("{not json", encoding="utf-8")
    fm3 = FreeMinutes(replace(cfg, cursor_dir=broken), clock=lambda: now["t"])
    check(fm3.used_today(MAC1)["charge"] is False and json.loads(fm3.path().read_text())["day"] == day2,
          "an unreadable day file: the day starts over with a new salt (at most one more free grant)")
    save = fm3._save

    def full(used):
        raise OSError(28, "No space left on device")
    fm3._save = full
    try:
        fm3.grant(MAC1, "charge")
        check(False, "a grant that cannot be written is refused")
    except OSError:
        check(fm3.used_today(MAC1)["charge"] is False, "a grant that cannot be written: OSError, nothing given")
    fm3._save = save


def test_free_charge(tmp: Path) -> None:
    print("free emergency minutes: the free charge on the station (the courtesy's path)")
    r = free_rig(tmp)
    st = r.st
    check(st.free_charge_refusal() is None and st.free_charge(), "a free charge starts with the relay free")
    check(st.state == State.COURTESY and not r.relay.is_open and st.session.free_charge and st.session.courtesy_used
          and r.snap()["courtesy_seconds_left"] == 120 and "Free emergency charge" in r.snap()["notice"],
          "COURTESY with the relay closed for FREE_CHARGE_SECONDS (120), said on screen")
    check(st.free_charge_refusal() == "busy_free" and not st.free_charge(), "a second free charge meanwhile: refused")
    r.tick(120)
    check(st.state == State.AWAITING_PAYMENT and r.relay.is_open and st.cooldown_until == 0.0,
          "after 2 min the relay opens; no operator cooldown started")
    check(st.courtesy() and not st.session.free_charge, "C right after a free charge: the operator's courtesy")
    rec = [x for x in r.records() if x["kind"] == "session"][-1]
    check(rec["end_reason"] == "free_charge_only" and rec["free_charge"] is True and rec["courtesy_used"] is True,
          "the unpaid free-charge session logged as free_charge_only, no money in it")
    check(st.free_charge_refusal() == "busy_courtesy", "no free charge during the operator's courtesy")
    st.end_session()

    r.pay("1")
    check(st.state == State.CHARGING and st.free_charge_refusal() == "busy" and not st.free_charge()
          and not r.relay.is_open and st.session.paid, "never during a paid session: refused, the paid session untouched")
    st.emergency_open()
    check(st.free_charge_refusal() == "finishing", "nor while a finished session's cut is confirmed")
    r.tick(r.cfg.finished_seconds + 1)

    check(st.free_charge(), "a new free charge on the next session")
    r.tick(30)
    r.pay("2")
    s = r.snap()
    check(st.state == State.CHARGING and s["remaining_seconds"] == 600 and st.courtesy_deadline is None
          and not r.relay.is_open, "a payment during a free charge carries over: 2 fichas = 10:00, the free time dropped")
    r.tick(600)
    r.tick(r.cfg.finished_seconds + 1)
    rec = [x for x in r.records() if x["kind"] == "session"][-1]
    check(rec["fichas"] == 2 and rec["free_charge"] is True and rec["verdict"] == "delivered",
          "the paid session's record says it began as a free charge")

    r.relay.error = "write timeout"
    check(st.free_charge_refusal() == "relay" and not st.free_charge(), "no free charge while the relay does not answer")
    r.relay.error = None
    st.record_free_grant("0123456789abcdef", "internet", 120)
    line = r.records()[-1]
    check(line["kind"] == "free_grant" and set(line) == {"kind", "device", "what", "seconds", "at"},
          "the log's free_grant line: kind, the day's device id, what, seconds, when; nothing else")


def test_free_charge_payer(tmp: Path) -> None:
    print("free emergency minutes: a free charge never takes the session someone is paying")
    r = free_rig(tmp)
    st = r.st
    check(st.free_charge(), "(device A's free charge)")
    r.tick(125)
    sid = st.session.id
    check(st.state == State.AWAITING_PAYMENT and st.session.courtesy_used and r.snap()["session_id"] == sid,
          "A's free charge ran out unpaid: its session and pay QR stay on screen")
    # Payer P scans that QR and approves in the app; meanwhile device B taps
    # "2 min free charge" on the portal.
    check(st.free_charge() and st.session.id == sid and st.state == State.COURTESY and r.snap()["session_id"] == sid,
          "B's free charge runs on the session on screen: the same ID, the same pay QR")
    r.tick(5)
    r.pay("1", memo=sid)
    check(st.state == State.CHARGING and st.session.id == sid and st.session.fichas == 1 and not r.relay.is_open
          and "not credited" not in (r.snap()["notice"] or ""),
          "P's payment to that QR is credited and carries over into the paid session")
    check(not [x for x in r.records() if x["kind"] in ("orphan", "refused")],
          "nothing logged as orphan or refused: no refund to make")
    st.end_session()
    r.tick(r.cfg.finished_seconds + 1)
    recs = [x for x in r.records() if x["kind"] == "session" and x["id"] == sid]
    check(len(recs) == 1 and recs[0]["fichas"] == 1 and recs[0]["free_charge"] is True,
          "one record for the session: paid, and begun as a free charge")

    # The same when B's free charge has already ended before the payment lands.
    sid2 = st.session.id
    check(st.free_charge() and r.tick(125) is None and st.free_charge() and st.session.id == sid2,
          "two free charges in a row (two devices): still the session on screen")
    r.tick(125)
    r.pay("1", memo=sid2)
    check(st.state == State.CHARGING and st.session.id == sid2 and st.session.fichas == 1,
          "a payment after both ended: credited to that session as usual")
    st.end_session()
    r.tick(r.cfg.finished_seconds + 1)

    # The operator's C key after a courtesy still opens a new session ID (as before).
    sid3 = st.session.id
    check(st.free_charge() and r.tick(125) is None and st.courtesy() and st.session.id != sid3,
          "C after a free charge: the operator's courtesy on a new session, as before")
    st.end_session()

    c = custody_rig(tmp / "custody", **{"wifi_portal": "simulate", "free_charge_seconds": 120,
                                        "free_internet_seconds": 120, "emergency_numbers": EMERGENCY})
    cs = c.st
    cs.on_ledger(int(c.unix()))
    check(cs.free_charge() and c.tick(125) is None, "(custody: A's free charge ran out)")
    csid = cs.session.id
    check(cs.free_charge() and cs.session.id == csid, "custody: B's free charge keeps the session and its pay link")
    deposit(c, 1)
    check(cs.state == State.CHARGING and cs.session.id == csid and cs.session.fichas == 1
          and not [x for x in c.records() if x["kind"] in ("orphan", "refused")],
          "custody: the deposit to the pay link on screen is credited, not refunded as 'session not served'")


def portal_client(main, peer: str, host: str = STATION_LAN) -> TestClient:
    return TestClient(main.app, base_url=f"http://{host}", client=(peer, 40000), follow_redirects=False)


def opennds_query(tok: str = "a1b2c3d4", ip: str = PHONE1) -> str:
    """The FAS level 0 query exactly as openNDS builds it (construct_querystring
    and encode_and_redirect_to_splashpage): clientip lands inside authaction."""
    return (f"/portal?authaction=http://{ROUTER}:2050/opennds_auth/?clientip={ip}&gatewayname=Ficha%20SOS"
            f"&tok={tok}&redir=http%3A%2F%2Fconnectivitycheck.gstatic.com%2Fgenerate_204")


def hidden(html_text: str) -> dict[str, str]:
    import html as html_mod
    return {k: html_mod.unescape(v) for k, v in
            re.findall(r'<input type="hidden" name="([^"]+)" value="([^"]*)">', html_text)}


def post_form(c: TestClient, path: str, form: dict[str, str], origin: str | None = None):
    from urllib.parse import urlencode as enc
    headers = {"content-type": "application/x-www-form-urlencoded"}
    if origin is not False:
        headers["origin"] = origin or str(c.base_url).rstrip("/")
    return c.post(path, content=enc(form), headers=headers)


def test_portal(tmp: Path) -> None:
    import portal as portal_mod
    print("free emergency minutes: the Wi-Fi portal with openNDS (main.py)")
    env = {"WIFI_PORTAL": "opennds", "HOST": "0.0.0.0", "MOCK_PAYMENT": "false", "WIFI_SSID": "Ficha SOS",
           "WIFI_SECURITY": "nopass", "FREE_CHARGE_SECONDS": "120", "FREE_INTERNET_SECONDS": "120",
           "EMERGENCY_NUMBERS": "Emergency 112; Police 190"}
    main = import_main(tmp, env, reload=True)
    macs = {PHONE1: MAC1, PHONE2: MAC2}
    main.neighbour = lambda ip: macs.get(ip)
    st = main.station
    phone, phone2 = portal_client(main, PHONE1), portal_client(main, PHONE2)

    page = phone.get(opennds_query())
    text = page.text
    check(page.status_code == 200 and page.headers["cache-control"] == "no-store"
          and text.index('href="tel:112"') < text.index('href="tel:190"') < text.index("Free emergency minutes")
          < text.index("Pay with Ficha") < text.index("Stay safe"),
          "GET /portal (openNDS FAS level 0): the emergency numbers first, as tel: links, then the free minutes, "
          "the pay link, the safety note")
    form = hidden(text)
    check(form.get("tok") == "a1b2c3d4" and form.get("authaction") == f"http://{ROUTER}:2050/opennds_auth/?clientip={PHONE1}"
          and form.get("redir") == "http://connectivitycheck.gstatic.com/generate_204" and "clientmac" not in form,
          "the page's forms carry the router's token, auth URL (with clientip inside) and redir, never a MAC")
    import html as html_mod
    check(html_mod.escape(main.snapshot()["uri"], quote=True) in text and "web+stellar:pay?" in text
          and "1 ficha = 5 min = 1 XLM" in text, "the pay link of the session on the station screen, with the price")

    # Zero CDN, no script, offline: everything it loads comes from this station.
    loads = re.findall(r"""<(?:img|script|link|iframe|source)\b[^>]*\b(?:src|href)=["']([^"']*)""", text)
    loads += re.findall(r"""url\(["']?([^"')]*)""", text)
    local = [u for u in loads if u.startswith("/static/")]
    check(loads and all(u.startswith(("/static/", "data:")) for u in loads) and "<script" not in text
          and "@import" not in text and all(phone.get(u).status_code == 200 for u in local),
          f"the portal loads nothing from another host and runs no script: {len(local)} files, all from /static")
    anchors = re.findall(r'<a\b[^>]*href="([^"]*)"', text)
    check(all(a.startswith(("tel:", "/portal", "web+stellar:")) for a in anchors),
          "its links: tel: numbers, the portal itself (language), the pay link")
    import socket as socket_mod
    connect, getaddrinfo = socket_mod.socket.connect, socket_mod.getaddrinfo

    def no_network(sock, address):
        # This process's own loopback pipes still work; nothing else does.
        if isinstance(address, tuple) and address[0] in ("127.0.0.1", "::1"):
            return connect(sock, address)
        raise OSError("no internet at all")

    def no_dns(host, *a, **k):
        if host in ("127.0.0.1", "::1", "localhost", None):
            return getaddrinfo(host, *a, **k)
        raise OSError("no internet at all")
    socket_mod.socket.connect, socket_mod.getaddrinfo = no_network, no_dns
    try:
        offline = phone.get(opennds_query())
    finally:
        socket_mod.socket.connect, socket_mod.getaddrinfo = connect, getaddrinfo
    check(offline.status_code == 200 and 'href="tel:112"' in offline.text, "the portal works with no internet at all")
    pt = phone.get(opennds_query(), headers={"accept-language": "pt-BR,pt;q=0.9,en;q=0.8"})
    check("Emergência" in pt.text and "Pagar com Ficha" in pt.text and 'lang="pt"' in pt.text
          and "Emergency" in phone.get(opennds_query() + "&lang=en").text,
          "Portuguese for a phone that asks for it (or ?lang=pt), English otherwise")

    # Free internet: once per device per day, then openNDS's own auth URL.
    resp = post_form(phone, "/portal/internet", form)
    check(resp.status_code == 303 and resp.headers["location"]
          == f"http://{ROUTER}:2050/opennds_auth/?tok=a1b2c3d4&redir=http%3A%2F%2Fconnectivitycheck.gstatic.com%2Fgenerate_204",
          "free internet: 303 to authaction?tok=..&redir=.. (openNDS FAS level 0's way back), no other parameter")
    grant = [x for x in main.station.log.read() if x["kind"] == "free_grant"][-1]
    check(grant["what"] == "internet" and grant["seconds"] == 120 and grant["device"] == main.free.device_id(MAC1)
          and "simulated" not in grant, "logged as a free_grant: the day's device id, internet, 120 s")
    resp = post_form(phone, "/portal/internet", form)
    check(resp.status_code == 303 and resp.headers["location"].startswith("/portal?")
          and "m=internet_used" in resp.headers["location"] and "tok=a1b2c3d4" in resp.headers["location"],
          "the same phone again: back to the portal, 'already had its free internet today'")
    check("already had its free internet today" in phone.get(resp.headers["location"]).text,
          "the portal says so, clearly")
    form2 = hidden(phone2.get(opennds_query(tok="e5f6a7b8", ip=PHONE2)).text)
    for bad in ("https://evil.example/opennds_auth/", "http://evil.example/opennds_auth/",
                "http://8.8.8.8:2050/opennds_auth/", f"http://{ROUTER}:2050/a/b/"):
        resp = post_form(phone2, "/portal/internet", dict(form2, authaction=bad))
        if "m=no_gateway" not in resp.headers["location"] or main.free.used_today(MAC2)["internet"]:
            check(False, f"authaction {bad} refused, nothing used")
    check(True, "an auth URL that is not a private-address openNDS gateway: refused (no open redirect), nothing used")
    check("m=no_gateway" in post_form(phone2, "/portal/internet", dict(form2, tok="")).headers["location"]
          and not main.free.used_today(MAC2)["internet"], "no token (not from the router's sign-in): refused")
    check(post_form(phone2, "/portal/internet", form2, origin="https://evil.example").status_code == 403
          and phone2.post("/portal/internet", content="tok=a", headers={"content-type": "text/plain"}).status_code == 415
          and not main.free.used_today(MAC2)["internet"],
          "a form posted by another site, or not a form: refused, nothing used")
    big = phone2.post("/portal/internet", content="tok=" + "a" * portal_mod.FORM_MAX_BYTES,
                      headers={"content-type": "application/x-www-form-urlencoded", "origin": f"http://{STATION_LAN}"})
    check(big.status_code == 413 and not main.free.used_today(MAC2)["internet"], "an oversized form: 413, nothing used")
    resp = post_form(phone2, "/portal/internet", form2)
    check(resp.headers["location"].startswith(f"http://{ROUTER}:2050/opennds_auth/?tok=e5f6a7b8&redir="),
          "phone 2's own sign-in: its own token, its own free internet")

    # Free charge: once per device per day, never during a paid session.
    resp = post_form(phone, "/portal/charge", form)
    check(resp.status_code == 303 and "m=charge_started" in resp.headers["location"]
          and st.state == State.COURTESY and st.session.free_charge and not st.relay.is_open,
          "free charge: the station's relay closes for 2 min (COURTESY, a free charge)")
    snap = main.snapshot()
    check(snap["free"] == {"portal": "opennds", "charge_seconds": 120, "internet_seconds": 120, "charging": True}
          and snap["emergency"] == [{"label": "Emergency", "number": "112"}, {"label": "Police", "number": "190"}],
          "the screen's state: the free minutes (a free charge running) and the emergency numbers")
    mine = phone.get(resp.headers["location"]).text
    check("Your free charge:" in mine and 'http-equiv="refresh"' in mine and "Free charge on for 2 min" in mine,
          "this phone's page counts its free charge down (a reload every 15 s, no script)")
    check("m=busy_free" in post_form(phone2, "/portal/charge", hidden(phone2.get(opennds_query(ip=PHONE2)).text))
          .headers["location"] and not main.free.used_today(MAC2)["charge"],
          "another phone meanwhile: 'the station is giving a free charge right now', nothing used")
    st.on_payment(Payment("tx-free", "op", "GPAYER", Decimal("1"), "XLM", st.session.id, "", "horizon"))
    check(st.state == State.CHARGING and st.session.paid and st.session.free_charge,
          "a payment during the free charge carries over into the paid session")
    check("Add time to the session now charging" in phone2.get(opennds_query(ip=PHONE2)).text,
          "while a paid session charges, the portal's pay link adds time to it, and says so")
    resp = post_form(phone2, "/portal/charge", hidden(phone2.get(opennds_query(ip=PHONE2)).text))
    check(re.search(r"[?&]m=busy(&|$)", resp.headers["location"]) and st.state == State.CHARGING
          and not main.free.used_today(MAC2)["charge"],
          "a free charge asked for during a paid session: refused, the paid session untouched, nothing used")
    st.emergency_open()
    st.session.finished_at -= 3600
    st.tick((0, 0, False))
    check(st.state == State.AWAITING_PAYMENT, "(the paid session closed)")
    resp = post_form(phone, "/portal/charge", form)
    check("m=charge_used" in resp.headers["location"] and st.state == State.AWAITING_PAYMENT,
          "the same phone the same day: 'already had its free charge today'")
    resp = post_form(phone2, "/portal/charge", hidden(phone2.get(opennds_query(ip=PHONE2)).text))
    check("m=charge_started" in resp.headers["location"] and st.state == State.COURTESY,
          "another phone: its own free charge")
    st.end_session()

    unknown = portal_client(main, "192.168.8.30")
    resp = post_form(unknown, "/portal/charge", hidden(unknown.get(opennds_query(ip="192.168.8.30")).text))
    check("m=unknown_device" in resp.headers["location"] and st.state == State.AWAITING_PAYMENT,
          "a phone not in the station's neighbour table: refused, 'join the station's Wi-Fi'")
    natted = portal_client(main, ROUTER)
    resp = post_form(natted, "/portal/charge", form)
    check("m=not_direct" in resp.headers["location"] and st.state == State.AWAITING_PAYMENT,
          "a request from another address than the phone's (a station behind NAT): refused, never the router's MAC")

    # HOST=0.0.0.0: the station also answers on any other network this
    # computer is on (a venue's Wi-Fi at 10.0.0.x, the station there at .7).
    # A neighbour there (it has an ARP entry) never joined Ficha's Wi-Fi.
    stranger, stranger_mac = "10.0.0.55", "aa:bb:cc:dd:ee:55"
    macs[stranger] = stranger_mac
    venue = portal_client(main, stranger, host="10.0.0.7:8030")
    resp = post_form(venue, "/portal/charge", {})
    check("m=no_gateway" in resp.headers["location"] and st.state == State.AWAITING_PAYMENT and st.relay.is_open
          and not main.free.used_today(stranger_mac)["charge"],
          "another network, the portal opened by the station's address there: no free charge (no router sign-in)")
    copied = hidden(venue.get(opennds_query(ip=stranger)).text)
    resp = post_form(venue, "/portal/charge", copied)
    check("m=not_lan" in resp.headers["location"] and st.state == State.AWAITING_PAYMENT and st.relay.is_open
          and not main.free.used_today(stranger_mac)["charge"],
          "the same with the router's sign-in parameters copied in: refused, not on the router's LAN, relay open")
    resp = post_form(venue, "/portal/internet", copied)
    check("m=not_lan" in resp.headers["location"] and not main.free.used_today(stranger_mac)["internet"],
          "and no free internet recorded for it either")
    check("This phone is not on the station&#x27;s Wi-Fi" in venue.get(opennds_query(ip=stranger)).text,
          "its page says to join the station's Wi-Fi")
    wrong_way = portal_client(main, PHONE2, host="10.0.0.7:8030")
    resp = post_form(wrong_way, "/portal/charge", hidden(wrong_way.get(opennds_query(ip=PHONE2)).text))
    check("m=not_lan" in resp.headers["location"] and st.state == State.AWAITING_PAYMENT,
          "a request that came in on the station's address on another network: refused too")
    check("from the station&#x27;s Wi-Fi sign-in page to get the free minutes" in phone.get("/portal").text,
          "a phone on the Wi-Fi that opened the station's address itself: told to use the sign-in page")
    resp = post_form(phone, "/portal/charge", {})
    check("m=no_gateway" in resp.headers["location"] and st.state == State.AWAITING_PAYMENT,
          "and asks for a free charge from there: refused, nothing used")

    # The station screen, its keys and /debug: only this computer.
    check(phone.get("/").status_code == 303 and phone.get("/").headers["location"] == "/portal",
          "a phone that opens the station's address gets the portal, not the operator's screen")
    try:
        with phone.websocket_connect("/ws", headers={"host": STATION_LAN}):
            pass
        check(False, "/ws from a phone on the Wi-Fi refused")
    except WebSocketDisconnect as exc:
        check(exc.code == 1008 and st.state == State.AWAITING_PAYMENT,
              "/ws from a phone on the Wi-Fi: refused (it cannot press ESC, C or E)")
    local = portal_client(main, "127.0.0.1", host="127.0.0.1:8030")
    with local.websocket_connect("/ws", headers={"host": "127.0.0.1:8030"}) as ws:
        first = ws.receive_json()
    check(local.get("/").status_code == 200 and first["free"]["charging"] is False,
          "this computer: the station screen and its socket, as always")
    html = (Path(__file__).resolve().parent / "static" / "index.html").read_text(encoding="utf-8")
    check(all(t in html for t in ('id="sosnums"', 'id="sosfree"', '"free charge left"', '? "free charge"',
                                  "sos(fr, em, d.wifi)", "a day per phone on the Wi-Fi")),
          "the station screen: the emergency band (numbers, free minutes, the Wi-Fi), the free charge's labels")

    text = files_text(tmp)
    check(not any(form_ in text for m in (MAC1, MAC2, stranger_mac) for form_ in mac_forms(m))
          and PHONE1 not in text and PHONE2 not in text and stranger not in text,
          "no MAC and no phone address in any file the station wrote (log, day file)")


def test_portal_simulate(tmp: Path) -> None:
    print("free emergency minutes: the portal simulated (no router)")
    env = {"WIFI_PORTAL": "simulate", "FREE_CHARGE_SECONDS": "120", "FREE_INTERNET_SECONDS": "120",
           "EMERGENCY_NUMBERS": "Emergency 112", "APP_URL": "https://ficha-stellar.vercel.app"}
    main = import_main(tmp, env, reload=True)
    main.neighbour = lambda ip: None
    st = main.station
    here = portal_client(main, "127.0.0.1", host="127.0.0.1:8000")
    page = here.get("/portal").text
    import html as html_mod
    links = [html_mod.unescape(a) for a in re.findall(r'<a\b[^>]*href="([^"]*)"', page)]
    pay = [a for a in links if a.startswith("https://")]
    check(len(pay) == 1 and pay[0].startswith("https://ficha-stellar.vercel.app/pay?uri=web%2Bstellar%3Apay%3F")
          and parse_qs(urlsplit(pay[0]).query)["uri"] == [main.snapshot()["uri"]]
          and not any(a.startswith("web+stellar:") for a in links),
          "direct mode with APP_URL: 'Pay with Ficha' opens the web app's /pay?uri=<the screen's pay link>, which any "
          "browser opens (the sign-in window, a phone without the app), not a bare web+stellar: link")
    check("SIMULATED: no Wi-Fi router here" in page and 'href="tel:112"' in page,
          "simulate: the portal on this computer, marked as simulated")
    html = (Path(__file__).resolve().parent / "static" / "index.html").read_text(encoding="utf-8")
    sos_js = html[html.index("function sos("):html.index("function fit(")]
    check(main.snapshot()["free"]["portal"] == "simulate" and 'fr.portal === "simulate"' in sos_js
          and 's.textContent = "simulated"' in sos_js and "no internet is given" in sos_js
          and sos_js.index("if (sim)") < sos_js.index('b.textContent = "Free "') and "fr.portal]" in sos_js,
          "the station screen's band says 'simulated' first (never cut off), and that no internet is given")
    resp = post_form(here, "/portal/internet", {"clientmac": "02:11:22:33:44:55"})
    check("m=internet_simulated" in resp.headers["location"] and "clientmac=02%3A11%3A22%3A33%3A44%3A55"
          in resp.headers["location"], "free internet with a test MAC: 'internet granted (simulated)'")
    shown = here.get(resp.headers["location"]).text
    grant = [x for x in st.log.read() if x["kind"] == "free_grant"][-1]
    check("Internet granted (simulated)" in shown and grant["simulated"] is True and grant["what"] == "internet"
          and "Free internet granted (simulated)" in main.snapshot()["notice"],
          "said on the portal and on the station screen, logged with simulated: true")
    check("m=internet_used" in post_form(here, "/portal/internet", {"clientmac": "02-11-22-33-44-55"}).headers["location"],
          "the same test MAC in another notation: the same device, already used")
    check("m=bad_mac" in post_form(here, "/portal/charge", {"clientmac": "ff:ff:ff:ff:ff:ff"}).headers["location"]
          and st.state == State.AWAITING_PAYMENT, "an invalid test MAC: refused")
    resp = post_form(here, "/portal/charge", {})
    check("m=charge_started" in resp.headers["location"] and st.state == State.COURTESY and st.session.free_charge,
          "this computer's own test device: a free charge (the relay closes)")
    st.end_session()
    lan = portal_client(main, PHONE1, host="127.0.0.1:8000")
    check("m=unknown_device" in post_form(lan, "/portal/charge", {"clientmac": "02:aa:aa:aa:aa:aa"},
                                          origin="http://127.0.0.1:8000").headers["location"],
          "a test MAC is taken only from this computer: another address must be a real neighbour")
    text = files_text(tmp)
    check("02:11:22:33:44:55" not in text and "021122334455" not in text, "the test MAC is not on disk either")


def test_free_rollover(tmp: Path) -> None:
    print("free emergency minutes: yesterday's salt goes at midnight, with no phone on the portal")
    import inspect
    from freeminutes import local_day
    env = {"WIFI_PORTAL": "simulate", "FREE_CHARGE_SECONDS": "120", "FREE_INTERNET_SECONDS": "120",
           "EMERGENCY_NUMBERS": "Emergency 112"}
    main = import_main(tmp, env, reload=True)
    now = [float(EPOCH)]
    main.free.clock = lambda: now[0]
    day1 = local_day(now[0])
    main.free.grant(MAC1, "charge")
    check(sorted(p.name for p in tmp.glob(".free_minutes*")) == [f".free_minutes.{day1}.json"],
          "(a free charge granted: the day's file, with its salt)")
    now[0] += 3 * 86_400  # three days on, the station running, no phone on the portal
    day2 = local_day(now[0])
    check((tmp / f".free_minutes.{day1}.json").exists(), "(nothing has asked for a device since)")

    async def run() -> None:
        task = asyncio.create_task(main.free_days())
        await asyncio.sleep(0.2)
        task.cancel()
    asyncio.run(run())
    files = sorted(p.name for p in tmp.glob(".free_minutes*"))
    check(files == [f".free_minutes.{day2}.json"] and main.free.day == day2,
          "the station's own minute check rolls the day: the old day's file and its salt deleted, no phone needed")
    check(main.FREE_ROLL_SECONDS <= 60 and "free_days()" in inspect.getsource(main.lifespan),
          "started with the station, every minute at most: within a minute of local midnight")

    def broken():
        raise PermissionError(13, "Permission denied")
    main.free.rollover = broken
    ticks: list[int] = []
    tick = main.station.tick
    main.station.tick = lambda reading: (ticks.append(1), tick(reading))

    async def run2() -> None:
        hb = asyncio.create_task(main.heartbeat())
        days = asyncio.create_task(main.free_days())
        await asyncio.sleep(1.3)
        alive = not days.done()
        hb.cancel()
        days.cancel()
        check(len(ticks) == 2 and alive,
              "a reset that fails is logged and tried again; the heartbeat (countdown, relay) goes on")
    try:
        logging.disable(logging.CRITICAL)
        asyncio.run(run2())
    finally:
        logging.disable(logging.NOTSET)
        del main.station.tick
        del main.free.rollover


if __name__ == "__main__":
    tests = (("a", test_mains), ("b", test_usb_vbus), ("c", test_restart), ("d", test_wifi),
             ("e", test_relay_fails), ("f", test_station_id), ("g", test_registry), ("h", test_receipt),
             ("i", test_money), ("j", test_robustness), ("k", test_screens), ("l", test_wrong_asset),
             ("m", test_registry_check), ("m2", test_public), ("m3", test_horizon_public),
             ("n", test_verify), ("o", test_custody_basics), ("p", test_custody),
             ("q", test_custody_restart), ("r", test_escrow_watch), ("r2", test_escrow_rpc30),
             ("s", test_custody_screens),
             ("t", test_custody_receipts), ("u", test_custody_edges), ("v", test_ledger_reset),
             ("w", test_registry_rules), ("x", test_custody_waiting), ("y", test_custody_rechecks),
             ("z", test_meter_sign), ("z2", test_charger_plugged), ("f1", test_free_off), ("f2", test_free_config),
             ("f3", test_free_ledger), ("f4", test_free_charge), ("f4b", test_free_charge_payer), ("f5", test_portal),
             ("f6", test_portal_simulate), ("f7", test_free_rollover))
    with tempfile.TemporaryDirectory() as d:
        for name, test in tests:
            (Path(d) / name).mkdir()
            test(Path(d) / name)
    print("\nall good")
