"""The station checks its own configuration against the signed registry.

The Ficha app shows a station, and pays it, as the signed registry describes
it (docs/station-app-contract.md, section 2): host key, asset, price, ficha
length and session cap. A station whose .env says something else would sell
one thing while the app promises another. So at startup, when STATION_ID is
set, the station reads the registry (the copy published with the app's site
first, then the copy in the repo), verifies its signature with the pinned
PUBLIC key (the station still holds no secret) and refuses to start on any
difference, naming each one.

With neither copy readable the station still starts on testnet, because it
must work offline: the log and the footer say the registry is unchecked. On
the public network it does not start (startup()): real money is paid only to
a station the registry vouches for.

A custody station reads the registry again while it runs (recheck(), every
minute, main.py): the app pays the contract the registry names, so a
registry published with another `escrow` (a redeploy), other terms or the
station made inactive would have the app pay where this station never
looks. On any difference it goes out of service, its pay QR hidden, until it
matches again: in practice, until it is restarted with the new values.
"""

from __future__ import annotations

import json
import logging
from decimal import Decimal
from pathlib import Path
from typing import Callable
from urllib.parse import urlsplit

import httpx

from config import BASE_DIR, Config, ConfigError
from registry_format import RegistryError, parse, sig_path, validate_doc, verify_bytes

log = logging.getLogger("ficha.registry")

# Per file. The station starts without the site, so this only delays a
# start when the network is down.
FETCH_TIMEOUT = 3.0


class Unavailable(Exception):
    """This copy of the registry cannot be read: try the next one."""


class Mismatch(ConfigError):
    """This station does not match the signed registry (or a copy is badly
    signed): the full message for the console, `short` for the footer."""

    def __init__(self, message: str, short: str) -> None:
        super().__init__(message)
        self.short = short


def fetch_url(url: str) -> tuple[bytes, bytes]:
    """The registry and its signature from the site."""
    try:
        with httpx.Client(timeout=FETCH_TIMEOUT, follow_redirects=True) as client:
            files = []
            for u in (url, url + ".sig"):
                r = client.get(u)
                r.raise_for_status()
                files.append(r.content)
    except httpx.HTTPStatusError as exc:
        raise Unavailable(f"HTTP {exc.response.status_code}") from None
    except httpx.HTTPError as exc:
        raise Unavailable(type(exc).__name__) from None
    return files[0], files[1]


def read_file(path: Path) -> tuple[bytes, bytes]:
    try:
        return path.read_bytes(), sig_path(path).read_bytes()
    except FileNotFoundError as exc:
        raise Unavailable(f"{Path(exc.filename).name} not found") from None
    except OSError as exc:
        raise Unavailable(exc.strerror or str(exc)) from None


def _shown(path: Path) -> str:
    try:
        return path.relative_to(BASE_DIR).as_posix()
    except ValueError:
        return str(path)


def _asset(code: str, issuer: str | None) -> str:
    return "XLM (native)" if issuer is None else f"{code} issued by {issuer}"


def _differences(cfg: Config, reg: dict, st: dict) -> list[str]:
    """Every field where this station and its registry entry disagree."""
    out = []

    def differ(env: str, here, field: str, there) -> None:
        out.append(f"{env}={here if here != '' else '(empty)'} here, {field} {there} in the registry")

    if not st["active"]:
        out.append("the registry lists this station as inactive (active: false): the app will not pay it")
    if reg["network"] != cfg.network:
        differ("STELLAR_NETWORK", cfg.network, "network", reg["network"])
    if st["host_key"] != cfg.host_public_key:
        differ("HOST_PUBLIC_KEY", cfg.host_public_key, "host_key", st["host_key"])
    here = ("XLM", None) if cfg.is_native else (cfg.asset_code, cfg.asset_issuer)
    there = (st["asset"]["code"], st["asset"]["issuer"])
    if here != there:
        differ("PAYMENT_ASSET_CODE/PAYMENT_ASSET_ISSUER", _asset(*here), "asset", _asset(*there))
    if Decimal(st["ficha_price"]) != cfg.ficha_price:
        differ("FICHA_PRICE", cfg.ficha_price, "ficha_price", st["ficha_price"])
    if st["ficha_minutes"] != cfg.ficha_minutes:
        differ("FICHA_MINUTES", cfg.ficha_minutes, "ficha_minutes", st["ficha_minutes"])
    if st["max_session_minutes"] != cfg.max_session_minutes:
        differ("MAX_SESSION_MINUTES", cfg.max_session_minutes, "max_session_minutes", st["max_session_minutes"])
    # The payment mode: the app pays a custody station only through the
    # contract the registry names, at the terms the registry gives.
    mode = st.get("mode", "direct")
    if mode != cfg.payment_mode:
        differ("PAYMENT_MODE", cfg.payment_mode, "mode", f"{mode}{'' if 'mode' in st else ' (absent)'}")
    elif cfg.custody:
        for env, here, field in (("ESCROW_CONTRACT", cfg.escrow_contract, "escrow"),
                                 ("REFUND_UNIT_SECONDS", cfg.refund_unit_seconds, "unit_seconds"),
                                 ("ESCROW_GRACE_SECONDS", cfg.escrow_grace_seconds, "grace_seconds")):
            if st.get(field) != here:
                differ(env, here, field, st.get(field))
    return out


def _check_copy(cfg: Config, source: str, name: str, data: bytes, sig: dict) -> dict:
    """Verify one copy and compare this station with its entry. Raises Mismatch."""
    sid = cfg.station_id
    resign = (f"If the registry is what is wrong, edit {_shown(cfg.registry_file)}, re-sign it "
              "(python tools/registry.py sign) and publish it with the site.")
    try:
        verify_bytes(data, sig, cfg.registry_key)
    except RegistryError as exc:
        raise Mismatch(
            f"the station registry at {source} does not verify with REGISTRY_KEY={cfg.registry_key}: "
            f"{exc}. The station does not start on a registry nobody signed. Get the signed copy "
            "(git pull), or set REGISTRY_KEY to the registry key pinned in "
            f"docs/station-app-contract.md. {resign}",
            f"{source} does not verify with REGISTRY_KEY",
        ) from None
    try:
        reg = parse(data)
        stations = reg.get("stations")
        # Only this station's entry: the app drops an entry it cannot read, so
        # another station's broken entry is not this station's problem.
        mine = [s for s in stations if isinstance(s, dict) and s.get("id") == sid] \
            if isinstance(stations, list) else stations
        validate_doc({**reg, "stations": mine}, name)
    except RegistryError as exc:
        raise Mismatch(f"the station registry at {source} is signed but {exc}\n{resign}",
                       f"{source} is signed but not valid") from None
    if not mine:
        raise Mismatch(
            f"STATION_ID={sid} is not in the signed station registry ({source}), so the app "
            f"does not know this station. Fix STATION_ID, or add the station to "
            f"{_shown(cfg.registry_file)}, re-sign it (python tools/registry.py sign) and publish it.",
            f"STATION_ID={sid} is not in {source}",
        )
    diffs = _differences(cfg, reg, mine[0])
    if diffs:
        raise Mismatch(
            f"STATION_ID={sid} does not match its entry in the signed station registry ({source}). "
            "The app shows and charges what the registry says:\n  - " + "\n  - ".join(diffs) +
            f"\nChange .env to the registry's values. {resign} "
            "REGISTRY_CHECK=false skips this check (development only).",
            "; ".join(diffs),
        )
    return reg


def check(cfg: Config, fetch: Callable[[str], tuple[bytes, bytes]] = fetch_url, quiet: bool = False) -> dict:
    """Check this station against the signed registry: at startup, and, for
    a custody station, again while it runs (recheck()).

    Returns the footer's registry health, {"status": ok | unchecked | off,
    "detail": ...}. Raises Mismatch (a ConfigError) when a copy is badly
    signed or this station differs from its entry. quiet: no log lines (a
    re-read every minute says only what changes, main.py)."""
    if not cfg.station_id:
        return {"status": "off", "detail": "no STATION_ID"}
    if not cfg.registry_check:
        if not quiet:
            log.warning("REGISTRY_CHECK=false: %s is NOT checked against the signed registry "
                        "(development only)", cfg.station_id)
        return {"status": "off", "detail": "REGISTRY_CHECK=false"}
    if not cfg.registry_key:
        if not quiet:
            log.warning("registry UNCHECKED: no registry key is pinned for %s (set REGISTRY_KEY). "
                        "Make sure .env matches the registry entry for %s by hand.", cfg.network, cfg.station_id)
        return {"status": "unchecked", "detail": "no REGISTRY_KEY"}

    url, path = cfg.registry_url, cfg.registry_file
    copies = (
        ("site", url, urlsplit(url).path.rsplit("/", 1)[-1], lambda: fetch(url)),
        ("local copy", _shown(path), path.name, lambda: read_file(path)),
    )
    missed = []
    for label, source, name, get in copies:
        try:
            data, sig_bytes = get()
        except Unavailable as exc:
            missed.append(f"{source}: {exc}")
            continue
        try:
            sig = json.loads(sig_bytes.decode("utf-8"))
        except (UnicodeDecodeError, ValueError):
            if label == "site":
                # A captive portal answers any address with its own page.
                missed.append(f"{source}: the signature is not JSON (a login page?)")
                continue
            sig = None  # verify_bytes refuses it
        if missed and not quiet:
            log.info("registry: %s; checking the %s instead", "; ".join(missed), label)
        reg = _check_copy(cfg, source, name, data, sig)
        if not quiet:
            log.info("registry: %s matches its entry in %s (issued %s)", cfg.station_id, source, reg.get("issued_at"))
        return {"status": "ok", "detail": label}

    if not quiet:
        log.warning("registry UNCHECKED: no copy could be read (%s). %s", "; ".join(missed),
                    "On the public network the station does not start." if cfg.network == "public" else
                    "Starting anyway, since the station must work offline; make sure .env matches the "
                    f"registry entry for {cfg.station_id}.")
    return {"status": "unchecked", "detail": "no copy found"}


def startup(cfg: Config, fetch: Callable[[str], tuple[bytes, bytes]] = fetch_url) -> dict:
    """check() at startup (main.py). On the public network the station starts
    only with the registry checked and matching ("ok"): a station that takes
    real payments, unchecked, could sell one thing while the app promises
    another. Raises ConfigError otherwise; testnet starts as check() says."""
    health = check(cfg, fetch)
    if cfg.network != "public" or health["status"] == "ok":
        return health
    if health["detail"] == "no copy found":
        fix = (f"Put the signed copy at {_shown(cfg.registry_file)} (and its .sig), or start with "
               f"this computer online so it reads {cfg.registry_url}.")
    else:
        fix = "Set STATION_ID and REGISTRY_KEY, and leave REGISTRY_CHECK on."
    raise ConfigError(
        f"registry {health['status']} ({health['detail']}) on the public network: a station that takes real "
        "payments starts only when it matches its entry in the signed registry, the one the app shows and "
        f"pays. {fix}"
    )


def recheck(cfg: Config, fetch: Callable[[str], tuple[bytes, bytes]] = fetch_url) -> dict:
    """A custody station, while it runs: the startup check again, in the
    same order (the site's copy, then the local one), without its log lines.
    Blocking: main.py runs it in a thread. Returns the health as check()
    does ("unchecked": no copy could be read now, nothing new); raises
    Mismatch when the station would no longer start. Direct mode: not
    re-read (it keeps working exactly as before)."""
    if not cfg.custody:
        return {"status": "off", "detail": "direct mode"}
    return check(cfg, fetch, quiet=True)
