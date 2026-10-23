"""The relay that cuts and releases power.

Vocabulary, because it is easy to get backwards:
  open()  -> contacts apart  -> NO power flows  (the safe state)
  close() -> contacts touch  -> power flows

The board is wired on its NO (normally open) contact, so any failure (no USB,
dead process, loose wire) ends in "does not charge", never "charges for free".

Diagnostic click test, no server, no phone:  python diag.py relay
"""

from __future__ import annotations

import logging
import threading
import time

log = logging.getLogger("ficha.relay")


class Relay:
    """Interface. Subclasses implement _send_open() and _send_close()."""

    def __init__(self) -> None:
        self._lock = threading.RLock()
        # Unknown until we command it. Treat unknown as "maybe closed" so the
        # first thing anyone does is open it.
        self._is_open: bool | None = None
        # What we last asked for. Re-sent by maintain() after a replug.
        self._want_open: bool = True
        self.error: str | None = None

    @property
    def is_open(self) -> bool:
        return self._is_open is not False

    @property
    def healthy(self) -> bool:
        return self.error is None

    def open(self) -> None:
        with self._lock:
            self._want_open = True
            self._apply(True)

    def close(self) -> None:
        with self._lock:
            self._want_open = False
            self._apply(False)

    def _apply(self, want_open: bool) -> None:
        try:
            self._send_open() if want_open else self._send_close()
            self._is_open = want_open
            self.error = None
        except Exception as exc:  # the caller must know, but keep the state honest
            self.error = f"{'open' if want_open else 'close'} failed: {exc}"
            log.error("relay %s", self.error)
            raise

    def maintain(self) -> None:
        """Called about once a second from a worker thread. Never raises."""

    def shutdown(self) -> None:
        """Open, then release the port. Never raises."""
        try:
            self.open()
        except Exception:
            pass
        self.release()

    def release(self) -> None:
        pass

    def describe(self) -> str:
        raise NotImplementedError

    def _send_open(self) -> None:
        raise NotImplementedError

    def _send_close(self) -> None:
        raise NotImplementedError


class MockRelay(Relay):
    def describe(self) -> str:
        return "mock"

    def _send_open(self) -> None:
        log.info("relay OPEN (power off)")

    def _send_close(self) -> None:
        log.info("relay CLOSE (power on)")


class SerialRelay(Relay):
    """LCUS V4.3 (LC Technology) and look-alikes: CH340 USB-serial, 9600 8N1,
    write-only 4-byte commands. The board never answers, so the only way to
    stay sure of its state is to keep telling it: maintain() re-sends the
    desired state every few seconds. That also restores it after the board is
    unplugged and plugged back (it powers up with the relay open) and reopens
    the port after any serial error.

    Careful with the vendor's words: LC Technology calls A0 01 01 A2 "open
    the USB switch", meaning ON. Here names follow the contacts: CLOSE = power
    on = A0 01 01 A2, OPEN = power off = A0 01 00 A1 (both from .env).

    The port may be anything pyserial understands: COM3, /dev/ttyUSB0, or
    loop:// for a dry run without hardware.
    """

    SETTLE_SECONDS = 0.3  # after opening the port, before the first command
    GAP_SECONDS = 0.1  # between commands; the board handles one at a time
    REASSERT_SECONDS = 5.0

    def __init__(self, port: str, baud: int, cmd_close: bytes, cmd_open: bytes) -> None:
        super().__init__()
        self.port = port
        self.baud = baud
        self.cmd_close = cmd_close
        self.cmd_open = cmd_open
        self._ser = None
        self._last_write = 0.0

    def describe(self) -> str:
        return f"serial {self.port}"

    # -- port ---------------------------------------------------------------
    def _connect(self):
        if self._ser is not None and self._ser.is_open:
            return self._ser
        import serial  # pyserial

        try:
            ser = serial.serial_for_url(
                self.port,
                baudrate=self.baud,
                bytesize=serial.EIGHTBITS,
                parity=serial.PARITY_NONE,
                stopbits=serial.STOPBITS_ONE,
                timeout=0.2,
                write_timeout=1.0,
            )
        except serial.SerialException as exc:
            raise RuntimeError(_explain_port_error(self.port, exc)) from None
        time.sleep(self.SETTLE_SECONDS)
        self._ser = ser
        log.info("relay port %s open", self.port)
        return ser

    def _drop(self) -> None:
        ser, self._ser = self._ser, None
        if ser is not None:
            try:
                ser.close()
            except Exception:
                pass

    def _write(self, cmd: bytes) -> None:
        try:
            ser = self._connect()
            wait = self.GAP_SECONDS - (time.monotonic() - self._last_write)
            if wait > 0:
                time.sleep(wait)
            sent = ser.write(cmd)  # bytes, never str: OFF contains a 0x00
            ser.flush()
            self._last_write = time.monotonic()
            if sent is not None and sent != len(cmd):
                raise RuntimeError(f"short write ({sent} of {len(cmd)} bytes)")
        except Exception:
            self._drop()
            raise

    def _send_open(self) -> None:
        # Twice: OPEN is the safety direction and the board never acknowledges.
        self._write(self.cmd_open)
        self._write(self.cmd_open)
        log.info("relay OPEN (power off) %s", self.cmd_open.hex(" ").upper())

    def _send_close(self) -> None:
        self._write(self.cmd_close)
        log.info("relay CLOSE (power on) %s", self.cmd_close.hex(" ").upper())

    def maintain(self) -> None:
        with self._lock:
            due = time.monotonic() - self._last_write >= self.REASSERT_SECONDS
            if not (due or self.error):
                return
            try:
                cmd = self.cmd_open if self._want_open else self.cmd_close
                self._write(cmd)
                self._is_open = self._want_open
                if self.error:
                    log.info("relay port %s back", self.port)
                self.error = None
            except Exception as exc:
                msg = f"{'open' if self._want_open else 'close'} failed: {exc}"
                if msg != self.error:
                    log.error("relay %s", msg)
                self.error = msg

    def release(self) -> None:
        with self._lock:
            self._drop()


def _explain_port_error(port: str, exc: Exception) -> str:
    # pyserial flattens the OS error into text, and Windows localizes the
    # message ("Acesso negado"), so match on the error class and errno only.
    text = str(exc)
    if "PermissionError(" in text or "[Errno 13]" in text or "[Errno 16]" in text:
        return (f"{port} is in use or not permitted (another program has it open? "
                f"the station already running? on Linux: add yourself to 'dialout')")
    if "FileNotFoundError(" in text or "[Errno 2]" in text:
        return f"{port} not found (board unplugged? run: python diag.py ports)"
    return (f"{port}: {text} (if the port is listed but will not open, check the CH340 "
            f"driver: see README, troubleshooting)")


def from_config(cfg) -> Relay:
    if cfg.mock:
        return MockRelay()
    return SerialRelay(cfg.relay_port, cfg.relay_baud, cfg.relay_cmd_close, cfg.relay_cmd_open)
