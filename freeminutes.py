"""Free emergency minutes: what each device used today (docs/free-minutes.md).

Every device gets, once a day, FREE_CHARGE_SECONDS of charging (the station's
own relay) and FREE_INTERNET_SECONDS of internet (the Wi-Fi router's). A
device is its Wi-Fi MAC address, and that address is never stored: the
station keeps HMAC-SHA256(salt, MAC), with a random salt of the day. The
salt is kept in CURSOR_DIR for its day only: at the reset (local midnight)
a new one replaces it and the old file is deleted. So the ids of two days
cannot be linked to each other, and once its day is over an id cannot be
traced back to a MAC. While the day lasts, whoever can read the station's
disk could test candidate MACs against the salt: that is why it lives no
longer than the day. Nothing else about a device is kept: no IP, no MAC, no
name.

One file per day, `.free_minutes.<YYYY-MM-DD>.json`: the salt and the
allowance used by each device id, rewritten whole at each grant (written
before the grant is given, so a restart never gives it twice).

The day rolls whenever a device is looked up, and also without one: a
running station calls rollover() every minute (main.py), so the old file
and its salt go within a minute of local midnight. A station that is off at
midnight deletes them when it starts again (FreeMinutes() rolls at once):
until then they are still on its disk.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import logging
import os
import re
import secrets
import time
from datetime import datetime
from pathlib import Path
from typing import Callable

from config import Config

log = logging.getLogger("ficha.free")

FILE_PREFIX = ".free_minutes."
KINDS = ("charge", "internet")
# A device id: the first 16 hex digits (64 bits) of the HMAC. Plenty to tell
# the devices of one day apart; the same id in the session log.
ID_HEX = 16
SALT_BYTES = 32

_HEX12 = re.compile(r"[0-9a-f]{12}")


class Refused(Exception):
    """A grant not given: `code` says why ("off" or "used")."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


def normalise_mac(text: str) -> str | None:
    """'AA-BB-CC-DD-EE-FF', 'aa:bb:cc:dd:ee:ff' or 'aabb.ccdd.eeff' ->
    'aa:bb:cc:dd:ee:ff'; None for anything that is not one device's address
    (all zeros, broadcast, multicast)."""
    hexs = re.sub(r"[:\-. ]", "", (text or "").strip().lower())
    if not _HEX12.fullmatch(hexs):
        return None
    octets = bytes.fromhex(hexs)
    if octets == bytes(6) or octets == b"\xff" * 6 or octets[0] & 1:
        return None
    return ":".join(f"{b:02x}" for b in octets)


def local_day(unix: float) -> str:
    """The allowance's day: the local calendar date (FREE_RESET=midnight)."""
    return datetime.fromtimestamp(unix).date().isoformat()


class FreeMinutes:
    def __init__(self, cfg: Config, clock: Callable[[], float] = time.time,
                 salt_factory: Callable[[], bytes] = lambda: secrets.token_bytes(SALT_BYTES)) -> None:
        self.dir = Path(cfg.cursor_dir)
        self.allowance = {"charge": cfg.free_charge_seconds, "internet": cfg.free_internet_seconds}
        self.clock = clock
        self.salt_factory = salt_factory
        self.day: str | None = None
        self.salt = b""
        self.used: dict[str, dict[str, int]] = {}
        self._roll()

    def path(self, day: str | None = None) -> Path:
        return self.dir / f"{FILE_PREFIX}{day or self.day}.json"

    def _roll(self) -> None:
        """Today's salt and ledger: from today's file, or new. Every other
        day's file goes: its salt with it."""
        day = local_day(self.clock())
        if day == self.day:
            return
        path = self.path(day)
        salt, used = None, {}
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            salt = bytes.fromhex(data["salt"])
            if len(salt) != SALT_BYTES or data.get("day") != day:
                raise ValueError("not this day's")
            used = {str(dev): {k: int(v) for k, v in kinds.items() if k in KINDS}
                    for dev, kinds in data["used"].items()}
        except FileNotFoundError:
            salt = None
        except (ValueError, KeyError, TypeError, AttributeError):
            # Unreadable: the day starts over with a new salt. In the
            # devices' favour: one more free grant at most.
            log.warning("%s unreadable; free minutes start over for today", path.name)
            salt, used = None, {}
        fresh = salt is None
        self.day, self.salt, self.used = day, salt or self.salt_factory(), used
        if fresh:
            try:
                self._save(self.used)
            except OSError as exc:
                # Kept in memory; each grant tries to write again, and is
                # refused while it cannot (never given twice after a restart).
                log.error("cannot write %s (%s); free minutes refused until it can", path.name,
                          exc.strerror or exc)
        self._purge(keep=path)
        log.info("free minutes: day %s, %d device(s) so far", day, len(self.used))

    def _purge(self, keep: Path) -> None:
        for p in self.dir.glob(FILE_PREFIX + "*"):
            if p.name != keep.name:
                try:
                    p.unlink()
                except OSError as exc:
                    log.error("cannot delete %s (%s): an old salt is still on disk", p.name, exc.strerror or exc)

    def _save(self, used: dict[str, dict[str, int]]) -> None:
        """Today's file, replaced whole: never half written."""
        path = self.path()
        tmp = path.with_name(path.name + ".tmp")
        data = json.dumps({"day": self.day, "salt": self.salt.hex(), "used": used}, sort_keys=True)
        with tmp.open("w", encoding="utf-8") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)

    def rollover(self) -> None:
        """The day's reset even when no device asks: at the first call after
        local midnight, a new salt, and the old day's file deleted."""
        self._roll()

    def device_id(self, mac: str) -> str:
        """The device's id for today. `mac` as normalise_mac() returns it."""
        self._roll()
        return hmac.new(self.salt, mac.encode("ascii"), hashlib.sha256).hexdigest()[:ID_HEX]

    def used_today(self, mac: str) -> dict[str, bool]:
        """{"charge": bool, "internet": bool}: what this device used today."""
        entry = self.used.get(self.device_id(mac), {})
        return {k: bool(entry.get(k)) for k in KINDS}

    def grant(self, mac: str, what: str) -> tuple[str, int]:
        """Give this device today's `what` ("charge" or "internet"), all of
        it at once: (device id, seconds). On disk before it returns. Raises
        Refused("off") or Refused("used"), or OSError when it cannot be
        written (then nothing is given)."""
        if what not in KINDS:
            raise ValueError(what)
        seconds = self.allowance[what]
        if seconds <= 0:
            raise Refused("off")
        dev = self.device_id(mac)
        entry = self.used.get(dev, {})
        if entry.get(what):
            raise Refused("used")
        used = dict(self.used)
        used[dev] = dict(entry, **{what: seconds})
        self._save(used)
        self.used = used
        return dev, seconds
