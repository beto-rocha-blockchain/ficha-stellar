"""The session state machine.

  AWAITING_PAYMENT  relay open, big QR. This is the resting state: there is
                    always a QR on screen, so there is no separate IDLE.
  COURTESY          relay closed for COURTESY_SECONDS, free, once per session
                    ID. A payment with the current memo turns it into CHARGING.
                    Also a device's free emergency charge (FREE_CHARGE_SECONDS,
                    from the Wi-Fi portal, once per device per day), which
                    keeps the session ID on screen.
  CHARGING          relay closed, countdown of fichas x FICHA_MINUTES. A new
                    payment with the same memo adds fichas and extends it.
  FINISHED          relay open, totals on screen, cut being confirmed. Then
                    the session is logged and a new ID starts over.

Billing is by TIME, and paid time is consumed only while this station is
verifiably charging the phone (CHARGE_VERIFY=true, the default). The meter
reads the phone's own battery current, which cannot tell this station's
outlet from a wall socket at home. So inside CHARGING the countdown has
phases:
  waiting   paid, relay closed, countdown not started: "plug your phone into
            this station". Ends as not_plugged after PLUG_TIMEOUT_SECONDS
            (with current flowing then, after one last probe: _last_check).
  checking  a probe: the relay opens for PROBE_SECONDS. Current that stops
            (or, on usb_vbus, a phone that vanishes) was this station's;
            current that keeps flowing comes from somewhere else.
  running   verified: the countdown runs, from the first charging reading
            after the probe (until then the phone is still recovering from
            it). On mains, current back only after DIP_READINGS readings or
            more is checked by one more probe first: the phone may have been
            moved to another charger meanwhile. A probe again every
            PROBE_EVERY_SECONDS, and after the current comes back from a dip.
  paused    no current for more than PAUSE_GRACE_SECONDS (given back), or a
            failed probe: the countdown stands still until a probe passes
            again. Ends as paused_too_long after PAUSE_TIMEOUT_SECONDS
            (the same last probe first).
With METER_SOURCE=outlet the meter is on the station's own output, so the
current it sees is this station's: no probes, the same pauses.
Watt-hours are measured and shown, never billed.

PAYMENT_MODE=custody (docs/station-app-contract.md, section 7): payments are
deposits into the FichaEscrow contract (escrow.py), each session has a hash
chain whose anchor is in the pay link, and the receipt carries the proof of
the paid time not consumed, which refunds it. The states are the same; a
session also ends, at the latest, CLAIM_WINDOW_SECONDS before its deadline,
in ledger time (ledger_time()).
The Station is driven from one thread (the event loop): tick() once a second
with a fresh meter reading, plus on_payment(), courtesy(), emergency_open()
and end_session() as events arrive. The clock is injected so the smoke test
can run fast.
"""

from __future__ import annotations

import json
import logging
import math
import os
import secrets
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from decimal import ROUND_DOWN, ROUND_HALF_UP, Decimal
from enum import Enum
from pathlib import Path
from typing import Callable

from stellar_sdk import StrKey

from config import CLAIM_WINDOW_SECONDS, STELLAR_DECIMALS, Config
from escrow import (
    CHECKPOINT_SECONDS, Deposit, Gone, Settle, anchor_of, b64url, bare, custody_block, from_b64url, new_seed,
    payer_share, price_stroops, proof, station_terms, to_amount, unused_units,
)
from escrow import deadline as escrow_deadline
from meter import Reading, plugged
from relay import Relay
from stellar import (
    Payment, format_amount, memo_station, new_session_id, payment_key, refund_memo, refund_tx_ref, refund_uri,
    session_memo,
)

log = logging.getLogger("ficha.session")

# How old the last good reading may be when the relay opens to serve as the
# "before" of the cut confirmation.
CUT_BASELINE_SECONDS = 5.0

# How long after a session gives way to the next one a payment to it is still
# announced on screen as not credited: its payer may still be at the station.
LATE_PAYMENT_SECONDS = 60.0

# Readings below MIN_CURRENT_MA in a row that make a dip (the phone may have
# been unplugged and moved): one low reading is the phone's own noise.
DIP_READINGS = 3
# The least time between two probes that PROBE_EVERY_SECONDS did not
# schedule (a retry after a failed probe, a check after a dip or a pause), to
# start with. Each such probe doubles it, up to PROBE_EVERY_SECONDS, so a
# current that keeps hovering around MIN_CURRENT_MA (a weak cable, the phone's
# own load) does not click the relay every half minute: each probe cuts the
# power for PROBE_SECONDS and wears the relay. A failed probe after a passing
# one means something changed: the gap starts over.
PROBE_RETRY_SECONDS = 30.0
# How early a tick may come and still count as the next second.
TICK_SLACK = 0.5

# Why the countdown is waiting or paused, for the screen and the log.
REASONS = {
    "no_current": "no charging current",
    "no_phone": "phone not readable",
    "elsewhere": "this phone is not charging from this station",
    "unchecked": "could not read the phone during the check",
    # Current back while waiting or paused, before the next probe may run
    # (the probe gap): the screen counts down to it instead of asking for a
    # phone that is already plugged in.
    "check_pending": "charging current detected, not checked yet",
}

STROOP = Decimal(1).scaleb(-STELLAR_DECIMALS)  # the smallest amount on the ledger

# Direct mode: the lines whose "refunds" the host owes (a "finished" line's
# are its session line's, which follows it).
REFUND_KINDS = ("session", "orphan", "refused", "underpaid")

# Custody: how many pay links shown and never paid the station remembers. A
# deposit made later with one of them is refunded in full (its c[0]). As many
# seeds of sessions it served: once such a session settles, a deposit that
# opens it again on the contract (the same ID and anchor) gets c[0] too.
SEEDS_KEPT = 100

# Custody: the receipts waiting to be claimed, each kept until its session
# settles or its deadline passes in ledger time (at most this many, the
# newest), and how long the waiting screen shows each of the two it takes
# turns with (_on_screen()).
RECEIPTS_KEPT = 50
RECEIPT_TURN_SECONDS = 8.0
# Of those, how many are read again after missed events (escrow_sessions()).
RECEIPTS_TRACKED = 20

# Custody: with no successful read of the contract for this long (and before
# the first), a deposit made now would not be seen: the screen hides the pay
# QR, as for a relay that does not answer. At least a few polls.
ESCROW_STALE_SECONDS = 30.0
# Public network, direct mode: with no successful read of Horizon for this
# long (and before the first), a real payment made now would not be seen
# until Horizon answers again, its payer maybe gone: the screen hides the pay
# QR the same way. At least a few polls. Testnet only shows it in the footer.
HORIZON_STALE_SECONDS = 10.0
# Custody: a station clock this far from ledger time is shown as a warning.
# Deadlines never depend on it (ledger_time()), but the log's times do.
CLOCK_SKEW_SECONDS = 60


class State(str, Enum):
    AWAITING_PAYMENT = "AWAITING_PAYMENT"
    COURTESY = "COURTESY"
    CHARGING = "CHARGING"
    FINISHED = "FINISHED"


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def mmss(seconds: float) -> str:
    """Time for the screen: two-digit minutes, e.g. 05:00, 60:00."""
    s = max(0, int(math.ceil(seconds)))
    return f"{s // 60:02d}:{s % 60:02d}"


def amount_str(value: Decimal | None) -> str | None:
    """An amount as the ledger writes it: 7 decimals."""
    return None if value is None else format(value.quantize(STROOP, rounding=ROUND_HALF_UP), "f")


def is_account(key) -> bool:
    """A Stellar account ID (G...): only one can be refunded. A debug
    payment's made-up payer ("DEBUG-PAYER") is owed nothing on the ledger."""
    return isinstance(key, str) and StrKey.is_valid_ed25519_public_key(key)


class SessionLog:
    """sessions.jsonl, append only. Lines by kind:
      credited    a payment credited to a session, written the moment it is
                  credited, so the payer is on disk even if the station dies
      delivering  the first reading at or above MIN_CURRENT_MA in a session
      finished    the session record the moment a paid session ends; the
                  session line follows once the cut is confirmed or not
      cut         a finished session's cut, the moment it is confirmed
      session     a closed session with its verdict (end_reason "interrupted"
                  when it was rebuilt at startup from the lines above)
      orphan, underpaid, refused   payments that were not credited
      free_grant  a device's free emergency minutes (WIFI_PORTAL): its id of
                  the day, what, seconds, when; never its MAC or IP
    Direct mode: a paid session line, and each orphan, refused and underpaid
    line, carries "refunds", what the host owes back and to whom, each with
    the SEP-0007 URI that pays it (Station._session_refunds()); dust never.
    Custody mode adds:
      seed        a session's hash chain seed, before its pay link shows
      consumed    a running session's consumed time, every CHECKPOINT_SECONDS
      settled     a session paid out by the contract (claim, release, refund)
      unserved    the full-refund receipt of a deposit the station could not
                  serve (its refused or orphan line has the same proof), so a
                  restart shows it again
    A session's "id" is its memo: "<STATION_ID>.<SESSION>", or the bare
    session ID on a station without STATION_ID.
    """

    def __init__(self, path: Path) -> None:
        self.path = path
        self.error: str | None = None  # the last write failed, for the footer

    def write(self, record: dict) -> None:
        try:
            self._append(json.dumps(record, default=_json_default, ensure_ascii=False))
        except Exception as exc:
            reason = exc.strerror if isinstance(exc, OSError) and exc.strerror else (str(exc) or type(exc).__name__)
            self.error = f"cannot write {self.path.name}: {reason}"
            raise
        self.error = None
        log.info("logged %s %s", record.get("kind"), record.get("id") or record.get("session") or record.get("tx_hash"))

    def _append(self, line: str) -> None:
        with self.path.open("a+b") as f:
            # A power cut can leave the last line unfinished: start on a new one.
            if f.tell() > 0:
                f.seek(-1, os.SEEK_END)
                if f.read(1) != b"\n":
                    line = "\n" + line
            f.write((line + "\n").encode("utf-8"))
            f.flush()
            os.fsync(f.fileno())

    def read(self) -> list[dict]:
        """Every record in the log. A line left unfinished by a power cut is skipped."""
        try:
            text = self.path.read_text(encoding="utf-8", errors="replace")
        except FileNotFoundError:
            return []
        records = []
        # Only a newline ends a record: splitlines() would also break on
        # U+2028 and friends, which a payer can put in a memo.
        for n, line in enumerate(text.split("\n"), 1):
            if not line.strip():
                continue
            try:
                rec = json.loads(line)
            except ValueError:
                log.warning("%s line %d is not valid JSON; skipped", self.path.name, n)
                continue
            if isinstance(rec, dict):
                records.append(rec)
        return records


# What a session record keeps of each payment credited to it.
_PAYMENT_FIELDS = ("tx_hash", "op_id", "payer", "amount", "asset", "fichas", "seconds", "change_due", "at", "source")


def _json_default(obj):
    if isinstance(obj, Decimal):
        return format(obj.normalize(), "f")
    raise TypeError(f"not serializable: {type(obj)}")


@dataclass
class Session:
    id: str  # the memo payments for this session carry
    timestamps: dict[str, str] = field(default_factory=dict)  # FIRST time of each state
    transitions: list[list[str]] = field(default_factory=list)  # every [state, time], in order
    courtesy_used: bool = False
    courtesy_max_ma: int = 0  # measured during courtesy; never part of the verdict
    courtesy_wh: float = 0.0
    # The courtesy was a device's free emergency charge (portal), not the C key.
    free_charge: bool = False
    payments: list[dict] = field(default_factory=list)
    fichas: int = 0
    amount: Decimal = Decimal(0)
    change_due: Decimal = Decimal(0)  # paid beyond whole fichas: refund by hand
    paid_seconds: int = 0
    capped_seconds: int = 0  # paid but beyond MAX_SESSION_MINUTES: refund by hand

    power_on_at: float | None = None
    # The countdown: budget is the paid time it may consume (paid minus
    # capped), consumed_base what its finished stretches consumed, run_since
    # when the stretch running now started (None: standing still).
    budget: int = 0
    consumed_base: float = 0.0
    run_since: float | None = None
    started: bool = False  # the countdown has run at all
    consumed_seconds: int = 0  # set when the session ends

    # Charge verification (CHARGE_VERIFY=true).
    phase: str | None = None  # waiting | checking | running | paused
    reason: str | None = None  # why waiting or paused (REASONS)
    verified: bool = False
    verified_at: str | None = None
    stopped_since: float | None = None  # verified, countdown standing still since
    paused_seconds: float = 0.0  # verified, countdown standing still (pauses, probes)
    probe_started: float | None = None
    probe_from: str | None = None  # the phase the probe interrupted
    probe_before_ma: int = 0  # the reading that started the probe
    # (mA, ok, plugged) with the relay open; plugged is None when the meter cannot tell
    probe_reads: list[tuple[int, bool, bool | None]] = field(default_factory=list)
    probes_passed: int = 0
    probes_failed: int = 0
    last_probe_end: float | None = None
    next_probe_at: float = 0.0
    probe_gap: float = PROBE_RETRY_SECONDS  # least time between unscheduled probes, now
    probe_scheduled: bool = False  # the probe under way is the regular one
    confirming: bool = False  # the last probe checked a slow recovery: its own counts
    last_probe_passed: bool = True
    low_since: float | None = None  # first reading of the current dip, if any
    low_reads: int = 0  # readings below MIN_CURRENT_MA in a row
    recovered: bool = False  # current seen again since the last probe
    dip: bool = False  # a dip since the last probe: check again when current returns
    probe_last: bool = False  # the probe under way is the last check (_last_check)

    max_ma: int = 0
    wh: float = 0.0
    ok_reads: int = 0
    failed_reads: int = 0
    delivering: bool = False

    end_reason: str | None = None
    unused_seconds: int = 0
    finished_at: float | None = None
    last_ok_at: float | None = None  # last good meter reading while powered
    last_ok_ma: int = 0
    last_ok_mv: int = 0
    last_ok_plugged: bool | None = None  # the phone said a charger was attached
    cut_from_ma: int | None = None  # the reading the cut is judged against
    cut: dict | None = None
    logged: bool = False

    # Custody: this session's hash chain, and its deposit on the contract.
    seed: bytes | None = None  # c[0]: secret until the receipt reveals a proof
    chain_len: int = 0  # N
    anchor: bytes | None = None  # c[N], in the pay link
    payer: str | None = None  # a custody session has one payer
    chain_fichas: int = 0  # the deposit's totals on the contract, credited or not
    chain_amount: int = 0  # stroops
    opened: int | None = None  # ledger time of the first deposit
    deadline: int | None = None  # ledger time: the payer claims until then
    checkpoint: int = 0  # consumed seconds last written to the log
    checkpoint_at: float | None = None
    settled: dict | None = None  # paid out by the contract while on screen

    @property
    def paid(self) -> bool:
        return self.fichas > 0

    @property
    def running(self) -> bool:
        return self.run_since is not None

    def consumed(self, now: float) -> float:
        """Paid time the countdown has consumed by `now`."""
        ran = now - self.run_since if self.run_since is not None else 0.0
        return min(float(self.budget), self.consumed_base + max(0.0, ran))


class Station:
    def __init__(
        self,
        cfg: Config,
        relay: Relay,
        session_log: SessionLog,
        clock: Callable[[], float] = time.monotonic,
        wallclock: Callable[[], str] = utc_now,
        id_factory: Callable[[], str] = new_session_id,
        unixclock: Callable[[], float] = time.time,
        seed_factory: Callable[[], bytes] = new_seed,
    ) -> None:
        self.cfg = cfg
        self.relay = relay
        self.log = session_log
        self.clock = clock
        self.wallclock = wallclock
        self.id_factory = id_factory
        self.unixclock = unixclock  # custody deadlines are ledger time, unix seconds
        self.seed_factory = seed_factory

        # Custody: the pay links shown and never credited, by session id (a
        # deposit made later with one is refunded in full), and the seeds of
        # the sessions served; the receipts waiting to be claimed, oldest
        # first, {"record", "seed", "served"} (the waiting screen shows one or
        # two of them, _on_screen()); and the sessions settled on the ledger,
        # as (id, anchor in base64url): a session on the contract is both.
        self.seeds: dict[str, tuple[bytes, int]] = {}
        self.served_seeds: dict[str, tuple[bytes, int]] = {}
        self.receipts: list[dict] = []
        self.settled_keys: set[tuple[str, str | None]] = set()
        # Custody and the public network: why this station would no longer
        # start, found while it runs (main.py reads the registry and, custody,
        # the contract again, and a deposit under other terms says so at
        # once): out of service until a later read finds it matches again. By
        # source: registry, escrow.
        self.mismatch: dict[str, str] = {}
        self._mismatch_seen: dict[str, float] = {}
        self.recheck_due = False
        # Custody: ledger time, from the latest ledger's close time at the last
        # read of the contract and this station's monotonic clock then
        # (ledger_time()); when the contract was last read; whether it is
        # watched at all (main.py, watch_escrow()); and how far this station's
        # own clock is from ledger time (seconds, ahead > 0).
        self.ledger_sample: tuple[float, float] | None = None
        self.escrow_read_at: float | None = None
        self.escrow_watched = False
        self.clock_skew: int | None = None
        # When Horizon last answered a poll for the host's payments, and
        # whether it is watched at all (main.py, watch_horizon()).
        self.horizon_read_at: float | None = None
        self.horizon_watched = False

        # Never assume the state the board was left in. If the board is not
        # there yet, the error shows on screen and relay.maintain() retries.
        try:
            self.relay.open()
        except Exception:
            log.error("relay not reachable at startup: %s", self.relay.error)

        self.closed_ids: set[str] = set()
        # Every payment already credited or logged, from the log on disk and
        # from this run: Horizon can deliver the same payment again.
        self.handled: set[str] = set()
        # Records not on disk yet (the write failed); retried each tick.
        self.pending: list[dict] = []
        self._flush_error: str | None = None
        # Direct mode: the refunds the host still owes, oldest first, from
        # the log: {"ref", "payer", "asset", "asset_issuer", "left"} (_owe()).
        self.refunds_due: list[dict] = []
        self._recover()

        self.state = State.AWAITING_PAYMENT
        self.session = self._new_session()
        self.ended: tuple[str, float] | None = None  # the session before this one, and when it gave way
        self.courtesy_deadline: float | None = None
        self.cooldown_until = 0.0

        self.last_tick: float | None = None
        self.reading: Reading = (0, 0, False)
        self.meter_ever_ok = False
        self.notice: tuple[str, float] | None = None

    # -- startup ----------------------------------------------------------------
    def _recover(self) -> None:
        """Read the log back. A paid session with credited lines but no closing
        line means the station died mid-session (crash, kill, power cut): close
        it now, so the payer and tx_hash end up with a verdict like any other.
        If the log cannot be written (the power cut left a full disk, say),
        the records wait in memory like any closing record: no crash."""
        credited: dict[str, list[dict]] = {}
        delivering: dict[str, dict] = {}
        finished: dict[str, dict] = {}
        cuts: dict[str, dict] = {}
        # Custody: seeds of pay links shown and of sessions served,
        # consumed-time checkpoints, the deposit totals each line saw on the
        # contract, the settles, and the receipts the waiting screen may show
        # again (a served session's, or an unserved deposit's full refund).
        # Each with its place in the log: a settle closes only the session
        # open on the contract at that moment, so it settles a receipt whose
        # session was opened before it, never one opened after it.
        seeds: dict[str, tuple[bytes, int]] = {}
        served_seeds: dict[str, tuple[bytes, int]] = {}
        chains: dict[str, list[tuple[int, dict]]] = {}
        checkpoints: dict[str, int] = {}
        first_credit: dict[str, int] = {}
        settles: list[tuple[int, str, str | None]] = []
        # (where its session was opened, where it was made, record, served)
        receipts: list[tuple[int, int, dict, bool]] = []
        lines = self.log.read()
        for pos, r in enumerate(lines):
            kind = r.get("kind")
            if kind in ("credited", "orphan", "underpaid", "refused", "dust", "settled") and "op_id" in r:
                self.handled.add(payment_key(r.get("tx_hash"), r.get("op_id")))
            if kind == "session" and r.get("id"):
                self.closed_ids.add(r["id"])
            elif kind == "credited" and r.get("session"):
                credited.setdefault(r["session"], []).append(r)
                first_credit.setdefault(r["session"], pos)
                c = r.get("custody")
                if isinstance(c, dict) and c.get("seed"):
                    try:
                        served_seeds[r["session"]] = (from_b64url(c["seed"]), int(c["chain_len"]))
                    except (KeyError, TypeError, ValueError):
                        pass
            elif kind == "delivering" and r.get("session"):
                delivering.setdefault(r["session"], r)
            elif kind == "finished" and r.get("id"):
                finished[r["id"]] = r
            elif kind == "cut" and r.get("session"):
                cuts[r["session"]] = r.get("cut_confirmation")
            elif kind == "seed" and r.get("session"):
                try:
                    seeds[r["session"]] = (from_b64url(r["seed"]), int(r["chain_len"]))
                except (KeyError, TypeError, ValueError):
                    log.warning("seed line of %s unreadable; skipped", r["session"])
            elif kind == "consumed" and r.get("session"):
                checkpoints[r["session"]] = max(checkpoints.get(r["session"], 0), int(r.get("consumed_seconds") or 0))
            elif kind == "settled" and r.get("id") and not r.get("foreign"):
                settles.append((pos, r["id"], r.get("anchor")))
            chain = r.get("custody")
            if isinstance(chain, dict):
                if kind in ("credited", "refused", "orphan"):
                    chains.setdefault(r.get("session") or r.get("memo"), []).append((pos, chain))
                elif kind in ("session", "unserved") and r.get("id"):
                    served = kind == "session"
                    receipts.append((first_credit.get(r["id"], pos) if served else pos, pos, r, served))
            # Direct mode: the refunds due, in the order they became due.
            if kind in REFUND_KINDS and isinstance(r.get("refunds"), list):
                self._owe(r["refunds"])
        end = len(lines)

        for sid, pays in credited.items():
            if sid in self.closed_ids:
                continue
            if sid in finished:
                # It had ended; only the cut confirmation was still pending.
                now = self.wallclock()
                record = dict(finished[sid], kind="session")
                record["timestamps"] = dict(record.get("timestamps") or {}, RECOVERED=now)
                record["transitions"] = list(record.get("transitions") or []) + [["RECOVERED", now]]
                record["cut_confirmation"] = cuts.get(sid) or record.get("cut_confirmation") or {
                    "confirmed": False, "reason": "station stopped before the cut was confirmed"}
                if not self.cfg.custody:
                    record["refunds"] = self._session_refunds(
                        sid, record.get("payments") or [], record.get("capped_seconds"), record.get("unused_seconds"))
                self._record(record)
                self._owe(record.get("refunds") or [])
                self.closed_ids.add(sid)
                if isinstance(record.get("custody"), dict):
                    receipts.append((first_credit[sid], end, record, True))
                log.warning("session %s had finished when the station stopped; logged", sid)
                continue
            first = pays[0]
            seen = delivering.get(sid)
            payments = [{k: p.get(k) for k in _PAYMENT_FIELDS} for p in pays]
            now = self.wallclock()
            changes = [p.get("change_due") for p in pays]
            # Lines written before change was recorded do not say it.
            change = None if None in changes else sum((Decimal(str(c)) for c in changes), Decimal(0))
            record = {
                "kind": "session",
                "id": sid,
                "network": first.get("network"),
                "host_key": first.get("host_key"),
                "final_state": "INTERRUPTED",
                "end_reason": "interrupted",
                "timestamps": {"CHARGING": first.get("at"), "RECOVERED": now},
                "transitions": [["CHARGING", first.get("at")], ["RECOVERED", now]],
                "payer": first.get("payer"),
                "tx_hash": first.get("tx_hash"),
                "amount": sum((Decimal(str(p.get("amount") or 0)) for p in pays), Decimal(0)),
                "asset": first.get("asset"),
                "fichas": sum(int(p.get("fichas") or 0) for p in pays),
                "paid_seconds": sum(int(p.get("seconds") or 0) for p in pays),
                "change_due": change,
                # How much was used is unknown: the station was not running.
                "capped_seconds": None,
                "consumed_seconds": None,
                "unused_seconds": None,
                # The credited line says how time was being checked, the
                # delivering line whether the current it saw was verified as
                # this station's (lines older than that do not).
                "verify_mode": first.get("verify_mode"),
                "verified": seen.get("verified") if seen else None,
                "verified_at": seen.get("verified_at") if seen else None,
                "paused_seconds": None,
                "probes": None,
                "refund_hint": {"change": amount_str(change), "capped": None, "unused": None,
                                "asset": first.get("asset")},
                # Direct mode: each payer's change only, the rest being unknown.
                **({"refunds": self._session_refunds(sid, payments, None, None)} if not self.cfg.custody else {}),
                "courtesy_used": None,
                # The peak is unknown. The one reading on disk is the first at
                # or above MIN_CURRENT_MA, which is what makes it "delivered".
                "max_current_ma": None,
                "first_delivering_ma": seen.get("current_ma") if seen else None,
                "wh": None,
                # Current seen before the station died still counts. Without it,
                # nothing can be said about the rest of the session.
                "verdict": "delivered" if seen else "unverified",
                "cut_confirmation": {"confirmed": False,
                                     "reason": "station stopped mid-session; relay opened at restart"},
                "payments": payments,
                "meter_reads": None,
            }
            custody = self._recovered_custody([c for _, c in chains.get(sid, [])], checkpoints.get(sid, 0),
                                              first.get("payer"))
            if custody:
                # Custody: the last consumed checkpoint is never more than the
                # time consumed, so the refund it proves is the payer's due or more.
                consumed = checkpoints.get(sid, 0)
                record.update(consumed_seconds=consumed, unused_seconds=record["paid_seconds"] - consumed,
                              refund_hint=self._hint(custody), custody=custody)
                receipts.append((first_credit[sid], end, record, True))
            self._record(record)
            self._owe(record.get("refunds") or [])
            self.closed_ids.add(sid)
            log.warning("session %s was interrupted (station stopped mid-session); %s", sid,
                        "its receipt refunds the time after the last checkpoint" if custody
                        else "logged for manual refund")

        # Custody: a pay link that was shown and never credited still refunds
        # a deposit made with it (the station restarted, or moved on).
        for sid in credited:
            seeds.pop(sid, None)
        self.seeds = dict(list(seeds.items())[-SEEDS_KEPT:])
        self.served_seeds = dict(list(served_seeds.items())[-SEEDS_KEPT:])
        self.settled_keys = {(sid, anchor) for _, sid, anchor in settles}
        if self.cfg.custody:
            self._restore_receipts(receipts, settles, chains)

    def _restore_receipts(self, receipts: list[tuple[int, int, dict, bool]], settles: list[tuple[int, str, str | None]],
                          chains: dict[str, list[tuple[int, dict]]]) -> None:
        """At startup: every receipt whose session has not settled since it
        was opened, the newest of each session (ID and anchor), in the order
        they were made, by the same rules as when they were. Whether a
        deadline has passed is left to ledger time (tick()): this station's
        own clock, which nothing has checked yet, could drop a receipt the
        contract still pays."""
        def same(sid: str, anchor: str | None, s: str, a: str | None) -> bool:
            return s == sid and a in (None, anchor)  # a settle line older than anchors names the ID only

        newest: dict[tuple[str, str | None], tuple[int, int, dict, bool]] = {}
        for opened, made, record, served in receipts:
            key = (record["id"], (record.get("custody") or {}).get("anchor"))
            if any(pos > opened and same(*key, s, a) for pos, s, a in settles):
                continue
            if key not in newest or made >= newest[key][1]:
                newest[key] = (opened, made, record, served)
        for opened, _, record, served in sorted(newest.values(), key=lambda x: x[1]):
            sid, anchor = record["id"], record["custody"].get("anchor")
            # The lines of this session on the contract only: not those of
            # one that held the same ID and anchor before it settled.
            since = max((pos for pos, s, a in settles if pos < opened and same(sid, anchor, s, a)), default=-1)
            record, seed = self._restorable(record, [c for pos, c in chains.get(sid, []) if pos > since], served)
            self._offer_receipt(record, seed, served)
        if self.receipts:
            log.info("%d receipt(s) waiting to be claimed, back on the waiting screen until each settles or "
                     "its deadline passes", len(self.receipts))

    def _recovered_custody(self, lines: list[dict], consumed: int, payer: str | None) -> dict | None:
        """The custody block of a session rebuilt from its log lines: the seed
        from its credited lines, the newest totals any line saw with its anchor."""
        own = [c for c in lines if c.get("seed")]
        if not own:
            return None
        try:
            seed, anchor = from_b64url(own[0]["seed"]), from_b64url(own[0]["anchor"])
            n = int(own[0]["chain_len"])
            newest = max((c for c in lines if c.get("anchor") == own[0]["anchor"]),
                         key=lambda c: int(c.get("total_fichas") or 0))
            totals = (int(newest["total_fichas"]), int(newest["total_amount"]), newest.get("deadline"))
            return self._refund(sid=own[0].get("session") or "", seed=seed, anchor=anchor, n=n, totals=totals,
                                payer=payer, consumed=consumed, unit=own[0].get("unit_seconds"),
                                ficha=own[0].get("ficha_seconds"))
        except (KeyError, TypeError, ValueError):
            log.warning("custody lines of an interrupted session unreadable: no refund proof")
            return None

    def _restorable(self, record: dict, lines: list[dict], served: bool) -> tuple[dict, bytes | None]:
        """At startup: a receipt to show again on the waiting screen, and the
        seed that recomputes it. A top-up seen after it was made is in its
        proof too. An unserved deposit's proof is c[0], its seed."""
        c = record.get("custody") or {}
        own = [x for x in lines if x.get("anchor") == c.get("anchor")]
        seed = None
        try:
            if served:
                seed = next((from_b64url(x["seed"]) for x in own if x.get("seed")), None)
            elif c.get("unused_units") == c.get("chain_len"):
                seed = from_b64url(c["proof"])
            newest = max(own, key=lambda x: int(x.get("total_fichas") or 0), default=None)
            if seed and newest and int(newest["total_fichas"]) > int(c["total_fichas"]):
                record = dict(record, custody=self._refund(
                    sid=record["id"], seed=seed, anchor=from_b64url(c["anchor"]), n=int(c["chain_len"]),
                    totals=(int(newest["total_fichas"]), int(newest["total_amount"]), newest.get("deadline")),
                    payer=c.get("payer"), consumed=int(record.get("consumed_seconds") or 0) if served else None,
                    unit=c.get("unit_seconds"), ficha=c.get("ficha_seconds")))
                record["refund_hint"] = self._hint(record["custody"])
        except (KeyError, TypeError, ValueError):
            log.warning("custody lines of %s unreadable; its receipt as logged", record.get("id"))
        return record, seed

    # -- helpers --------------------------------------------------------------
    def _new_session(self) -> Session:
        s = Session(id=session_memo(self.cfg, self.id_factory()))
        now = self.wallclock()
        s.timestamps[State.AWAITING_PAYMENT.value] = now
        s.transitions.append([State.AWAITING_PAYMENT.value, now])
        if self.cfg.custody:
            # A new hash chain for every session (section 7.3). Its seed is on
            # disk before the pay link shows: a deposit made with it is still
            # refunded if the station dies. A log that cannot take it puts
            # the station out of service, and the pay QR stays hidden, until it can.
            s.seed, s.chain_len = self.seed_factory(), self.cfg.chain_len
            s.anchor = anchor_of(s.seed, s.chain_len)
            self._record({"kind": "seed", "session": s.id, "at": now, "escrow": self.cfg.escrow_contract,
                          "seed": b64url(s.seed), "anchor": b64url(s.anchor), "chain_len": s.chain_len})
            self.seeds[s.id] = (s.seed, s.chain_len)
            while len(self.seeds) > SEEDS_KEPT:
                self.seeds.pop(next(iter(self.seeds)))
        log.info("session %s awaiting payment", s.id)
        return s

    def _enter(self, state: State) -> None:
        log.info("session %s %s -> %s", self.session.id, self.state.value, state.value)
        self.state = state
        now = self.wallclock()
        self.session.timestamps.setdefault(state.value, now)
        self.session.transitions.append([state.value, now])

    def _record(self, record: dict) -> None:
        """Queue a record and write it: closing records, and the delivering,
        finished and cut lines. If the write fails, the record stays queued,
        tick() retries it every second and the footer shows the log error: a
        full or read-only disk never takes the station down, and the error
        (and "Out of service") goes as soon as the log takes a line again."""
        self.pending.append(record)
        self._flush()

    def _flush(self) -> None:
        while self.pending:
            try:
                self.log.write(self.pending[0])
            except Exception:
                if self.log.error != self._flush_error:
                    log.error("%s; %d record(s) waiting, retrying every second", self.log.error, len(self.pending))
                    self._flush_error = self.log.error
                return
            self.pending.pop(0)
        if self._flush_error:
            log.info("session log writable again; waiting records written")
        self._flush_error = None

    def _say(self, text: str, seconds: float = 6.0) -> None:
        self.notice = (text, self.clock() + seconds)

    @staticmethod
    def _tx(tx_hash: str | None) -> str:
        """The ledger transaction behind a notice, as " · tx 1a2b3c4d…" (none
        for a debug event, which never reached the ledger)."""
        if not tx_hash or tx_hash.startswith("debug-"):
            return ""
        return f" · tx {tx_hash[:8]}…"

    def _relay_open(self) -> None:
        try:
            self.relay.open()
        except Exception:
            log.exception("could not open relay")

    def _relay_close(self) -> None:
        try:
            self.relay.close()
        except Exception:
            log.exception("could not close relay")

    # -- payments -------------------------------------------------------------
    def fichas_for(self, amount: Decimal) -> int:
        if amount <= 0:
            return 0
        return int(amount // self.cfg.ficha_price)

    def on_payment(self, p: Payment) -> None:
        if p.key in self.handled:
            log.warning("payment %s (%s %s from %s) already handled; ignored", p.key, p.amount, p.asset, p.payer)
            return
        self._on_payment(p)
        self.handled.add(p.key)

    def _on_payment(self, p: Payment) -> None:
        s = self.session
        station = memo_station(p.memo)
        if station is not None and station != self.cfg.station_id:
            # Several stations can share one host key; the station this memo
            # names credits or logs it. Here it is only marked as handled.
            log.info("payment %s with memo %s is for station %s; left to it", p.tx_hash, p.memo, station)
            return
        if p.wrong_asset:
            # The host account takes other assets for its own reasons: only a
            # payment whose memo is this station's is logged, for refund.
            if p.memo is not None and (station is not None or p.memo == s.id or p.memo in self.closed_ids):
                self._log_uncredited(p, "refused", "wrong asset")
                if p.memo == s.id:
                    self._say(f"Payment in {p.asset} not credited: this station takes {self.cfg.asset_label}. "
                              "Logged for refund", 10)
            return
        live = self.state in (State.AWAITING_PAYMENT, State.COURTESY, State.CHARGING)
        if p.memo is not None and p.memo == s.id and live:
            if self.cfg.custody:
                # A custody station is paid only through the contract: a
                # classic payment to the host buys nothing here.
                self._log_uncredited(p, "refused", "custody mode: pay with the Ficha app")
                self._say(f"Payment of {format_amount(p.amount)} {p.asset} not credited: this station takes "
                          "payments through the Ficha app. Logged for refund", 10)
                return
            if not self.relay.healthy:
                # Money that cannot buy energy right now: log it for refund.
                self._log_uncredited(p, "refused", "station out of service")
                self._say(f"Out of service: payment of {format_amount(p.amount)} {p.asset} not credited, "
                          "logged for refund", 10)
                return
            fichas = self.fichas_for(p.amount)
            if fichas < 1:
                self._log_uncredited(p, "underpaid", "below the price of 1 ficha")
                self._say(f"Payment of {format_amount(p.amount)} {p.asset} is below 1 ficha: not credited")
                return
            self._credit(p, fichas)
            return

        if p.memo is None:
            reason = "no valid memo"
        elif p.memo in self.closed_ids or p.memo == s.id:
            reason = "session already closed"
        else:
            reason = "unknown session"
        if reason != "session already closed" and self.fichas_for(p.amount) < 1:
            # Below 1 ficha and naming none of this station's sessions: dust,
            # typically address poisoning (a look-alike sender, so the host
            # copies the wrong address from its history). Logged, never refunded.
            self._log_uncredited(p, "dust", f"{reason}, below the price of 1 ficha: not refunded")
            return
        self._log_uncredited(p, "orphan", reason)
        # Paid on the FINISHED screen, or just after (the last seconds of the
        # countdown, say): the payer is likely still here, so say it.
        just_ended = (self.ended is not None and p.memo == self.ended[0]
                      and self.clock() - self.ended[1] <= LATE_PAYMENT_SECONDS)
        if p.memo is not None and (p.memo == s.id or just_ended):
            # Short enough for one line on a small screen: a second line would
            # squeeze the readings. Horizon writes 7 decimals ("1.0000000"):
            # the screen shows the amount as the price is shown, "1".
            self._say(f"{format_amount(p.amount)} {p.asset} paid after session {p.memo} ended: "
                      "not credited, logged for refund", 10)

    def _log_uncredited(self, p: Payment, kind: str, reason: str, custody: dict | None = None) -> None:
        log.warning("%s payment %s: %s", kind, p.tx_hash, reason)
        # Direct mode: owed back in full, to its own payer. Dust never is.
        refunds = None if self.cfg.custody or kind == "dust" else self._uncredited_refunds(p)
        self.log.write({
            "kind": kind,
            "reason": reason,
            "network": self.cfg.network,
            "host_key": self.cfg.host_public_key,
            "at": self.wallclock(),
            "payer": p.payer,
            "tx_hash": p.tx_hash,
            "op_id": p.op_id,
            "amount": p.amount,
            "asset": p.asset,
            **({"asset_issuer": p.asset_issuer or None} if p.wrong_asset else {}),
            "memo": p.memo,
            "current_session": self.session.id,
            "source": p.source,
            # A deposit: the session's totals on the contract after it (and,
            # when it is refunded in full, the proof that does it).
            **({"custody": custody} if custody else {}),
            **({"refunds": refunds} if refunds is not None else {}),
        })
        # On disk: never logged twice, whatever happens after (on_deposit).
        self.handled.add(payment_key(p.tx_hash, p.op_id))
        self._owe(refunds or [])

    def _credit(self, p: Payment, fichas: int, deposit: Deposit | None = None) -> None:
        s = self.session
        now = self.clock()
        seconds = fichas * self.cfg.ficha_seconds
        payment = {
            "tx_hash": p.tx_hash,
            "op_id": p.op_id,
            "payer": p.payer,
            "amount": p.amount,
            "asset": p.asset,
            "fichas": fichas,
            "seconds": seconds,
            # Paid beyond whole fichas; it buys nothing and is refunded by hand.
            "change_due": p.amount - fichas * self.cfg.ficha_price,
            "at": self.wallclock(),
            "source": p.source,
        }
        # On disk before the relay closes: if the station dies from here on,
        # the payer is still in the log and the session is closed at restart.
        # A deposit's line also carries the session's seed: the restart can
        # still make its receipt, with the refund proof.
        self.log.write({"kind": "credited", "session": s.id, "network": self.cfg.network,
                        "host_key": self.cfg.host_public_key, "memo": p.memo,
                        "verify_mode": self._verify_mode(), **payment,
                        **({"custody": dict(self._chain_line(deposit), seed=b64url(s.seed), chain_len=s.chain_len,
                                            unit_seconds=self.cfg.refund_unit_seconds,
                                            ficha_seconds=self.cfg.ficha_seconds)} if deposit else {})})
        self.handled.add(payment_key(p.tx_hash, p.op_id))
        if deposit is not None:
            self.seeds.pop(s.id, None)
            self.served_seeds[s.id] = (s.seed, s.chain_len)
            while len(self.served_seeds) > SEEDS_KEPT:
                self.served_seeds.pop(next(iter(self.served_seeds)))
            self._take_totals(s, deposit)
        s.payments.append(payment)
        s.fichas += fichas
        s.amount += p.amount
        s.change_due += payment["change_due"]
        s.paid_seconds += seconds
        log.info("session %s +%d fichas (%s %s)", s.id, fichas, p.amount, p.asset)

        # Said before the countdown moves: a session-limit notice from
        # _add_time() must not be covered by this one. A deposit names its
        # transaction: the contract at work, on screen.
        tx = self._tx(p.tx_hash) if deposit is not None else ""
        if self.state in (State.AWAITING_PAYMENT, State.COURTESY):
            self._say(f"{fichas} ficha{'s' if fichas != 1 else ''} received{tx}", 10 if tx else 6)
            # Courtesy time is dropped, never added to paid time.
            self.courtesy_deadline = None
            self._enter(State.CHARGING)
            self._relay_close()
            s.power_on_at = now
            self._add_time(seconds)
            if self.cfg.charge_verify:
                # The countdown waits for the phone to be charging HERE.
                s.phase, s.reason, s.next_probe_at = "waiting", None, now
                log.info("session %s waiting for the phone to charge from this station", s.id)
            elif self.cfg.topology != "usb_vbus":
                self._run(now)
        else:
            self._say(f"+{fichas} ficha{'s' if fichas != 1 else ''}{tx}", 10 if tx else 6)
            self._add_time(seconds)

    def _add_time(self, seconds: int) -> None:
        """Paid time for the countdown, up to MAX_SESSION_MINUTES of it; the
        rest is capped (logged for refund). The cap is on time consumed,
        which is never more than this budget."""
        s = self.session
        room = max(0, self.cfg.max_session_minutes * 60 - s.budget)
        if seconds > room:
            lost = seconds - room
            s.capped_seconds += lost
            seconds = room
            self._say(f"Session limit is {self.cfg.max_session_minutes} min: {mmss(lost)} beyond it "
                      "will not be delivered (logged for refund)", 10)
        s.budget += seconds

    def _run(self, now: float) -> None:
        """The countdown runs from now."""
        s = self.session
        if s.run_since is None:
            s.run_since = now
            if not s.started:
                log.info("session %s countdown started", s.id)
            s.started = True

    def _stop(self, at: float) -> None:
        """The countdown stands still from `at` (which may be a moment ago)."""
        s = self.session
        if s.run_since is not None:
            s.consumed_base = s.consumed(max(at, s.run_since))
            s.run_since = None

    # -- direct mode: what the host owes back ------------------------------------
    # The station holds no key and cannot refund: the host pays each refund
    # due from its own wallet. What is due, and to whom, comes from this log
    # only, never from a wallet's history, where a look-alike address may
    # have sent the host a tiny payment exactly to be copied (address
    # poisoning). Custody mode refunds by proof instead (section 7).
    def _station_asset(self) -> tuple[str, str | None]:
        """The station's asset as (code, issuer), issuer None for native XLM."""
        return self.cfg.asset_label, None if self.cfg.is_native else self.cfg.asset_issuer

    def _refund_due(self, payer: str, amount: Decimal, ref: str, asset: str, issuer: str | None) -> dict:
        """One refund due as a log line keeps it, with the SEP-0007 URI that pays it."""
        return {"payer": payer, "amount": format_amount(amount), "asset": asset,
                **({"asset_issuer": issuer} if issuer else {}), "ref": ref, "memo": refund_memo(ref),
                "uri": refund_uri(self.cfg, payer, amount, ref, asset, issuer)}

    def _session_refunds(self, sid: str, payments: list[dict], capped: int | None,
                         unused: int | None) -> list[dict]:
        """What a closed session owes each of its payers: the change of their
        own credited lines, and their share of the time paid and not
        delivered (capped and unused, at this station's price, as
        refund_hint), split by what each had credited. Each rounded down to
        the stroop, so together they never exceed what is due. An
        interrupted session (unused None: unknown) owes the change only."""
        lost = Decimal(0) if unused is None else self._time_value(int(capped or 0) + int(unused))
        change: dict[str, Decimal] = {}
        credit: dict[str, Decimal] = {}
        for p in payments:
            payer = p.get("payer")
            c = Decimal(str(p["change_due"])) if p.get("change_due") is not None else Decimal(0)
            change[payer] = change.get(payer, Decimal(0)) + c
            credit[payer] = credit.get(payer, Decimal(0)) + Decimal(str(p.get("amount") or 0)) - c
        total = sum(credit.values(), Decimal(0))
        asset, issuer = self._station_asset()
        out = []
        for payer, c in change.items():
            due = (c + (lost * credit[payer] / total if total > 0 else 0)).quantize(STROOP, rounding=ROUND_DOWN)
            if due > 0 and is_account(payer):
                out.append(self._refund_due(payer, due, sid, asset, issuer))
        return out

    def _uncredited_refunds(self, p: Payment) -> list[dict]:
        """An orphan, refused or underpaid payment is owed back in full, to
        its own payer, in the asset it came in. Its REF is the session its
        memo names, if that is one of this station's, else its transaction."""
        named = p.memo is not None and (p.memo == self.session.id or p.memo in self.closed_ids)
        ref = p.memo if named else refund_tx_ref(self.cfg, p.tx_hash)
        asset, issuer = (p.asset, p.asset_issuer or None) if p.wrong_asset else self._station_asset()
        due = p.amount.quantize(STROOP, rounding=ROUND_DOWN)
        return [self._refund_due(p.payer, due, ref, asset, issuer)] if due > 0 and is_account(p.payer) else []

    def _owe(self, refunds: list) -> None:
        """These refunds are due now, oldest first: the screen shows the
        newest until the host pays it."""
        for r in refunds:
            try:
                entry = {"ref": str(r["ref"]), "payer": r["payer"], "asset": str(r["asset"]),
                         "asset_issuer": r.get("asset_issuer") or None, "left": Decimal(str(r["amount"]))}
            except (KeyError, TypeError, AttributeError, ArithmeticError):
                log.warning("a refund due in the log is unreadable; skipped: %r", r)
                continue
            if entry["left"] > 0 and is_account(entry["payer"]):
                self.refunds_due.append(entry)

    # -- custody: the contract's events ----------------------------------------
    def on_escrow(self, ev: Deposit | Settle | Gone) -> None:
        """An event of the FichaEscrow contract (escrow.EscrowWatcher)."""
        if isinstance(ev, Deposit):
            self.on_deposit(ev)
        elif isinstance(ev, Settle):
            self.on_settle(ev)
        elif isinstance(ev, Gone):
            self._gone(ev.session, ev.anchor)

    def on_deposit(self, d: Deposit) -> None:
        key = payment_key(d.tx_hash, d.event_id)
        if key in self.handled:
            log.warning("deposit %s to %s already handled; ignored", key, d.session)
            return
        try:
            self._on_deposit(d)
        except Exception:
            # Nothing on disk yet (the log cannot be written): the watcher
            # reads it again. Already logged: never again, or each poll would
            # log it once more and never get past it to the events after it.
            if key not in self.handled:
                raise
            log.exception("deposit %s is logged, but handling it failed; not read again", key)
        self.handled.add(key)

    def _deposit_payment(self, d: Deposit, fichas: int | None = None) -> Payment:
        """A deposit as the payment the state machine and the log already know
        (source escrow): this deposit, or `fichas` of it."""
        stroops = d.amount if fichas is None else fichas * price_stroops(self.cfg)
        return Payment(tx_hash=d.tx_hash, op_id=d.event_id, payer=d.payer, amount=to_amount(stroops),
                       asset=self.cfg.asset_label, memo=f"{self.cfg.station_id}.{d.session}",
                       created_at=d.closed_at, source="escrow" if d.source != "debug" else "debug")

    def _chain_line(self, d: Deposit) -> dict:
        """What a log line keeps of a deposit: the session's totals on the contract after it."""
        return {"escrow": self.cfg.escrow_contract, "session": d.session, "anchor": b64url(d.anchor),
                "total_fichas": d.total_fichas, "total_amount": d.total_amount, "deadline": d.deadline,
                "event_id": d.event_id, "ledger": d.ledger}

    def _take_totals(self, s: Session, d: Deposit) -> None:
        """The session's deposit as the contract now holds it, credited or not:
        the refund at the end counts every unit on the contract."""
        if d.total_fichas < s.chain_fichas:
            return
        s.chain_fichas, s.chain_amount, s.deadline = d.total_fichas, d.total_amount, d.deadline
        s.payer = s.payer or d.payer
        s.opened = d.deadline - d.total_fichas * self.cfg.ficha_seconds - self.cfg.escrow_grace_seconds

    def _on_deposit(self, d: Deposit) -> None:
        cfg, s = self.cfg, self.session
        sid = f"{cfg.station_id}.{d.session}"
        p = self._deposit_payment(d)
        chain = self._chain_line(d)
        price = price_stroops(cfg)
        live = self.state in (State.AWAITING_PAYMENT, State.COURTESY, State.CHARGING)
        if sid == s.id and d.anchor == s.anchor and s.settled is not None:
            # The contract session this station serves (or just served) has
            # settled (a host_refund while charging, a claim on the FINISHED
            # screen), so this deposit, with the same ID and anchor, opened
            # another one, which this station never serves. Revealing c[0]
            # is safe now: the session it also proves settled once and for all.
            self._refund_unserved(p, sid, s.seed, s.chain_len, d, "session already settled",
                                  "refused" if live else "orphan")
            return
        if sid == s.id and live:
            if d.anchor != s.anchor:
                # Someone paid this session's ID with a hash chain of their
                # own. On the contract that is a session of its own (the
                # anchor is part of its key): their chain refunds them, and
                # this station's session, QR and next payer are untouched.
                self._log_uncredited(p, "refused", "anchor mismatch", custody=chain)
                return
            if d.total_fichas <= s.chain_fichas:
                return  # nothing new: a state already seen (read again after missed events)
            reason = None
            if d.terms is not None and d.terms != station_terms(cfg):
                # The payer signed the terms on the contract, and they are not
                # this station's (changed after its startup check): its time,
                # units and proofs would not match the session's. The next
                # payer would sign them too: out of service until the
                # contract is read again and matches (main.py, recheck).
                reason = "the session's terms on the contract are not this station's"
                mine = station_terms(cfg)
                self._mismatch("escrow", "a deposit under other terms: " + ", ".join(
                    f"{k} {d.terms.get(k)} on the contract, {mine[k]} here" for k in mine if d.terms.get(k) != mine[k]))
            elif d.amount != d.fichas * price or d.total_amount != d.total_fichas * price:
                reason = "amount does not match the price"
            elif d.total_fichas > cfg.max_fichas:
                reason = "more fichas than a session holds"
            elif not self.relay.healthy:
                reason = "station out of service"
            if reason and not s.paid:
                # Money that cannot buy energy here: the receipt reveals c[0],
                # a full refund whatever was paid, and a new session starts.
                self._refund_unserved(p, sid, s.seed, s.chain_len, d, reason, "refused")
                self._rotate()
            elif reason:
                # A top-up the station cannot credit: the session's receipt,
                # which counts every unit on the contract, returns it.
                self._log_uncredited(p, "refused", reason, custody=chain)
                self._take_totals(s, d)
                self._say(f"Top-up of {format_amount(p.amount)} {p.asset} not credited ({reason}): "
                          "it comes back with the receipt", 10)
            else:
                # The totals, not this deposit's fichas: a deposit missed
                # (read back as the session's totals) still counts once.
                fichas = d.total_fichas - s.chain_fichas
                self._credit(self._deposit_payment(d, fichas), fichas, deposit=d)
            return

        known = self.seeds.get(sid)
        if known and anchor_of(*known) == d.anchor:
            # The pay link of a session never served (the station restarted,
            # or moved on to a new QR): c[0], a full refund (and its receipt
            # again, with the new totals, for a top-up of one).
            self._refund_unserved(p, sid, known[0], known[1], d, "session not served", "orphan")
            return
        served = self.served_seeds.get(sid)
        if served and anchor_of(*served) == d.anchor and (sid, b64url(d.anchor)) in self.settled_keys:
            # A session this station served, settled since, opened again on
            # the contract by this deposit (the same ID and anchor: an old pay
            # link). Never served: c[0], safe now that the session it also
            # proves has settled for good, as for the session on screen above.
            self._refund_unserved(p, sid, served[0], served[1], d, "session already settled", "orphan")
            return
        entry = self._pending(sid, d.anchor)
        if (self.state == State.FINISHED and sid == s.id and d.anchor == s.anchor) or entry is not None:
            # A top-up after the session ended, while its receipt waits to be
            # claimed: the receipt now returns it too (section 7.5).
            self._log_uncredited(p, "orphan", "session already closed", custody=chain)
            if self.state == State.FINISHED and sid == s.id:
                self._take_totals(s, d)
            else:
                self._entry_totals(entry, d)
            self._say(f"{format_amount(p.amount)} {p.asset} paid after session {sid} ended: not credited, "
                      "it comes back with the receipt", 10)
            return
        reason = "session already closed" if sid in self.closed_ids else "unknown session"
        self._log_uncredited(p, "orphan", reason, custody=chain)
        just_ended = self.ended is not None and sid == self.ended[0] and self.clock() - self.ended[1] <= LATE_PAYMENT_SECONDS
        if just_ended:
            self._say(f"{format_amount(p.amount)} {p.asset} paid after session {sid} ended: not credited, "
                      "logged for refund", 10)

    def _refund_unserved(self, p: Payment, sid: str, seed: bytes, n: int, d: Deposit, reason: str,
                         kind: str) -> None:
        """A deposit the station cannot serve at all, made with its own pay
        link: logged with c[0] as its proof (q = N, a full refund whatever was
        paid, top-ups included, section 7.5), and its receipt on the waiting
        screen, also logged (kind unserved) so a restart shows it again. Its
        share is counted in the session's own units."""
        t = d.terms or {}
        custody = self._refund(sid=sid, seed=seed, anchor=d.anchor, n=n, payer=d.payer, consumed=None,
                               totals=(d.total_fichas, d.total_amount, d.deadline),
                               unit=t.get("unit_secs"), ficha=t.get("ficha_secs"))
        self._log_uncredited(p, kind, reason, custody=dict(self._chain_line(d), unused_units=custody["unused_units"],
                                                            proof=custody["proof"]))
        cfg = self.cfg
        record = {
            "kind": "unserved", "id": sid, "network": cfg.network, "host_key": cfg.host_public_key,
            "end_reason": "not_served", "timestamps": {State.FINISHED.value: self.wallclock()},
            "amount": to_amount(d.total_amount), "asset": cfg.asset_label, "fichas": d.total_fichas,
            "paid_seconds": d.total_fichas * cfg.ficha_seconds, "consumed_seconds": 0,
            "max_current_ma": 0, "wh": 0.0, "verdict": "unverified",
            "cut_confirmation": {"confirmed": False, "reason": "never served"},
            "refund_hint": self._hint(custody), "custody": custody,
        }
        self._record(dict(record))
        # Point at a receipt on screen only when it is this payer's (and
        # say when it shows, if a session is still on screen).
        if not self._offer_receipt(record, seed, served=False):
            then = "logged for a full refund, ask the operator"
        elif self.state in (State.CHARGING, State.FINISHED):
            then = "its refund receipt follows this session on screen"
        else:
            then = "scan the refund receipt with the Ficha app to get it back"
        what = "Out of service: " if reason == "station out of service" else ""
        self._say(f"{what}{format_amount(p.amount)} {p.asset} not credited: {then}", 10)

    def _refund(self, *, sid: str, seed: bytes, anchor: bytes, n: int, totals: tuple, payer: str | None,
                consumed: int | None, unit: int | None = None, ficha: int | None = None) -> dict:
        """A custody session's refund for these totals on the contract: U by
        section 7.7 from the time consumed, or, never served (consumed None),
        N with c[0]. The session's own terms (unit, ficha) when it was opened
        under other settings than the station's now. U is at most N, the
        chain's length: a session that holds more fichas than this station's
        terms allow (the host registered larger ones while the station ran on
        its old settings) is refunded by proof up to N, and the rest only by
        host_refund (section 7.10)."""
        cfg = self.cfg
        unit, ficha = unit or cfg.refund_unit_seconds, ficha or cfg.ficha_seconds
        fichas, amount, dl = totals
        u = n if consumed is None else min(n, unused_units(fichas * ficha, consumed, unit))
        return custody_block(escrow=cfg.escrow_contract, session=sid, anchor=anchor, chain_len=n,
                             unit_seconds=unit, ficha_seconds=ficha, total_fichas=fichas, total_amount=amount,
                             deadline=dl, payer=payer, unused=u, proof_value=proof(seed, n, u))

    def _hint(self, custody: dict) -> dict:
        """refund_hint in custody mode: automatic, by the receipt's proof."""
        return {"automatic": True, "unused_units": custody["unused_units"],
                "to_payer": amount_str(to_amount(custody["to_payer"])), "asset": self.cfg.asset_label}

    def _offer_receipt(self, record: dict, seed: bytes | None, served: bool) -> bool:
        """A receipt waits to be claimed until its session settles or its
        deadline passes, whatever comes after it: one that refunds nothing
        now (a top-up may still make it refund) or has expired never takes the
        place of one that refunds. The waiting screen takes turns with the
        newest of each kind (_on_screen()). It replaces an older receipt of
        the same session (ID and anchor). True: it is one of those on screen
        (or will be, once the session on screen now has ended)."""
        key = (record["id"], (record.get("custody") or {}).get("anchor"))
        self.receipts = [e for e in self.receipts if self._key(e) != key]
        entry = {"record": record, "seed": seed, "served": served}
        self.receipts.append(entry)
        del self.receipts[:-RECEIPTS_KEPT]
        return any(e is entry for e in self._on_screen())

    @staticmethod
    def _key(entry: dict) -> tuple[str, str | None]:
        """A receipt's session on the contract: its ID and anchor (base64url)."""
        return entry["record"]["id"], (entry["record"].get("custody") or {}).get("anchor")

    def _pending(self, sid: str, anchor: bytes) -> dict | None:
        """The receipt waiting to be claimed for this session (ID and anchor), if any."""
        key = (sid, b64url(anchor))
        return next((e for e in self.receipts if self._key(e) == key), None)

    def _drop_receipts(self, sid: str, anchor: bytes | None) -> bool:
        """The session (ID, and anchor if said) has nothing left to claim: its receipt goes. True: one went."""
        kept = [e for e in self.receipts
                if not (e["record"]["id"] == sid and (anchor is None or self._key(e)[1] == b64url(anchor)))]
        dropped = len(kept) != len(self.receipts)
        self.receipts = kept
        return dropped

    def _on_screen(self) -> list[dict]:
        """The receipts the waiting screen takes turns showing: the newest
        served one that refunds something, and the newest unserved full
        refund. A refund for a session the station never served (a stale QR,
        which anyone can pay) never takes a served receipt's place, and a
        receipt that refunds nothing ("0 XLM back") or has expired is never shown."""
        live = [e for e in self.receipts if self._refunds(e["record"]) and not self._expired(e["record"])]
        served = next((e for e in reversed(live) if e["served"]), None)
        unserved = next((e for e in reversed(live) if not e["served"]), None)
        return [e for e in (served, unserved) if e is not None]

    def _shown_receipt(self) -> tuple[dict | None, int, int]:
        """The receipt on the waiting screen now, its turn and how many take turns."""
        turns = self._on_screen()
        if not turns:
            return None, 0, 0
        i = int(self.clock() // RECEIPT_TURN_SECONDS) % len(turns)
        return turns[i], i + 1, len(turns)

    @staticmethod
    def _refunds(record: dict) -> bool:
        """The receipt gives something back: one that does not is never shown
        as the last receipt ("0 XLM back, scan to claim it")."""
        return int((record.get("custody") or {}).get("to_payer") or 0) > 0

    def _entry_totals(self, entry: dict, d: Deposit) -> None:
        """A top-up of the session whose receipt waits to be claimed."""
        rec, c = entry["record"], entry["record"]["custody"]
        if d.total_fichas <= c["total_fichas"] or entry["seed"] is None:
            return
        rec["custody"] = self._refund(sid=rec["id"], seed=entry["seed"], anchor=d.anchor, n=c["chain_len"],
                                      totals=(d.total_fichas, d.total_amount, d.deadline), payer=c.get("payer"),
                                      consumed=int(rec.get("consumed_seconds") or 0) if entry["served"] else None,
                                      unit=c["unit_seconds"], ficha=c["ficha_seconds"])
        rec["refund_hint"] = self._hint(rec["custody"])

    def _expired(self, record: dict) -> bool:
        """The deadline passed, in ledger time: nothing left to claim. Never
        before ledger time is known (the first read of the contract): this
        station's own clock could be off by more than the time left to claim."""
        dl = (record.get("custody") or {}).get("deadline")
        return dl is not None and self._ledger_known() and self.ledger_time() > dl

    def _prune(self) -> None:
        """Receipts whose deadline passed, in ledger time, leave."""
        gone = [e["record"]["id"] for e in self.receipts if self._expired(e["record"])]
        if gone:
            self.receipts = [e for e in self.receipts if not self._expired(e["record"])]
            log.info("receipt(s) of %s: deadline passed, nothing left to claim", ", ".join(gone[-5:])
                     + (f" and {len(gone) - 5} more" if len(gone) > 5 else ""))

    def _mismatch(self, source: str, problem: str) -> None:
        """A deposit just showed that this station no longer matches (source):
        out of service, and the contract read again at once (main.py)."""
        self._mismatch_seen[source] = self.clock()
        self.recheck_due = True
        self.on_recheck(source, problem)

    def on_recheck(self, source: str, problem: str | None, started: float | None = None) -> None:
        """Custody and the public network (cfg.rechecks_registry), main.py:
        the registry ("registry") or, custody, this station's terms on the
        contract ("escrow") read again while the station runs. A problem (why
        it would not start now) puts it out of service, no pay QR, until a
        read finds none; a read that started before a deposit showed the
        problem (started, this station's clock) does not clear it."""
        old = self.mismatch.get(source)
        if problem is None:
            if old is None or (started is not None and started < self._mismatch_seen.get(source, -math.inf)):
                return
            del self.mismatch[source]
            log.info("%s matches this station again: back in service", source)
            return
        if problem != old:
            log.warning("%s no longer matches this station (%s): out of service until it does. Change .env to "
                        "match and restart the station", source, problem)
        self.mismatch[source] = problem

    # -- custody: ledger time and the contract's health ----------------------------
    def ledger_time(self) -> float:
        """Ledger time now, unix seconds: what the contract's deadlines are
        in. The latest ledger's close time at the last read of the contract,
        moved on by this station's monotonic clock since; its own wall clock,
        which nothing checks, only until the first read."""
        if self.ledger_sample is None:
            return self.unixclock()
        at_ledger, at = self.ledger_sample
        return at_ledger + (self.clock() - at)

    def _ledger_known(self) -> bool:
        """Ledger time comes from the ledger: read at least once, or the
        contract is not watched at all (tests), where the station's own clock
        stands in for it."""
        return self.ledger_sample is not None or not self.escrow_watched

    def watch_escrow(self) -> None:
        """main.py, custody: the contract's events are watched. Until the
        first read, and whenever none succeeded for ESCROW_STALE_SECONDS, the
        station is out of service (out_of_service())."""
        self.escrow_watched = True

    def watch_horizon(self) -> None:
        """main.py: Horizon is watched for payments to the host. On the
        public network, in direct mode, until the first read and whenever none
        succeeded for HORIZON_STALE_SECONDS, the station is out of service
        (out_of_service())."""
        self.horizon_watched = True

    def on_horizon(self) -> None:
        """Horizon answered a poll just now (stellar.HorizonWatcher)."""
        self.horizon_read_at = self.clock()

    def on_ledger(self, close_time: int | None) -> None:
        """The contract was read just now (escrow.EscrowWatcher, a page of
        events), the latest ledger closed at close_time (unix seconds; 0 or
        None: not said)."""
        now = self.clock()
        self.escrow_read_at = now
        if not close_time:
            return
        self.ledger_sample = (float(close_time), now)
        # The latest ledger closed up to a few seconds ago: only far more is a clock off.
        skew = int(round(self.unixclock() - close_time))
        off = abs(skew) > CLOCK_SKEW_SECONDS
        if off and (self.clock_skew is None or abs(skew - self.clock_skew) > CLOCK_SKEW_SECONDS):
            log.warning("this station's clock is %d s %s ledger time: custody deadlines follow the ledger, "
                        "but set the clock right (the log's times and the screen's)", abs(skew),
                        "ahead of" if skew > 0 else "behind")
        elif not off and self.clock_skew is not None:
            log.info("this station's clock agrees with ledger time again")
        self.clock_skew = skew if off else None
        self._prune()

    def _anchor_of(self, sid: str) -> bytes | None:
        """The anchor of one of this station's sessions it still knows: the
        one on screen, a receipt's waiting to be claimed, a pay link shown, or
        a session served. None: not known."""
        s = self.session
        if sid == s.id and s.anchor is not None:
            return s.anchor
        for e in reversed(self.receipts):
            if e["record"]["id"] == sid:
                try:
                    return from_b64url(self._key(e)[1])
                except ValueError:
                    return None
        known = self.seeds.get(sid) or self.served_seeds.get(sid)
        return anchor_of(*known) if known else None

    def on_settle(self, e: Settle) -> None:
        """The contract paid a session out (claim, release or host_refund)."""
        key = payment_key(e.tx_hash, e.event_id)
        if key in self.handled:
            return
        cfg = self.cfg
        sid = f"{cfg.station_id}.{e.session}"
        mine = self._anchor_of(sid)
        # Someone else's session under this ID (another anchor): logged, and
        # nothing of this station's changes.
        foreign = e.anchor is not None and mine is not None and e.anchor != mine
        settled = {"how": e.how, "to_payer": amount_str(to_amount(e.to_payer)),
                   "to_host": amount_str(to_amount(e.to_host)), "unused_units": e.unused_units,
                   "tx_hash": e.tx_hash}
        self.log.write({"kind": "settled", "id": sid, "network": cfg.network, "host_key": cfg.host_public_key,
                        "at": self.wallclock(), "payer": e.payer, **settled, "asset": cfg.asset_label,
                        "op_id": e.event_id, "ledger": e.ledger,
                        **({"anchor": b64url(e.anchor)} if e.anchor is not None else {}),
                        **({"foreign": True} if foreign else {})})
        self.handled.add(key)
        if foreign:
            log.info("settle of another session under %s (another anchor): not this station's", sid)
            return
        self.settled_keys.add((sid, b64url(e.anchor) if e.anchor is not None else None))
        s = self.session
        shown = self._drop_receipts(sid, e.anchor)
        if s.id == sid and s.paid and s.settled is None:
            # On the FINISHED screen (a claim), or still being served (a
            # host_refund: the time already credited runs out as paid). Either
            # way its receipt is never offered again, and a deposit under the
            # same ID and anchor opens another session on the contract
            # (_on_deposit), whose own settle later changes nothing here.
            s.settled, shown = settled, True
            if self.state != State.FINISHED:
                log.warning("session %s settled on the ledger (%s) while still being served", sid, e.how)
        if shown:
            self._say(f"{sid} settled: {format_amount(to_amount(e.to_payer))} {cfg.asset_label} to the payer, "
                      f"{format_amount(to_amount(e.to_host))} to the host{self._tx(e.tx_hash)}", 10)

    def _gone(self, session: str, anchor: bytes | None = None) -> None:
        """A session no longer open on the ledger, found by a read after
        missed events: its receipt has nothing left to claim."""
        sid = f"{self.cfg.station_id}.{session}"
        if self._drop_receipts(sid, anchor):
            log.info("receipt of %s: the session is no longer open on the ledger", sid)

    def escrow_sessions(self) -> list[tuple[str, bytes]]:
        """The sessions to read when events were missed, as (ID, anchor): the
        one on screen, the receipts waiting to be claimed (the newest), and
        the latest pay links shown."""
        out = [self.session.id]
        out += [e["record"]["id"] for e in self.receipts if not self._expired(e["record"])][-RECEIPTS_TRACKED:]
        out += list(self.seeds)[-10:]
        pairs = [(sid, self._anchor_of(sid)) for sid in dict.fromkeys(out)]
        return [(sid, a) for sid, a in pairs if a is not None]

    def _rotate(self) -> None:
        """Custody: give up the session awaiting payment for a new one (new
        ID, seed and pay link): a deposit with its pay link that the station
        will not serve holds that session on the ledger. A courtesy under way
        goes on under the new ID: the person in front of the station did
        nothing wrong."""
        old = self.session
        if self.state != State.COURTESY:
            self._close_unpaid()
        self.closed_ids.add(old.id)
        self.seeds.pop(old.id, None)
        self.ended = (old.id, self.clock())
        self.session = new = self._new_session()
        if self.state == State.COURTESY:
            for name in ("courtesy_used", "power_on_at", "last_ok_at", "last_ok_ma", "last_ok_mv",
                         "last_ok_plugged", "courtesy_max_ma", "courtesy_wh", "free_charge"):
                setattr(new, name, getattr(old, name))
            now = self.wallclock()
            new.timestamps.setdefault(State.COURTESY.value, now)
            new.transitions.append([State.COURTESY.value, now])
        log.info("session %s given up for %s", old.id, new.id)

    def mock_deposit(self, fichas: int, session: str | None = None, anchor: bytes | None = None,
                     payer: str = "DEBUG-PAYER", amount: int | None = None,
                     terms: dict | None = None) -> Deposit:
        """MOCK_PAYMENT in custody: the deposit event a payment from the app
        would bring, to the current session with its own anchor and the
        station's terms unless told otherwise. Nothing reaches the ledger."""
        s, cfg = self.session, self.cfg
        sid = session or s.id
        if anchor is None:
            anchor = s.anchor if sid == s.id else (self._anchor_of(sid) or bytes(32))
        # The session's totals so far, and when it opened, if it holds this anchor.
        base, opened = 0, int(self.ledger_time())
        entry = self._pending(sid, anchor)
        if sid == s.id and anchor == s.anchor and s.chain_fichas and s.settled is None:
            base, opened = s.chain_fichas, s.opened
        elif entry is not None:
            c = entry["record"]["custody"]
            base = c["total_fichas"]
            opened = c["deadline"] - base * cfg.ficha_seconds - cfg.escrow_grace_seconds
        price = price_stroops(cfg)
        total = base + fichas
        tag = secrets.token_hex(8)
        return Deposit(event_id=f"debug-{tag}", tx_hash=f"debug-{tag}", ledger=0, closed_at=self.wallclock(),
                       session=bare(sid), payer=payer, fichas=fichas,
                       amount=fichas * price if amount is None else amount, total_fichas=total,
                       total_amount=base * price + (fichas * price if amount is None else amount), anchor=anchor,
                       deadline=escrow_deadline(opened, total, cfg.ficha_seconds, cfg.escrow_grace_seconds),
                       source="debug", terms=terms or station_terms(cfg))

    def mock_settle(self, unused: int | None = None, how: str = "proof", session: str | None = None) -> Settle | None:
        """MOCK_PAYMENT in custody: the settle event a claim with the receipt
        on screen (or another way out, how) would bring: the FINISHED
        screen's, the one on the waiting screen now, or the newest waiting to
        be claimed; or the one of `session`. None: no such receipt."""
        shown, _, _ = self._shown_receipt()
        if session is not None:
            entry = next((e for e in reversed(self.receipts) if e["record"]["id"] == session), None)
            record = self._session_record() if session == self.session.id and self.session.paid \
                and self.state == State.FINISHED else entry and entry["record"]
        elif self.state == State.FINISHED and self.session.paid:
            record = self._session_record()
        elif shown is not None or self.receipts:
            record = (shown or self.receipts[-1])["record"]
        else:
            return None
        if not record:
            return None
        c = record.get("custody")
        if not c:
            return None
        paid_units = c["total_fichas"] * c["ficha_seconds"] // c["unit_seconds"]
        u = min(c["unused_units"] if unused is None else unused, paid_units) if how != "deadline" else 0
        to_payer = payer_share(c["total_amount"], u, paid_units)
        tag = secrets.token_hex(8)
        return Settle(event_id=f"debug-{tag}", tx_hash=f"debug-{tag}", ledger=0, closed_at=self.wallclock(),
                      session=c["session"], payer=c.get("payer") or "DEBUG-PAYER", to_host=c["total_amount"] - to_payer,
                      to_payer=to_payer, unused_units=u, how=how, anchor=from_b64url(c["anchor"]))

    # -- keys -----------------------------------------------------------------
    def courtesy(self) -> bool:
        now = self.clock()
        if self.cfg.courtesy_seconds <= 0:
            self._say("Courtesy is disabled")
            return False
        if self.state != State.AWAITING_PAYMENT:
            return False
        if not self.relay.healthy:
            self._say("Out of service: no courtesy until the relay answers")
            return False
        if now < self.cooldown_until:
            self._say(f"Courtesy available again in {mmss(self.cooldown_until - now)}")
            return False
        self._start_courtesy(self.cfg.courtesy_seconds)
        return True

    def free_charge_refusal(self) -> str | None:
        """Why a free emergency charge (the Wi-Fi portal, main.py) cannot
        start now, or None. Only with the relay free: never during a paid
        session, a courtesy or another free charge, nor while a finished
        session's cut is being confirmed. Whether this device already had
        its free charge today is the portal's to say (freeminutes.py)."""
        if self.cfg.free_charge_seconds <= 0:
            return "charge_off"
        if self.state == State.CHARGING:
            return "busy"
        if self.state == State.COURTESY:
            return "busy_free" if self.session.free_charge else "busy_courtesy"
        if self.state == State.FINISHED:
            return "finishing"
        if not self.relay.healthy:
            return "relay"
        return None

    def free_charge(self) -> bool:
        """A device's free emergency charge: the courtesy's path for
        FREE_CHARGE_SECONDS (a payment now carries over into the paid
        session, as from a courtesy), on the session on screen: its ID and
        pay QR stay, so whoever is paying them is credited. Granted per
        device per day by the portal, so it neither waits for nor starts
        the operator's cooldown."""
        if self.free_charge_refusal():
            return False
        self._start_courtesy(self.cfg.free_charge_seconds, free=True)
        self._say(f"Free emergency charge: {mmss(self.cfg.free_charge_seconds)}. Pay to keep charging")
        return True

    def _start_courtesy(self, seconds: int, free: bool = False) -> None:
        now = self.clock()
        if self.session.courtesy_used and not free:
            # One operator courtesy per session ID: start a fresh one. A free
            # charge never does: it runs on the session on screen, however
            # many courtesies that session had (the portal's ledger limits
            # free charges, per device per day). Any phone on the Wi-Fi can
            # ask for one at any moment, and a new ID would leave a payment
            # already made to the QR on screen uncredited.
            self._close_unpaid()
            self.ended = (self.session.id, now)
            self.session = self._new_session()
        self.session.courtesy_used = True
        self.session.free_charge = free
        self._enter(State.COURTESY)
        self._relay_close()
        self.session.power_on_at = now
        self.courtesy_deadline = now + seconds

    def record_free_grant(self, device: str, what: str, seconds: int, simulated: bool = False) -> None:
        """The session log's only trace of a free grant (main.py's portal): a
        day's device id, never its MAC, its IP or a name."""
        self._record({"kind": "free_grant", "device": device, "what": what, "seconds": seconds,
                      "at": self.wallclock(), **({"simulated": True} if simulated else {})})

    def emergency_open(self) -> None:
        """ESC: open the relay, always, whatever the state."""
        self._relay_open()
        log.warning("emergency open (ESC) in %s", self.state.value)
        if self.state == State.CHARGING:
            self._finish("emergency_stop")
        elif self.state == State.COURTESY:
            self._end_courtesy()
        # healthy: the last command (open, retried above) went through.
        if self.relay.healthy and self.relay.is_open:
            self._say("Relay forced open")
        else:
            self._say("Relay did NOT open: the open command failed. Unplug the relay board now.", 60)

    def end_session(self) -> None:
        """E: the operator ends the session now, for its payer (who asked to
        stop, say). Not an emergency, which is ESC: the session ends as
        "stopped", and the time not charged comes back as at any other end
        (custody: by the receipt's proof; direct: logged for refund)."""
        if self.state == State.CHARGING:
            log.info("session %s ended by the operator (E)", self.session.id)
            self._finish("stopped")
        elif self.state == State.COURTESY:
            self._end_courtesy()
        else:
            return
        if not (self.relay.healthy and self.relay.is_open):
            self._say("Relay did NOT open: the open command failed. Unplug the relay board now.", 60)
        elif self.state == State.FINISHED:
            self._say("Session ended: the time not charged "
                      + ("comes back with the receipt" if self.cfg.custody else "is logged for refund"))

    def _end_courtesy(self) -> None:
        self._relay_open()
        self.courtesy_deadline = None
        if not self.session.free_charge:  # a free charge is limited per device per day instead
            self.cooldown_until = self.clock() + self.cfg.courtesy_cooldown_seconds
        self._enter(State.AWAITING_PAYMENT)

    # -- the clock ------------------------------------------------------------
    def tick(self, reading: Reading) -> None:
        now = self.clock()
        dt = 0.0 if self.last_tick is None else min(5.0, max(0.0, now - self.last_tick))
        self.last_tick = now

        if self.pending:
            self._flush()

        ma, mv, ok = reading[:3]
        plug = plugged(reading) if ok else None
        self.reading = reading
        if ok:
            self.meter_ever_ok = True

        s = self.session
        if self.state == State.COURTESY:
            if ok:  # relay closed here too: a payment + ESC right away still has a "before"
                s.last_ok_at, s.last_ok_ma, s.last_ok_mv, s.last_ok_plugged = now, ma, mv, plug
                # Measured for the record, kept apart from any paid verdict.
                s.courtesy_max_ma = max(s.courtesy_max_ma, ma)
                if ma > 0:
                    s.courtesy_wh += (ma * mv / 1e6) * dt / 3600.0
            if now >= self.courtesy_deadline:
                log.info("session %s courtesy ended without payment", s.id)
                self._end_courtesy()

        elif self.state == State.CHARGING:
            verify = self.cfg.charge_verify
            if ok:
                s.ok_reads += 1
                # The "before" of a cut, and the reading held on screen: never
                # one taken while a probe had the power off.
                if s.phase != "checking":
                    s.last_ok_at, s.last_ok_ma, s.last_ok_mv, s.last_ok_plugged = now, ma, mv, plug
            else:
                s.failed_reads += 1
            # With verification, only current this station is verified to be
            # delivering counts: peak, energy and the "delivered" verdict.
            # Not the reading the countdown has yet to decide on after a probe:
            # it may be another charger's (see _verify_tick).
            if ok and (not verify or s.running):
                self._measure(ma, mv, dt, plug)
            if s.running and s.consumed(now) >= s.budget:
                full = s.budget >= self.cfg.max_session_minutes * 60
                self._finish("max_session" if full else "time_up")
            elif self._deadline_due():
                # However long the pauses were, the payer keeps
                # CLAIM_WINDOW_SECONDS to claim the time left (section 7.5).
                log.info("session %s ends %ss before its deadline on the contract", s.id, CLAIM_WINDOW_SECONDS)
                self._finish("deadline")
            elif verify:
                self._verify_tick(now, ma, ok, plug)
            elif not s.started:
                waited = now - (s.power_on_at or now)
                if ok or waited >= self.cfg.adb_wait_timeout:
                    if not ok:
                        log.warning("device did not come back in %ss; counting anyway", self.cfg.adb_wait_timeout)
                    self._run(now)
            if self.cfg.custody and self.state == State.CHARGING:
                self._checkpoint(now)

        elif self.state == State.FINISHED:
            self._check_cut(reading, now)
            if now - s.finished_at >= self.cfg.finished_seconds:
                self._close_paid()
                self.ended = (s.id, now)
                self.session = self._new_session()
                self.state = State.AWAITING_PAYMENT

        if self.receipts:
            self._prune()
        if self.notice and now >= self.notice[1]:
            self.notice = None

    def _deadline_due(self) -> bool:
        """Custody: the session's deadline on the contract, less the payer's
        time to claim, has come, in ledger time: a station clock that is off
        neither ends sessions early nor serves them into the claim window."""
        s = self.session
        return (self.cfg.custody and s.deadline is not None
                and self.ledger_time() >= s.deadline - CLAIM_WINDOW_SECONDS)

    def _checkpoint(self, now: float) -> None:
        """Custody: the consumed time on disk every CHECKPOINT_SECONDS while it
        grows. A session the station never saw end (killed, a power cut) is
        refunded from the last one, which is never more than the time
        consumed: in the payer's favour."""
        s = self.session
        if s.checkpoint_at is not None and now - s.checkpoint_at < CHECKPOINT_SECONDS - TICK_SLACK:
            return
        s.checkpoint_at = now
        consumed = int(s.consumed(now))
        if consumed > s.checkpoint:
            s.checkpoint = consumed
            self._record({"kind": "consumed", "session": s.id, "consumed_seconds": consumed, "at": self.wallclock()})

    def _measure(self, ma: int, mv: int, dt: float, plug: bool | None = None) -> None:
        s = self.session
        s.max_ma = max(s.max_ma, ma)
        # A phone on this station's charger is delivered to even when its
        # battery is net negative under load (see meter.plugged).
        if (ma >= self.cfg.min_current_ma or plug is True) and not s.delivering:
            s.delivering = True
            log.info("session %s delivering (%d mA)", s.id, ma)
            # Lets an interrupted session still be judged delivered.
            self._record({"kind": "delivering", "session": s.id, "at": self.wallclock(),
                          "current_ma": ma, "verified": s.verified, "verified_at": s.verified_at})
        if ma > 0:
            s.wh += (ma * mv / 1e6) * dt / 3600.0

    # -- charge verification --------------------------------------------------
    @property
    def _probes(self) -> bool:
        """The meter is the phone's own: only a probe tells where current comes from."""
        return self.cfg.meter_source == "phone"

    def _verify_tick(self, now: float, ma: int, ok: bool, plug: bool | None = None) -> None:
        s = self.session
        cfg = self.cfg
        if s.phase == "checking":
            s.probe_reads.append((ma, ok, plug))
            # The heartbeat ticks about once a second, a few ms early or late:
            # a 3 s probe must not become a 4 s one.
            if now - s.probe_started >= cfg.probe_seconds - TICK_SLACK:
                self._end_probe(now)
            return

        # A charger attached counts as charging even when the battery is net
        # negative under load; whose charger it is, a probe finds out.
        charging = ok and (ma >= cfg.min_current_ma or plug is True)
        if charging:
            lows = s.low_reads
            s.low_since, s.low_reads = None, 0
            if not s.recovered:
                s.recovered = True
                if s.phase == "running":
                    # The first charging reading after a passing probe. On
                    # mains the phone stays readable off this station: current
                    # back later than DIP_READINGS may be another charger's (it
                    # was unplugged during or right after the probe). One more
                    # probe first, whose own recovery counts however long it
                    # takes: a phone slow to charge again must not loop.
                    if lows >= DIP_READINGS and self._probes and cfg.topology == "mains" and not s.confirming:
                        log.info("session %s: current back only after %d low readings; checking again",
                                 s.id, lows)
                        self._start_probe(now, ma, confirming=True)
                        return
                    self._restart(now)
        else:
            if s.low_since is None:
                s.low_since = now
            s.low_reads += 1
            # Unplugged, maybe to plug in somewhere else: check again when
            # the current comes back. Not one noisy reading, and not the wait
            # for the current to come back after a probe: that is the probe's.
            if s.recovered and s.low_reads >= DIP_READINGS:
                s.dip = True

        # Waiting and paused: a probe when current flows, but no sooner than
        # next_probe_at (a failed one is retried after the probe gap). Current
        # back before then (the phone moved here, or charging again after an
        # inconclusive probe) is check_pending, not the "no current" it
        # replaces; "elsewhere" and "unchecked" stay until the probe says.
        pending = charging and now < s.next_probe_at
        if s.phase == "waiting":
            if not charging:
                s.reason = None  # nothing to check: "plug your phone into this station"
            elif pending and s.reason is None:
                s.reason = "check_pending"
            if now >= self._window_end():
                if not self._last_check(now, ma, charging):
                    log.info("session %s: phone never charged from this station in %ss",
                             s.id, cfg.plug_timeout_seconds)
                    self._finish("not_plugged")
            elif charging and now >= s.next_probe_at:
                self._check(now, ma)

        elif s.phase == "running":
            since_probe = now - s.last_probe_end if s.last_probe_end is not None else math.inf
            if s.low_since is not None:
                # From when the current went away; after a passing probe it
                # has not come back yet, so from the probe's end.
                gone = s.low_since if s.recovered or s.last_probe_end is None else s.last_probe_end
                if now - gone > cfg.pause_grace_seconds:
                    self._pause(gone, "no_current" if ok else "no_phone")
            elif self._probes and (since_probe >= cfg.probe_every_seconds
                                   or (s.dip and since_probe >= s.probe_gap)):
                self._start_probe(now, ma, scheduled=since_probe >= cfg.probe_every_seconds)

        elif s.phase == "paused":
            if not charging:
                s.reason = "no_current" if ok else "no_phone"
            elif pending and s.reason in ("no_current", "no_phone"):
                s.reason = "check_pending"
            if now >= self._window_end():
                if not self._last_check(now, ma, charging):
                    log.info("session %s paused for %ss; ended", s.id, cfg.pause_timeout_seconds)
                    self._finish("paused_too_long")
            elif charging and now >= s.next_probe_at:
                self._check(now, ma)

    def _window_end(self) -> float:
        """Waiting: when the time to plug in runs out. Paused: when the pause does."""
        s = self.session
        if s.phase == "waiting":
            return s.power_on_at + self.cfg.plug_timeout_seconds
        return s.stopped_since + self.cfg.pause_timeout_seconds

    def _last_check(self, now: float, ma: int, charging: bool) -> bool:
        """The window is up (_window_end). Current flowing now may be this
        station's: the phone moved here after the last probe, with the next
        one due after the window. One last check decides, instead of ending
        the session while this station may be charging the phone. Once: a
        probe that ended after the window did (this check, or one that ran
        over the end) has had its say. False: the session ends."""
        s = self.session
        if not charging or (s.last_probe_end is not None and s.last_probe_end >= self._window_end()):
            return False
        log.info("session %s: %s is up with current flowing; one last check", s.id,
                 "the time to plug in" if s.phase == "waiting" else "the pause")
        if self._probes:
            s.probe_last = True
        self._check(now, ma)
        return True

    def _check(self, now: float, ma: int) -> None:
        """Current is flowing: find out whether it is this station's."""
        if self._probes:
            self._start_probe(now, ma)
        else:
            self._resume(now)  # an outlet meter only sees this station's current

    def _start_probe(self, now: float, ma: int, scheduled: bool = False, confirming: bool = False) -> None:
        s = self.session
        # The session's first probe is its verification, not a retry; a
        # confirmation comes at most once per probe. Neither backs off the others.
        s.probe_scheduled = scheduled or confirming or s.last_probe_end is None
        s.confirming = confirming
        if s.phase == "running":
            self._stop(now)  # the power is off for the probe: not consumed
            if s.stopped_since is None:  # else standing still since the probe before (a confirmation)
                s.stopped_since = now
        s.probe_from, s.phase, s.probe_started, s.dip = s.phase, "checking", now, False
        s.probe_before_ma, s.probe_reads = ma, []
        log.info("session %s probe: relay open for %ss", s.id, self.cfg.probe_seconds)
        try:
            self.relay.open()
        except Exception:
            log.exception("probe could not open the relay")
            self._relay_close()
            self._probe_done(now, "inconclusive")

    def _end_probe(self, now: float) -> None:
        """The relay has been open for PROBE_SECONDS. Current that stopped (or
        a phone that vanished with the cut USB power) was this station's;
        current still flowing comes from another charger. Every reading
        counts but the first, which may predate the opening (the meter reads
        on its own thread), and the current must have fallen by at least
        MIN_CURRENT_MA: a nearly full phone on another charger hovers around
        MIN_CURRENT_MA, and one low reading of it is no proof."""
        s, cfg = self.session, self.cfg
        reads = s.probe_reads[1:] or s.probe_reads
        seen = [ma for ma, ok, _ in reads if ok]
        plugs = [p for _, ok, p in reads if ok and p is not None]
        if plugs:
            # The phone says whether a charger is attached, and its last word,
            # once the opening has settled, decides: still attached with this
            # station's relay open means another charger; gone means this
            # station's. The battery current is no help under load, and the
            # phone's gauge lags a relay change by a few seconds anyway.
            result = "fail" if plugs[-1] else "pass"
        elif any(ma >= cfg.min_current_ma for ma in seen):
            result = "fail"
        elif len(seen) < len(reads) and cfg.topology != "usb_vbus":
            result = "inconclusive"  # mains: WiFi ADB should have kept reading
        elif seen and s.probe_before_ma - max(seen) < cfg.min_current_ma:
            result = "fail"  # below MIN_CURRENT_MA, but no clear drop
        else:
            # usb_vbus: data rides on the cut cable, so the phone is gone.
            result = "pass"
        # A last check that did not pass ends the session: the relay stays open.
        if result == "pass" or not s.probe_last:
            self._relay_close()
        self._probe_done(now, result, max(seen) if seen else None)

    def _probe_done(self, now: float, result: str, ma: int | None = None) -> None:
        s = self.session
        came_from, s.probe_from, s.probe_started, s.probe_reads = s.probe_from, None, None, []
        last, s.probe_last = s.probe_last, False
        s.last_probe_end, s.recovered = now, False
        log.info("session %s probe %s (%s mA with the relay open)", s.id, result, ma)
        cap = float(self.cfg.probe_every_seconds)
        if result == "pass":
            if not s.probe_scheduled:
                s.probe_gap = min(s.probe_gap * 2, cap)
            s.last_probe_passed = True
            s.probes_passed += 1
            self._resume(now)
            return
        s.probes_failed += 1
        # Still waiting for the phone (up to PLUG_TIMEOUT_SECONDS), or a change
        # right after a passing probe: retry soon. Failing again and again
        # while verified: back off.
        if came_from == "waiting" or s.last_probe_passed:
            s.probe_gap = PROBE_RETRY_SECONDS
        else:
            s.probe_gap = min(s.probe_gap * 2, cap)
        s.last_probe_passed = False
        s.next_probe_at = now + s.probe_gap
        s.reason = "elsewhere" if result == "fail" else "unchecked"
        # Not verified yet: still waiting. Verified: the countdown stays still
        # (stopped_since was set when the probe or the pause began).
        s.phase = "waiting" if came_from == "waiting" else "paused"
        if last:
            waiting = came_from == "waiting"
            log.info("session %s: the last check did not pass; %s", s.id,
                     "phone never charged from this station" if waiting else "paused too long")
            self._finish("not_plugged" if waiting else "paused_too_long")

    def _resume(self, now: float) -> None:
        """Verified: this station is charging the phone. The countdown runs
        from the first charging reading: after a probe the phone takes a
        moment to charge again (the charger restarts; on usb_vbus the phone
        enumerates again), and that moment is the probe's, not paid time."""
        s = self.session
        if not s.verified:
            s.verified, s.verified_at = True, self.wallclock()
            log.info("session %s verified: charging from this station", s.id)
        if s.stopped_since is None:
            s.stopped_since = now  # verified, the countdown standing still
        s.phase, s.reason, s.low_since, s.low_reads, s.dip = "running", None, None, 0, False
        if s.last_probe_end is None:
            s.last_probe_end = now  # outlet meter: never probes
        if s.recovered:
            self._restart(now)

    def _restart(self, now: float) -> None:
        """Verified and charging: the countdown runs from now."""
        s = self.session
        if s.stopped_since is not None:
            s.paused_seconds += now - s.stopped_since
            s.stopped_since = None
        self._run(now)

    def _pause(self, since: float, reason: str) -> None:
        """No current for longer than the grace: the countdown stands still
        from when the current went away, so those seconds are given back.
        Current back: a probe, but no sooner than the current probe gap
        after the last one (see PROBE_RETRY_SECONDS)."""
        s = self.session
        self._stop(since)
        if s.stopped_since is None:  # else it stood still already: a probe passed, no current since
            s.stopped_since = since
        retry = since
        if self._probes and s.last_probe_end is not None:
            retry = max(since, s.last_probe_end + s.probe_gap)
        s.phase, s.reason, s.next_probe_at = "paused", reason, retry
        log.info("session %s paused: %s", s.id, REASONS[reason])

    def _finish(self, reason: str) -> None:
        s = self.session
        now = self.clock()
        self._relay_open()
        s.end_reason = reason
        self._stop(now)
        if s.stopped_since is not None:
            s.paused_seconds += now - s.stopped_since
            s.stopped_since = None
        s.probe_started = s.probe_from = None
        s.probe_last = False
        # Paid time never consumed is refunded by hand: whatever the
        # countdown did not consume, verified charging only. Whole seconds,
        # rounded down as the checkpoints are: E or ESC lands between two
        # ticks, and rounding up could cost the payer a refund unit (section 7.7).
        s.consumed_seconds = int(s.consumed_base)
        s.unused_seconds = s.budget - s.consumed_seconds
        s.finished_at = now
        self.closed_ids.add(s.id)
        self._set_cut_baseline(now)
        self._enter(State.FINISHED)
        # Everything but the cut is known now. If the station dies during the
        # FINISHED screen, the restart logs this instead of guessing.
        self._record(dict(self._session_record(), kind="finished", cut_confirmation=s.cut))

    def _set_cut_baseline(self, now: float) -> None:
        """A cut is only confirmed as a CHANGE seen after opening: the phone
        must have been readable just before (and, when the cut shows as a
        drop, drawing current), otherwise a meter that was already dead, or a
        phone that was already full, would look like proof that the relay
        opened."""
        s = self.session
        fresh = s.last_ok_at is not None and now - s.last_ok_at <= CUT_BASELINE_SECONDS
        if not fresh:
            s.cut = {"confirmed": False, "reason": "phone not readable just before the relay opened"}
        elif self._cut_by_drop and s.last_ok_ma < self.cfg.min_current_ma and not s.last_ok_plugged:
            s.cut = {"confirmed": False,
                     "reason": f"no current before the relay opened ({s.last_ok_ma} mA), nothing to see drop"}
        else:
            s.cut_from_ma = s.last_ok_ma
        if s.cut:
            log.info("session %s cut cannot be confirmed: %s", s.id, s.cut["reason"])

    @property
    def _cut_by_drop(self) -> bool:
        """The cut shows as current falling, not as the phone vanishing: on
        mains (WiFi ADB keeps reading), and with an outlet meter, which stays
        readable whatever the phone does."""
        return self.cfg.topology == "mains" or self.cfg.meter_source == "outlet"

    def _check_cut(self, reading: Reading, now: float) -> None:
        """After opening: usb_vbus expects the phone to vanish, mains (or an
        outlet meter) expects current to fall to about zero (or go negative,
        discharging)."""
        s = self.session
        if s.cut is not None:
            return
        if not self.relay.is_open:
            return  # the open command failed: power may still be flowing
        ma, _, ok = reading[:3]
        plug = plugged(reading) if ok else None
        if self._cut_by_drop and ok and plug is False:
            method = "charger_gone"  # the phone says its charger went away
        elif self._cut_by_drop and ok and plug is None and ma < self.cfg.min_current_ma:
            method = "current_drop"
        elif not self._cut_by_drop and not ok:
            method = "device_gone"
        else:
            return
        s.cut = {"confirmed": True, "method": method, "from_ma": s.cut_from_ma,
                 "to_ma": ma if ok else None, "at": self.wallclock(),
                 "after_seconds": round(now - s.finished_at, 1)}
        log.info("session %s cut confirmed by %s", s.id, method)
        # The receipt says so from now on: a restart must not say otherwise.
        self._record({"kind": "cut", "session": s.id, "cut_confirmation": s.cut})

    def _verify_mode(self) -> str:
        """off: paid time counts from payment (bench tests). probe: the phone's
        meter, checked by opening the relay. outlet: a meter on the station's
        own output."""
        if not self.cfg.charge_verify:
            return "off"
        return "probe" if self._probes else "outlet"

    def verdict(self, s: Session) -> str:
        # With verification, max_ma only counts readings taken while this
        # station was verified to be charging the phone.
        if s.max_ma >= self.cfg.min_current_ma or s.delivering:
            return "delivered"
        if s.ok_reads > 0:
            return "no_current"
        return "unverified"

    def _time_value(self, seconds: int) -> Decimal:
        """What paid time is worth at this station's price."""
        return Decimal(seconds) * self.cfg.ficha_price / self.cfg.ficha_seconds

    def _session_custody(self) -> dict | None:
        """Custody: the session's deposit and its refund, U from the time
        consumed against every unit on the contract (a top-up the station
        could not credit comes back too)."""
        s = self.session
        if not self.cfg.custody or s.seed is None or not s.chain_fichas:
            return None
        custody = self._refund(sid=s.id, seed=s.seed, anchor=s.anchor, n=s.chain_len, payer=s.payer,
                               totals=(s.chain_fichas, s.chain_amount, s.deadline), consumed=s.consumed_seconds)
        if s.settled:
            custody["settled"] = s.settled
        return custody

    def _session_record(self) -> dict:
        s = self.session
        first = s.payments[0] if s.payments else {}
        custody = self._session_custody()
        return {
            "kind": "session",
            "id": s.id,
            "network": self.cfg.network,
            "host_key": self.cfg.host_public_key,
            "final_state": self.state.value,
            "end_reason": s.end_reason,
            "timestamps": dict(s.timestamps),
            "transitions": [list(t) for t in s.transitions],
            "payer": first.get("payer"),
            "tx_hash": first.get("tx_hash"),
            "amount": s.amount,
            "asset": self.cfg.asset_label,
            "fichas": s.fichas,
            "paid_seconds": s.paid_seconds,
            "change_due": s.change_due,
            "capped_seconds": s.capped_seconds,
            # Paid time the countdown consumed: with verification, only time
            # this station was verified to be charging the phone.
            "consumed_seconds": s.consumed_seconds,
            # paid - capped - consumed
            "unused_seconds": s.unused_seconds,
            "verify_mode": self._verify_mode(),
            "verified": s.verified,
            "verified_at": s.verified_at,
            # Verified, countdown standing still: pauses and probes.
            "paused_seconds": int(round(s.paused_seconds)),
            "probes": {"passed": s.probes_passed, "failed": s.probes_failed},
            # What the host may refund by hand, in the asset, 7 decimals. In
            # custody mode the refund is automatic: the receipt's proof.
            "refund_hint": self._hint(custody) if custody else {
                "change": amount_str(s.change_due),
                "capped": amount_str(self._time_value(s.capped_seconds)),
                "unused": amount_str(self._time_value(s.unused_seconds)),
                "asset": self.cfg.asset_label,
            },
            # Direct mode: what the host owes each payer, and the URI that pays it.
            **({"refunds": self._session_refunds(s.id, s.payments, s.capped_seconds, s.unused_seconds)}
               if not self.cfg.custody and s.paid else {}),
            "courtesy_used": s.courtesy_used,
            "courtesy_max_ma": s.courtesy_max_ma,
            "courtesy_wh": round(s.courtesy_wh, 4),
            # Only on a session that had one: the record is unchanged otherwise.
            **({"free_charge": True} if s.free_charge else {}),
            "max_current_ma": s.max_ma,
            "wh": round(s.wh, 4),
            "verdict": self.verdict(s) if s.paid else None,
            "cut_confirmation": s.cut or {
                "confirmed": False,
                "reason": "relay did not take the open command" if not self.relay.is_open
                else "not confirmed before the session was logged"},
            "payments": s.payments,
            "meter_reads": {"ok": s.ok_reads, "failed": s.failed_reads},
            **({"custody": custody} if custody else {}),
        }

    def _close_paid(self) -> None:
        s = self.session
        if s.logged:
            return
        s.logged = True
        record = self._session_record()
        self._record(record)
        self._owe(record.get("refunds") or [])
        # Custody: the receipt waits on the waiting screen, smaller, until the
        # session settles or its deadline passes (section 7.5).
        if record.get("custody") and not s.settled and (s.id, b64url(s.anchor)) not in self.settled_keys:
            self._offer_receipt(dict(record), s.seed, served=True)

    def _close_unpaid(self) -> None:
        """A session that only ever had a courtesy (or a free emergency
        charge). Logged so the host can see how they are being used; there
        is no money in it."""
        s = self.session
        if s.logged or not s.courtesy_used or s.paid:
            return
        s.logged = True
        s.end_reason = "free_charge_only" if s.free_charge else "courtesy_only"
        self.closed_ids.add(s.id)
        self._record(self._session_record())

    def shutdown(self) -> None:
        """Open the relay and flush whatever session is in flight. Never raises."""
        self._relay_open()
        try:
            if self.state in (State.CHARGING, State.COURTESY):
                if self.state == State.CHARGING:
                    self._finish("shutdown")
                else:
                    self._end_courtesy()
            if self.state == State.FINISHED:
                self._close_paid()
            else:
                self._close_unpaid()
        except Exception:
            log.exception("error flushing session on shutdown")
        # Last chance: whatever could not be written goes to the console.
        for record in self.pending:
            log.critical("NOT WRITTEN to %s: %s", self.log.path,
                         json.dumps(record, default=_json_default, ensure_ascii=False))

    # -- for the screen -------------------------------------------------------
    def out_of_service(self) -> str | None:
        """Why a payment made now would buy no energy, or None. Relay not
        answering: the payment is refused and logged for refund. Log not
        writable: it can be neither credited nor logged (Horizon hands it
        over again until it can). Custody and the public network, the
        registry (or the contract) read again and no longer matching: the
        app pays what it says now. Custody, the contract not read for
        ESCROW_STALE_SECONDS (or not yet): a deposit made now would not be
        seen until it is, with its payer maybe gone. The public network,
        Horizon not read for HORIZON_STALE_SECONDS (or not yet): the same,
        with real money. Either way the screen hides the pay QR."""
        if not self.relay.healthy:
            return f"relay: {self.relay.error}"
        if self.log.error:
            return self.log.error
        if self.cfg.rechecks_registry and self.mismatch:
            # The registry or the contract changed under the running station:
            # the app pays what they say now, which this station would refuse
            # (or, with another contract, never see; or, direct on public,
            # sell on the old terms).
            source = next(iter(self.mismatch))
            return f"{source}: {self.mismatch[source]}"
        if self.cfg.custody and self.escrow_watched:
            if self.escrow_read_at is None:
                return "escrow: the contract not read yet"
            stale = max(ESCROW_STALE_SECONDS, 3 * self.cfg.horizon_poll_seconds)
            if self.clock() - self.escrow_read_at > stale:
                return f"escrow: the contract not read for {int(self.clock() - self.escrow_read_at)} s"
        if self.cfg.network == "public" and not self.cfg.custody and self.horizon_watched:
            if self.horizon_read_at is None:
                return "horizon: not read yet"
            stale = max(HORIZON_STALE_SECONDS, 3 * self.cfg.horizon_poll_seconds)
            if self.clock() - self.horizon_read_at > stale:
                return f"horizon: not read for {int(self.clock() - self.horizon_read_at)} s"
        return None

    def snapshot(self) -> dict:
        now = self.clock()
        s = self.session
        charging = self.state == State.CHARGING
        # A probe has the power off for a moment.
        powered = self.state in (State.CHARGING, State.COURTESY) and s.phase != "checking"
        ma, mv, ok = self.reading[:3]
        # A failed reading holds the last good one only while power is on in
        # this session: after the relay opens, or in a new session, the old
        # number would be a lie. So it would while waiting or paused: the
        # relay stays closed, but the phone may be gone for minutes.
        held = (not ok and powered and s.last_ok_at is not None
                and (not charging or s.phase in (None, "running")))
        plug = plugged(self.reading) if ok else None
        if held:
            ma, mv, plug = s.last_ok_ma, s.last_ok_mv, s.last_ok_plugged

        if charging:
            remaining = max(0.0, s.budget - s.consumed(now))
            # Paid time one more payment could still add before MAX_SESSION_MINUTES.
            room = self.cfg.max_session_minutes * 60 - s.budget
        else:
            remaining = 0.0
            room = self.cfg.max_session_minutes * 60
        # With verification the countdown starts and resumes on a heartbeat
        # tick, and every snapshot follows one: remaining is whole seconds,
        # give or take the ticks' jitter (a few ms either way). Rounded, not
        # ceiled, or the second on screen would repeat and then skip with it.
        shown = int(round(remaining))
        fichas_left = math.ceil(shown / self.cfg.ficha_seconds) if shown > 0 else 0

        # Where the countdown stands, for the screen (charging only).
        phase = s.phase if charging else None
        verifying = s.phase == "checking"
        before_verified = phase == "waiting" or (verifying and s.probe_from == "waiting")
        stood_still = phase == "paused" or (verifying and s.probe_from == "paused")
        # The next check: the next probe, or the last check when the window
        # runs out before it (see _last_check).
        check_at = min(s.next_probe_at, self._window_end()) if phase in ("waiting", "paused") else None
        charge = {
            "verify": self._verify_mode(),
            "phase": phase,
            "reason": s.reason if charging else None,
            "reason_text": REASONS.get(s.reason) if charging and s.reason else None,
            "verified": s.verified,
            "consumed_seconds": int(round(s.consumed(now))) if charging else s.consumed_seconds,
            "plug_seconds_left": (int(math.ceil(max(0.0, self.cfg.plug_timeout_seconds - (now - s.power_on_at))))
                                  if before_verified else None),
            # Standing still since a tick too: rounded like the countdown.
            "pause_seconds_left": (int(round(max(0.0, self.cfg.pause_timeout_seconds - (now - s.stopped_since))))
                                   if stood_still and s.stopped_since is not None else None),
            # Waiting or paused: when the next check may run, if current flows
            # (see check_pending). It falls on a tick, as every snapshot
            # follows one: rounded, so the heartbeat's jitter of a few ms
            # neither repeats nor skips a second.
            "check_seconds_left": (max(1, int(round(check_at - now)))
                                   if check_at is not None and now < check_at else None),
            "probe_seconds": self.cfg.probe_seconds,
        }

        if ok:
            meter_status = "ok"
        elif self.meter_ever_ok:
            meter_status = "degraded"
        else:
            meter_status = "unavailable"

        courtesy_left = max(0.0, self.courtesy_deadline - now) if self.courtesy_deadline else 0.0
        log_error = self.log.error or (f"{len(self.pending)} record(s) waiting" if self.pending else None)
        waiting = self.state in (State.AWAITING_PAYMENT, State.COURTESY)
        receipt, turn, turns = self._shown_receipt() if waiting else (None, 0, 0)
        return {
            "state": self.state.value,
            "session_id": s.id,
            "current_ma": ma if (ok or held) else None,
            "voltage_mv": mv if (ok or held) else None,
            "watts": round(ma * mv / 1e6, 2) if (ok or held) and ma > 0 else 0.0,
            "wh": round(s.courtesy_wh if self.state == State.COURTESY else s.wh, 3),
            "held": held,
            # The phone's own word on a charger being attached (None: this
            # meter cannot tell): charging even when its battery is net negative.
            "charger_attached": plug if (ok or held) else None,
            # Not while waiting, checking or paused: the current then is not
            # (or not yet known to be) this station's.
            "delivering": s.delivering and charging and phase in (None, "running"),
            "remaining_seconds": shown,
            "time_text": mmss(courtesy_left if self.state == State.COURTESY else shown),
            "fichas_left": fichas_left,
            "fichas_bought": s.fichas,
            # False once a whole ficha no longer fits in the session: a payment
            # would then be capped (money for no energy), so the screen hides
            # the pay QR.
            "can_add": round(room) >= self.cfg.ficha_seconds,
            # The countdown has not started: waiting for the phone to charge
            # here (or, without verification on usb_vbus, to come back).
            "waiting_for_device": charging and not s.started,
            "charge": charge,
            "courtesy_seconds_left": int(math.ceil(courtesy_left)),
            "courtesy_available": (self.state == State.AWAITING_PAYMENT and now >= self.cooldown_until
                                   and self.relay.healthy),
            "powered": powered,
            "relay": {"open": self.relay.is_open, "healthy": self.relay.healthy, "error": self.relay.error},
            "meter": meter_status,
            "log": {"status": "error" if log_error else "ok", "detail": log_error or "",
                    "pending": len(self.pending)},
            "out_of_service": self.out_of_service(),
            "notice": self.notice[0] if self.notice else None,
            # Built fresh each time, so the cut shows as soon as it is confirmed.
            "last": self._session_record() if self.state == State.FINISHED else None,
            "mode": self.cfg.payment_mode,
            # Custody: what the pay link carries, the session's deadline, and
            # ledger time now, which deadlines are in (the screen counts the
            # minutes left to claim from it: neither this computer's clock
            # nor its time zone decides), with this station's clock skew.
            "custody": ({"session": bare(s.id), "anchor": b64url(s.anchor), "deadline": s.deadline,
                         "claim_window_seconds": CLAIM_WINDOW_SECONDS, "ledger_time": int(self.ledger_time()),
                         "clock_skew": self.clock_skew}
                        if self.cfg.custody and s.anchor is not None else None),
            # Custody, while waiting: a receipt still waiting to be claimed
            # that gives something back, smaller; with two (_on_screen()),
            # which one of them it is.
            "last_receipt": receipt["record"] if receipt else None,
            "last_receipt_turn": [turn, turns] if turns > 1 else None,
        }

    def say(self, text: str, seconds: float = 6.0) -> None:
        """A notice on screen (main.py: the simulated phone's U key)."""
        self._say(text, seconds)
