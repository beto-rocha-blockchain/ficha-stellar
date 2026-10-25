"""Watching the ledger for payments to the host.

Polling, not streaming: every HORIZON_POLL_SECONDS we ask Horizon for the
payments of HOST_PUBLIC_KEY after our cursor, with ?join=transactions so the
memo comes with each record. Those it sends (a refund the host pays back)
go to their own callback and never credit anything. The cursor lives in a file named by network and account.
The first run without a cursor starts at the newest payment made before the
station started: history is never replayed, and nothing paid after the start
is skipped, even if Horizon could not be reached at first. On testnet, a
cursor far past the network's latest ledger (saved before a testnet reset,
when the ledger started over) is dropped the same way. Before any of it,
Horizon's root must say it serves STELLAR_NETWORK's network: until it does,
nothing is read and every poll fails.

The station only ever knows the host's PUBLIC key. Nothing here signs.
"""

from __future__ import annotations

import asyncio
import logging
import re
import secrets
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal
from typing import Callable
from urllib.parse import quote, urlencode, urlsplit

import httpx

from config import (
    ID_ALPHABET, LEDGER_RESET_MARGIN, MEMO_TEXT_MAX_BYTES, NETWORK_PASSPHRASES, STATION_ID_LENGTH, Config,
)

log = logging.getLogger("ficha.stellar")

ACCEPTED_TYPES = {"payment", "path_payment_strict_send", "path_payment_strict_receive"}

# Testnet: with nothing new after the cursor, at most this often the cursor
# is checked against the network's latest ledger (a reset).
RESET_CHECK_SECONDS = 60.0


def token_ledger(paging_token: str | None) -> int | None:
    """The ledger a payment's paging token is in (its top 32 bits), or None."""
    return int(paging_token) >> 32 if paging_token and paging_token.isdigit() else None

SEP7_MSG_MAX_CHARS = 300

# "<STATION_ID>.<SESSION>", the memo of a station that has an ID.
_STATION_MEMO = re.compile(rf"([{ID_ALPHABET}]{{{STATION_ID_LENGTH}}})\.F[{ID_ALPHABET}]{{7}}")


def new_session_id() -> str:
    sid = "F" + "".join(secrets.choice(ID_ALPHABET) for _ in range(7))
    assert len(sid.encode()) <= MEMO_TEXT_MAX_BYTES
    return sid


def session_memo(cfg: Config, session_id: str) -> str:
    """The memo a payment for this session carries: "<STATION_ID>.<SESSION>",
    or the bare session ID on a station without an ID (legacy)."""
    memo = f"{cfg.station_id}.{session_id}" if cfg.station_id else session_id
    validate_memo(memo)
    return memo


def memo_station(memo: str | None) -> str | None:
    """The station ID a memo is addressed to, or None when it has no prefix."""
    m = _STATION_MEMO.fullmatch(memo or "")
    return m.group(1) if m else None


def validate_memo(memo: str) -> None:
    if len(memo.encode("utf-8")) > MEMO_TEXT_MAX_BYTES:
        raise ValueError(f"memo {memo!r} exceeds {MEMO_TEXT_MAX_BYTES} bytes")


def format_amount(amount: Decimal) -> str:
    return format(amount.normalize(), "f")


def sep7_msg(cfg: Config, memo: str) -> str:
    msg = f"Ficha {cfg.station_name or 'charging'} · session {memo}"
    if len(msg) > SEP7_MSG_MAX_CHARS:
        raise ValueError(f"SEP-0007 msg exceeds {SEP7_MSG_MAX_CHARS} characters")
    return msg


def sep7_uri(cfg: Config, memo: str, amount: Decimal) -> str:
    """SEP-0007 pay URI. For native XLM, asset_code/asset_issuer are omitted.
    network_passphrase is omitted on the public network only: SEP-0007 reads
    a URI without it as a public-network request, so a testnet QR must say so."""
    validate_memo(memo)
    params: list[tuple[str, str]] = [
        ("destination", cfg.host_public_key),
        ("amount", format_amount(amount)),
    ]
    if not cfg.is_native:
        params += [("asset_code", cfg.asset_code), ("asset_issuer", cfg.asset_issuer)]
    params += [
        ("memo", memo),
        ("memo_type", "MEMO_TEXT"),
    ]
    if cfg.network != "public":
        params.append(("network_passphrase", NETWORK_PASSPHRASES[cfg.network]))
    params.append(("msg", sep7_msg(cfg, memo)))
    return "web+stellar:pay?" + urlencode(params, quote_via=quote)


# A refund the host pays back to a payer carries the text memo "refund <REF>"
# (docs/station-app-contract.md, section 3.1): REF is the session ID, or, for
# a payment whose memo names none of this station's sessions, its transaction.
REFUND_MEMO_PREFIX = "refund "


def refund_memo(ref: str) -> str:
    memo = REFUND_MEMO_PREFIX + ref
    validate_memo(memo)
    return memo


def refund_ref_of(memo: str | None) -> str | None:
    """The REF a refund's memo names, or None when it is no refund's memo."""
    if not memo or not memo.startswith(REFUND_MEMO_PREFIX):
        return None
    return memo[len(REFUND_MEMO_PREFIX):] or None


def refund_tx_ref(cfg: Config, tx_hash: str) -> str:
    """The REF of a refund for a payment whose memo names none of this
    station's sessions: "<STATION_ID>.tx<first 8 hex of its hash>", or
    "tx<first 12 hex>" when that does not fit the memo (no STATION_ID)."""
    h = tx_hash.removeprefix("debug-")  # MOCK_PAYMENT: never on the ledger
    ref = f"{cfg.station_id}.tx{h[:8]}"
    if cfg.station_id and len((REFUND_MEMO_PREFIX + ref).encode("utf-8")) <= MEMO_TEXT_MAX_BYTES:
        return ref
    return f"tx{h[:12]}"


def refund_uri(cfg: Config, payer: str, amount: Decimal, ref: str, asset_code: str = "XLM",
               asset_issuer: str | None = None) -> str:
    """SEP-0007 pay URI of a refund: the HOST pays `amount` back to `payer`,
    the payer written in the station's log (never an address from a wallet's
    history), with the memo "refund <REF>". As sep7_uri(): asset_code and
    asset_issuer only for an issued asset, network_passphrase on every
    network but public. The host's wallet scans it, or the Ficha site's
    /refund page builds the payment from it."""
    memo = refund_memo(ref)
    params: list[tuple[str, str]] = [("destination", payer), ("amount", format_amount(amount))]
    if asset_issuer:
        params += [("asset_code", asset_code), ("asset_issuer", asset_issuer)]
    params += [("memo", memo), ("memo_type", "MEMO_TEXT")]
    if cfg.network != "public":
        params.append(("network_passphrase", NETWORK_PASSPHRASES[cfg.network]))
    params.append(("msg", f"Ficha refund · {ref}"))
    return "web+stellar:pay?" + urlencode(params, quote_via=quote)


@dataclass(frozen=True)
class Payment:
    tx_hash: str
    op_id: str
    payer: str
    amount: Decimal
    asset: str
    memo: str | None  # text memo only; other memo types come through as None
    created_at: str
    source: str = "horizon"  # horizon | debug
    # Paid in another asset than the station's: never credited. asset is then
    # the code actually paid ("XLM" for native) and asset_issuer its issuer.
    wrong_asset: bool = False
    asset_issuer: str = ""
    # The account paid: the host, or, for a payment the host sent (payer is
    # the host), its recipient.
    destination: str = ""

    @property
    def key(self) -> str:
        """Identity of this payment. Horizon may deliver the same operation
        twice; one transaction may also carry several payments to the host."""
        return payment_key(self.tx_hash, self.op_id)


def payment_key(tx_hash: str | None, op_id: str | None) -> str:
    return f"{tx_hash}/{op_id}"


def _asset_code(rec: dict) -> str:
    return "XLM" if rec.get("asset_type") == "native" else str(rec.get("asset_code") or "?")


def _created_at(rec: dict) -> datetime | None:
    try:
        created = datetime.fromisoformat(rec["created_at"])
    except (KeyError, TypeError, ValueError):
        return None
    return created if created.tzinfo else created.replace(tzinfo=timezone.utc)


class WrongNetwork(Exception):
    """Horizon serves another network than STELLAR_NETWORK: the full message
    for the console, `short` for the footer."""

    def __init__(self, message: str, short: str) -> None:
        super().__init__(message)
        self.short = short


class HorizonWatcher:
    PAGE = 200

    def __init__(
        self,
        cfg: Config,
        on_payment: Callable[[Payment], None],
        now: Callable[[], datetime] = lambda: datetime.now(timezone.utc),
        on_read: Callable[[], None] | None = None,
        on_sent: Callable[[Payment], None] | None = None,
    ) -> None:
        self.cfg = cfg
        self.on_payment = on_payment
        # A payment the host sent (Station.on_host_payment): a refund it pays
        # back, or its own business. Never on_payment: it credits nothing.
        self.on_sent = on_sent
        # Called after each poll Horizon answered (Station.on_horizon): on
        # the public network, with none for a while, the pay QR goes.
        self.on_read = on_read
        # Payments made after this are this run's business, however long
        # Horizon takes to answer the first time.
        self.started_at = now()
        self.status = "starting"
        self.detail = ""
        self.last_ok: float | None = None
        self.cursor: str | None = None
        self.cursor_error: str | None = None
        self.reset_checked_at: float | None = None  # monotonic
        self.network_checked = False  # Horizon's root said STELLAR_NETWORK's passphrase

    # -- health, for the footer ------------------------------------------
    def health(self) -> dict:
        return {"status": self.status, "detail": self.detail}

    def _set(self, status: str, detail: str = "", full: str = "") -> None:
        """detail is for the footer; full, when given, is the whole story for the console."""
        if (status, detail) != (self.status, self.detail):
            (log.warning if status == "error" else log.info)("horizon %s %s", status, full or detail)
        self.status, self.detail = status, detail

    # -- cursor ------------------------------------------------------------
    def _load_cursor(self) -> str | None:
        try:
            text = self.cfg.cursor_file.read_text().strip()
            return text or None
        except FileNotFoundError:
            return None

    def _save_cursor(self, cursor: str) -> None:
        """The cursor always moves on in memory. If the file cannot be written,
        payments keep being processed and the footer shows the error; after a
        restart Horizon may hand some payments over again, and the station
        ignores the ones it has already handled."""
        self.cursor = cursor
        try:
            tmp = self.cfg.cursor_file.with_suffix(".tmp")
            tmp.write_text(cursor)
            tmp.replace(self.cfg.cursor_file)
        except OSError as exc:
            error = f"cursor not saved: {exc.strerror or exc}"
            if error != self.cursor_error:
                log.error("horizon %s (%s)", error, self.cfg.cursor_file)
            self.cursor_error = error
            return
        if self.cursor_error:
            log.info("horizon cursor saved again")
        self.cursor_error = None

    # -- polling -------------------------------------------------------------
    @property
    def _payments_url(self) -> str:
        return f"{self.cfg.horizon_url}/accounts/{self.cfg.host_public_key}/payments"

    async def _check_network(self, client: httpx.AsyncClient) -> None:
        """Horizon's root must say it serves STELLAR_NETWORK's network (its
        network_passphrase), the one the pay QR asks for. A Horizon on another
        network (futurenet, a local quickstart, a testnet one on a public
        station) never sees a payment made from the QR, and would credit one
        made there, with free coins, under the session's memo. Raises
        WrongNetwork until it says so: no cursor is saved, nothing is
        credited, and on the public network the pay QR stays hidden
        (Station.out_of_service()). Asked once per run, before anything else."""
        resp = await client.get(f"{self.cfg.horizon_url}/")
        resp.raise_for_status()
        try:
            root = resp.json()
        except ValueError:
            root = None
        said = root.get("network_passphrase") if isinstance(root, dict) else None
        wanted = NETWORK_PASSPHRASES[self.cfg.network]
        host = urlsplit(self.cfg.horizon_url).hostname or "HORIZON_URL"
        if said != wanted:
            what = f"says it serves {said!r}" if isinstance(said, str) else "does not say which network it serves"
            raise WrongNetwork(
                f"the Horizon at {host} {what}, and STELLAR_NETWORK={self.cfg.network} needs {wanted!r}: no "
                f"payment is read from it until it says so. Point HORIZON_URL at a {self.cfg.network} Horizon, "
                "or leave it empty for SDF's.",
                f"not the {self.cfg.network} network",
            )
        self.network_checked = True
        log.info("horizon at %s serves %r, the %s network", host, said, self.cfg.network)

    async def _init_cursor(self, client: httpx.AsyncClient) -> None:
        """No cursor yet: start at the newest payment made at or before the
        station started. Older history is never replayed; anything paid after
        the start is processed, even if Horizon was unreachable at first."""
        params = {"order": "desc", "limit": self.PAGE}
        while True:
            resp = await client.get(self._payments_url, params=params)
            if resp.status_code == 404:
                raise RuntimeError(f"account not found on {self.cfg.network} (is it funded?)")
            resp.raise_for_status()
            records = resp.json()["_embedded"]["records"]
            for rec in records:
                created = _created_at(rec)
                if created is None or created <= self.started_at:
                    self._save_cursor(rec["paging_token"])
                    log.info("horizon cursor initialized at %s, the last payment before the start "
                             "(history is not replayed)", self.cursor)
                    return
            if len(records) < self.PAGE:
                break
            params = {"order": "desc", "limit": self.PAGE, "cursor": records[-1]["paging_token"]}
        self._save_cursor("0")  # every payment on the account came after the start
        log.info("horizon cursor initialized at the beginning (no payment before the start)")

    def _matches_asset(self, rec: dict) -> bool:
        if self.cfg.is_native:
            return rec.get("asset_type") == "native"
        return rec.get("asset_code") == self.cfg.asset_code and rec.get("asset_issuer") == self.cfg.asset_issuer

    def _to_payment(self, rec: dict) -> Payment | None:
        """A payment to the host, or one the host sent (payer the host, even
        to itself), or None."""
        if rec.get("type") not in ACCEPTED_TYPES:
            return None
        host = self.cfg.host_public_key
        if rec.get("from") != host and rec.get("to") != host:
            return None
        if not rec.get("transaction_successful", True):
            return None
        tx = rec.get("transaction") or {}
        memo = tx.get("memo") if tx.get("memo_type") == "text" else None
        # Another asset buys nothing, but it is handed over all the same: the
        # station logs it for refund when the memo is its own.
        wrong = not self._matches_asset(rec)
        return Payment(
            tx_hash=rec.get("transaction_hash", ""),
            op_id=rec.get("id", ""),
            payer=rec.get("from", ""),
            amount=Decimal(rec["amount"]),
            asset=_asset_code(rec) if wrong else self.cfg.asset_label,
            memo=memo,
            created_at=rec.get("created_at", ""),
            wrong_asset=wrong,
            asset_issuer=rec.get("asset_issuer", "") if wrong else "",
            destination=rec.get("to", ""),
        )

    async def poll_once(self, client: httpx.AsyncClient) -> None:
        if not self.network_checked:
            # Before the cursor too: a first run saves one from what it reads.
            await self._check_network(client)
        if self.cursor is None:
            self.cursor = self._load_cursor()
        if self.cursor is None:
            await self._init_cursor(client)
        while True:
            resp = await client.get(
                self._payments_url,
                params={"cursor": self.cursor, "order": "asc", "limit": self.PAGE, "join": "transactions"},
            )
            resp.raise_for_status()
            records = resp.json()["_embedded"]["records"]
            for rec in records:
                payment = self._to_payment(rec)
                if payment is None:
                    pass
                elif payment.payer == self.cfg.host_public_key:
                    # Sent by the host, whatever its memo: never a payment to a session.
                    log.info("host sent %s %s to %s memo=%r", payment.amount, payment.asset, payment.destination,
                             payment.memo)
                    if self.on_sent:
                        self.on_sent(payment)
                else:
                    log.info("payment %s %s from %s memo=%r", payment.amount, payment.asset, payment.payer, payment.memo)
                    self.on_payment(payment)
                self._save_cursor(rec["paging_token"])
            if not records and await self._reset(client):
                continue
            if len(records) < self.PAGE:
                return

    async def _reset(self, client: httpx.AsyncClient) -> bool:
        """Testnet, nothing after the cursor: is it far past the network's
        latest ledger (Horizon's root, history_latest_ledger)? Then it was
        saved before a testnet reset, when the ledger started over, and
        Horizon answers it with nothing for months while the footer says ok:
        start over as on a first run. Checked at most every
        RESET_CHECK_SECONDS; a root Horizon cannot give is no reset."""
        now = time.monotonic()
        if self.cfg.network != "testnet" or (self.reset_checked_at is not None
                                              and now - self.reset_checked_at < RESET_CHECK_SECONDS):
            return False
        self.reset_checked_at = now
        at = token_ledger(self.cursor)
        if at is None:
            return False
        try:
            resp = await client.get(f"{self.cfg.horizon_url}/")
            resp.raise_for_status()
            latest = int(resp.json()["history_latest_ledger"])
        except Exception as exc:
            log.debug("horizon root not readable (%s): cursor not checked", exc)
            return False
        if at <= latest + LEDGER_RESET_MARGIN:
            return False
        log.warning("horizon cursor %s is in ledger %d, past the network's latest ledger %d: the testnet was "
                    "reset; the cursor starts over", self.cursor, at, latest)
        await self._init_cursor(client)
        return True

    async def poll(self, client: httpx.AsyncClient) -> None:
        """One round, health included. Never raises (but can be cancelled)."""
        try:
            await self.poll_once(client)
            self.last_ok = time.monotonic()
            # Horizon answered, payments are seen: even when the cursor file
            # could not be saved (the footer says so).
            if self.on_read:
                self.on_read()
            if self.cursor_error:
                self._set("error", self.cursor_error)
            else:
                self._set("ok")
        except asyncio.CancelledError:
            raise
        except WrongNetwork as exc:
            self._set("error", exc.short, full=str(exc))
        except httpx.HTTPStatusError as exc:
            # httpx says it in two lines with the whole request URL, far too
            # long for the footer: it would push the price off the screen.
            resp = exc.response
            self._set("error", f"HTTP {resp.status_code} {resp.reason_phrase}".strip(), full=str(exc))
        except Exception as exc:  # network trouble never kills the station
            self._set("error", str(exc) or exc.__class__.__name__)

    async def run(self) -> None:
        async with httpx.AsyncClient(timeout=10.0) as client:
            while True:
                await self.poll(client)
                await asyncio.sleep(self.cfg.horizon_poll_seconds)
