"""Errors of the ETL integration, answered by its own router.

They are not ``LoomError`` subclasses on purpose: Loom's error mapper only acts inside
its ``RestInterface``, and the ETL routes are a plain FastAPI router (like the queries
router), so it is the router that turns ``status``, ``code`` and ``retryable`` into the
HTTP envelope. Messages must already be safe to show: never a host, a key or a raw body.
"""

from __future__ import annotations


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
    """The deployment or run does not exist, or lies outside the configured tags (404)."""

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
    """The orchestrator refused the request itself, e.g. invalid parameters (400)."""

    status = 400
    code = "etl_rejected"


class Busy(EtlError):
    """Too many orchestrator requests are already in flight in this process (503)."""

    status = 503
    code = "etl_busy"

    def __init__(self) -> None:
        super().__init__("ETL requests are queued, try again shortly", retryable=True)
