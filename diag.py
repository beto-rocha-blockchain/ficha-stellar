"""Hardware diagnostics. No server, no payment, no browser.

    python diag.py ports            list serial ports, point out the CH340 board
    python diag.py relay            click test: close/open the relay 3 times
    python diag.py off              force the relay OPEN (power off) and exit
    python diag.py probe            ask the board for its state (0xFF); many
                                    LCUS-1 boards never answer, which is fine
    python diag.py meter [secs]     read the phone over ADB and print live values
    python diag.py charge [secs]    the whole chain: close relay, watch current
                                    rise, open relay, confirm the cut

They always use the real drivers (whatever MOCK says) and the rest of .env.
Stop the station first: a COM port can only be open in one program.
"""

from __future__ import annotations

import logging
import sys
import time

import config

CH340_VID, CH340_PID = 0x1A86, 0x7523


def _cfg():
    try:
        return config.load()
    except config.ConfigError as exc:
        # Diagnostics should still run with a half-finished .env.
        print(f"(config warning: {exc})")
        import os
        os.environ["MOCK_PAYMENT"] = "true"
        os.environ["MOCK"] = "true"
        return config.load()


def _relay(cfg):
    from relay import SerialRelay
    return SerialRelay(cfg.relay_port, cfg.relay_baud, cfg.relay_cmd_close, cfg.relay_cmd_open)


def _meter(cfg, verbose: bool = True):
    from meter import AdbMeter
    return AdbMeter.from_config(cfg, verbose=verbose)


def cmd_ports(cfg) -> int:
    from serial.tools import list_ports

    ports = list(list_ports.comports())
    if not ports:
        print("No serial ports. Plug the relay board in; on Windows it should appear as")
        print("'USB-SERIAL CH340 (COMx)' in Device Manager. If it shows with a warning")
        print("icon, install the CH340 driver (WCH CH341SER).")
        return 1
    found = False
    for p in ports:
        is_ch340 = p.vid == CH340_VID and p.pid == CH340_PID
        found |= is_ch340
        mark = "  <-- CH340 (relay board?)" if is_ch340 else ""
        cur = "  [RELAY_PORT]" if p.device == cfg.relay_port else ""
        vidpid = f"{p.vid:04X}:{p.pid:04X}" if p.vid is not None else "----:----"
        print(f"{p.device:<14} {vidpid}  {p.description}{mark}{cur}")
    if not any(p.device == cfg.relay_port for p in ports):
        print(f"\nRELAY_PORT={cfg.relay_port} is not in the list: set it in .env.")
    elif not found:
        print("\nNo CH340 found; the relay board uses a CH340 (VID 1A86, PID 7523).")
    return 0


def cmd_off(cfg) -> int:
    relay = _relay(cfg)
    try:
        relay.open()
        print(f"Relay OPEN on {cfg.relay_port} (power off).")
        return 0
    except Exception as exc:
        print(f"Could not open the relay: {exc}")
        return 1
    finally:
        relay.release()


def cmd_relay(cfg) -> int:
    """Only opens and closes the relay three times, to confirm the wiring by
    the click. Starts and ends OPEN."""
    relay = _relay(cfg)
    try:
        relay.open()
        print(f"{cfg.relay_port}: relay OPEN. Listen for the clicks (and the board LED).")
        time.sleep(1.0)
        for i in range(1, 4):
            relay.close()
            print(f"  {i}/3 CLOSE  (power on)")
            time.sleep(1.0)
            relay.open()
            print(f"  {i}/3 OPEN   (power off)")
            time.sleep(1.0)
        print("Done. Relay left OPEN.")
        print("No click? Check RELAY_PORT (python diag.py ports), RELAY_BAUD and the")
        print("RELAY_CMD_* bytes in .env.")
        return 0
    except KeyboardInterrupt:
        return 130
    except Exception as exc:
        print(f"Relay error: {exc}")
        return 1
    finally:
        try:
            relay.open()
        except Exception:
            pass
        relay.release()


def cmd_probe(cfg) -> int:
    """LC Technology documents 0xFF as a status query on its 4 and 8 channel
    boards. The 1 channel V4.3 may or may not answer; the station never
    depends on it. Ends by re-sending OPEN."""
    relay = _relay(cfg)
    try:
        relay.open()
        ser = relay._connect()
        for state in ("OPEN", "CLOSED", "OPEN"):
            if state == "CLOSED":
                relay.close()
            elif state == "OPEN":
                relay.open()
            time.sleep(0.2)
            ser.reset_input_buffer()
            ser.write(bytes([0xFF]))
            ser.flush()
            time.sleep(0.3)
            reply = ser.read(64)
            shown = "".join(chr(c) if 32 <= c < 127 else "." for c in reply) if reply else "(no answer)"
            print(f"relay {state:<6} -> {reply.hex(' ').upper() or '--'}  {shown}")
        return 0
    except Exception as exc:
        print(f"Relay error: {exc}")
        return 1
    finally:
        try:
            relay.open()
        except Exception:
            pass
        relay.release()


def _fmt(reading) -> str:
    ma, mv, ok = reading[:3]
    if not ok:
        return "  -- no reading --"
    return f"{ma:>7} mA  {mv:>5} mV  {ma * mv / 1e6:>6.2f} W"


def cmd_meter(cfg, seconds: int) -> int:
    meter = _meter(cfg)
    print(meter.report())
    ok_count = 0
    try:
        for _ in range(seconds):
            t0 = time.monotonic()
            r = meter.read()
            ok_count += r[2]
            print(f"{time.strftime('%H:%M:%S')} {_fmt(r)}   {meter.describe()}")
            time.sleep(max(0.0, 1.0 - (time.monotonic() - t0)))
    except KeyboardInterrupt:
        pass
    finally:
        meter.close()
    print(meter.report())
    return 0 if ok_count else 1


def cmd_charge(cfg, seconds: int) -> int:
    """Close the relay, watch the current, open it, confirm the cut."""
    relay = _relay(cfg)
    meter = _meter(cfg)
    peak = 0
    delivered = False
    before = None  # last reading with the relay closed: what the cut is judged against
    opened = False
    try:
        relay.open()
        print(f"Relay OPEN. Topology {cfg.topology}. Baseline:")
        for _ in range(3):
            print("   ", _fmt(meter.read()))
            time.sleep(1.0)

        relay.close()
        print(f"Relay CLOSED. Charging for {seconds} s (min {cfg.min_current_ma} mA counts as delivered):")
        start = time.monotonic()
        waited_device = cfg.topology != "usb_vbus"
        while time.monotonic() - start < seconds:
            t0 = time.monotonic()
            r = meter.read()
            before = r
            if r[2]:
                waited_device = True
                peak = max(peak, r[0])
                if r[0] >= cfg.min_current_ma and not delivered:
                    delivered = True
                    print(f"    delivering after {time.monotonic() - start:.1f} s")
            elif not waited_device:
                print("    waiting for the phone to come back on USB...")
                time.sleep(1.0)
                continue
            print("   ", _fmt(r))
            time.sleep(max(0.0, 1.0 - (time.monotonic() - t0)))
    except KeyboardInterrupt:
        print("interrupted")
    except Exception as exc:
        print(f"Error: {exc}")
    finally:
        try:
            relay.open()
            opened = True
            print("Relay OPEN (power off). Confirming the cut:")
        except Exception as exc:
            print(f"!!! could not open the relay: {exc}. UNPLUG THE BOARD.")
        relay.release()

    cut = None
    why_not = None
    if not opened:
        why_not = "relay open command failed"
    elif not (before and before[2]):
        why_not = "phone not readable just before opening"
    elif cfg.topology == "mains" and before[0] < cfg.min_current_ma:
        why_not = f"no current before opening ({before[0]} mA), nothing to see drop"
    for i in range(0 if why_not else 8):
        time.sleep(1.0)
        r = meter.read()
        print("   ", _fmt(r))
        if cfg.topology == "usb_vbus" and not r[2]:
            cut = "phone vanished from USB"
        elif cfg.topology == "mains" and r[2] and r[0] < cfg.min_current_ma:
            cut = "current dropped"
        if cut:
            print(f"    cut confirmed after {i + 1} s: {cut}")
            break
    meter.close()

    print()
    print(f"peak current : {peak} mA")
    print(f"verdict      : {'delivered' if delivered else ('no_current' if peak or meter.ever_ok else 'unverified')}")
    print(f"cut          : {cut or 'NOT confirmed' + (f' ({why_not})' if why_not else '')}")
    return 0 if delivered and cut else 1


def main(argv: list[str]) -> int:
    try:
        sys.stdout.reconfigure(errors="replace")  # Windows consoles are not UTF-8
    except Exception:
        pass
    logging.basicConfig(level=logging.WARNING, format="%(levelname)s %(name)s: %(message)s")
    if not argv or argv[0] in ("-h", "--help", "help"):
        print(__doc__)
        return 0
    cfg = _cfg()
    what = argv[0]
    secs = int(argv[1]) if len(argv) > 1 else None
    if what == "ports":
        return cmd_ports(cfg)
    if what == "relay":
        return cmd_relay(cfg)
    if what == "off":
        return cmd_off(cfg)
    if what == "probe":
        return cmd_probe(cfg)
    if what == "meter":
        return cmd_meter(cfg, secs or 15)
    if what == "charge":
        return cmd_charge(cfg, secs or 20)
    print(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
