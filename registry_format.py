"""The signed station registry: its format and its signature.

Shared by tools/registry.py (the operator signs and checks the registry) and
registry_check.py (a station checks its own entry at startup). Only public
keys here: verifying needs no secret, so a station can do it.

docs/station-app-contract.md, section 2, is the contract.
"""

from __future__ import annotations

import base64
import json
import re
from datetime import datetime
from decimal import Decimal
from pathlib import Path

from stellar_sdk import Keypair, StrKey
from stellar_sdk.exceptions import BadSignatureError

from config import (
    CLAIM_WINDOW_SECONDS, DEFAULT_PLUG_TIMEOUT_SECONDS, ESCROW_GRACE_RANGE, ESCROW_MAX_CHAIN,
    ESCROW_MAX_SESSION_SECONDS, ID_ALPHABET, PAYMENT_MODES, STATION_ID_LENGTH, STELLAR_DECIMALS,
)

REGISTRY_FORMAT = "ficha-registry/1"
SIG_FORMAT = "ficha-registry-sig/1"
# Only a custody entry carries these (section 2): they are the contract's terms.
CUSTODY_FIELDS = ("escrow", "unit_seconds", "grace_seconds")


class RegistryError(Exception):
    pass


def sig_path(path: Path) -> Path:
    return path.with_name(path.name + ".sig")


# -- contents ----------------------------------------------------------------
def _is_station_id(value) -> bool:
    return (isinstance(value, str) and len(value) == STATION_ID_LENGTH
            and all(c in ID_ALPHABET for c in value))


# Exactly the amounts the app accepts (app/src/stellar/amount.ts). Decimal()
# alone would also take ".5", "1.", "1e1", "+1" and "1_0", and the app drops
# a station whose price it cannot read, so the signed registry would pay nothing.
PRICE_RE = re.compile(r"[0-9]+(\.[0-9]+)?")


def _price_problem(value) -> str | None:
    if not isinstance(value, str) or not PRICE_RE.fullmatch(value):
        return f"must be a decimal string like \"1\" or \"0.25\" (digits, optionally a dot and decimals), not {value!r}"
    if "." in value and len(value.split(".")[1]) > STELLAR_DECIMALS:
        return f"has more than {STELLAR_DECIMALS} decimals"
    if Decimal(value) <= 0:
        return "must be greater than zero"
    return None


def _whole(value) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _mode_problems(st: dict, where: str, network: str | None = None) -> list[str]:
    """The payment mode (section 2): direct when absent; a custody entry names
    the escrow contract and the refund unit and grace the contract holds for
    it, within the contract's own bounds (an entry outside them never
    matches it). A direct entry carries none of them. Custody is testnet
    only until the contract is audited: no station could run it, and the
    app could not pay it, on the public network."""
    mode = st.get("mode", "direct")
    if mode not in PAYMENT_MODES:
        return [f"{where}: mode must be \"direct\" or \"custody\", not {mode!r}"]
    if mode == "direct":
        extra = [f for f in CUSTODY_FIELDS if f in st]
        return [f"{where}: {', '.join(extra)} only with \"mode\": \"custody\""] if extra else []
    problems = []
    if network == "public":
        problems.append(f"{where}: custody is for testnet only until the FichaEscrow contract is audited; "
                        "a public station is \"mode\": \"direct\"")
    asset = st.get("asset")
    if isinstance(asset, dict) and asset.get("issuer") is not None:
        # The escrow trusts the token's issuer: one (the host's own, say) could
        # freeze the payer before the claim or claw back the escrow's balance.
        problems.append(f"{where}: custody takes native XLM only for now (asset issuer null): an issued "
                        "asset's issuer could freeze a payer or claw back what the escrow holds")
    if not isinstance(st.get("escrow"), str) or not StrKey.is_valid_contract(st["escrow"]):
        problems.append(f"{where}: custody needs escrow, the FichaEscrow contract ID (C...)")
    minutes, cap, unit = st.get("ficha_minutes"), st.get("max_session_minutes"), st.get("unit_seconds")
    if not _whole(unit) or unit <= 0:
        problems.append(f"{where}: custody needs unit_seconds, a whole number above zero")
    elif _whole(minutes) and minutes > 0 and _whole(cap):
        session = cap // minutes * minutes * 60
        if (minutes * 60) % unit:
            problems.append(f"{where}: unit_seconds {unit} must divide ficha_minutes x 60 ({minutes * 60})")
        elif session // unit > ESCROW_MAX_CHAIN:
            problems.append(f"{where}: {session} s of paid time at unit_seconds {unit} is {session // unit} "
                            f"refund units, more than {ESCROW_MAX_CHAIN}")
        if session > ESCROW_MAX_SESSION_SECONDS:
            problems.append(f"{where}: custody holds at most {ESCROW_MAX_SESSION_SECONDS} s of paid time "
                            f"per session, not {session}")
    grace = st.get("grace_seconds")
    low, high = ESCROW_GRACE_RANGE
    if not _whole(grace) or not low <= grace <= high:
        problems.append(f"{where}: custody needs grace_seconds, a whole number from {low} to {high}")
    return problems


def parse(data: bytes) -> dict:
    try:
        reg = json.loads(data.decode("utf-8"))
    except (UnicodeDecodeError, ValueError) as exc:
        raise RegistryError(f"not UTF-8 JSON: {exc}") from None
    if not isinstance(reg, dict):
        raise RegistryError("the registry must be a JSON object")
    return reg


def validate(data: bytes, name: str = "stations.json") -> dict:
    """Parse and check a registry. Raises RegistryError listing every problem."""
    return validate_doc(parse(data), name)


def validate_doc(reg: dict, name: str = "stations.json") -> dict:
    problems = []
    if reg.get("format") != REGISTRY_FORMAT:
        problems.append(f"format must be {REGISTRY_FORMAT!r}")
    try:
        datetime.fromisoformat(reg.get("issued_at"))
    except (TypeError, ValueError):
        problems.append("issued_at must be a date and time like 2026-09-30T00:00:00Z")
    network = reg.get("network")
    if network not in ("testnet", "public"):
        problems.append("network must be testnet or public")
    elif (network == "public") != (".public." in name):
        problems.append(f"network {network!r} in {name}: public stations go in stations.public.json, "
                        "testnet ones in stations.json")
    stations = reg.get("stations")
    if not isinstance(stations, list):
        problems.append("stations must be a list")
        stations = []

    seen: set[str] = set()
    for n, st in enumerate(stations):
        where = f"stations[{n}]"
        if not isinstance(st, dict):
            problems.append(f"{where} must be an object")
            continue
        sid = st.get("id")
        where = f"station {sid!r}" if isinstance(sid, str) else where
        if not _is_station_id(sid):
            problems.append(f"{where}: id must be {STATION_ID_LENGTH} characters from {ID_ALPHABET}")
        elif sid in seen:
            problems.append(f"{where}: id listed twice")
        else:
            seen.add(sid)
        if not isinstance(st.get("name"), str) or not st["name"].strip():
            problems.append(f"{where}: name is required")
        if not StrKey.is_valid_ed25519_public_key(str(st.get("host_key"))):
            problems.append(f"{where}: host_key must be a public key (G...)")
        asset = st.get("asset")
        if not isinstance(asset, dict) or not isinstance(asset.get("code"), str) or not asset["code"]:
            problems.append(f"{where}: asset must be {{\"code\": ..., \"issuer\": ...}}")
        elif "issuer" not in asset:
            # The app reads a missing issuer as an issued asset and drops the station.
            problems.append(f"{where}: asset needs an \"issuer\" (null means native XLM)")
        elif asset["issuer"] is None:
            if asset["code"] != "XLM":
                problems.append(f"{where}: asset {asset['code']} needs an issuer (null means native XLM)")
        elif not StrKey.is_valid_ed25519_public_key(str(asset["issuer"])):
            problems.append(f"{where}: asset issuer must be a public key (G...) or null")
        price = _price_problem(st.get("ficha_price"))
        if price:
            problems.append(f"{where}: ficha_price {price}")
        minutes = st.get("ficha_minutes")
        if not isinstance(minutes, int) or isinstance(minutes, bool) or minutes <= 0:
            problems.append(f"{where}: ficha_minutes must be a whole number above zero")
        cap = st.get("max_session_minutes")
        if not isinstance(cap, int) or isinstance(cap, bool) or (isinstance(minutes, int) and cap < minutes):
            problems.append(f"{where}: max_session_minutes must be a whole number, at least ficha_minutes")
        if not isinstance(st.get("active"), bool):
            problems.append(f"{where}: active must be true or false")
        problems += _mode_problems(st, where, network)
        # The app shows these as they are: an object there (say hours per
        # weekday) is not text it can show.
        if st.get("hours") is not None and not isinstance(st["hours"], str):
            problems.append(f"{where}: hours must be text, like \"Mon-Fri 08:00-20:00\"")
        loc = st.get("location")
        if loc is not None:
            lat, lng = (loc.get("lat"), loc.get("lng")) if isinstance(loc, dict) else (None, None)
            if not (isinstance(lat, (int, float)) and -90 <= lat <= 90
                    and isinstance(lng, (int, float)) and -180 <= lng <= 180):
                problems.append(f"{where}: location needs lat (-90..90) and lng (-180..180)")
            for field in ("address", "city", "country"):
                if isinstance(loc, dict) and loc.get(field) is not None and not isinstance(loc[field], str):
                    problems.append(f"{where}: location {field} must be text")

    if problems:
        raise RegistryError("registry is not valid:\n  - " + "\n  - ".join(problems))
    return reg


def notes(reg: dict) -> list[str]:
    """What a valid registry may still get wrong for the stations that run
    it, said before signing: a custody entry whose grace_seconds the contract
    takes, but a station with the default PLUG_TIMEOUT_SECONDS refuses to
    start with (it needs CLAIM_WINDOW_SECONDS + PLUG_TIMEOUT_SECONDS, section 2)."""
    floor = CLAIM_WINDOW_SECONDS + DEFAULT_PLUG_TIMEOUT_SECONDS
    out = []
    for st in reg.get("stations") or []:
        grace = st.get("grace_seconds") if isinstance(st, dict) and st.get("mode") == "custody" else None
        if _whole(grace) and grace < floor:
            out.append(f"station {st.get('id')!r}: grace_seconds {grace} is valid on the contract, but its station "
                       f"needs at least {CLAIM_WINDOW_SECONDS} (to claim) + PLUG_TIMEOUT_SECONDS "
                       f"({DEFAULT_PLUG_TIMEOUT_SECONDS} by default) = {floor} to start; 1680 recommended")
    return out


# -- signatures --------------------------------------------------------------
def verify_bytes(data: bytes, sig: dict, pinned: str | None = None) -> str:
    """Check a detached signature over `data`. Returns the signing public key.
    With `pinned`, the signature must also come from that key."""
    if not isinstance(sig, dict) or sig.get("format") != SIG_FORMAT:
        raise RegistryError(f"signature file format must be {SIG_FORMAT!r}")
    key = sig.get("key")
    if not StrKey.is_valid_ed25519_public_key(str(key)):
        raise RegistryError("signature file: key is not a public key")
    if pinned and key != pinned:
        raise RegistryError(f"signed by {key}, not by the pinned key {pinned}")
    try:
        Keypair.from_public_key(key).verify(data, base64.b64decode(sig.get("sig", ""), validate=True))
    except (BadSignatureError, ValueError, TypeError):
        raise RegistryError("signature does NOT match these bytes (file changed after signing?)") from None
    return key
