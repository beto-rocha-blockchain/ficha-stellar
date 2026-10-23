"""The meter: current and voltage read from the phone that is charging.

read() returns (mA, mV, ok). Values are BATTERY values as the phone reports
them (e.g. 3200 mA at 4100 mV), normalized so positive current means charging.
Watts are always mA * mV of the phone itself, never the 5/9/20 V of the USB
port.
"""

from __future__ import annotations

import logging
import math
import random
import threading
import time
from typing import Callable

log = logging.getLogger("ficha.meter")

# (mA, mV, ok), or (mA, mV, ok, plugged) when the meter can tell whether the
# phone has a charger attached (see plugged()).
Reading = tuple


def plugged(reading: Reading) -> bool | None:
    """Whether the phone says a charger is attached: True or False from the
    phone's own charging status, None when this meter cannot tell. Under load
    (screen on, screen recording) a phone on a weak charger can be net
    negative while it charges, so the battery current alone cannot say."""
    return reading[3] if len(reading) > 3 else None


def charger_attached(status: str) -> bool | None:
    """The phone's battery status as charger presence: Charging, Full and
    Not charging (plugged in but holding) mean a charger is attached;
    Discharging means none; anything else is unknown."""
    st = status.strip().lower()
    if st in ("charging", "full", "not charging"):
        return True
    if st == "discharging":
        return False
    return None


class Meter:
    def read(self) -> Reading:
        raise NotImplementedError

    def describe(self) -> str:
        raise NotImplementedError

    def close(self) -> None:
        pass


class Sampler:
    """Reads the meter once a second on its own thread, so a slow or hung ADB
    call never stalls the countdown or the screen. latest() hands out the
    newest reading, or a failed one if it is stale."""

    STALE_SECONDS = 3.5

    def __init__(self, meter: Meter, period: float = 1.0) -> None:
        self.meter = meter
        self.period = period
        self._latest: Reading = (0, 0, False)
        self._at = 0.0
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, name="meter", daemon=True)

    def start(self) -> None:
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()

    def latest(self) -> Reading:
        with self._lock:
            if time.monotonic() - self._at > self.STALE_SECONDS:
                return (0, 0, False)
            return self._latest

    def _run(self) -> None:
        while not self._stop.is_set():
            started = time.monotonic()
            try:
                reading = self.meter.read()
            except Exception as exc:
                log.warning("meter read raised: %s", exc)
                reading = (0, 0, False)
            with self._lock:
                self._latest, self._at = reading, time.monotonic()
            self._stop.wait(max(0.05, self.period - (time.monotonic() - started)))


class MockMeter(Meter):
    """Imitates the REAL hardware of the chosen topology, not an ideal one.

    Profile sets the numbers:
      fast (mains):   ramps in 2-3 s to 2500-4000 mA, 3900-4300 mV, slow decay
      usb  (usb_vbus): 450-600 mA, 3800-4100 mV
    Topology sets how ADB behaves:
      mains:    ADB is over WiFi and survives the relay opening; when power is
                cut the phone keeps reporting, current goes negative (discharge)
      usb_vbus: cutting VBUS drops the data lines too; the phone vanishes while
                the relay is open and takes a moment to enumerate after closing
    plug says where the phone is plugged in (MOCK_PLUG), and can be changed
    at any time (the smoke test moves the phone mid-session):
      station:   into this station, so it charges only while the relay is closed
      elsewhere: into another charger (a wall outlet at home), so it charges
                 whatever the relay does; on usb_vbus it is off the station's
                 cable, so ADB does not see it at all
      none:      nowhere: mains reads a phone discharging, usb_vbus no phone
    source "outlet" imitates a meter on the station's own output instead of
    the phone (METER_SOURCE=outlet): it sees current only when this station
    is charging the phone, and reads 0 mA otherwise.
    """

    ENUMERATION_SECONDS = 2.2

    def __init__(
        self,
        profile: str,
        topology: str,
        powered: Callable[[], bool],
        clock: Callable[[], float] = time.monotonic,
        rng: random.Random | None = None,
        plug: str = "station",
        source: str = "phone",
    ) -> None:
        self.profile = profile
        self.topology = topology
        self.plug = plug
        self.source = source
        self._relay_closed = powered
        self._clock = clock
        self._rng = rng or random.Random()
        self._was_powered = False
        self._power_since = 0.0
        self._target_ma = 0.0
        self._ramp_s = 1.0
        self._v0 = 3900.0
        self._last_mv = 3950.0

    def describe(self) -> str:
        where = "" if self.plug == "station" else f" plugged {self.plug}"
        return f"mock/{self.profile}{'/outlet' if self.source == 'outlet' else ''}{where}"

    def _powered(self) -> bool:
        """Is the phone getting power from anywhere?"""
        if self.plug == "station":
            return self._relay_closed()
        return self.plug == "elsewhere"

    def _on_power(self, now: float) -> None:
        r = self._rng
        self._power_since = now
        if self.profile == "fast":
            self._target_ma = r.uniform(2700, 3900)
            self._ramp_s = r.uniform(2.0, 3.0)
            self._v0 = r.uniform(3900, 4000)
        else:
            self._target_ma = r.uniform(480, 590)
            self._ramp_s = 0.8
            self._v0 = r.uniform(3800, 3880)

    def read(self) -> Reading:
        now = self._clock()
        powered = self._powered()
        if powered and not self._was_powered:
            self._on_power(now)
        self._was_powered = powered
        r = self._rng

        if self.source == "outlet":
            # The station's own output: it sees this phone only while this
            # station charges it, never a charger somewhere else.
            if not (powered and self.plug == "station"):
                return (0, 0, True)
            t = now - self._power_since
        elif self.topology == "usb_vbus":
            if not powered or self.plug != "station":
                return (0, 0, False)  # device gone: data rides on the cut cable
            if now - self._power_since < self.ENUMERATION_SECONDS:
                return (0, 0, False)  # still enumerating
            t = now - self._power_since - self.ENUMERATION_SECONDS
        else:
            t = now - self._power_since

        if not powered:
            # Mains: phone still on WiFi, running on its own battery.
            mv = max(3700.0, self._last_mv - r.uniform(0, 2))
            self._last_mv = mv
            return (-int(r.uniform(150, 350)), int(mv), True)

        ramp = min(1.0, max(0.0, t / self._ramp_s))
        if self.profile == "fast":
            decay = math.exp(-t / 2400.0)  # about 2.5% per minute
            ma = self._target_ma * ramp * decay + r.uniform(-40, 40)
            ma = max(0.0, min(4000.0, ma))
            mv = min(4300.0, self._v0 + t * 0.15) + r.uniform(-5, 5)
            mv = max(3900.0, min(4300.0, mv))
        else:
            ma = self._target_ma * ramp + r.uniform(-15, 15)
            ma = max(0.0, min(600.0, ma))
            if ramp >= 1.0:
                ma = max(450.0, ma)
            mv = min(4100.0, self._v0 + t * 0.08) + r.uniform(-5, 5)
            mv = max(3800.0, min(4100.0, mv))
        self._last_mv = mv
        return (int(ma), int(mv), True)


# Battery directories under /sys/class/power_supply, most likely first. Any
# other directory whose type is "Battery" is tried after these. Charger-side
# supplies (usb, ac, wireless, main, pc_port, dc...) are never used: their
# voltage is the port's 5/9/20 V, not the battery's.
BATTERY_CANDIDATES = (
    "battery", "bms", "Battery", "main-battery", "max170xx_battery",
    "max77705-fuelgauge", "max77729-fuelgauge", "sec-fuelgauge",
    "bq27541-0", "bq27541_battery", "bq27542-0", "bq27z561-0",
    "fg_battery", "mtk-gauge", "mtk_battery", "sm5720-fuelgauge",
)
CHARGER_TYPES = {"usb", "mains", "wireless", "usb_pd", "usb_c", "usb_dcp", "usb_cdp",
                 "usb_aca", "usb_hvdcp", "usb_hvdcp_3", "usb_pd_drp", "brick_id", "dc"}

# One adb call per reading: current, voltage and status on one line.
_READ = 'echo "$(cat {d}/current_now 2>&1)|$(cat {d}/voltage_now 2>&1)|$(cat {s} 2>&1)"'
# Newer Android (seen on a moto g54, Android 15) denies listing the directory
# but still lets the shell read the files in it, so the known names are tried
# by full path as well. Paths that do not exist (including an unexpanded glob)
# are skipped.
_SCAN = ('for d in /sys/class/power_supply/* '
         + " ".join(f"/sys/class/power_supply/{n}" for n in BATTERY_CANDIDATES)
         + '; do [ -e "$d/type" ] || [ -e "$d/current_now" ] || continue; '
         'echo "$d|$(cat $d/type 2>/dev/null)|'
         '$(cat $d/current_now 2>/dev/null)|$(cat $d/voltage_now 2>/dev/null)|'
         '$(cat $d/status 2>/dev/null)"; done')

# A phone never draws 10 A, so any |current| at or above this is in microamps.
UA_THRESHOLD = 10_000


def _int(text: str) -> int | None:
    text = text.strip()
    try:
        return int(text)
    except ValueError:
        try:
            return int(float(text))
        except ValueError:
            return None


def normalize_mv(raw: int) -> int:
    """Battery voltage to millivolts, whatever unit the driver used."""
    v = abs(raw)
    if v >= 100_000:  # microvolts (the Linux ABI unit)
        return int(round(raw / 1000))
    if v >= 1000:  # already millivolts
        return raw
    return raw * 1000  # volts, seen on a few odd drivers


class AdbMeter(Meter):
    """Reads the phone's BATTERY current and voltage over ADB.

    Transport usb: `adb [-s serial] shell ...` through the charging cable. In
    usb_vbus topology the phone vanishes whenever the relay opens; that is
    normal and simply reads as ok=False.
    Transport tcp: ADB over WiFi. `adb connect ip:port` at startup, and again
    (rate-limited) whenever the phone drops off.

    Normalization, learned from the phone itself:
      path  - scan of /sys/class/power_supply at startup (and again on failure)
      unit  - uA vs mA by magnitude, sticky once a value >= 10 000 is seen;
              METER_CURRENT_SCALE overrides (e.g. 0.001, -1)
      sign  - positive = charging. Calibrated from the status file: while the
              phone says "Discharging" the current must be flowing out.
    If sysfs cannot be read, falls back to `dumpsys battery` (voltage always,
    current only on builds that print it) and says so.
    """

    SHELL_TIMEOUT = 3.0
    RECONNECT_EVERY = 5.0
    RESCAN_EVERY = 1.0

    def __init__(
        self,
        adb_cmd: list[str],
        transport: str,
        serial: str = "",
        current_scale: float | None = None,
        verbose: bool = False,
        run: Callable | None = None,
    ) -> None:
        import subprocess

        self._subprocess = subprocess
        self._run = run or subprocess.run
        self.adb_cmd = list(adb_cmd)
        self.transport = transport
        self.serial = serial
        self.scale = current_scale
        self.verbose = verbose

        self.mode: str | None = None  # "sysfs" | "dumpsys" | None (not found yet)
        self.dir: str | None = None
        self.status_path: str | None = None
        self.unit_ua: bool | None = None  # None = undecided
        self._sign_votes = 0  # >0 normal (positive = charging), <0 inverted
        self.detail = "starting"
        self.ever_ok = False
        self.last_raw: tuple[str, ...] | None = None
        self._last_reconnect = 0.0
        self._last_scan = 0.0
        self._connect_error: str | None = None
        self._warned: set[str] = set()

        self._adb(["start-server"], timeout=15.0)
        if self.transport == "tcp":
            self._connect(force=True)
        self._scan()

    @classmethod
    def from_config(cls, cfg, verbose: bool = False) -> "AdbMeter":
        return cls([cfg.adb_path], cfg.adb_transport, cfg.adb_serial,
                   current_scale=cfg.meter_current_scale, verbose=verbose)

    # -- adb plumbing ---------------------------------------------------------
    def _adb(self, args: list[str], timeout: float | None = None, serial: bool = False):
        cmd = list(self.adb_cmd)
        if serial and self.serial:
            cmd += ["-s", self.serial]
        cmd += args
        kwargs = {}
        if hasattr(self._subprocess, "CREATE_NO_WINDOW"):
            kwargs["creationflags"] = self._subprocess.CREATE_NO_WINDOW
        try:
            r = self._run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace",
                          timeout=timeout or self.SHELL_TIMEOUT, **kwargs)
            return r.returncode, r.stdout or "", r.stderr or ""
        except FileNotFoundError:
            return 127, "", f"adb not found at {self.adb_cmd[0]!r} (set ADB_PATH)"
        except self._subprocess.TimeoutExpired:
            return 124, "", "adb timed out"

    def _shell(self, script: str):
        return self._adb(["shell", script], serial=True)

    def _connect(self, force: bool = False) -> bool:
        now = time.monotonic()
        if not force and now - self._last_reconnect < self.RECONNECT_EVERY:
            return False
        self._last_reconnect = now
        if not self.serial:
            self._set_detail("ADB_SERIAL (ip:port) is not set")
            return False
        code, out, err = self._adb(["connect", self.serial], timeout=8.0)
        text = (out + err).strip()
        low = text.lower()
        ok = "connected to" in low and "failed" not in low and "cannot" not in low
        if ok:
            log.info("adb %s", text.splitlines()[0])
            self._connect_error = None
            self._last_scan = 0.0  # look for the battery right away
        else:
            self._connect_error = f"cannot connect to {self.serial}: {text or code}"
            self._set_detail(self._connect_error)
        return ok

    def _set_detail(self, text: str) -> None:
        if text != self.detail:
            (log.info if text.startswith("sysfs") else log.warning)("meter: %s", text)
        self.detail = text

    @staticmethod
    def _explain(err: str) -> str:
        low = err.lower()
        if "adb_path" in low:
            return err.strip()
        if "unauthorized" in low:
            return "phone unauthorized: accept the USB debugging prompt on the phone"
        if "more than one device" in low:
            return "more than one device: set ADB_SERIAL"
        if "offline" in low:
            return "phone offline"
        if "not found" in low or "no devices" in low:
            return "no phone"
        if "timed out" in low:
            return "adb timed out"
        lines = err.strip().splitlines()
        return lines[-1] if lines else "adb failed"

    def _on_adb_failure(self, err: str) -> None:
        self._set_detail(self._explain(err))
        if self.transport == "tcp" and self.serial:
            if "offline" in err.lower():
                self._adb(["disconnect", self.serial], timeout=5.0)
            self._connect()
            if self._connect_error:
                self._set_detail(self._connect_error)

    # -- discovery ------------------------------------------------------------
    def _scan(self) -> None:
        self._last_scan = time.monotonic()
        code, out, err = self._shell(_SCAN)
        if code != 0:
            self._on_adb_failure(err or out)
            return
        entries = []
        names = set()
        for line in out.splitlines():
            parts = line.strip().split("|")
            if len(parts) != 5:
                continue
            path, typ, cur, volt, status = parts
            name = path.rsplit("/", 1)[-1]
            if name in names:  # listed by the glob and again by full path
                continue
            names.add(name)
            entries.append((path, name, typ.strip(), _int(cur), _int(volt), status.strip()))

        def usable(e):
            _, _, typ, cur, volt, _ = e
            return cur is not None and volt is not None and typ.lower() not in CHARGER_TYPES

        by_name = {e[1]: e for e in entries if usable(e)}
        chosen = next((by_name[n] for n in BATTERY_CANDIDATES if n in by_name), None)
        if chosen is None:
            chosen = next((e for e in entries if usable(e) and e[2].lower() == "battery"), None)
        if self.verbose:
            seen = ", ".join(f"{e[1]}({e[2] or '?'})" for e in entries) or "none"
            print(f"power supplies seen: {seen}")

        if chosen is not None:
            self.mode, self.dir = "sysfs", chosen[0]
            battery_status = next((e for e in entries if e[1] == "battery" and e[5]), None)
            if chosen[5]:
                self.status_path = f"{self.dir}/status"
            elif battery_status:
                self.status_path = f"{battery_status[0]}/status"
            else:
                self.status_path = "/sys/class/power_supply/battery/status"
            self._set_detail(f"sysfs {chosen[1]}")
        else:
            self.mode, self.dir = "dumpsys", None
            if "dumpsys" not in self._warned:
                self._warned.add("dumpsys")
                log.warning("no readable battery current in /sys/class/power_supply; "
                            "falling back to dumpsys battery (current may be unavailable)")
            self._set_detail("dumpsys fallback")

    # -- normalization --------------------------------------------------------
    def _raw_ma(self, raw: int) -> float:
        """Current in mA with the phone's own sign, or scaled by the override."""
        if self.scale is not None:
            return raw * self.scale
        if abs(raw) >= UA_THRESHOLD and not self.unit_ua:
            self.unit_ua = True
            log.info("meter: current unit is uA (saw %d)", raw)
        return raw / 1000 if self.unit_ua else float(raw)

    def _sign(self) -> int:
        return -1 if self._sign_votes < 0 else 1

    def _learn_sign(self, raw_ma: float, status: str) -> None:
        """Positive means charging. Learned only while the phone says
        'Discharging', when the current must be flowing out: the station
        starts with the relay open and every probe opens it, so those readings
        come often. 'Charging' readings never vote: under load (screen on,
        screen recording) a phone on a weak charger is net negative while it
        charges, and their votes flipped the sign back and forth. Once the
        sign is known, a contrary reading counts a third as much, so the few
        seconds the phone's gauge lags behind a relay change cannot flip it."""
        if self.scale is not None:
            return
        if status.strip().lower() != "discharging" or abs(raw_ma) < 20:
            return
        vote = 3 if raw_ma < 0 else -3
        if self.sign_known() and (vote > 0) != (self._sign_votes > 0):
            vote //= 3
        before = self._sign()
        self._sign_votes = max(-30, min(30, self._sign_votes + vote))
        if self._sign() != before:
            log.info("meter: current sign is %s", "inverted" if self._sign() < 0 else "normal")

    def sign_known(self) -> bool:
        return self.scale is not None or abs(self._sign_votes) >= 6

    def _normalize(self, raw: int, status: str) -> int:
        raw_ma = self._raw_ma(raw)
        self._learn_sign(raw_ma, status)
        return int(round(raw_ma * (1 if self.scale is not None else self._sign())))

    # -- reading --------------------------------------------------------------
    def read(self) -> Reading:
        if self.mode is None and time.monotonic() - self._last_scan >= self.RESCAN_EVERY:
            self._scan()
        if self.mode == "sysfs":
            return self._read_sysfs()
        if self.mode == "dumpsys":
            return self._read_dumpsys()
        if self.transport == "tcp" and self._connect_error:
            self._connect()
        return (0, 0, False)

    def _read_sysfs(self) -> Reading:
        code, out, err = self._shell(_READ.format(d=self.dir, s=self.status_path))
        if code != 0:
            self._on_adb_failure(err or out)
            return (0, 0, False)
        parts = out.strip().split("|")
        if len(parts) != 3:
            self._set_detail(f"unexpected output: {out.strip()[:60]}")
            return (0, 0, False)
        self.last_raw = tuple(p.strip() for p in parts)
        cur, volt = _int(parts[0]), _int(parts[1])
        if cur is None or volt is None:
            # Permission denied, file gone after an update, another phone...
            self._set_detail(f"sysfs unreadable ({parts[0].strip()[:40]}); rescanning")
            self._scan()
            return (0, 0, False)
        ma = self._normalize(cur, parts[2])
        self.ever_ok = True
        self._set_detail(f"sysfs {self.dir.rsplit('/', 1)[-1]}")
        return (ma, normalize_mv(volt), True, charger_attached(parts[2]))

    def _read_dumpsys(self) -> Reading:
        code, out, err = self._shell("dumpsys battery")
        if code != 0:
            self._on_adb_failure(err or out)
            return (0, 0, False)
        mv = cur = None
        status = ""
        for line in out.splitlines():
            key, _, value = line.strip().partition(":")
            key = key.strip().lower()
            if key == "voltage":
                mv = _int(value)
            elif key in ("current now", "current_now", "currentnow"):
                cur = _int(value)
            elif key == "status":
                status = {"2": "charging", "3": "discharging", "4": "not charging",
                          "5": "full"}.get(value.strip(), "")
        self.last_raw = (str(cur), str(mv), status)
        if cur is None:
            self._set_detail("dumpsys: this phone does not report current")
            return (0, 0, False)
        ma = self._normalize(cur, status)
        self.ever_ok = True
        self._set_detail("dumpsys")
        return (ma, normalize_mv(mv) if mv else 0, True, charger_attached(status))

    # -- for humans -----------------------------------------------------------
    def describe(self) -> str:
        unit = ""
        if self.mode == "sysfs" and self.scale is None:
            unit = " uA" if self.unit_ua else " mA?"
        return f"adb/{self.transport} {self.detail}{unit}"

    def report(self) -> str:
        if self.scale is not None:
            unit = sign = f"fixed by METER_CURRENT_SCALE={self.scale}"
        else:
            unit = "uA" if self.unit_ua else "mA (tentative: no value >= 10000 seen yet)"
            sign = ("inverted" if self._sign() < 0 else "normal") + (
                "" if self.sign_known() else " (not calibrated yet)")
        return (f"meter  : adb/{self.transport} {self.serial or '(default device)'}\n"
                f"source : {self.mode or 'none'} {self.dir or ''}\n"
                f"unit   : {unit}\n"
                f"sign   : {sign} (positive = charging)\n"
                f"status : {self.detail}\n"
                f"raw    : {' | '.join(self.last_raw) if self.last_raw else '-'}")


def from_config(cfg, powered: Callable[[], bool]) -> Meter:
    if cfg.mock:
        return MockMeter(cfg.mock_profile, cfg.topology, powered, plug=cfg.mock_plug, source=cfg.meter_source)
    return AdbMeter.from_config(cfg)
