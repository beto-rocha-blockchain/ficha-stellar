"""Keeps the relay safe when the station process dies.

The relay board latches its last command for as long as USB keeps it powered.
If the station were killed while charging (crash of the interpreter, Task
Manager, OOM killer), power would keep flowing. So with a real relay,
`python main.py` does not run the station directly: it runs it as a child
process and waits. However the child ends, this parent then opens the port
and sends OPEN.

What this cannot cover: both processes killed together, or the machine
freezing with USB still powered. Losing power is safe (the board loses power
too and the NO contact opens). On Linux, also add an ExecStopPost that runs
`python diag.py off` (see README).
"""

from __future__ import annotations

import logging
import os
import signal
import subprocess
import sys
import threading
import time
from typing import Callable

log = logging.getLogger("ficha.supervisor")

CHILD_ENV = "FICHA_CHILD"


def is_child() -> bool:
    return os.environ.get(CHILD_ENV) == "1"


def end_process(
    server=None,
    grace: float = 10.0,
    raise_signal: Callable[[int], None] = signal.raise_signal,
    hard_exit: Callable[[int], None] = os._exit,
) -> threading.Timer:
    """Take the whole station process down; the caller has opened the relay.
    Through the server when main.run() started it; otherwise (for example
    `uvicorn main:app`, whose server main.py cannot reach) the way SIGTERM
    would. If the process is still alive after `grace` seconds, it exits hard."""
    if server is not None:
        server.should_exit = True
    else:
        raise_signal(signal.SIGTERM)
    timer = threading.Timer(grace, hard_exit, args=(3,))
    timer.daemon = True
    timer.start()
    return timer


def force_open(cfg, attempts: int = 5) -> bool:
    """Open the relay from outside the station. True when the command went out."""
    from relay import SerialRelay

    relay = SerialRelay(cfg.relay_port, cfg.relay_baud, cfg.relay_cmd_close, cfg.relay_cmd_open)
    try:
        for i in range(attempts):
            try:
                relay.open()
                return True
            except Exception as exc:
                log.warning("could not open relay (attempt %d/%d): %s", i + 1, attempts, exc)
                time.sleep(1.0)
        return False
    finally:
        relay.release()


def run(cfg, argv: list[str]) -> int:
    env = dict(os.environ, **{CHILD_ENV: "1"})
    child = subprocess.Popen([sys.executable, *argv], env=env)
    log.info("station running as pid %d (supervisor pid %d)", child.pid, os.getpid())

    def forward(signum, _frame):
        try:
            child.terminate()
        except Exception:
            pass

    if hasattr(signal, "SIGTERM"):
        signal.signal(signal.SIGTERM, forward)

    interrupts = 0
    while True:
        try:
            code = child.wait()
            break
        except KeyboardInterrupt:
            # Ctrl+C reaches the child too; it shuts down and opens the relay
            # itself. A second Ctrl+C means it is stuck.
            interrupts += 1
            if interrupts >= 2:
                log.warning("station not stopping; terminating it")
                child.terminate()

    ok = force_open(cfg)
    if ok:
        log.info("station exited with code %s; relay forced OPEN", code)
    else:
        log.critical("station exited with code %s and the relay could NOT be opened; "
                     "unplug the relay board now", code)
    return code if ok else 3
