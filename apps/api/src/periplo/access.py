"""Authorization and audit.

Two questions every state-affecting call answers, once identity and tenant
are known (:mod:`periplo.tenancy`): *may this happen* (the ``Authorizer``
port) and *who should know it happened* (the ``AuditSink`` port). Both are
composed behind :class:`Access`, the single object routers call.

The open-core defaults (:class:`SwitchAuthorizer`, :class:`LogAuditSink`)
implement single-tenant behaviour: ``PERIPLO_ETL_ALLOW_OPERATE``
gates operating ETLs, and audit events go to the structured log.
"""

from __future__ import annotations

import hashlib
from collections.abc import Awaitable, Callable, Mapping
from datetime import UTC, datetime
from enum import StrEnum
from typing import Any, Final, Literal, Protocol, TypeVar

import anyio
import msgspec
from loom.core.errors import Forbidden, Unauthenticated
from loom.core.logger import get_logger
from loom.rest.errors import HttpErrorMapper

from periplo.tenancy import RequestContext, current_context, require_default_tenant

_log = get_logger(__name__)

_T = TypeVar("_T")

AUDIT_WRITE_TIMEOUT_SECONDS: Final = 5.0
"""How long any audit write may take; see ``Access.operate`` and ``Access._record``."""

Outcome = Literal["requested", "succeeded", "failed", "cancelled", "denied"]

Target = tuple[str, ...]
"""What an action is about, as an ``Authorizer`` receives it.

The convention, shared by every route and by any private ``Authorizer``:

- ``()`` — the resource as a whole (list ETLs, read the catalog, run a query);
- ``("etl", name)`` — one deployment (:func:`etl_target`);
- ``("run", run_id)`` — one run (:func:`run_target`);
- ``("table", database, table)`` — one catalog table (:func:`table_target`);
- ``("query", query_id)`` — one admitted query (:func:`query_target`).
"""

WHOLE: Final[Target] = ()


def etl_target(name: str) -> Target:
    return ("etl", name)


def run_target(run_id: str) -> Target:
    return ("run", run_id)


def table_target(database: str, table: str) -> Target:
    return ("table", database, table)


def query_target(query_id: str) -> Target:
    return ("query", query_id)


class Action(StrEnum):
    READ_CATALOG = "read_catalog"
    QUERY = "query"
    VIEW_ETL = "view_etl"
    OPERATE_ETL = "operate_etl"


STATE_CHANGING: Final = frozenset({Action.OPERATE_ETL})
"""Actions a ``denied`` audit event is worth recording for: the state-changing ones."""


class Denied(Forbidden):
    """Raised by an ``Authorizer`` to refuse an action, with a caller-chosen ``code``.

    ``code`` must map to ``403`` in :class:`~loom.rest.errors.HttpErrorMapper`: either
    it already does (a code shared with another ``Denied``), or this registers it.
    A code already mapped to a different status is a programming error, not a request
    to relax that other mapping. Registration is process-global and permanent.
    """

    def __init__(
        self, message: str = "You are not allowed to do this", *, code: str = "forbidden"
    ) -> None:
        super().__init__(message)
        self.code = code
        status = HttpErrorMapper._STATUS.get(code, 403)
        if status != 403:
            raise ValueError(f"{code!r} is already mapped to {status}, not 403")
        HttpErrorMapper._STATUS.setdefault(code, 403)


def as_403(error: Forbidden) -> Forbidden:
    """*error* itself when its ``code`` answers ``403``, else a ``Denied`` that does.

    A ``Forbidden`` whose code Loom's mapper does not know would end in ``500`` on
    the catalog, and one whose code maps elsewhere (say ``not_found``) would answer
    that status: every surface must answer a refusal the same way, with ``403``.
    An unregistered code is kept (``Denied`` registers it, process-global and
    permanent); one already mapped to another status is replaced by the generic
    ``forbidden``.
    """
    status = HttpErrorMapper._STATUS.get(error.code)
    if status == 403:
        return error
    if status is None:
        return Denied(error.message, code=error.code)
    return Denied(error.message)


def as_401(error: Unauthenticated) -> Unauthenticated:
    """*error* itself when its ``code`` answers ``401``, else one that does.

    The counterpart of :func:`as_403`: an unregistered code is registered as ``401``
    (process-global and permanent, like ``Denied``) and kept; one already mapped to
    another status is replaced by the generic ``unauthenticated``.
    """
    status = HttpErrorMapper._STATUS.get(error.code)
    if status == 401:
        return error
    if status is None:
        HttpErrorMapper._STATUS.setdefault(error.code, 401)
        return error
    return Unauthenticated(error.message)


class Authorizer(Protocol):
    async def authorize(self, context: RequestContext, action: Action, target: Target) -> None:
        """Return to allow; raise loom ``Forbidden`` (or ``Denied``) to refuse.

        Anything else fails the request, never a silent allow. ``target`` follows the
        :data:`Target` convention; ``()`` asks whether the action is allowed at
        all. For run routes (``("run", run_id)``) the authorizer is not told
        which deployment the run belongs to: resolving a run to its ETL, and
        keeping it within the tenant, is the ``OrchestratorProvider``'s job.
        """
        ...


class SwitchAuthorizer:
    """Default :class:`Authorizer`: the single-tenant ``allow_operate`` switch."""

    def __init__(self, *, allow_operate: bool) -> None:
        self._allow_operate = allow_operate

    async def authorize(self, context: RequestContext, action: Action, target: Target) -> None:
        # A single-tenant default is a boundary: another tenant is a composition
        # error, never a request it can decide on.
        require_default_tenant(context)
        if action is Action.OPERATE_ETL and not self._allow_operate:
            raise Denied(
                "Operating ETLs is disabled for this installation", code="etl_operate_disabled"
            )


class AuditEvent(msgspec.Struct, frozen=True, kw_only=True):
    """One fact worth keeping about a state-changing or denied action."""

    at: datetime
    tenant: str
    subject: str
    action: Action
    target: Target
    outcome: Outcome
    detail: dict[str, str | int] = {}
    """``run_id`` | normalized ``sql``, ``query_id``, ``state``, ``rows``, ``bytes``, ``code``.

    Never row data.
    """


class AuditSink(Protocol):
    async def record(self, event: AuditEvent) -> None:
        """Raise when the event could not be stored."""
        ...


class LogAuditSink:
    """Default :class:`AuditSink`: a structured log line, for any tenant.

    Never logs a full SQL statement: only its ``sql_sha256`` and the first
    512 normalized characters. ``AuditEvent.detail`` itself keeps the
    full normalized SQL, for private sinks that need it.
    """

    async def record(self, event: AuditEvent) -> None:
        detail: dict[str, Any] = dict(event.detail)
        sql = detail.pop("sql", None)
        fields: dict[str, Any] = {
            "tenant": event.tenant,
            "subject": event.subject,
            "action": str(event.action),
            "target": event.target,
            "outcome": event.outcome,
            **detail,
        }
        if isinstance(sql, str):
            fields["sql_sha256"] = hashlib.sha256(sql.encode()).hexdigest()
            fields["sql"] = sql[:512]
        _log.info("audit", **fields)


def _event(
    context: RequestContext,
    action: Action,
    target: Target,
    outcome: Outcome,
    detail: Mapping[str, str | int] | None = None,
) -> AuditEvent:
    return AuditEvent(
        at=datetime.now(UTC),
        tenant=context.tenant.id,
        subject=context.identity.subject,
        action=action,
        target=target,
        outcome=outcome,
        detail=dict(detail) if detail else {},
    )


class Access:
    """The one object routers call to authorize an action and audit it."""

    def __init__(self, authorizer: Authorizer, audit: AuditSink) -> None:
        self._authorizer = authorizer
        self._audit = audit

    async def require(
        self, action: Action, target: Target = WHOLE, *, data_plane: bool = False
    ) -> RequestContext:
        """Authorize *action* for the current request, or raise a denial.

        Any loom ``Forbidden`` is re-raised through :func:`as_403` and any
        ``Unauthenticated`` through :func:`as_401`, so each answers the same status on
        every surface. ``data_plane=True`` guards a global data plane
        still shared by every tenant (catalog reads, query execution): it fails
        for any tenant but the single default one, before ``authorize`` is even
        asked.
        """
        context = current_context()
        if data_plane:
            require_default_tenant(context)
        try:
            await self._authorizer.authorize(context, action, target)
        except Forbidden as error:
            denial = as_403(error)
            await self._record_denied(context, action, target, denial.code)
            if denial is error:
                raise
            raise denial from error
        except Unauthenticated as error:
            refusal = as_401(error)
            await self._record_denied(context, action, target, refusal.code)
            if refusal is error:
                raise
            raise refusal from error
        return context

    async def allows(self, action: Action) -> bool:
        """Whether *action* would be authorized on the whole resource, without raising.

        A ``Forbidden``/``Unauthenticated`` denial answers ``False``; any
        other exception propagates: a broken authorizer is an error, not a ``False``.
        """
        context = current_context()
        try:
            await self._authorizer.authorize(context, action, WHOLE)
        except (Forbidden, Unauthenticated):
            return False
        return True

    async def operate(
        self,
        action: Action,
        target: Target,
        work: Callable[[], Awaitable[_T]],
        *,
        describe: Callable[[_T], Mapping[str, str]] = lambda _: {},
    ) -> _T:
        """Authorize, audit and perform a state-changing action.

        1. ``require`` — a denial is audited (best-effort) and re-raised.
        2. The ``requested`` event, *not* captured and time-bounded: a sink that
           fails or runs out of time stops the action before ``work`` ever runs:
           an action that cannot be audited must not happen.
        3. ``work()``.
        4. A best-effort, shielded and time-bounded outcome event:
           ``succeeded``; ``failed`` with the failure's ``code`` when it has
           one; or ``cancelled`` when the request was cancelled mid-action.
           A ``describe`` that breaks is logged and the action still counts
           as ``succeeded``: it has already happened.
        """
        context = await self.require(action, target)
        try:
            with anyio.fail_after(AUDIT_WRITE_TIMEOUT_SECONDS):
                await self._audit.record(_event(context, action, target, "requested"))
        except TimeoutError:
            _log.error("audit.write_timeout", action=str(action), outcome="requested")
            raise
        try:
            result = await work()
        except Exception as error:
            code = getattr(error, "code", "unexpected")
            await self.record_shielded(_event(context, action, target, "failed", {"code": code}))
            raise
        except BaseException:
            await self.record_shielded(_event(context, action, target, "cancelled"))
            raise
        await self.record_shielded(
            _event(context, action, target, "succeeded", self._describe(describe, result, action))
        )
        return result

    async def record_best_effort(self, event: AuditEvent) -> None:
        """Record *event* for a bounded time, logging (never raising) when the sink fails.

        Unshielded: a request that is already cancelled may cut the write short.
        """
        await self._record(event, shield=False)

    async def record_shielded(self, event: AuditEvent) -> None:
        """Record *event* best-effort, even from a cancelled request, for a bounded time.

        Shielded so a disconnect or cancellation still leaves the event; bounded by
        :data:`AUDIT_WRITE_TIMEOUT_SECONDS` so a hung sink never holds the request
        (or its query slot) forever.
        """
        await self._record(event, shield=True)

    async def _record(self, event: AuditEvent, *, shield: bool) -> None:
        with anyio.move_on_after(AUDIT_WRITE_TIMEOUT_SECONDS, shield=shield) as scope:
            try:
                await self._audit.record(event)
            except Exception as error:
                _log.error(
                    "audit.write_failed",
                    error=type(error).__name__,
                    action=str(event.action),
                    outcome=event.outcome,
                )
        if scope.cancelled_caught:
            _log.error("audit.write_timeout", action=str(event.action), outcome=event.outcome)

    async def _record_denied(
        self, context: RequestContext, action: Action, target: Target, code: str
    ) -> None:
        if action in STATE_CHANGING:
            await self.record_best_effort(_event(context, action, target, "denied", {"code": code}))

    @staticmethod
    def _describe(
        describe: Callable[[_T], Mapping[str, str]], result: _T, action: Action
    ) -> Mapping[str, str]:
        try:
            return describe(result)
        except Exception as error:
            _log.error("audit.describe_failed", error=type(error).__name__, action=str(action))
            return {}
