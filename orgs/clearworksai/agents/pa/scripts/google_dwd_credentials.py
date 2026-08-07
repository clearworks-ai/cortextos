#!/usr/bin/env python3
"""Reusable Google Workspace domain-wide delegation credential helper."""
from __future__ import annotations

import base64
import json
import os
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
TOKEN_CACHE = Path("/tmp/gws-dwd-token-cache.json")
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


def get_token(*, cache_file: Path = TOKEN_CACHE, key_file: Path = KEY_FILE,
              now: float | None = None) -> str:
    """Return a cached or freshly minted DWD token without logging it."""
    current = int(time.time() if now is None else now)
    try:
        cached = json.loads(cache_file.read_text())
        if cached.get("expiry", 0) > current + 60 and isinstance(cached.get("token"), str):
            try:
                os.chmod(cache_file, 0o600)
            except Exception:
                pass
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
        cache_file.write_text(json.dumps({"token": token, "expiry": expiry}))
        os.chmod(cache_file, 0o600)
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
