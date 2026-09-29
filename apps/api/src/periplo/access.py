"""Authorization and audit.

Two questions every state-affecting call answers, once identity and tenant
are known (:mod:`periplo.tenancy`): *may this happen* (the ``Authorizer``
port) and *who should know it happened* (the ``AuditSink`` port). Both are
composed behind :class:`Access`, the single object routers call.

The open-core defaults (:class:`SwitchAuthorizer`, :class:`LogAuditSink`)
implement single-tenant behaviour: ``PERIPLO_ETL_ALLOW_OPERATE``
gates operating ETLs, and audit events go to the structured log.

Every route asks in the same shape:

- a listing: ``require(action, WHOLE)``, then one :meth:`Access.visible` over its items;
- a single item: :meth:`Access.reveal`. With a plain ``Authorizer`` that is ``require``
  on the item, and a refusal answers ``403``. With a :class:`FilteringAuthorizer` it is
  ``require(action, WHOLE)``, then ``visible`` about the item alone, and a hidden item
  raises the route's own not-found error, byte-identical to one that does not exist.

A ``404`` only ever comes from filtering: a refusal is never remapped to one.

A product names its own actions with a dotted prefix of its own (``"shop.export"``), so
their values never collide with a core :class:`Action`; ``Access`` refuses one that does.
"""

from __future__ import annotations

import hashlib
from collections.abc import Awaitable, Callable, Collection, Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from enum import StrEnum
from typing import Any, Final, Literal, NoReturn, Protocol, TypeVar, runtime_checkable

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
- ``("run", run_id, etl)`` — one run and the deployment it belongs to, with ``etl``
  empty when the orchestrator cannot tell or the deployment is gone (:func:`run_target`);
- ``("table", database, table)`` — one catalog table (:func:`table_target`);
- ``("query", query_id)`` — one admitted query (:func:`query_target`).
"""

WHOLE: Final[Target] = ()


def etl_target(name: str) -> Target:
    return ("etl", name)


def run_target(run_id: str, etl: str = "") -> Target:
    return ("run", run_id, etl)


def table_target(database: str, table: str) -> Target:
    return ("table", database, table)


def query_target(query_id: str) -> Target:
    return ("query", query_id)


def etl_of(target: Target) -> str | None:
    """The deployment an ``etl`` or ``run`` target is about; ``None`` for any other target."""
    match target:
        case ("etl", name) | ("run", _, name):
            return name
        case _:
            return None


class Action(StrEnum):
    """The actions of the core. A product adds its own as another ``StrEnum``."""

    READ_CATALOG = "read_catalog"
    ADMIN_CATALOG = "admin_catalog"
    """The sources, their discovery reports and starting a discovery."""
    QUERY = "query"
    VIEW_ETL = "view_etl"
    OPERATE_ETL = "operate_etl"


_CORE_VALUES: Final = frozenset(action.value for action in Action)

STATE_CHANGING: Final = frozenset({Action.OPERATE_ETL})
"""Core actions a ``denied`` audit event is worth recording for from ``require``.

``Access.operate`` records every denial it meets, whatever the action.
"""


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


@dataclass(frozen=True, slots=True, kw_only=True)
class Justification:
    """What an ``Authorizer`` names as the reason it allowed an action."""

    grant: str
    """The grant that allowed it, recorded as ``grant`` in the detail of the audit events
    of ``Access.operate``."""


class Authorizer(Protocol):
    async def authorize(
        self, context: RequestContext, action: StrEnum, target: Target
    ) -> Justification | None:
        """Return to allow; raise loom ``Forbidden`` (or ``Denied``) to refuse.

        Anything else fails the request, never a silent allow. ``action`` is an
        :class:`Action` or a product's own ``StrEnum``. ``target`` follows the
        :data:`Target` convention; ``()`` asks whether the action is allowed at
        all. A run target carries its deployment, or ``""`` when it is not known: deny
        ``""`` unless runs without a deployment are granted explicitly. Keeping the run
        within the tenant is the ``OrchestratorProvider``'s job.

        Returns:
            The :class:`Justification` of the action, or ``None``.
        """
        ...


@runtime_checkable
class FilteringAuthorizer(Authorizer, Protocol):
    """An :class:`Authorizer` that can also tell which items of a collection are visible."""

    async def visible(
        self, context: RequestContext, action: StrEnum, targets: Sequence[Target]
    ) -> Collection[Target]:
        """The *targets* the caller may see, asked once for the whole collection.

        Only asked once ``authorize(context, action, WHOLE)`` has allowed the action.
        Raise like ``authorize`` to refuse the collection as a whole. Anything not
        among *targets* in the answer is ignored.
        """
        ...


class SwitchAuthorizer:
    """Default :class:`Authorizer`: the single-tenant ``allow_operate`` switch."""

    def __init__(self, *, allow_operate: bool) -> None:
        self._allow_operate = allow_operate

    async def authorize(self, context: RequestContext, action: StrEnum, target: Target) -> None:
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
    action: str
    """The :class:`Action` or product ``StrEnum`` member itself, encoded as its value."""
    target: Target
    outcome: Outcome
    detail: dict[str, str | int] = {}
    """``run_id`` | normalized ``sql``, ``query_id``, ``state``, ``rows``, ``bytes``, ``code``,
    and ``grant``, from the :class:`Justification` the authorizer named.

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
    action: StrEnum,
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


async def _shown(
    authorizer: FilteringAuthorizer,
    context: RequestContext,
    action: StrEnum,
    targets: Sequence[Target],
) -> list[Target]:
    """*targets* the authorizer's ``visible`` keeps, in their order and never more."""
    answer = set(await authorizer.visible(context, action, targets))
    return [target for target in targets if target in answer]


def _vet(action: StrEnum) -> StrEnum:
    """*action*; raises ``TypeError`` for anything but a ``StrEnum`` member, and
    ``ValueError`` for a product action whose value a core :class:`Action` has."""
    if not isinstance(action, StrEnum):
        raise TypeError(f"An action must be a StrEnum member, not {type(action).__name__}")
    if not isinstance(action, Action) and action.value in _CORE_VALUES:
        raise ValueError(f"{action!r} has the value of a core action: prefix it with a namespace")
    return action


class Access:
    """The one object routers call to authorize an action and audit it."""

    def __init__(self, authorizer: Authorizer, audit: AuditSink) -> None:
        self._authorizer = authorizer
        self._filter = authorizer if isinstance(authorizer, FilteringAuthorizer) else None
        self._audit = audit

    async def require(self, action: StrEnum, target: Target = WHOLE) -> RequestContext:
        """Authorize *action* for the current request, or raise a denial.

        Any loom ``Forbidden`` is re-raised through :func:`as_403` and any
        ``Unauthenticated`` through :func:`as_401`, so each answers the same status on
        every surface.
        """
        context = current_context()
        await self._authorize(context, action, target)
        return context

    async def visible(self, action: StrEnum, targets: Sequence[Target]) -> list[Target]:
        """The *targets* the current request may see, in their order.

        Without a :class:`FilteringAuthorizer` every target, and the authorizer is not
        asked: the listing's own ``require(action, WHOLE)`` already decided. With one,
        a single ``visible`` call; its answer is kept only where it names one of
        *targets*. Refusals are mapped as in :meth:`require`; any other exception
        propagates.
        """
        _vet(action)
        if self._filter is None:
            return list(targets)
        context = current_context()
        try:
            return await _shown(self._filter, context, action, targets)
        except (Forbidden, Unauthenticated) as error:
            await self._refuse(context, action, WHOLE, error)

    async def reveal(
        self, action: StrEnum, target: Target, *, hidden: Callable[[], Exception]
    ) -> RequestContext:
        """Authorize *action* on one item, or raise: a denial, or ``hidden()`` when hidden.

        Without a :class:`FilteringAuthorizer` this is :meth:`require` on *target*. With
        one, :meth:`require` on the whole resource, then :meth:`visible` on *target*.

        Returns:
            The request's context.
        """
        if self._filter is None:
            return await self.require(action, target)
        context = await self.require(action, WHOLE)
        if not await self.visible(action, [target]):
            raise hidden()
        return context

    async def allows(self, action: StrEnum) -> bool:
        """Whether *action* would be authorized on the whole resource, without raising.

        A ``Forbidden``/``Unauthenticated`` denial answers ``False``; any
        other exception propagates: a broken authorizer is an error, not a ``False``.
        """
        _vet(action)
        context = current_context()
        try:
            await self._authorizer.authorize(context, action, WHOLE)
        except (Forbidden, Unauthenticated):
            return False
        return True

    async def operate(
        self,
        action: StrEnum,
        target: Target,
        work: Callable[[], Awaitable[_T]],
        *,
        describe: Callable[[_T], Mapping[str, str]] = lambda _: {},
    ) -> _T:
        """Authorize, audit and perform a state-changing action, of the core or a product.

        1. Authorization as in ``require``; a denial is audited (best-effort) for any
           action and re-raised.
        2. The ``requested`` event, *not* captured and time-bounded: a sink that
           fails or runs out of time stops the action before ``work`` ever runs:
           an action that cannot be audited must not happen.
        3. ``work()``.
        4. A best-effort, shielded and time-bounded outcome event:
           ``succeeded``; ``failed`` with the failure's ``code`` when it has
           one; or ``cancelled`` when the request was cancelled mid-action.
           A ``describe`` that breaks is logged and the action still counts
           as ``succeeded``: it has already happened.

        Every event carries the authorizer's grant, when it named one, as ``grant``.
        """
        context = current_context()
        justification = await self._authorize(context, action, target, always=True)
        granted: dict[str, str] = {} if justification is None else {"grant": justification.grant}
        try:
            with anyio.fail_after(AUDIT_WRITE_TIMEOUT_SECONDS):
                await self._audit.record(_event(context, action, target, "requested", granted))
        except TimeoutError:
            _log.error("audit.write_timeout", action=str(action), outcome="requested")
            raise
        try:
            result = await work()
        except Exception as error:
            code = getattr(error, "code", "unexpected")
            await self.record_shielded(
                _event(context, action, target, "failed", {"code": code, **granted})
            )
            raise
        except BaseException:
            await self.record_shielded(_event(context, action, target, "cancelled", granted))
            raise
        described = self._describe(describe, result, action)
        await self.record_shielded(
            _event(context, action, target, "succeeded", {**described, **granted})
        )
        return result

    async def operate_revealed(
        self,
        view: StrEnum,
        action: StrEnum,
        target: Target,
        work: Callable[[], Awaitable[_T]],
        *,
        hidden: Callable[[], Exception],
        describe: Callable[[_T], Mapping[str, str]] = lambda _: {},
    ) -> _T:
        """:meth:`operate` on an item the caller must also be allowed to *view*.

        Without a :class:`FilteringAuthorizer` this is :meth:`operate`. With one, *view*
        is authorized on the whole resource and *target* must be visible to it first:
        a refusal is audited as a denied *action* and re-raised, and a hidden item is
        audited as a denied *action* with the code ``hidden`` before ``hidden()`` is
        raised.
        """
        _vet(action)
        if self._filter is not None:
            await self._reveal_to_operate(self._filter, view, action, target, hidden)
        return await self.operate(action, target, work, describe=describe)

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

    async def _reveal_to_operate(
        self,
        authorizer: FilteringAuthorizer,
        view: StrEnum,
        action: StrEnum,
        target: Target,
        hidden: Callable[[], Exception],
    ) -> None:
        """Raise unless *target* is visible under *view*, auditing a refusal or a hidden
        item as a denied *action*."""
        context = current_context()
        try:
            await authorizer.authorize(context, _vet(view), WHOLE)
            shown = await _shown(authorizer, context, view, [target])
        except (Forbidden, Unauthenticated) as error:
            await self._refuse(context, action, target, error, always=True)
        if not shown:
            await self._record_denied(context, action, target, "hidden", always=True)
            raise hidden()

    async def _authorize(
        self, context: RequestContext, action: StrEnum, target: Target, *, always: bool = False
    ) -> Justification | None:
        """The authorizer's grant for *action*, or its refusal re-raised through ``_refuse``."""
        _vet(action)
        try:
            return await self._authorizer.authorize(context, action, target)
        except (Forbidden, Unauthenticated) as error:
            await self._refuse(context, action, target, error, always=always)

    async def _refuse(
        self,
        context: RequestContext,
        action: StrEnum,
        target: Target,
        error: Forbidden | Unauthenticated,
        *,
        always: bool = False,
    ) -> NoReturn:
        """Audit *error* when it is worth it, then raise it with the status it must answer."""
        refusal = as_403(error) if isinstance(error, Forbidden) else as_401(error)
        await self._record_denied(context, action, target, refusal.code, always=always)
        if refusal is error:
            raise error
        raise refusal from error

    async def _record_denied(
        self,
        context: RequestContext,
        action: StrEnum,
        target: Target,
        code: str,
        *,
        always: bool = False,
    ) -> None:
        if always or action in STATE_CHANGING:
            await self.record_best_effort(_event(context, action, target, "denied", {"code": code}))

    @staticmethod
    def _describe(
        describe: Callable[[_T], Mapping[str, str]], result: _T, action: StrEnum
    ) -> Mapping[str, str]:
        try:
            return describe(result)
        except Exception as error:
            _log.error("audit.describe_failed", error=type(error).__name__, action=str(action))
            return {}
