#!/usr/bin/env python3
"""Reusable Google Workspace domain-wide delegation credential helper."""
from __future__ import annotations

import base64
import json
import os
import stat
import subprocess
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

SUBJECT = "josh@clearworks.ai"
SCOPES = (
    "https://mail.google.com/",
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.modify",
    "https://www.googleapis.com/auth/calendar.readonly",
)
TOKEN_CACHE = Path.home() / ".cortextos" / "cortextos1" / "state" / "pa" / "google-provider" / "dwd-token-cache.json"
KEY_FILE = Path.home() / ".config" / "gws" / "service-account-key.json"


def _b64url(value: Any) -> str:
    if isinstance(value, dict):
        value = json.dumps(value, separators=(",", ":")).encode()
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode()


def _refresh_token(key_file: Path, now: int) -> tuple[str, int]:
    try:
        from cryptography.hazmat.primitives import hashes, serialization
        from cryptography.hazmat.primitives.asymmetric import padding
    except ImportError as exc:
        raise RuntimeError("dwd_crypto_unavailable") from exc
    try:
        key_data = json.loads(key_file.read_text())
        private_key = key_data["private_key"]
        client_email = key_data["client_email"]
        token_uri = key_data["token_uri"]
        key_id = key_data["private_key_id"]
        if token_uri != "https://oauth2.googleapis.com/token":
            raise ValueError()
    except Exception as exc:
        raise RuntimeError("dwd_key_invalid") from exc
    header = {"alg": "RS256", "typ": "JWT", "kid": key_id}
    payload = {"iss": client_email, "sub": SUBJECT, "scope": " ".join(SCOPES),
               "aud": token_uri, "iat": now, "exp": now + 3600}
    signing_input = f"{_b64url(header)}.{_b64url(payload)}".encode()
    try:
        loaded_key = serialization.load_pem_private_key(private_key.encode(), password=None)
        signature = loaded_key.sign(signing_input, padding.PKCS1v15(), hashes.SHA256())
        assertion = f"{signing_input.decode()}.{_b64url(signature)}"
        request = urllib.request.Request(token_uri, data=urllib.parse.urlencode({
            "grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer",
            "assertion": assertion,
        }).encode())
        with urllib.request.urlopen(request, timeout=15) as response:
            result = json.loads(response.read())
        token = result["access_token"]
        expires_in = int(result.get("expires_in", 3600))
        if not isinstance(token, str) or not token or expires_in <= 300:
            raise ValueError()
        return token, now + expires_in - 300
    except Exception as exc:
        raise RuntimeError("dwd_token_unavailable") from exc


def _read_cache(cache_file: Path) -> dict[str, Any]:
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(cache_file, flags)
    try:
        metadata = os.fstat(descriptor)
        if (not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != os.getuid()
                or stat.S_IMODE(metadata.st_mode) & 0o077):
            raise RuntimeError("dwd_cache_invalid")
        with os.fdopen(descriptor, "r", encoding="utf-8", closefd=False) as handle:
            value = json.load(handle)
        if not isinstance(value, dict):
            raise RuntimeError("dwd_cache_invalid")
        return value
    finally:
        os.close(descriptor)


def _write_cache(cache_file: Path, token: str, expiry: int) -> None:
    cache_file.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    parent = cache_file.parent.lstat()
    if not stat.S_ISDIR(parent.st_mode) or parent.st_uid != os.getuid():
        raise RuntimeError("dwd_cache_invalid")
    os.chmod(cache_file.parent, 0o700)
    temporary = cache_file.parent / f".{cache_file.name}.{os.getpid()}.{os.urandom(8).hex()}.tmp"
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(temporary, flags, 0o600)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", closefd=False) as handle:
            json.dump({"token": token, "expiry": expiry}, handle)
            handle.flush()
            os.fsync(descriptor)
        os.chmod(temporary, 0o600)
        os.replace(temporary, cache_file)
        os.chmod(cache_file, 0o600)
    finally:
        os.close(descriptor)
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


def get_token(*, cache_file: Path = TOKEN_CACHE, key_file: Path = KEY_FILE,
              now: float | None = None) -> str:
    """Return a cached or freshly minted DWD token without logging it."""
    current = int(time.time() if now is None else now)
    try:
        cached = _read_cache(cache_file)
        if cached.get("expiry", 0) > current + 60 and isinstance(cached.get("token"), str):
            return cached["token"]
    except Exception:
        pass
    try:
        token, expiry = _refresh_token(key_file, current)
    except RuntimeError as exc:
        if str(exc) != "dwd_crypto_unavailable":
            raise
        result = subprocess.run(
            ["uv", "run", "--with", "cryptography", str(Path(__file__).resolve()), "--print-token"],
            capture_output=True, text=True, timeout=30,
            env={key: value for key, value in os.environ.items() if key != "PYTHONPATH"},
        )
        token = result.stdout.strip()
        if result.returncode != 0 or not token:
            raise RuntimeError("dwd_token_unavailable")
        return token
    try:
        _write_cache(cache_file, token, expiry)
    except Exception:
        pass
    return token


if __name__ == "__main__":
    if sys.argv[1:] != ["--print-token"]:
        raise SystemExit("dwd_usage_invalid")
    try:
        print(get_token())
    except Exception as error:
        raise SystemExit(str(error) if str(error).startswith("dwd_") else "dwd_token_unavailable")
