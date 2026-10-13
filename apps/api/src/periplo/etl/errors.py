"""Errors of the ETL integration, answered by its own router.

They are not ``LoomError`` subclasses: Loom's error mapper only acts inside its
``RestInterface``, and the ETL routes are a plain FastAPI router (like the queries
router), so it is the router that turns ``status``, ``code`` and ``retryable`` into the
HTTP envelope. Messages must already be safe to show: never a host, a key or a raw body.
"""

from __future__ import annotations

from typing import Final

RUN_NOT_KNOWN: Final = "Run {run_id} is not known"
"""The message of ``Unknown`` for a run, filled with ``run_id``."""
ETL_NOT_KNOWN: Final = "ETL {name} is not known"
"""The message of ``Unknown`` for a deployment, filled with ``name``."""


class EtlError(Exception):
    """Base of the ETL errors; subclasses fix ``status`` and ``code`` as class attributes."""

    status: int
    code: str
    message: str
    retryable: bool

    def __init__(self, message: str, *, retryable: bool = False) -> None:
        super().__init__(message)
        self.message = message
        self.retryable = retryable


class NotConfigured(EtlError):
    """The orchestrator's base URL is unset for this installation (404)."""

    status = 404
    code = "etl_not_configured"

    def __init__(self) -> None:
        super().__init__("The ETL orchestrator is not configured for this installation")


class Unknown(EtlError):
    """The deployment or run does not exist, lies outside the tags, or is hidden (404).

    A hidden one answers the same :data:`RUN_NOT_KNOWN` or :data:`ETL_NOT_KNOWN` message.
    """

    status = 404
    code = "not_found"


class Ambiguous(EtlError):
    """More than one deployment answers to the name (409)."""

    status = 409
    code = "etl_ambiguous"


class Upstream(EtlError):
    """The orchestrator failed, timed out or rejected the credential (502).

    Retryable by default; a rejected credential is not.
    """

    status = 502
    code = "etl_upstream"

    def __init__(self, message: str, *, retryable: bool = True) -> None:
        super().__init__(message, retryable=retryable)


class Rejected(EtlError):
    """The orchestrator refused the request itself, e.g. invalid parameters (400).

    ``upstream_status`` is the orchestrator's own status, when it answered one (a 422 for
    a field it does not know); never part of the response.
    """

    status = 400
    code = "etl_rejected"

    def __init__(self, message: str, *, upstream_status: int | None = None) -> None:
        super().__init__(message)
        self.upstream_status = upstream_status


class Busy(EtlError):
    """Too many orchestrator requests are already in flight in this process (503)."""

    status = 503
    code = "etl_busy"

    def __init__(self) -> None:
        super().__init__("ETL requests are queued, try again shortly", retryable=True)


class NotCancellable(EtlError):
    """The run cannot be cancelled in its current state (409): it has finished, it is
    already being cancelled, or it is not stuck cancelling long enough to force."""

    status = 409
    code = "etl_run_not_cancellable"


class NotRetryable(EtlError):
    """The run cannot be retried (409): only a failed or crashed run of a deployment can."""

    status = 409
    code = "etl_run_not_retryable"
