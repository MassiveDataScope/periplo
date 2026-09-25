"""Errors of Periplo that Loom's REST adapter turns into HTTP answers.

Loom maps a ``LoomError`` to a status by its ``code`` (``HttpErrorMapper``); a code it
does not know becomes a 500. The two conditions below are not failures of the server,
so they get their own codes and statuses, registered in the mapper at import time:
Loom 2.1 offers no other hook, and the mapper's table is a plain class-level dict.
"""

from __future__ import annotations

from fastapi.responses import JSONResponse
from loom.core.errors import Forbidden, LoomError, Unauthenticated
from loom.rest.errors import HttpErrorMapper

NOT_READY = "not_ready"
TABLE_UNREADABLE = "table_unreadable"
ETL_OPERATE_DISABLED = "etl_operate_disabled"


class NotReady(LoomError):
    """The first discovery has not published a catalog yet: retry shortly (503)."""

    def __init__(self) -> None:
        super().__init__("The first discovery has not finished yet", code=NOT_READY)


class TableUnavailable(LoomError):
    """Storage refused or broke while reading a table's log: an upstream failure (502).

    The message must already be safe to show; the cause stays in the server log.
    """

    def __init__(self, message: str) -> None:
        super().__init__(message, code=TABLE_UNREADABLE)


HttpErrorMapper._STATUS.setdefault(NOT_READY, 503)
HttpErrorMapper._STATUS.setdefault(TABLE_UNREADABLE, 502)
HttpErrorMapper._STATUS.setdefault(ETL_OPERATE_DISABLED, 403)


def denial_response(error: Forbidden | Unauthenticated) -> JSONResponse:
    """A denial from ``Access``, in the envelope the ETL and queries routers answer with.

    Those routers build their own responses (Loom's mapper only acts inside its
    ``RestInterface``), so they share this one translation to keep one error shape.
    """
    status = HttpErrorMapper._STATUS.get(error.code, 403)
    return JSONResponse(
        {"detail": {"code": error.code, "message": error.message, "retryable": False}},
        status_code=status,
    )
