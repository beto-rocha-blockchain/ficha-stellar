"""Station registry tooling. Runs on the operator's machine, never on a station.

The registry lists every station the Ficha app trusts: ID, name, host key,
asset and price. It is public and signed (docs/station-app-contract.md,
section 2): registry/stations.json plus a detached signature in
registry/stations.json.sig. The app pins the registry public key and rejects
a registry whose signature does not verify.

    python tools/registry.py new-key                 fresh keypair, printed once
    python tools/registry.py new-id                  a random station ID not in use
    python tools/registry.py sign [--key-file PATH]  or REGISTRY_SECRET in the environment
    python tools/registry.py verify [--key G...]     --key: the key the app pins

The registry SECRET never lives in the repo, on a station or in the app. This
tool never writes it anywhere; it reads it from a key file kept offline or
from the REGISTRY_SECRET environment variable. `sign` signs the exact bytes
of the file, so edit the JSON first (including issued_at), then sign.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import secrets
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from stellar_sdk import Keypair, StrKey  # noqa: E402

from config import ID_ALPHABET, STATION_ID_LENGTH  # noqa: E402
# The format and the signature check are shared with the station, which
# checks its own entry at startup (registry_check.py).
from registry_format import (  # noqa: E402,F401
    REGISTRY_FORMAT, SIG_FORMAT, RegistryError, notes, sig_path, validate, verify_bytes,
)

DEFAULT_FILE = ROOT / "registry" / "stations.json"


# -- signatures --------------------------------------------------------------
def sign_bytes(data: bytes, keypair: Keypair) -> dict:
    return {"format": SIG_FORMAT, "key": keypair.public_key,
            "sig": base64.b64encode(keypair.sign(data)).decode("ascii")}


def load_secret(key_file: str | None) -> Keypair:
    if key_file:
        try:
            secret = Path(key_file).read_text(encoding="utf-8").strip()
        except OSError as exc:
            raise RegistryError(f"cannot read the key file: {exc.strerror or exc}") from None
    else:
        secret = os.environ.get("REGISTRY_SECRET", "").strip()
        if not secret:
            raise RegistryError("no key: pass --key-file PATH or set REGISTRY_SECRET")
    # Never echo the value back, not even in an error.
    if not StrKey.is_valid_ed25519_secret_seed(secret):
        raise RegistryError("the key is not a Stellar secret key (S..., 56 characters)")
    return Keypair.from_secret(secret)


# -- commands ----------------------------------------------------------------
def cmd_new_key(_args) -> int:
    kp = Keypair.random()
    bar = "!" * 72
    print(bar)
    print("  NEW REGISTRY KEY. Store the SECRET offline NOW (password manager or")
    print("  paper in a safe). It is shown once; this tool keeps no copy.")
    print("  Never put it in the repo, on a station, in the app or in a chat.")
    print(bar)
    print(f"public  {kp.public_key}")
    print(f"secret  {kp.secret}")
    print(bar)
    print("Pin the PUBLIC key in the app's build config and in docs/station-app-contract.md.")
    return 0


def used_ids(folder: Path) -> set[str]:
    """IDs are unique worldwide: collect them from every registry file."""
    ids = set()
    for path in folder.glob("stations*.json"):
        try:
            reg = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        for st in reg.get("stations") or []:
            if isinstance(st, dict) and isinstance(st.get("id"), str):
                ids.add(st["id"])
    return ids


def new_station_id(taken: set[str]) -> str:
    while True:
        sid = "".join(secrets.choice(ID_ALPHABET) for _ in range(STATION_ID_LENGTH))
        if sid not in taken:
            return sid


def cmd_new_id(args) -> int:
    print(new_station_id(used_ids(Path(args.file).parent)))
    return 0


def cmd_sign(args) -> int:
    path = Path(args.file)
    keypair = load_secret(args.key_file)
    data = path.read_bytes()
    reg = validate(data, path.name)
    for note in notes(reg):
        print(f"note: {note}")
    sig = sign_bytes(data, keypair)
    sig_path(path).write_text(json.dumps(sig, indent=2) + "\n", encoding="utf-8", newline="\n")
    print(f"signed {path.name} ({reg['network']}, {len(reg['stations'])} station(s), "
          f"sha256 {hashlib.sha256(data).hexdigest()[:16]}) with {keypair.public_key}")
    print(f"wrote {sig_path(path).name}")
    return 0


def cmd_verify(args) -> int:
    path = Path(args.file)
    data = path.read_bytes()
    try:
        sig = json.loads(sig_path(path).read_text(encoding="utf-8"))
    except FileNotFoundError:
        raise RegistryError(f"{sig_path(path).name} not found: sign the registry first") from None
    except ValueError:
        raise RegistryError(f"{sig_path(path).name} is not JSON") from None
    key = verify_bytes(data, sig, args.key)
    reg = validate(data, path.name)
    for note in notes(reg):
        print(f"note: {note}")
    print(f"OK: {path.name} ({reg['network']}, {len(reg['stations'])} station(s)) signed by {key}")
    if not args.key:
        print("Only integrity was checked. Pass --key G... (the pinned registry key) to check who signed it.")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="registry.py", description="Ficha station registry tooling")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("new-key", help="print a fresh keypair once (store the secret offline)")
    p = sub.add_parser("new-id", help="print a random station ID not used in any registry file")
    p.add_argument("--file", default=str(DEFAULT_FILE))
    p = sub.add_parser("sign", help="sign the exact bytes of the registry file")
    p.add_argument("--file", default=str(DEFAULT_FILE))
    p.add_argument("--key-file", help="file holding the registry secret (else REGISTRY_SECRET)")
    p = sub.add_parser("verify", help="check the registry and its signature")
    p.add_argument("--file", default=str(DEFAULT_FILE))
    p.add_argument("--key", help="the registry public key the app pins")
    args = parser.parse_args(argv)
    command = {"new-key": cmd_new_key, "new-id": cmd_new_id, "sign": cmd_sign, "verify": cmd_verify}
    try:
        return command[args.command](args)
    except (RegistryError, OSError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
