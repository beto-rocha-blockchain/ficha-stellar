"""Custody mode: the hash chain, the pay link, the startup check against the
FichaEscrow contract, and the watcher of its events
(docs/station-app-contract.md, section 7).

The payer deposits into the contract instead of paying the host. For each
session the station draws a random seed c[0] and puts the tip of its hash
chain, the anchor c[N] = sha256^N(c[0]), in the pay link. When the session
ends the receipt reveals c[N-U], which proves that U units of paid time were
NOT delivered: only the session's payer can claim them back with it, and a
session nobody claims goes to the host in full after its deadline. The seed
signs nothing and can only refund that session's payer.

On the contract a session is (host, station, session ID, anchor): a deposit
with another anchor under this station's session ID is someone else's
session, which this station never serves and which cannot touch its own.

The station still holds no Stellar key and no account, signs nothing and pays
no fee: it only reads the contract through a Soroban RPC (getEvents and
getLedgerEntries).
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import logging
import math
import re
import secrets
import time
from dataclasses import dataclass
from datetime import timezone
from decimal import Decimal
from typing import Callable, Union

from stellar_sdk import Asset, SorobanServer, scval, xdr
from stellar_sdk.client.requests_client import RequestsClient
from stellar_sdk.exceptions import SorobanRpcErrorResponse
from stellar_sdk.soroban_rpc import EventFilter, EventFilterType, EventInfo, GetEventsResponse

from config import LEDGER_RESET_MARGIN, NETWORK_PASSPHRASES, STELLAR_DECIMALS, Config, ConfigError

log = logging.getLogger("ficha.escrow")

SEED_BYTES = 32
# How often a custody session's consumed time goes to the log while it runs:
# a session the station did not see end refunds from the last one, which is
# never more than the time actually consumed.
CHECKPOINT_SECONDS = 30
# The startup check delays a start only when the RPC is down.
CHECK_TIMEOUT = 5.0
# The first run on a contract, host and station reads events from about when
# the station started, this many ledgers (~5 s each) earlier: nothing made
# after the start is skipped, and older history is never replayed.
FIRST_RUN_MARGIN_LEDGERS = 12
LEDGER_SECONDS = 5

_B64URL_32 = re.compile(r"[A-Za-z0-9_-]{43}")
# A session's terms on the contract (its Terms), the station's own when they match.
TERMS_KEYS = ("token", "price", "ficha_secs", "max_fichas", "unit_secs", "grace_secs")


# -- the hash chain ---------------------------------------------------------------
def b64url(raw: bytes) -> str:
    """base64url (RFC 4648 section 5) without padding: 43 characters for 32 bytes."""
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def from_b64url(text: str) -> bytes:
    """Exactly 32 bytes from their 43-character base64url, or ValueError."""
    if not isinstance(text, str) or not _B64URL_32.fullmatch(text):
        raise ValueError("not 32 bytes in base64url")
    raw = base64.urlsafe_b64decode(text + "=")
    if b64url(raw) != text:  # the last character carries 2 bits that must be zero
        raise ValueError("not 32 bytes in canonical base64url")
    return raw


def new_seed() -> bytes:
    """c[0]: new for every session, from a cryptographic random source,
    never reused and never derived from anything."""
    return secrets.token_bytes(SEED_BYTES)


def hash_times(value: bytes, times: int) -> bytes:
    """SHA-256 applied `times` times, over the raw 32 bytes."""
    for _ in range(times):
        value = hashlib.sha256(value).digest()
    return value


def anchor_of(seed: bytes, n: int) -> bytes:
    """c[N], the anchor the pay link and the deposit carry."""
    return hash_times(seed, n)


def proof(seed: bytes, n: int, unused: int) -> bytes:
    """c[N-U]: SHA-256 applied U times to it gives the anchor. Hashing forward
    only ever proves fewer units."""
    if not 0 <= unused <= n:
        raise ValueError(f"unused units {unused} not within 0..{n}")
    return hash_times(seed, n - unused)


# -- units, shares, deadlines (section 7.7) -----------------------------------------
def unused_units(paid_seconds: int, consumed_seconds: int, unit_seconds: int) -> int:
    """U = min(paid units, ceil(max(0, paid - consumed) / unit)): rounded up,
    in the payer's favour."""
    left = max(0, paid_seconds - consumed_seconds)
    return min(paid_seconds // unit_seconds, -(-left // unit_seconds))


def payer_share(amount: int, unused: int, paid_units: int) -> int:
    """What a claim of `unused` units pays back, as the contract computes it:
    ceil(amount x U' / paid units), U' = min(U, paid units)."""
    if paid_units <= 0:
        return 0
    return (amount * min(unused, paid_units) + paid_units - 1) // paid_units


def deadline(opened: int, total_fichas: int, ficha_seconds: int, grace_seconds: int) -> int:
    """Claim and top-ups until then (ledger unix seconds); release after it."""
    return opened + total_fichas * ficha_seconds + grace_seconds


def price_stroops(cfg: Config) -> int:
    """One ficha in the token's smallest unit: the contract's price."""
    return int(cfg.ficha_price.scaleb(STELLAR_DECIMALS))


def to_amount(stroops: int) -> Decimal:
    return Decimal(stroops).scaleb(-STELLAR_DECIMALS)


def token_contract(cfg: Config) -> str:
    """The asset's Stellar Asset Contract: the token the station's terms name."""
    asset = Asset.native() if cfg.is_native else Asset(cfg.asset_code, cfg.asset_issuer)
    return asset.contract_id(NETWORK_PASSPHRASES[cfg.network])


def bare(session_id: str) -> str:
    """The contract's session argument: "F3H9TXAB" of "ERZGCG.F3H9TXAB"."""
    return session_id.rsplit(".", 1)[-1]


def pay_link(cfg: Config, session_id: str, anchor: bytes) -> str:
    """<APP_URL>/p?v=1&n&h&s&x&a, in that order (section 7.3). It carries no
    amount and no contract ID: the payer picks fichas in the app, and the
    contract is the one the signed registry names. No value needs escaping."""
    params = (("v", "1"), ("n", "p" if cfg.network == "public" else "t"), ("h", cfg.host_public_key),
              ("s", cfg.station_id), ("x", bare(session_id)), ("a", b64url(anchor)))
    return f"{cfg.app_url or 'ficha:'}/p?" + "&".join(f"{k}={v}" for k, v in params)


def custody_block(*, escrow: str, session: str, anchor: bytes, chain_len: int, unit_seconds: int,
                  ficha_seconds: int, total_fichas: int, total_amount: int, deadline: int | None,
                  payer: str | None, unused: int, proof_value: bytes) -> dict:
    """What a session record says about its deposit and its refund: the
    receipt's q (unused_units) and z (proof), and the payer's share they claim."""
    paid_units = total_fichas * ficha_seconds // unit_seconds
    return {
        "escrow": escrow,
        "session": bare(session),
        "payer": payer,
        "anchor": b64url(anchor),
        "chain_len": chain_len,
        "unit_seconds": unit_seconds,
        "ficha_seconds": ficha_seconds,
        "total_fichas": total_fichas,
        "total_amount": total_amount,  # stroops
        "deadline": deadline,
        "unused_units": unused,
        "proof": b64url(proof_value),
        "to_payer": payer_share(total_amount, unused, paid_units),  # stroops
    }


# -- events ------------------------------------------------------------------------
@dataclass(frozen=True)
class Deposit:
    """A deposit event: a new session or a top-up of one (section 7.2). Or,
    after events were missed, a session read from the ledger (source
    "session"), which carries its totals only."""
    event_id: str
    tx_hash: str
    ledger: int
    closed_at: str
    session: str  # the bare session ID
    payer: str
    fichas: int  # bought by this deposit
    amount: int  # this deposit, in stroops
    total_fichas: int  # the session's totals after it
    total_amount: int
    anchor: bytes
    deadline: int  # ledger unix seconds
    source: str = "event"  # event | session | debug
    # The session's terms, frozen at its first deposit (TERMS_KEYS); None
    # only for a debug deposit that does not say.
    terms: dict | None = None


@dataclass(frozen=True)
class Settle:
    """A settle event: claim (how proof), release (deadline) or host_refund
    (host). The session is (session, anchor)."""
    event_id: str
    tx_hash: str
    ledger: int
    closed_at: str
    session: str
    payer: str
    to_host: int  # stroops
    to_payer: int
    unused_units: int
    how: str
    anchor: bytes | None = None  # None only for a debug settle that does not say


@dataclass(frozen=True)
class Gone:
    """A session the station tracks that is not open on the ledger, found by
    a read after events were missed: settled, or never paid."""
    session: str
    anchor: bytes | None = None


Event = Union[Deposit, Settle, Gone]


def _native(value):
    """scval.to_native, with addresses as their G.../C... strings."""
    if isinstance(value, dict):
        return {k: _native(v) for k, v in value.items()}
    return getattr(value, "address", value)


def _whole(value) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value < 0:
        raise ValueError(f"not a whole number: {value!r}")
    return value


def _bytes32(value) -> bytes:
    if not isinstance(value, (bytes, bytearray)) or len(value) != SEED_BYTES:
        raise ValueError("not 32 bytes")
    return bytes(value)


def _text(value) -> str:
    if not isinstance(value, str) or not value:
        raise ValueError(f"not text: {value!r}")
    return value


def _terms(value) -> dict:
    """A session's terms (the contract's Terms map), checked."""
    if not isinstance(value, dict):
        raise ValueError("terms: not a map")
    return {"token": _text(value["token"]), "price": _whole(value["price"]),
            **{k: _whole(value[k]) for k in TERMS_KEYS[2:]}}


def station_terms(cfg: Config) -> dict:
    """This station's own terms, as a session on the contract holds them."""
    want = expected_terms(cfg)
    return {k: want[k] for k in TERMS_KEYS}


def failed_call(e: EventInfo) -> bool:
    """Whether the RPC marks this event as one of a failed contract call.
    Since protocol 23 getEvents returns the events of successful calls only,
    and Stellar RPC 30 no longer sends inSuccessfulContractCall at all:
    stellar-sdk 16.1.1 reads it as None, and its next major drops the field.
    So only an explicit false, from an older RPC, is a failed call; a record
    that does not say is a successful one."""
    return getattr(e, "in_successful_contract_call", None) is False


def decode_event(cfg: Config, e: EventInfo) -> Deposit | Settle | None:
    """One getEvents record as a Deposit or a Settle of this station, or None
    (another host or station, a failed call, or a record it cannot read)."""
    try:
        kind, host, station, session = [_native(scval.to_native(xdr.SCVal.from_xdr(t))) for t in e.topic]
        if host != cfg.host_public_key or station != cfg.station_id or failed_call(e):
            return None
        data = _native(scval.to_native(xdr.SCVal.from_xdr(e.value)))
        closed = e.ledger_close_at
        common = {"event_id": e.id, "tx_hash": e.transaction_hash, "ledger": e.ledger,
                  "closed_at": (closed.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
                                if closed else ""),
                  "session": _text(session), "payer": _text(data["payer"])}
        if kind == "deposit":
            return Deposit(**common, fichas=_whole(data["fichas"]), amount=_whole(data["amount"]),
                           total_fichas=_whole(data["total_fichas"]), total_amount=_whole(data["total_amount"]),
                           anchor=_bytes32(data["anchor"]), deadline=_whole(data["deadline"]),
                           terms=_terms(data["terms"]))
        if kind == "settle":
            return Settle(**common, to_host=_whole(data["to_host"]), to_payer=_whole(data["to_payer"]),
                          unused_units=_whole(data["unused_units"]), how=_text(data["how"]),
                          anchor=_bytes32(data["anchor"]))
    except (KeyError, TypeError, ValueError, AttributeError) as exc:
        log.warning("escrow event %s could not be read (%s); skipped", getattr(e, "id", "?"), exc)
    return None


def deposit_from_session(session: str, s: dict) -> Deposit:
    """An open session read from the ledger, as a deposit of its totals. Its
    id names the session (ID and anchor) and the totals, so the same state
    read twice counts once."""
    anchor = _bytes32(s["anchor"])
    return Deposit(event_id=f"session:{session}:{b64url(anchor)[:8]}:{s['fichas']}", tx_hash="", ledger=0,
                   closed_at="", session=session, payer=_text(s["payer"]), fichas=_whole(s["fichas"]),
                   amount=_whole(s["amount"]), total_fichas=_whole(s["fichas"]), total_amount=_whole(s["amount"]),
                   anchor=anchor, deadline=_whole(s["deadline"]), source="session", terms=_terms(s))


# -- reading the ledger ------------------------------------------------------------------
class Ledger:
    """The contract, read through a Soroban RPC: no key, no fee, nothing
    signed or sent (section 7.2). Blocking calls: the event loop runs them in
    a thread."""

    def __init__(self, cfg: Config, server: SorobanServer | None = None, timeout: float = 10.0) -> None:
        self.cfg = cfg
        self.server = server or SorobanServer(cfg.rpc_url, client=RequestsClient(
            num_retries=0, request_timeout=math.ceil(timeout), post_timeout=timeout))
        host = scval.to_address(cfg.host_public_key).to_xdr()
        station = scval.to_symbol(cfg.station_id).to_xdr()
        self.filters = [EventFilter(event_type=EventFilterType.CONTRACT, contract_ids=[cfg.escrow_contract],
                                    topics=[[scval.to_symbol(k).to_xdr(), host, station, "*"]
                                            for k in ("deposit", "settle")])]

    def _entry(self, *key: xdr.SCVal) -> dict | None:
        entry = self.server.get_contract_data(self.cfg.escrow_contract, scval.to_vec(list(key)))
        if entry is None:
            return None
        return _native(scval.to_native(xdr.LedgerEntryData.from_xdr(entry.xdr).contract_data.val))

    def station(self) -> dict | None:
        """This station's terms on the contract (StationCfg), or None."""
        return self._entry(scval.to_symbol("Station"), scval.to_address(self.cfg.host_public_key),
                           scval.to_symbol(self.cfg.station_id))

    def session(self, session: str, anchor: bytes) -> dict | None:
        """The open session (Session) under this ID and anchor, or None: never
        paid, or settled."""
        return self._entry(scval.to_symbol("Session"), scval.to_address(self.cfg.host_public_key),
                           scval.to_symbol(self.cfg.station_id), scval.to_symbol(bare(session)),
                           scval.to_bytes(anchor))

    def network_passphrase(self) -> str:
        return self.server.get_network().passphrase

    def latest_ledger(self):
        return self.server.get_latest_ledger()

    def events(self, *, start_ledger: int | None = None, cursor: str | None = None,
               limit: int = 100) -> GetEventsResponse:
        return self.server.get_events(start_ledger=start_ledger, cursor=cursor, filters=self.filters, limit=limit)


def _why(exc: Exception) -> str:
    """Short enough for the footer."""
    text = getattr(exc, "message", None) or str(exc) or type(exc).__name__
    text = text.splitlines()[0] if text else type(exc).__name__
    return text if len(text) <= 80 else text[:79] + "…"


# -- the startup check (section 7.5) --------------------------------------------------------
def expected_terms(cfg: Config) -> dict:
    """This station's settings as the contract's StationCfg (section 7.4, step 3)."""
    return {"token": token_contract(cfg), "price": price_stroops(cfg), "ficha_secs": cfg.ficha_seconds,
            "max_fichas": cfg.max_fichas, "unit_secs": cfg.refund_unit_seconds,
            "grace_secs": cfg.escrow_grace_seconds, "active": True}


def differences(cfg: Config, terms: dict) -> list[str]:
    """Every term where this station and its entry on the contract disagree."""
    want = expected_terms(cfg)
    here = {
        "token": ("PAYMENT_ASSET_CODE/PAYMENT_ASSET_ISSUER", f"{cfg.asset_label} (its contract {want['token']})"),
        "price": ("FICHA_PRICE", f"{cfg.ficha_price} ({want['price']} stroops)"),
        "ficha_secs": ("FICHA_MINUTES", f"{cfg.ficha_minutes} ({want['ficha_secs']} s)"),
        "max_fichas": ("MAX_SESSION_MINUTES", f"{cfg.max_session_minutes} ({want['max_fichas']} fichas)"),
        "unit_secs": ("REFUND_UNIT_SECONDS", str(cfg.refund_unit_seconds)),
        "grace_secs": ("ESCROW_GRACE_SECONDS", str(cfg.escrow_grace_seconds)),
    }
    out = []
    if terms.get("active") is not True:
        out.append("the contract lists this station as inactive (active: false): it takes no deposits")
    for field, (env, shown) in here.items():
        if terms.get(field) != want[field]:
            out.append(f"{env}={shown} here, {field} {terms.get(field)} on the contract")
    return out


def check(cfg: Config, ledger: Ledger | None = None) -> dict:
    """Custody: this station's terms on the contract must be its own, read
    with no key (station() through getLedgerEntries). Run once at startup,
    after the registry check. Returns the footer's health,
    {"status": ok | unchecked | off, "detail": ...}; raises ConfigError on a
    difference, an RPC of another network, or no such station. An RPC it
    cannot reach lets the station start, "escrow unchecked"."""
    if not cfg.custody:
        return {"status": "off", "detail": "direct mode"}
    ledger = ledger or Ledger(cfg, timeout=CHECK_TIMEOUT)
    try:
        passphrase = ledger.network_passphrase()
        terms = ledger.station()
    except Exception as exc:
        log.warning("escrow UNCHECKED: the RPC at %s could not be read (%s). Starting anyway; make sure "
                    "%s is registered on %s with this station's terms.", cfg.rpc_url, _why(exc),
                    cfg.station_id, cfg.escrow_contract)
        return {"status": "unchecked", "detail": "RPC unreachable"}
    if passphrase != NETWORK_PASSPHRASES[cfg.network]:
        raise ConfigError(f"RPC_URL={cfg.rpc_url} serves the network {passphrase!r}, not {cfg.network}. "
                          "Empty RPC_URL follows the network.")
    where = f"the escrow contract {cfg.escrow_contract} (ESCROW_CONTRACT)"
    if terms is None:
        raise ConfigError(
            f"STATION_ID={cfg.station_id} is not registered under HOST_PUBLIC_KEY={cfg.host_public_key} on "
            f"{where}: the app could not pay it. The host registers it (register, signed with the host's "
            "key on the host's own device, never on the station), or fix ESCROW_CONTRACT, HOST_PUBLIC_KEY "
            "or STATION_ID.")
    diffs = differences(cfg, terms)
    if diffs:
        raise ConfigError(
            f"STATION_ID={cfg.station_id} does not match its terms on {where}. The app pays what the "
            "contract says:\n  - " + "\n  - ".join(diffs) +
            "\nChange .env to the contract's terms, or have the host register the station again with these.")
    log.info("escrow: %s matches its terms on %s", cfg.station_id, cfg.escrow_contract)
    return {"status": "ok", "detail": "contract"}


def recheck(cfg: Config, ledger: Ledger) -> list[str]:
    """Custody, while the station runs (main.py, every minute, and at once
    after a deposit under other terms): the startup check again. The host
    may register the station again with other terms, which the app then
    pays and this station refuses; and a startup check that could not reach
    the RPC never compared them. Blocking (main.py runs it in a thread).
    Returns why the station would no longer start, short ([]: it matches);
    raises when the RPC cannot be read (nothing new)."""
    passphrase = ledger.network_passphrase()
    if passphrase != NETWORK_PASSPHRASES[cfg.network]:
        return [f"RPC_URL serves another network ({passphrase})"]
    terms = ledger.station()
    if terms is None:
        return [f"STATION_ID={cfg.station_id} is not registered under this host on the contract"]
    return differences(cfg, terms)


# -- the watcher -------------------------------------------------------------------------
class EscrowWatcher:
    """Polls the contract's deposit and settle events for this station (host
    and STATION_ID) with getEvents, every HORIZON_POLL_SECONDS, after a
    cursor kept on disk per network, contract, host and station.

    The RPC keeps only a recent window of events (about 7 days on the testnet
    RPC). A cursor older than that means events were missed: the sessions the
    station still cares about (tracked) are read with session() instead. An
    open one comes in as a deposit of its totals, one that is gone as Gone.
    `tracked` gives them as (session ID, anchor). Each event reaches on_event
    on the event loop, never in a thread; before the events of each page
    read, on_read gets the latest ledger's close time (unix seconds, 0 when
    the RPC does not say): the station's ledger time, and its sign that the
    contract can be read."""

    PAGE = 100

    def __init__(self, cfg: Config, on_event: Callable[[Event], None],
                 tracked: Callable[[], list[tuple[str, bytes]]] = list, ledger: Ledger | None = None,
                 now: Callable[[], float] = time.time,
                 on_read: Callable[[int | None], None] | None = None) -> None:
        self.cfg = cfg
        self.on_event = on_event
        self.on_read = on_read
        self.tracked = tracked
        self.ledger = ledger or Ledger(cfg)
        self.started_at = now()
        self.status = "starting"
        self.detail = ""
        self.cursor: str | None = None
        self.cursor_ledger: int | None = None  # the newest ledger the cursor had scanned
        self.close_time: int | None = None  # the latest ledger's close time, at the last page read
        self.loaded = False
        self.cursor_error: str | None = None

    # -- health, for the footer ------------------------------------------
    def health(self) -> dict:
        return {"status": self.status, "detail": self.detail}

    def _set(self, status: str, detail: str = "") -> None:
        if (status, detail) != (self.status, self.detail):
            (log.warning if status == "error" else log.info)("escrow events %s %s", status, detail)
        self.status, self.detail = status, detail

    # -- cursor ------------------------------------------------------------
    @property
    def _whose(self) -> dict:
        """What the cursor file belongs to: its name has only a digest of it."""
        return {"network": self.cfg.network, "escrow": self.cfg.escrow_contract,
                "host": self.cfg.host_public_key, "station": self.cfg.station_id}

    def _load_cursor(self) -> None:
        self.loaded = True
        try:
            saved = json.loads(self.cfg.escrow_cursor_file.read_text())
            if {k: saved.get(k) for k in self._whose} != self._whose:
                raise ValueError("another network, contract, host or station")
            self.cursor, self.cursor_ledger = str(saved["cursor"]), int(saved["ledger"])
        except FileNotFoundError:
            pass
        except (OSError, ValueError, KeyError, TypeError, AttributeError) as exc:
            log.warning("escrow cursor %s unreadable (%s): starting as on a first run",
                        self.cfg.escrow_cursor_file.name, exc)

    def _save_cursor(self, cursor: str, ledger: int) -> None:
        """Always moves on in memory. A file that cannot be written shows as an
        error; after a restart some events come again, and the station ignores
        the ones it has already handled."""
        self.cursor, self.cursor_ledger = cursor, ledger
        path = self.cfg.escrow_cursor_file
        try:
            tmp = path.with_name(path.name + ".tmp")
            tmp.write_text(json.dumps({**self._whose, "cursor": cursor, "ledger": ledger}))
            tmp.replace(path)
        except OSError as exc:
            error = f"cursor not saved: {exc.strerror or exc}"
            if error != self.cursor_error:
                log.error("escrow %s (%s)", error, self.cfg.escrow_cursor_file)
            self.cursor_error = error
            return
        self.cursor_error = None

    def _past(self, latest: int) -> bool:
        """The cursor is far past the network's latest ledger: it was saved
        before a testnet reset (the ledger started over), and nothing after
        it would come for months. Dropped: the next read is as on a first run."""
        if self.cursor_ledger is None or self.cursor_ledger <= latest + LEDGER_RESET_MARGIN:
            return False
        log.warning("escrow cursor at ledger %d, past the network's latest ledger %d (a testnet reset?): "
                    "reading as on a first run", self.cursor_ledger, latest)
        self.cursor = self.cursor_ledger = None
        return True

    # -- polling -------------------------------------------------------------
    def _fetch(self) -> tuple[GetEventsResponse, bool]:
        """One page after the cursor, and whether events were missed before it.
        Blocking: runs in a thread."""
        if self.cursor is not None:
            try:
                resp = self.ledger.events(cursor=self.cursor, limit=self.PAGE)
            except SorobanRpcErrorResponse as exc:
                log.warning("escrow cursor refused by the RPC (%s): reading from its oldest ledger", _why(exc))
            else:
                if not self._past(resp.latest_ledger):
                    return resp, self.cursor_ledger is not None and self.cursor_ledger + 1 < resp.oldest_ledger
        latest = self.ledger.latest_ledger()
        self._past(latest.sequence)
        if self.cursor is None and self.cursor_ledger is None:
            # First run: from about when the station started, so a deposit
            # made while the RPC was still unreachable is not skipped.
            back = math.ceil(max(0.0, latest.close_time - self.started_at) / LEDGER_SECONDS)
            start = max(1, latest.sequence - back - FIRST_RUN_MARGIN_LEDGERS)
            try:
                return self.ledger.events(start_ledger=start, limit=self.PAGE), False
            except SorobanRpcErrorResponse:
                return self.ledger.events(start_ledger=latest.sequence, limit=self.PAGE), False
        # A cursor the RPC no longer has: from the oldest ledger it keeps.
        oldest = self.ledger.events(start_ledger=latest.sequence, limit=1).oldest_ledger
        start = max(oldest, (self.cursor_ledger or 0) + 1)
        return self.ledger.events(start_ledger=start, limit=self.PAGE), (self.cursor_ledger or 0) + 1 < oldest

    async def poll_once(self) -> None:
        if not self.loaded:
            self._load_cursor()
        while True:
            resp, missed = await asyncio.to_thread(self._fetch)
            # Read: ledger time for the station before it handles the events
            # (stellar-sdk 16 spells the field latest_Ledger_close_time).
            self.close_time = (getattr(resp, "latest_Ledger_close_time", None)
                               or getattr(resp, "latest_ledger_close_time", None))
            if self.on_read:
                self.on_read(self.close_time)
            for e in resp.events:
                ev = decode_event(self.cfg, e)
                if ev is not None:
                    log.info("escrow %s %s.%s (%s)", type(ev).__name__.lower(), self.cfg.station_id, ev.session,
                             ev.tx_hash)
                    self.on_event(ev)
            self._save_cursor(resp.cursor, resp.latest_ledger)
            if missed:
                await self._recover()
            if len(resp.events) < self.PAGE:
                return

    async def _recover(self) -> None:
        sessions = list(self.tracked())
        log.warning("escrow events were missed (the RPC no longer has them); reading %d session(s) instead",
                    len(sessions))
        for session, anchor in sessions:
            s = await asyncio.to_thread(self.ledger.session, session, anchor)
            self.on_event(deposit_from_session(bare(session), s) if s else Gone(bare(session), anchor))

    async def poll(self) -> None:
        """One round, health included. Never raises (but can be cancelled)."""
        try:
            await self.poll_once()
            if self.cursor_error:
                self._set("error", self.cursor_error)
            else:
                self._set("ok")
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # network trouble never kills the station
            self._set("error", _why(exc))

    async def run(self) -> None:
        while True:
            await self.poll()
            await asyncio.sleep(self.cfg.horizon_poll_seconds)
