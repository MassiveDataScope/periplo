"""An empty S3 bucket in a process of its own, reporting the key id that signed each request.

Its own process, so a request that holds the interpreter while it waits for storage can
still be answered. Run as a script, it prints ``port <n>`` once it listens, then one
``signed <key id>`` line per request.
"""

from __future__ import annotations

import re
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

_EMPTY_LISTING = (
    b'<?xml version="1.0" encoding="UTF-8"?>'
    b'<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">'
    b"<Name>lake</Name><Prefix></Prefix><KeyCount>0</KeyCount><MaxKeys>1000</MaxKeys>"
    b"<IsTruncated>false</IsTruncated></ListBucketResult>"
)


class _EmptyBucket(BaseHTTPRequestHandler):
    """Lists nothing and finds no object, after reporting who signed the request."""

    def do_GET(self) -> None:
        self._report()
        self.send_response(200)
        self.send_header("Content-Type", "application/xml")
        self.send_header("Content-Length", str(len(_EMPTY_LISTING)))
        self.end_headers()
        self.wfile.write(_EMPTY_LISTING)

    def do_HEAD(self) -> None:
        self._report()
        self.send_response(404)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _report(self) -> None:
        match = re.search(r"Credential=([^/]+)/", self.headers.get("Authorization", ""))
        print(f"signed {match.group(1) if match else 'unsigned'}", flush=True)

    def log_message(self, format: str, *args: object) -> None:
        return None


class FakeS3:
    """The bucket's process: its endpoint, and every key id that has signed a request."""

    def __init__(self) -> None:
        self._process = subprocess.Popen(
            [sys.executable, __file__], stdout=subprocess.PIPE, text=True
        )
        assert self._process.stdout is not None
        self._lines = self._process.stdout
        port = self._lines.readline().split()[1]
        self.endpoint = f"http://127.0.0.1:{port}"
        self._signed: list[str] = []
        self._lock = threading.Lock()
        threading.Thread(target=self._read, daemon=True).start()

    def signed(self, *, settle: float = 0.2) -> list[str]:
        """The key ids so far, once no report has arrived for *settle* seconds."""
        seen = -1
        while seen != len(self._copy()):
            seen = len(self._copy())
            time.sleep(settle)
        return self._copy()

    def close(self) -> None:
        self._process.terminate()
        self._process.wait(timeout=5)

    def _copy(self) -> list[str]:
        with self._lock:
            return list(self._signed)

    def _read(self) -> None:
        for line in self._lines:
            with self._lock:
                self._signed.append(line.split()[1])


if __name__ == "__main__":
    server = ThreadingHTTPServer(("127.0.0.1", 0), _EmptyBucket)
    print(f"port {server.server_port}", flush=True)
    server.serve_forever()
