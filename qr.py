"""QR codes for the station screen: the payment QR (SEP-0007, or the custody
pay link), the WiFi "Get online" QR and the receipt QR. All are generated
here and sent to the page as data URIs, never fetched from anywhere: the
screen has to work offline.
"""

from __future__ import annotations

import base64
import io
from datetime import datetime
from decimal import Decimal
from urllib.parse import quote, urlencode

import qrcode
import qrcode.image.svg

from config import Config
from escrow import from_b64url, pay_link, to_amount
from stellar import format_amount, sep7_uri

# Characters the WiFi QR format reserves; each is escaped with a backslash.
_WIFI_SPECIAL = "\\;,:"


def data_uri(text: str) -> str:
    """An SVG QR of `text` as a data URI."""
    img = qrcode.make(text, image_factory=qrcode.image.svg.SvgPathImage, border=2,
                      error_correction=qrcode.constants.ERROR_CORRECT_M)
    buf = io.BytesIO()
    img.save(buf)
    return "data:image/svg+xml;base64," + base64.b64encode(buf.getvalue()).decode()


_pay_cache: dict[tuple[str, str | None], tuple[str, str]] = {}


def pay_qr(cfg: Config, session_id: str, anchor: str | None = None) -> tuple[str, str]:
    """(uri, QR data URI) to pay this session. Direct mode: SEP-0007, asking
    for 1 ficha with the session's memo (a session's id is its memo).
    Custody: the pay link with the session's anchor (base64url), where the
    payer picks the fichas in the app (docs/station-app-contract.md, 7.3)."""
    key = (session_id, anchor if cfg.custody else None)
    if key not in _pay_cache:
        uri = pay_link(cfg, session_id, from_b64url(anchor)) if cfg.custody else \
            sep7_uri(cfg, session_id, cfg.ficha_price)
        _pay_cache.clear()  # only the current session is ever shown
        _pay_cache[key] = (uri, data_uri(uri))
    return _pay_cache[key]


_VERDICTS = {"delivered": "d", "no_current": "n", "unverified": "u"}


def receipt_payload(cfg: Config, record: dict, app_only: bool = False) -> str:
    """The receipt of a paid session (docs/station-app-contract.md, section 3):
    <APP_URL>/r?v=1&m=...&t=..., or ficha:/r?v=1&... without APP_URL (or,
    app_only, always: phone cameras do not open it, the Ficha app does).
    Unsigned, since the station holds no key: the app treats it as the
    station's statement and checks it against the payment on the ledger.

    A custody session's receipt is v=2 (section 7.6): a, f and p are its
    deposit's totals on the contract, and q and z, the unused units and the
    proof that refunds them, follow t."""
    # u: paid time the countdown consumed, that is time this station was
    # verified to be charging the phone (CHARGE_VERIFY, the default).
    used = record.get("consumed_seconds")
    if used is None:
        used = record["paid_seconds"] - (record["capped_seconds"] or 0) - (record["unused_seconds"] or 0)
    stamps = record["timestamps"]
    # A session rebuilt at a restart ended when the station came back.
    finished = datetime.fromisoformat(stamps.get("FINISHED") or stamps["RECOVERED"])
    custody = record.get("custody")
    amount, fichas, paid = Decimal(str(record["amount"])), record["fichas"], record["paid_seconds"]
    if custody:
        amount, fichas = to_amount(custody["total_amount"]), custody["total_fichas"]
        paid = fichas * custody["ficha_seconds"]
    # Rebuilt at a restart: the energy and the peak are unknown, the first
    # delivering reading is the most that is known.
    wh = record["wh"] if record.get("wh") is not None else 0.0
    peak = record.get("max_current_ma")
    if peak is None:
        peak = record.get("first_delivering_ma") or 0
    params = [
        ("v", "2" if custody else "1"),
        ("m", record["id"]),
        ("n", "p" if record["network"] == "public" else "t"),
        ("h", record["host_key"]),
        ("a", format_amount(amount)),
        ("k", record["asset"]),
        ("f", str(fichas)),
        ("p", str(paid)),
        ("u", str(max(0, used))),
        ("wh", f"{wh:.3f}"),
        ("x", str(peak)),
        ("vd", _VERDICTS[record["verdict"]]),
        ("c", "1" if record["cut_confirmation"].get("confirmed") else "0"),
        ("t", str(int(finished.timestamp()))),
    ]
    if custody:
        params += [("q", str(custody["unused_units"])), ("z", custody["proof"])]
    base = "ficha:" if app_only else cfg.app_url or "ficha:"
    return f"{base}/r?" + urlencode(params, quote_via=quote)


_receipt_cache: dict[str, str] = {}


def receipt_qr(cfg: Config, snap: dict) -> dict | None:
    """{"uri", "qr"} while the FINISHED screen of a paid session is up, else None."""
    last = snap.get("last")
    if snap.get("state") != "FINISHED" or not last or not last.get("fichas"):
        return None
    uri = receipt_payload(cfg, last)
    if uri not in _receipt_cache:
        _receipt_cache.clear()  # changes once, when the cut is confirmed
        _receipt_cache[uri] = data_uri(uri)
    return {"uri": uri, "qr": _receipt_cache[uri]}


_last_receipt_cache: dict[str, str] = {}


def last_receipt_qr(cfg: Config, record: dict | None) -> dict | None:
    """Custody: a receipt still waiting to be claimed, on the waiting screen
    until it settles or its deadline passes, with what it gives back and
    until when. As ficha:/r?..., never the APP_URL link: it sits beside the
    pay QR, and someone who came to pay and points a phone camera at it must
    not land on someone else's receipt. The Ficha app's scanner (and, on
    Android, its ficha: link) reads it."""
    if not record or not record.get("custody"):
        return None
    uri = receipt_payload(cfg, record, app_only=True)
    if uri not in _last_receipt_cache:
        _last_receipt_cache.clear()
        _last_receipt_cache[uri] = data_uri(uri)
    custody = record["custody"]
    return {"uri": uri, "qr": _last_receipt_cache[uri], "session_id": record["id"],
            "to_payer": format_amount(to_amount(custody["to_payer"])), "asset": record["asset"],
            "deadline": custody.get("deadline"), "full": record.get("end_reason") == "not_served"}


def wifi_escape(text: str) -> str:
    return "".join("\\" + c if c in _WIFI_SPECIAL else c for c in text)


def wifi_payload(ssid: str, password: str, security: str) -> str:
    """WIFI:T:<sec>;S:<ssid>;P:<pass>;; as phone cameras read it."""
    if security == "nopass":
        return f"WIFI:T:nopass;S:{wifi_escape(ssid)};P:;;"
    return f"WIFI:T:{security};S:{wifi_escape(ssid)};P:{wifi_escape(password)};;"


_wifi_cache: dict[tuple[str, str, str], str] = {}


def wifi_qr(cfg: Config) -> str | None:
    """QR data URI to join the offered network, or None when none is offered."""
    if not cfg.wifi_ssid:
        return None
    key = (cfg.wifi_ssid, cfg.wifi_password, cfg.wifi_security)
    if key not in _wifi_cache:
        _wifi_cache[key] = data_uri(wifi_payload(*key))
    return _wifi_cache[key]
