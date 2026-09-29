"""The built web console, served by the API process when ``PERIPLO_WEB_DIR`` names it.

One process answers both, and the console stays same-origin with the API it calls.
It is mounted after every API route, so it only answers what nothing else did: a
path under ``/api`` or ``/health`` that no route matches keeps being the API's 404,
never the console's page.
"""

from __future__ import annotations

import mimetypes
import os
from pathlib import Path

from loom.core.config import ConfigError
from starlette.datastructures import Headers
from starlette.exceptions import HTTPException
from starlette.responses import FileResponse, Response
from starlette.staticfiles import NotModifiedResponse, StaticFiles
from starlette.types import Scope

INDEX = "index.html"
HASHED = "assets"
"""Vite's output folder: every name in it carries a content hash."""
RESERVED = frozenset({"api", "health"})
"""First path segments that belong to the API, whether or not a route matches."""

IMMUTABLE = "public, max-age=31536000, immutable"
REVALIDATE = "no-cache"

ENCODINGS = (("br", ".br"), ("gzip", ".gz"))
"""Precompressed siblings the build may leave next to a file, in order of preference."""


class WebConsole(StaticFiles):
    """Static files of the single-page console, with the page as fallback for its routes."""

    def __init__(self, directory: Path) -> None:
        if not (directory / INDEX).is_file():
            raise ConfigError(f"PERIPLO_WEB_DIR: {directory} has no {INDEX}")
        super().__init__(directory=directory)
        self._root = directory.resolve()
        # The build output does not change while the process runs: listing the
        # compressed siblings once spares a stat per request and encoding.
        self._compressed = frozenset(
            str(path.relative_to(self._root))
            for path in self._root.rglob("*")
            if path.suffix in {suffix for _, suffix in ENCODINGS} and path.is_file()
        )

    async def get_response(self, path: str, scope: Scope) -> Response:
        try:
            response = await super().get_response(path, scope)
            served = path
        except HTTPException as error:
            if error.status_code != 404 or not _is_page(path):
                raise
            response = await super().get_response(INDEX, scope)
            served = INDEX
        response.headers["cache-control"] = (
            IMMUTABLE if Path(served).parts[:1] == (HASHED,) else REVALIDATE
        )
        return response

    def file_response(
        self,
        full_path: str | os.PathLike[str],
        stat_result: os.stat_result,
        scope: Scope,
        status_code: int = 200,
    ) -> Response:
        relative = str(Path(full_path).relative_to(self._root))
        variants = [(e, relative + s) for e, s in ENCODINGS if relative + s in self._compressed]
        if not variants:
            return super().file_response(full_path, stat_result, scope, status_code)
        request_headers = Headers(scope=scope)
        accepted = _accepted_encodings(request_headers.get("accept-encoding", ""))
        encoding, variant = next(((e, v) for e, v in variants if e in accepted), (None, relative))
        target = self._root / variant
        response = FileResponse(
            target,
            status_code=status_code,
            stat_result=stat_result if encoding is None else target.stat(),
            media_type=mimetypes.guess_type(relative)[0] or "application/octet-stream",
        )
        # Every answer for this path depends on the header, compressed or not.
        response.headers["vary"] = "Accept-Encoding"
        if encoding is not None:
            response.headers["content-encoding"] = encoding
        if self.is_not_modified(response.headers, request_headers):
            return NotModifiedResponse(response.headers)
        return response


def _is_page(path: str) -> bool:
    # A missing file (a stale chunk after a deploy) must fail as a 404, not come back as
    # HTML that the browser would try to run; only extension-less paths are pages.
    parts = Path(path).parts
    if not parts or parts == (".",):
        return True
    return parts[0] not in RESERVED | {HASHED} and "." not in parts[-1]


def _accepted_encodings(header: str) -> frozenset[str]:
    accepted = set()
    for token in header.split(","):
        name, _, params = token.strip().partition(";")
        quality = params.strip().removeprefix("q=")
        if name and not (params and _is_zero(quality)):
            accepted.add(name.strip().lower())
    return frozenset(accepted)


def _is_zero(quality: str) -> bool:
    try:
        return float(quality) == 0
    except ValueError:
        return False
