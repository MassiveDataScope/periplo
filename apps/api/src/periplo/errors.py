"""Errors of Periplo that Loom's REST adapter turns into HTTP answers.

Loom maps a ``LoomError`` to a status by its ``code`` (``HttpErrorMapper``); a code it
does not know becomes a 500. The conditions below get their own codes and statuses,
registered in the mapper at import time.
"""

from __future__ import annotations

from fastapi.responses import JSONResponse
from loom.core.errors import Forbidden, LoomError, Unauthenticated
from loom.rest.errors import HttpErrorMapper

NOT_READY = "not_ready"
TABLE_UNREADABLE = "table_unreadable"
ETL_OPERATE_DISABLED = "etl_operate_disabled"
CREDENTIALS_UNAVAILABLE = "credentials_unavailable"
CREDENTIALS_FAILED = "credentials_failed"
TIMEOUT = "timeout"


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


class CredentialsUnavailable(LoomError):
    """A tenant's storage credentials are missing or unusable: retry shortly (503).

    Raised by a ``CredentialsProvider`` that has none to give, and by Periplo for
    credentials it will not read with. The message must already be safe to show.
    """

    def __init__(self, message: str = "Storage credentials are not available right now") -> None:
        super().__init__(message, code=CREDENTIALS_UNAVAILABLE)


class CredentialsTimeout(LoomError):
    """The credentials provider took longer than a read may wait (504)."""

    def __init__(self, seconds: float) -> None:
        super().__init__(f"Storage credentials took longer than {seconds:g} s", code=TIMEOUT)


class CredentialsFailed(LoomError):
    """The credentials provider broke; its own error stays out of the answer (500)."""

    def __init__(self) -> None:
        super().__init__("Storage credentials could not be obtained", code=CREDENTIALS_FAILED)


HttpErrorMapper._STATUS.setdefault(NOT_READY, 503)
HttpErrorMapper._STATUS.setdefault(TABLE_UNREADABLE, 502)
HttpErrorMapper._STATUS.setdefault(ETL_OPERATE_DISABLED, 403)
HttpErrorMapper._STATUS.setdefault(CREDENTIALS_UNAVAILABLE, 503)
HttpErrorMapper._STATUS.setdefault(TIMEOUT, 504)
HttpErrorMapper._STATUS.setdefault(CREDENTIALS_FAILED, 500)


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
