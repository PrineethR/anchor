"""A small Firestore REST client, standard library only.

The Mac side of the cloud site talks to Firestore through this. Three ways to be let in:

  ServiceAccountAuth  a service-account key file (the real project). Bypasses security rules, so keep the key
                      outside the repo and treat it like a password. Signing uses the `openssl` that ships with macOS.
  EmulatorAuth        the local Firebase emulator (FIRESTORE_EMULATOR_HOST is set). `Bearer owner` bypasses rules there too.
  UserAuth            pretends to be a signed-in person, with a claims dict. Only the emulator accepts these (unsigned);
                      it is how the rules are tested.

Values: None, bool, int, float, str, bytes, datetime, list and dict map to Firestore's types and back.
"""

from __future__ import annotations

import base64
import json
import os
import subprocess
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

SCOPE = "https://www.googleapis.com/auth/datastore"
TOKEN_URL = "https://oauth2.googleapis.com/token"


class FirestoreError(RuntimeError):
    def __init__(self, status: int, message: str):
        super().__init__(f"Firestore {status}: {message}")
        self.status = status


# --- values -------------------------------------------------------------------------------------

def encode(v) -> dict:
    if v is None:
        return {"nullValue": None}
    if isinstance(v, bool):
        return {"booleanValue": v}
    if isinstance(v, int):
        return {"integerValue": str(v)}
    if isinstance(v, float):
        return {"doubleValue": v}
    if isinstance(v, str):
        return {"stringValue": v}
    if isinstance(v, (bytes, bytearray)):
        return {"bytesValue": base64.b64encode(bytes(v)).decode("ascii")}
    if isinstance(v, datetime):
        return {"timestampValue": (v if v.tzinfo else v.astimezone()).astimezone(timezone.utc).isoformat().replace("+00:00", "Z")}
    if isinstance(v, (list, tuple)):
        return {"arrayValue": {"values": [encode(x) for x in v]}}
    if isinstance(v, dict):
        return {"mapValue": {"fields": {str(k): encode(x) for k, x in v.items()}}}
    raise TypeError(f"Can't store a {type(v).__name__} in Firestore")


def decode(v: dict):
    if "nullValue" in v:
        return None
    if "booleanValue" in v:
        return v["booleanValue"]
    if "integerValue" in v:
        return int(v["integerValue"])
    if "doubleValue" in v:
        return float(v["doubleValue"])
    if "stringValue" in v:
        return v["stringValue"]
    if "bytesValue" in v:
        return base64.b64decode(v["bytesValue"])
    if "timestampValue" in v:
        return datetime.fromisoformat(v["timestampValue"].replace("Z", "+00:00"))
    if "arrayValue" in v:
        return [decode(x) for x in v["arrayValue"].get("values", [])]
    if "mapValue" in v:
        return {k: decode(x) for k, x in v["mapValue"].get("fields", {}).items()}
    return None


def _fields(doc: dict) -> dict:
    return {k: decode(v) for k, v in doc.get("fields", {}).items()}


# --- auth ---------------------------------------------------------------------------------------

def _b64url(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode("ascii")


class EmulatorAuth:
    def header(self) -> str:
        return "Bearer owner"


class UserAuth:
    """An unsigned token with these claims; only the emulator accepts it."""

    def __init__(self, uid: str, email: str | None = None, verified: bool = True, **extra):
        claims = {"user_id": uid, "sub": uid, "iat": int(time.time()), "exp": int(time.time()) + 3600,
                  "firebase": {"sign_in_provider": "google.com"}, **extra}
        if email:
            claims.update(email=email, email_verified=verified)
        self._token = f"{_b64url(b'{\"alg\":\"none\",\"typ\":\"JWT\"}')}.{_b64url(json.dumps(claims).encode())}."

    def header(self) -> str:
        return "Bearer " + self._token


class ServiceAccountAuth:
    def __init__(self, key_file: str | Path):
        info = json.loads(Path(key_file).expanduser().read_text())
        self.email, self._pem, self.project_id = info["client_email"], info["private_key"], info.get("project_id")
        self._token, self._until = "", 0.0

    def _sign(self, data: bytes) -> bytes:
        with tempfile.NamedTemporaryFile("w", suffix=".pem") as key:
            os.chmod(key.name, 0o600)
            key.write(self._pem)
            key.flush()
            return subprocess.run(["openssl", "dgst", "-sha256", "-sign", key.name], input=data, capture_output=True, check=True).stdout

    def header(self) -> str:
        if time.time() > self._until - 60:
            now = int(time.time())
            head = _b64url(json.dumps({"alg": "RS256", "typ": "JWT"}).encode())
            body = _b64url(json.dumps({"iss": self.email, "scope": SCOPE, "aud": TOKEN_URL, "iat": now, "exp": now + 3600}).encode())
            jwt = f"{head}.{body}.{_b64url(self._sign(f'{head}.{body}'.encode()))}"
            data = urllib.parse.urlencode({"grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer", "assertion": jwt}).encode()
            with urllib.request.urlopen(urllib.request.Request(TOKEN_URL, data=data), timeout=20) as r:
                out = json.loads(r.read())
            self._token, self._until = out["access_token"], time.time() + int(out.get("expires_in", 3600))
        return "Bearer " + self._token


def default_auth(key_file: str | Path | None = None):
    """The emulator if one is running, else the service account named by `key_file` or ANCHOR_SERVICE_ACCOUNT."""
    if os.environ.get("FIRESTORE_EMULATOR_HOST"):
        return EmulatorAuth()
    path = key_file or os.environ.get("ANCHOR_SERVICE_ACCOUNT")
    if not path:
        raise RuntimeError("No Firestore credentials. Pass --key-file, or set ANCHOR_SERVICE_ACCOUNT to your service-account key.")
    return ServiceAccountAuth(path)


# --- the client ---------------------------------------------------------------------------------

class Firestore:
    def __init__(self, project: str, auth=None, timeout: float = 30.0):
        self.project, self.auth, self.timeout = project, auth or default_auth(), timeout
        host = os.environ.get("FIRESTORE_EMULATOR_HOST")
        self.root = f"{'http://' + host if host else 'https://firestore.googleapis.com'}/v1/projects/{project}/databases/(default)/documents"

    def _call(self, method: str, url: str, body=None):
        data = None if body is None else json.dumps(body).encode()
        req = urllib.request.Request(url, data=data, method=method,
                                     headers={"Authorization": self.auth.header(), "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as r:
                raw = r.read()
                return json.loads(raw) if raw else {}
        except urllib.error.HTTPError as e:
            try:
                msg = json.loads(e.read())["error"]["message"]
            except Exception:
                msg = e.reason
            finally:
                e.close()
            raise FirestoreError(e.code, msg) from None

    @staticmethod
    def _quote(path: str) -> str:
        return "/".join(urllib.parse.quote(p, safe="") for p in path.strip("/").split("/"))

    def get(self, path: str) -> dict | None:
        try:
            return _fields(self._call("GET", f"{self.root}/{self._quote(path)}"))
        except FirestoreError as e:
            if e.status == 404:
                return None
            raise

    def set(self, path: str, data: dict) -> None:
        """Create the document, or replace it whole."""
        self._call("PATCH", f"{self.root}/{self._quote(path)}", {"fields": {k: encode(v) for k, v in data.items()}})

    def update(self, path: str, data: dict) -> None:
        """Change just these top-level fields (a value of None removes one). Creates the document if it is missing."""
        mask = "&".join("updateMask.fieldPaths=" + urllib.parse.quote(f"`{k}`", safe="") for k in data)
        self._call("PATCH", f"{self.root}/{self._quote(path)}?{mask}", {"fields": {k: encode(v) for k, v in data.items() if v is not None}})

    def touch(self, path: str, data: dict, server_time: str) -> None:
        """Write `data` into the document (merging) and set field `server_time` to Firestore's own clock."""
        name = f"projects/{self.project}/databases/(default)/documents/{path.strip('/')}"
        write = {"update": {"name": name, "fields": {k: encode(v) for k, v in data.items()}},
                 "updateMask": {"fieldPaths": [*data, server_time]},
                 "updateTransforms": [{"fieldPath": server_time, "setToServerValue": "REQUEST_TIME"}]}
        self._call("POST", f"{self.root.rsplit('/documents', 1)[0]}/documents:commit", {"writes": [write]})

    def delete(self, path: str) -> None:
        try:
            self._call("DELETE", f"{self.root}/{self._quote(path)}")
        except FirestoreError as e:
            if e.status != 404:
                raise

    def list(self, path: str, fields: list[str] | None = None) -> list[dict]:
        """Every document in a collection, each with its `_id`. `fields` limits what comes back (and is still billed as a read)."""
        out, token = [], None
        while True:
            q = {"pageSize": "300", **({"pageToken": token} if token else {})}
            qs = urllib.parse.urlencode(q) + "".join("&mask.fieldPaths=" + urllib.parse.quote(f) for f in fields or [])
            res = self._call("GET", f"{self.root}/{self._quote(path)}?{qs}")
            out += [{"_id": d["name"].rsplit("/", 1)[1], **_fields(d)} for d in res.get("documents", [])]
            token = res.get("nextPageToken")
            if not token:
                return out

    def query(self, parent: str, collection: str, field: str, op: str, value, fields: list[str] | None = None) -> list[dict]:
        """Documents in `parent/collection` where field <op> value. op is EQUAL, IN, ..."""
        q = {"from": [{"collectionId": collection}],
             "where": {"fieldFilter": {"field": {"fieldPath": field}, "op": op, "value": encode(value)}}}
        if fields:
            q["select"] = {"fields": [{"fieldPath": f} for f in fields]}
        res = self._call("POST", f"{self.root}/{self._quote(parent)}:runQuery" if parent else f"{self.root}:runQuery",
                         {"structuredQuery": q})
        return [{"_id": r["document"]["name"].rsplit("/", 1)[1], **_fields(r["document"])} for r in res if "document" in r]
