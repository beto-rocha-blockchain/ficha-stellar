"""Station configuration.

Everything comes from the environment (.env). Nothing is hardcoded here except
defaults, and every combination that cannot work is refused at startup with a
message that says what to change.
"""

from __future__ import annotations

import hashlib
import ipaddress
import math
import os
import re
import tempfile
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from pathlib import Path
from urllib.parse import urlsplit

from dotenv import load_dotenv
from stellar_sdk import Network, StrKey

BASE_DIR = Path(__file__).resolve().parent

HORIZON_URLS = {
    "testnet": "https://horizon-testnet.stellar.org",
    "public": "https://horizon.stellar.org",
}

# SEP-0007 reads a pay URI without network_passphrase as a public-network
# request, so a QR for any other network has to name it.
NETWORK_PASSPHRASES = {
    "testnet": Network.TESTNET_NETWORK_PASSPHRASE,
    "public": Network.PUBLIC_NETWORK_PASSPHRASE,
}

# Station and session IDs use this alphabet: no 0/1/I/L/O/U, which get
# misread when an ID is typed by hand (docs/station-app-contract.md).
ID_ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ"
STATION_ID_LENGTH = 6
STATION_NAME_MAX_CHARS = 64  # keeps the SEP-0007 msg well under its 300

# Default asset per network. Public defaults to Circle's USDC; confirm the
# issuer on stellar.expert before using it with real money.
DEFAULT_ASSETS = {
    "testnet": ("", ""),
    "public": ("USDC", "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN"),
}

# The signed station registry (docs/station-app-contract.md, section 2). The
# station checks its own entry against it at startup (registry_check.py):
# first the copy published with the app's site, then the copy in this repo, so
# a station offline can still check. One file per network.
REGISTRY_SITE = "https://ficha-stellar.vercel.app/registry/"
REGISTRY_FILES = {"testnet": "stations.json", "public": "stations.public.json"}
# The registry public key the app pins. None yet for public: that registry is
# not published, so a public station starts with its registry unchecked.
REGISTRY_KEYS = {"testnet": "GBC2MDBTM4MX3XJKRX5QM3YXUR2AISCOJGJ74MXLPIZHZDIDHOLFAASA", "public": ""}

MEMO_TEXT_MAX_BYTES = 28
STELLAR_DECIMALS = 7  # amounts on the ledger have 7 decimal places

# Payment modes (docs/station-app-contract.md): direct, a classic payment to
# the host with the session's memo, or custody, a deposit into the FichaEscrow
# contract that refunds unused time by proof (section 7).
PAYMENT_MODES = ("direct", "custody")
# The Soroban RPC a custody station reads the contract through (read only:
# no key, no fee). None for public: custody is testnet only for now.
RPC_URLS = {"testnet": "https://soroban-testnet.stellar.org", "public": ""}
# A custody session ends at the latest this long before its deadline, so the
# payer always has this long to claim the unused time.
CLAIM_WINDOW_SECONDS = 900
# PLUG_TIMEOUT_SECONDS when .env leaves it out. A custody station needs
# grace_secs of at least CLAIM_WINDOW_SECONDS + PLUG_TIMEOUT_SECONDS (1080 by
# default): the contract and the registry accept less, this station does not.
DEFAULT_PLUG_TIMEOUT_SECONDS = 180
# A saved ledger cursor (Horizon's or the escrow's) this many ledgers (about
# 80 min) past the network's latest ledger was saved before a testnet reset,
# when the ledger started over from 1: it is dropped. A load-balanced server a
# few ledgers behind the last one is no reset.
LEDGER_RESET_MARGIN = 1000
# The contract's own bounds (register): an entry outside them never matches it.
ESCROW_MAX_CHAIN = 256
ESCROW_MAX_SESSION_SECONDS = 86_400
ESCROW_GRACE_RANGE = (300, 86_400)
I128_MAX = 2 ** 127 - 1

# WIFI_SECURITY values, as written in the WiFi QR. WPA covers WPA and WPA2.
WIFI_SECURITY = {"": "WPA", "wpa": "WPA", "wpa2": "WPA", "nopass": "nopass"}

# Free emergency minutes (docs/free-minutes.md): who gives the free internet.
# off: no portal, no free minutes. opennds: the station's Wi-Fi router runs
# openNDS and sends each phone to this station's portal (FAS level 0); the
# router gives and limits the free internet (a courtesy limit, not a hard one:
# openwrt/README.md). simulate: no router (a laptop demo): the
# portal records grants and says what a router would do.
WIFI_PORTALS = ("off", "opennds", "simulate")
# When a device's daily allowance starts over. Only local midnight: a rolling
# 24 h window would have to recognise a device across two daily salts, which
# is exactly the linking the daily salt exists to prevent (freeminutes.py).
FREE_RESETS = ("midnight",)
FREE_SECONDS_MAX = 3600
EMERGENCY_NUMBERS_MAX = 6
EMERGENCY_LABEL_MAX_CHARS = 32
_EMERGENCY_NUMBER = re.compile(r"\+?[0-9]{2,15}")


class ConfigError(Exception):
    pass


def _is_loopback(host: str) -> bool:
    if host.lower() == "localhost":
        return True
    try:
        return ipaddress.ip_address(host.strip("[]")).is_loopback
    except ValueError:
        return False


def _str(name: str, default: str = "") -> str:
    return os.getenv(name, default).strip()


def _bool(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None or raw.strip() == "":
        return default
    value = raw.strip().lower()
    if value in ("1", "true", "yes", "on"):
        return True
    if value in ("0", "false", "no", "off"):
        return False
    raise ConfigError(f"{name}={raw!r} is not a boolean (use true or false)")


def _int(name: str, default: int) -> int:
    raw = _str(name)
    if raw == "":
        return default
    try:
        return int(raw)
    except ValueError:
        raise ConfigError(f"{name}={raw!r} is not an integer") from None


def _float(name: str, default: float) -> float:
    raw = _str(name)
    if raw == "":
        return default
    try:
        return float(raw)
    except ValueError:
        raise ConfigError(f"{name}={raw!r} is not a number") from None


def _decimal(name: str, default: str) -> Decimal:
    raw = _str(name, default) or default
    try:
        return Decimal(raw)
    except InvalidOperation:
        raise ConfigError(f"{name}={raw!r} is not a number") from None


def _scale(name: str) -> float | None:
    raw = _str(name, "auto").lower()
    if raw in ("", "auto"):
        return None
    try:
        value = float(raw)
    except ValueError:
        raise ConfigError(f"{name}={raw!r}: use auto or a number like 0.001 or -1") from None
    if value == 0:
        raise ConfigError(f"{name} cannot be zero")
    return value


def _hex_bytes(name: str, default: str) -> bytes:
    raw = _str(name, default) or default
    try:
        return bytes.fromhex(raw)
    except ValueError:
        raise ConfigError(f"{name}={raw!r} is not a hex byte string like 'A0 01 01 A2'") from None


def _emergency(name: str) -> tuple[tuple[str, str], ...]:
    """'Police 190; Ambulance 192; Fire 193' -> (("Police", "190"), ...): the
    number is the last word of each entry, the label all before it (maybe
    empty). Judged in validate_free()."""
    entries = []
    for part in re.split(r"[;,\n]", os.getenv(name, "")):
        part = part.strip()
        if part:
            label, _, number = part.rpartition(" ")
            entries.append((label.strip(), number.strip()))
    return tuple(entries)


def _path(name: str, default: str) -> Path:
    p = Path(_str(name, default) or default)
    return p if p.is_absolute() else BASE_DIR / p


@dataclass(frozen=True)
class Config:
    # modes
    mock: bool
    mock_payment: bool
    mock_profile: str  # fast | usb
    mock_plug: str  # station | elsewhere | none: where the fake phone gets its power
    topology: str  # mains | usb_vbus

    # server
    host: str
    port: int

    # this station
    station_id: str  # "" = legacy: the memo is the bare session ID
    station_name: str
    app_url: str  # "" = receipts start with "ficha:"

    # stellar
    network: str  # testnet | public
    horizon_url: str
    host_public_key: str
    asset_code: str  # "" means native XLM
    asset_issuer: str
    horizon_poll_seconds: float
    cursor_dir: Path

    # payment mode: custody deposits into the FichaEscrow contract (section 7)
    payment_mode: str  # direct | custody
    escrow_contract: str  # C..., custody only
    rpc_url: str  # Soroban RPC, read only
    refund_unit_seconds: int  # the contract's unit_secs
    escrow_grace_seconds: int  # the contract's grace_secs

    # product
    ficha_price: Decimal
    ficha_minutes: int
    max_session_minutes: int
    courtesy_seconds: int
    courtesy_cooldown_seconds: int
    min_current_ma: int
    finished_seconds: int
    session_log: Path

    # relay
    relay_port: str
    relay_baud: int
    relay_cmd_close: bytes
    relay_cmd_open: bytes

    # meter
    adb_path: str
    adb_transport: str  # usb | tcp
    adb_serial: str
    adb_wait_timeout: int
    meter_current_scale: float | None  # None = learn unit and sign from the phone

    # charge verification: paid time counts only while this station charges the phone
    charge_verify: bool  # False = count from payment, whatever the phone does (bench tests)
    meter_source: str  # phone (ADB, needs probes) | outlet (a meter on the station's own output)
    plug_timeout_seconds: int
    pause_grace_seconds: int
    pause_timeout_seconds: int
    probe_every_seconds: int
    probe_seconds: int

    # signed registry: checked at startup when station_id is set
    registry_check: bool
    registry_url: str
    registry_file: Path
    registry_key: str  # "" = no key pinned: the registry cannot be checked

    # offered network (only rendered as a QR; the station does not run it)
    wifi_ssid: str  # "" = no network offered, nothing shown
    wifi_password: str
    wifi_security: str  # WPA | nopass

    # free emergency minutes (docs/free-minutes.md), per device per day, through
    # the Wi-Fi portal. All off by default: the station behaves as before.
    wifi_portal: str = "off"  # off | opennds | simulate
    free_charge_seconds: int = 0  # 0 = no free charge
    free_internet_seconds: int = 0  # 0 = no free internet
    free_reset: str = "midnight"  # the allowance and its salt are per local calendar day
    # (label, number), shown first on the portal and on the station screen
    emergency_numbers: tuple[tuple[str, str], ...] = ()

    @property
    def free_on(self) -> bool:
        """The Wi-Fi portal is on: the station listens on the router's network."""
        return self.wifi_portal != "off"

    @property
    def is_native(self) -> bool:
        return self.asset_code == ""

    @property
    def asset_label(self) -> str:
        return "XLM" if self.is_native else self.asset_code

    @property
    def ficha_seconds(self) -> int:
        return self.ficha_minutes * 60

    @property
    def cursor_file(self) -> Path:
        # Named by network and account, so switching either never reuses a
        # cursor that belongs to another ledger or another host.
        key = self.host_public_key or "nokey"
        return self.cursor_dir / f".horizon_cursor.{self.network}.{key}"

    @property
    def custody(self) -> bool:
        return self.payment_mode == "custody"

    @property
    def max_fichas(self) -> int:
        """Most fichas one session holds: the contract's max_fichas."""
        return self.max_session_minutes // self.ficha_minutes if self.ficha_minutes > 0 else 0

    @property
    def chain_len(self) -> int:
        """N, the custody hash chain's length: the most refund units a session holds."""
        unit = self.refund_unit_seconds
        return self.max_fichas * self.ficha_seconds // unit if unit > 0 else 0

    @property
    def escrow_cursor_file(self) -> Path:
        # Named by network, contract, host and station: the events of one
        # never resume from another's cursor. The contract and the host by a
        # digest: with both in full the name alone is 150 characters, and a
        # deep CURSOR_DIR would pass the Windows path limit.
        digest = hashlib.sha256(f"{self.escrow_contract}.{self.host_public_key}".encode()).hexdigest()[:16]
        return self.cursor_dir / f".escrow_cursor.{self.network}.{self.station_id}.{digest}"


def load(env_file: str | os.PathLike | None = None) -> Config:
    load_dotenv(env_file or BASE_DIR / ".env", override=False)

    network = _str("STELLAR_NETWORK", "testnet").lower()
    if network not in HORIZON_URLS:
        raise ConfigError(f"STELLAR_NETWORK={network!r}: use testnet or public")

    topology = _str("TOPOLOGY", "mains").lower()
    if topology not in ("mains", "usb_vbus"):
        raise ConfigError(f"TOPOLOGY={topology!r}: use mains or usb_vbus")

    mock = _bool("MOCK", False)
    mock_payment = _bool("MOCK_PAYMENT", False)

    profile = _str("MOCK_PROFILE").lower() or ("fast" if topology == "mains" else "usb")
    if profile not in ("fast", "usb"):
        raise ConfigError(f"MOCK_PROFILE={profile!r}: use fast or usb")
    plug = _str("MOCK_PLUG").lower() or "station"
    if plug not in ("station", "elsewhere", "none"):
        raise ConfigError(f"MOCK_PLUG={plug!r}: use station, elsewhere or none")

    meter_source = _str("METER_SOURCE").lower() or "phone"
    if meter_source not in ("phone", "outlet"):
        raise ConfigError(f"METER_SOURCE={meter_source!r}: use phone or outlet")

    adb_transport = _str("ADB_TRANSPORT", "tcp" if topology == "mains" else "usb").lower()
    if adb_transport not in ("usb", "tcp"):
        raise ConfigError(f"ADB_TRANSPORT={adb_transport!r}: use usb or tcp")
    adb_serial = _str("ADB_SERIAL")

    default_code, default_issuer = DEFAULT_ASSETS[network]
    # Empty code means "the network default". XLM with no issuer means native.
    asset_code = _str("PAYMENT_ASSET_CODE")
    asset_issuer = _str("PAYMENT_ASSET_ISSUER")
    if asset_code == "":
        asset_code, asset_issuer = default_code, default_issuer
    elif asset_code.upper() == "XLM" and not asset_issuer:
        asset_code = ""

    host_key = _str("HOST_PUBLIC_KEY")
    payment_mode = _str("PAYMENT_MODE").lower() or "direct"

    cfg = Config(
        mock=mock,
        mock_payment=mock_payment,
        mock_profile=profile,
        mock_plug=plug,
        topology=topology,
        host=_str("HOST", "127.0.0.1"),
        port=_int("PORT", 8000),
        station_id=_str("STATION_ID").upper(),
        station_name=_str("STATION_NAME"),
        app_url=_str("APP_URL").rstrip("/"),
        network=network,
        horizon_url=(_str("HORIZON_URL") or HORIZON_URLS[network]).rstrip("/"),
        host_public_key=host_key,
        asset_code=asset_code,
        asset_issuer=asset_issuer,
        horizon_poll_seconds=_float("HORIZON_POLL_SECONDS", 2.0),
        cursor_dir=_path("CURSOR_DIR", "."),
        payment_mode=payment_mode,
        escrow_contract=_str("ESCROW_CONTRACT"),
        rpc_url=(_str("RPC_URL") or RPC_URLS[network]).rstrip("/"),
        refund_unit_seconds=_int("REFUND_UNIT_SECONDS", 30),
        escrow_grace_seconds=_int("ESCROW_GRACE_SECONDS", 1680),
        ficha_price=_decimal("FICHA_PRICE", "1"),
        ficha_minutes=_int("FICHA_MINUTES", 5),
        max_session_minutes=_int("MAX_SESSION_MINUTES", 60),
        courtesy_seconds=_int("COURTESY_SECONDS", 60),
        courtesy_cooldown_seconds=_int("COURTESY_COOLDOWN_SECONDS", 300),
        min_current_ma=_int("MIN_CURRENT_MA", 100),
        # Custody: long enough to scan the receipt that carries the refund.
        finished_seconds=_int("FINISHED_SECONDS", 60 if payment_mode == "custody" else 20),
        session_log=_path("SESSION_LOG", "sessions.jsonl"),
        relay_port=_str("RELAY_PORT", "COM3"),
        relay_baud=_int("RELAY_BAUD", 9600),
        relay_cmd_close=_hex_bytes("RELAY_CMD_CLOSE", "A0 01 01 A2"),
        relay_cmd_open=_hex_bytes("RELAY_CMD_OPEN", "A0 01 00 A1"),
        adb_path=_str("ADB_PATH", "adb"),
        adb_transport=adb_transport,
        adb_serial=adb_serial,
        adb_wait_timeout=_int("ADB_WAIT_TIMEOUT", 20),
        meter_current_scale=_scale("METER_CURRENT_SCALE"),
        charge_verify=_bool("CHARGE_VERIFY", True),
        meter_source=meter_source,
        plug_timeout_seconds=_int("PLUG_TIMEOUT_SECONDS", DEFAULT_PLUG_TIMEOUT_SECONDS),
        pause_grace_seconds=_int("PAUSE_GRACE_SECONDS", 20),
        pause_timeout_seconds=_int("PAUSE_TIMEOUT_SECONDS", 600),
        probe_every_seconds=_int("PROBE_EVERY_SECONDS", 300),
        probe_seconds=_int("PROBE_SECONDS", 3),
        registry_check=_bool("REGISTRY_CHECK", True),
        registry_url=_str("REGISTRY_URL") or REGISTRY_SITE + REGISTRY_FILES[network],
        registry_file=_path("REGISTRY_FILE", f"registry/{REGISTRY_FILES[network]}"),
        registry_key=_str("REGISTRY_KEY") or REGISTRY_KEYS[network],
        # Not stripped: spaces can be part of an SSID or a password.
        wifi_ssid=os.getenv("WIFI_SSID", ""),
        wifi_password=os.getenv("WIFI_PASSWORD", ""),
        wifi_security=WIFI_SECURITY.get(_str("WIFI_SECURITY").lower(), _str("WIFI_SECURITY")),
        wifi_portal=_str("WIFI_PORTAL").lower() or "off",
        free_charge_seconds=_int("FREE_CHARGE_SECONDS", 0),
        free_internet_seconds=_int("FREE_INTERNET_SECONDS", 0),
        free_reset=_str("FREE_RESET").lower() or "midnight",
        emergency_numbers=_emergency("EMERGENCY_NUMBERS"),
    )
    validate(cfg)
    return cfg


def validate(cfg: Config) -> None:
    key = cfg.host_public_key
    if key.startswith("S"):
        # Someone pasted a seed. Refuse loudly and never echo it back.
        raise ConfigError(
            "HOST_PUBLIC_KEY looks like a SECRET key (starts with S). The station "
            "never holds a secret. Remove it from .env now and put the host's "
            "PUBLIC key (starts with G) instead."
        )
    if key and not StrKey.is_valid_ed25519_public_key(key):
        raise ConfigError(f"HOST_PUBLIC_KEY={key!r} is not a valid Stellar public key")
    if not key and not cfg.mock_payment:
        raise ConfigError("HOST_PUBLIC_KEY is required (the host's public key, starts with G)")

    if cfg.topology == "mains" and cfg.adb_transport != "tcp" and not cfg.mock:
        raise ConfigError(
            "TOPOLOGY=mains needs ADB_TRANSPORT=tcp (the charging cable carries no "
            "data to this computer) or MOCK=true"
        )
    if cfg.topology == "usb_vbus" and cfg.adb_transport != "usb" and not cfg.mock:
        # usb_vbus takes the phone vanishing from ADB, when the relay cuts
        # VBUS, as the proof of a probe and of the final cut. Read over WiFi
        # it never vanishes: a failed read would pass a probe, and no cut
        # would ever be confirmed.
        raise ConfigError(
            "TOPOLOGY=usb_vbus needs ADB_TRANSPORT=usb (ADB through the cut cable). A phone read "
            "over WiFi stays readable when the power is cut: that is TOPOLOGY=mains, whatever "
            "the relay switches"
        )
    if cfg.adb_transport == "tcp" and not cfg.mock and ":" not in cfg.adb_serial:
        raise ConfigError("ADB_TRANSPORT=tcp needs ADB_SERIAL=ip:port of the phone")

    if cfg.mock_payment and cfg.network == "public":
        raise ConfigError(
            "MOCK_PAYMENT=true on the public network would hand out free energy. "
            "Turn it off before switching to public."
        )
    if cfg.mock_payment and not _is_loopback(cfg.host):
        raise ConfigError(
            f"HOST={cfg.host} with MOCK_PAYMENT=true lets anyone on the network make "
            "free payments. Use HOST=127.0.0.1, or turn MOCK_PAYMENT off."
        )

    other = "public" if cfg.network == "testnet" else "testnet"
    if urlsplit(cfg.horizon_url).hostname == urlsplit(HORIZON_URLS[other]).hostname:
        raise ConfigError(
            f"HORIZON_URL={cfg.horizon_url} is the {other} Horizon, but "
            f"STELLAR_NETWORK={cfg.network}. Empty HORIZON_URL follows the network."
        )
    if not math.isfinite(cfg.horizon_poll_seconds) or cfg.horizon_poll_seconds < 0.5:
        raise ConfigError("HORIZON_POLL_SECONDS must be at least 0.5")
    if not cfg.cursor_dir.is_dir():
        raise ConfigError(f"CURSOR_DIR={cfg.cursor_dir} is not a directory")
    try:
        with tempfile.TemporaryFile(dir=cfg.cursor_dir):
            pass
    except OSError as exc:
        raise ConfigError(f"CURSOR_DIR={cfg.cursor_dir} is not writable ({exc.strerror or exc})") from None
    # Every payment is on disk before it is credited: with a log that cannot
    # be written, a payment can be neither credited nor logged for refund.
    log_file = cfg.session_log
    try:
        if log_file.exists():
            if not log_file.is_file():
                raise ConfigError(f"SESSION_LOG={log_file} is not a file")
            with log_file.open("ab"):
                pass
        elif not log_file.parent.is_dir():
            raise ConfigError(f"SESSION_LOG={log_file}: the directory {log_file.parent} does not exist")
        else:
            with tempfile.TemporaryFile(dir=log_file.parent):
                pass
    except OSError as exc:
        raise ConfigError(f"SESSION_LOG={log_file} is not writable ({exc.strerror or exc})") from None

    sid = cfg.station_id
    if sid and (len(sid) != STATION_ID_LENGTH or any(c not in ID_ALPHABET for c in sid)):
        raise ConfigError(
            f"STATION_ID={sid!r}: use {STATION_ID_LENGTH} characters from {ID_ALPHABET} "
            "(no 0, 1, I, L, O or U), or leave it empty"
        )
    if len(cfg.station_name) > STATION_NAME_MAX_CHARS:
        raise ConfigError(f"STATION_NAME is longer than {STATION_NAME_MAX_CHARS} characters")
    if cfg.app_url:
        url = urlsplit(cfg.app_url)
        if url.scheme != "https" or not url.netloc or url.query or url.fragment or " " in cfg.app_url:
            raise ConfigError(f"APP_URL={cfg.app_url!r}: use an https:// address without ? or #, or leave it empty")

    rkey = cfg.registry_key
    if rkey.startswith("S"):
        # The registry SECRET signs on the operator's machine, never here.
        raise ConfigError(
            "REGISTRY_KEY looks like a SECRET key (starts with S). The registry "
            "secret never lives on a station. Remove it from .env now and put the "
            "registry's PUBLIC key (starts with G) instead, or leave it empty."
        )
    if rkey and not StrKey.is_valid_ed25519_public_key(rkey):
        raise ConfigError(f"REGISTRY_KEY={rkey!r} is not a valid Stellar public key")
    rurl = urlsplit(cfg.registry_url)
    if rurl.scheme != "https" or not rurl.netloc or rurl.query or rurl.fragment or " " in cfg.registry_url:
        raise ConfigError(f"REGISTRY_URL={cfg.registry_url!r}: use an https:// address without ? or #, "
                          "or leave it empty")

    if not cfg.is_native:
        if not cfg.asset_issuer:
            raise ConfigError(f"PAYMENT_ASSET_CODE={cfg.asset_code} needs PAYMENT_ASSET_ISSUER")
        if not StrKey.is_valid_ed25519_public_key(cfg.asset_issuer):
            raise ConfigError(f"PAYMENT_ASSET_ISSUER={cfg.asset_issuer!r} is not a valid public key")

    price = cfg.ficha_price
    if not price.is_finite() or price <= 0:
        raise ConfigError("FICHA_PRICE must be a number greater than zero")
    if price.normalize().as_tuple().exponent < -STELLAR_DECIMALS:
        raise ConfigError(f"FICHA_PRICE has more than {STELLAR_DECIMALS} decimals, the most Stellar can pay")
    if cfg.min_current_ma < 1:
        raise ConfigError("MIN_CURRENT_MA must be at least 1 (0 would call any reading a delivery)")
    if cfg.ficha_minutes <= 0:
        raise ConfigError("FICHA_MINUTES must be greater than zero")
    if cfg.max_session_minutes < cfg.ficha_minutes:
        raise ConfigError("MAX_SESSION_MINUTES must be at least FICHA_MINUTES")
    if cfg.courtesy_seconds < 0 or cfg.courtesy_cooldown_seconds < 0:
        raise ConfigError("COURTESY_SECONDS and COURTESY_COOLDOWN_SECONDS cannot be negative")
    if len(cfg.relay_cmd_close) == 0 or len(cfg.relay_cmd_open) == 0:
        raise ConfigError("RELAY_CMD_CLOSE and RELAY_CMD_OPEN cannot be empty")

    validate_charge_verify(cfg)
    validate_custody(cfg)

    if cfg.wifi_ssid:
        if len(cfg.wifi_ssid.encode("utf-8")) > 32:
            raise ConfigError("WIFI_SSID is longer than 32 bytes, the WiFi limit")
        if cfg.wifi_security not in ("WPA", "nopass"):
            raise ConfigError(f"WIFI_SECURITY={cfg.wifi_security!r}: use WPA or nopass")
        if cfg.wifi_security == "WPA" and not 8 <= len(cfg.wifi_password) <= 63:
            raise ConfigError("WIFI_PASSWORD must be 8 to 63 characters for WPA/WPA2 "
                              "(or set WIFI_SECURITY=nopass for an open network)")
        if cfg.wifi_security == "nopass" and cfg.wifi_password:
            raise ConfigError("WIFI_SECURITY=nopass but WIFI_PASSWORD is set: pick one")

    validate_free(cfg)


def validate_free(cfg: Config) -> None:
    """Free emergency minutes (docs/free-minutes.md): a free charge and free
    internet per device per day, given through the station's Wi-Fi portal.
    A device is known only through that portal, so the minutes need it. The
    station still holds no secret: the router limits the internet."""
    if cfg.wifi_portal not in WIFI_PORTALS:
        raise ConfigError(f"WIFI_PORTAL={cfg.wifi_portal!r}: use off, opennds (the station's Wi-Fi router runs "
                          "openNDS) or simulate (no router: a demo on this computer)")
    if cfg.free_reset not in FREE_RESETS:
        if cfg.free_reset in ("rolling", "24h", "rolling24h", "rolling_24h"):
            raise ConfigError("FREE_RESET=rolling is not supported: a rolling 24 h window would have to recognise "
                              "a phone across two daily salts, which is the linking the daily salt prevents. "
                              "Use FREE_RESET=midnight (local time), the default")
        raise ConfigError(f"FREE_RESET={cfg.free_reset!r}: use midnight (local time), the default")
    for name, value in (("FREE_CHARGE_SECONDS", cfg.free_charge_seconds),
                        ("FREE_INTERNET_SECONDS", cfg.free_internet_seconds)):
        if not 0 <= value <= FREE_SECONDS_MAX:
            raise ConfigError(f"{name}={value}: from 0 (off) to {FREE_SECONDS_MAX} seconds a day "
                              "(120 is two emergency minutes)")
    if (cfg.free_charge_seconds or cfg.free_internet_seconds) and not cfg.free_on:
        raise ConfigError("FREE_CHARGE_SECONDS and FREE_INTERNET_SECONDS are per phone per day, and this station "
                          "knows a phone only through its Wi-Fi portal: set WIFI_PORTAL=opennds (the router) or "
                          "simulate (a demo without one), or set both to 0")

    numbers = cfg.emergency_numbers
    if len(numbers) > EMERGENCY_NUMBERS_MAX:
        raise ConfigError(f"EMERGENCY_NUMBERS lists {len(numbers)} numbers: at most {EMERGENCY_NUMBERS_MAX}, "
                          "the ones a person in danger needs first")
    for label, number in numbers:
        if not _EMERGENCY_NUMBER.fullmatch(number):
            raise ConfigError(f"EMERGENCY_NUMBERS: {f'{label} {number}'.strip()!r} does not end in a phone number. "
                              "Use 'label number' pairs separated by ';', e.g. "
                              "EMERGENCY_NUMBERS='Emergency 112' or 'Police 190; Ambulance 192; Fire 193'")
        if len(label) > EMERGENCY_LABEL_MAX_CHARS or not label.isprintable():
            raise ConfigError(f"EMERGENCY_NUMBERS: the label {label!r} must be up to {EMERGENCY_LABEL_MAX_CHARS} "
                              "printable characters")
    if not cfg.free_on:
        return
    if not numbers:
        raise ConfigError(f"WIFI_PORTAL={cfg.wifi_portal} needs EMERGENCY_NUMBERS: the portal shows them first. "
                          "E.g. EMERGENCY_NUMBERS='Emergency 112' (Portugal, the EU) or "
                          "'Police 190; Ambulance 192; Fire 193' (Brazil)")
    if cfg.wifi_portal == "opennds":
        if _is_loopback(cfg.host):
            raise ConfigError(f"WIFI_PORTAL=opennds with HOST={cfg.host}: phones reach the portal over the router's "
                              "Wi-Fi, so HOST must be this computer's address on the router's network, or 0.0.0.0. "
                              "The station screen, its keys and /debug still answer only to this computer")
        if not cfg.wifi_ssid:
            raise ConfigError("WIFI_PORTAL=opennds needs WIFI_SSID (and WIFI_SECURITY, WIFI_PASSWORD): the "
                              "screen's join QR is how phones reach the portal")


def validate_charge_verify(cfg: Config) -> None:
    """Paid time counts only while this station is charging the phone
    (session.py). The phone's own meter cannot tell this station's outlet
    from any other charger: only a probe, the relay opened for a moment,
    can."""
    if not cfg.charge_verify:
        if cfg.network == "public":
            raise ConfigError(
                "CHARGE_VERIFY=false on the public network would bill users for time charged "
                "anywhere, even at home. It is for bench tests on testnet only."
            )
        return
    if cfg.meter_source == "outlet" and not cfg.mock:
        raise ConfigError(
            "METER_SOURCE=outlet needs a meter on the station's own output, which this version "
            "does not have yet (MOCK=true simulates one). Use METER_SOURCE=phone."
        )
    if not 2 <= cfg.probe_seconds <= 30:
        # A probe does not judge its first reading, which may predate the
        # opening (the meter reads on its own thread): one second leaves none.
        raise ConfigError("PROBE_SECONDS must be 2 to 30 (each probe cuts the power for that long, "
                          "and its first reading may still be from before the cut)")
    if cfg.probe_every_seconds < 10 * cfg.probe_seconds:
        raise ConfigError("PROBE_EVERY_SECONDS must be at least 10 times PROBE_SECONDS, "
                          "or the probes would take a tenth of the charging time")
    if cfg.plug_timeout_seconds <= cfg.probe_seconds:
        raise ConfigError("PLUG_TIMEOUT_SECONDS must be longer than PROBE_SECONDS")
    if cfg.pause_grace_seconds < 5:
        raise ConfigError("PAUSE_GRACE_SECONDS must be at least 5: a shorter one pauses on the phone's "
                          "own dips, and on usb_vbus on the phone coming back after each probe")
    if cfg.pause_timeout_seconds <= cfg.probe_seconds:
        raise ConfigError("PAUSE_TIMEOUT_SECONDS must be longer than PROBE_SECONDS")


def validate_custody(cfg: Config) -> None:
    """Custody mode (docs/station-app-contract.md, section 7): the payer
    deposits into the FichaEscrow contract, and the receipt carries a proof of
    the paid time NOT delivered, which refunds it. The station still holds no
    key: it reads the contract, never signs. Its settings must be the
    contract's own terms for this station, within the contract's bounds."""
    if cfg.payment_mode not in PAYMENT_MODES:
        raise ConfigError(f"PAYMENT_MODE={cfg.payment_mode!r}: use direct or custody")
    if not cfg.custody:
        return
    if cfg.network != "testnet":
        raise ConfigError("PAYMENT_MODE=custody is for testnet only until the FichaEscrow contract is audited. "
                          "Use PAYMENT_MODE=direct on the public network.")
    if not cfg.station_id:
        raise ConfigError("PAYMENT_MODE=custody needs STATION_ID: the station and session IDs are the "
                          "contract's arguments (there is no memo)")
    if not cfg.host_public_key:
        raise ConfigError("PAYMENT_MODE=custody needs HOST_PUBLIC_KEY: the pay link names the host")
    contract = cfg.escrow_contract
    if contract.startswith("S"):
        raise ConfigError("ESCROW_CONTRACT looks like a SECRET key (starts with S). The station never "
                          "holds a secret. Remove it from .env now and put the contract ID (starts with C).")
    if not StrKey.is_valid_contract(contract):
        raise ConfigError(f"ESCROW_CONTRACT={contract!r}: PAYMENT_MODE=custody needs the FichaEscrow contract "
                          "ID (C..., docs/station-app-contract.md, section 7.1)")
    if not cfg.charge_verify:
        raise ConfigError("PAYMENT_MODE=custody needs CHARGE_VERIFY=true: the refund the receipt proves is "
                          "the paid time this station did not verifiably charge the phone")
    if not cfg.is_native:
        # The contract moves the asset through its issuer's contract (SAC): an
        # issuer can freeze a payer before the claim, or claw back what the
        # escrow holds. Native XLM has no issuer (section 7.10).
        raise ConfigError(f"PAYMENT_MODE=custody takes native XLM only for now, not {cfg.asset_code}: an "
                          "issued asset's issuer could freeze the payer or claw back the escrow's balance. "
                          "Leave PAYMENT_ASSET_CODE and PAYMENT_ASSET_ISSUER empty")
    url = urlsplit(cfg.rpc_url)
    if (url.scheme not in ("https", "http") or not url.hostname or url.query or url.fragment
            or " " in cfg.rpc_url or (url.scheme == "http" and not _is_loopback(url.hostname))):
        raise ConfigError(f"RPC_URL={cfg.rpc_url!r}: use an https:// Soroban RPC address without ? or #, "
                          "or leave it empty for the network's default")
    unit = cfg.refund_unit_seconds
    if unit <= 0 or cfg.ficha_seconds % unit:
        raise ConfigError(f"REFUND_UNIT_SECONDS={unit}: a whole number of seconds above zero that divides "
                          f"FICHA_MINUTES x 60 ({cfg.ficha_seconds})")
    session = cfg.max_fichas * cfg.ficha_seconds
    if session > ESCROW_MAX_SESSION_SECONDS:
        raise ConfigError(f"custody: a session holds at most {ESCROW_MAX_SESSION_SECONDS} s of paid time "
                          f"(floor(MAX_SESSION_MINUTES / FICHA_MINUTES) x FICHA_MINUTES x 60 is {session})")
    if cfg.chain_len > ESCROW_MAX_CHAIN:
        raise ConfigError(f"custody: the refund proof covers at most {ESCROW_MAX_CHAIN} units, and "
                          f"{session} s of paid time at REFUND_UNIT_SECONDS={unit} is {cfg.chain_len}: "
                          "raise REFUND_UNIT_SECONDS")
    low, high = ESCROW_GRACE_RANGE
    grace = cfg.escrow_grace_seconds
    if not low <= grace <= high:
        raise ConfigError(f"ESCROW_GRACE_SECONDS={grace}: from {low} to {high} (1680 recommended)")
    if grace < CLAIM_WINDOW_SECONDS + cfg.plug_timeout_seconds:
        # The station ends a session CLAIM_WINDOW_SECONDS before its deadline:
        # with less, a phone plugged in at the last moment could never use
        # all of its paid time.
        raise ConfigError(f"ESCROW_GRACE_SECONDS={grace} leaves no room to charge: at least "
                          f"{CLAIM_WINDOW_SECONDS} s (the payer's time to claim) + PLUG_TIMEOUT_SECONDS "
                          f"({cfg.plug_timeout_seconds}); 1680 recommended")
    stroops = cfg.ficha_price.scaleb(STELLAR_DECIMALS)
    if stroops * cfg.max_fichas * (cfg.chain_len + 1) > I128_MAX:
        raise ConfigError("FICHA_PRICE is too large for the contract's arithmetic")
