"""A toy "cloud product" built on periplo's public ports.

Everything here plugs into :class:`periplo.extensions.Extensions` the same way a real
product would, and only ever imports *public* names from ``periplo`` — never anything
prefixed with ``_`` (``test_no_private_periplo_imports`` in
``tests/unit/test_extension_example.py`` checks this with ``ast``). It exists purely for
tests: :func:`build_example_app` is the thin factory such a product would write for its
own ``create_app``-equivalent, and ``tests/integration/test_extensions.py`` drives
it through two tenants to prove the composition holds end to end.

The five pieces, one per :class:`~periplo.extensions.Extensions` field:

- :class:`HeaderAuthenticator` — identity from a single test-only header.
- :class:`AttributeTenants` — the tenant is the identity's own ``tenant`` attribute.
- :class:`RoleAuthorizer` — ``viewer``/``operator`` roles gate the four actions.
- :class:`MemoryAudit` — every event kept in a list, optionally made to fail.
- :class:`TenantOrchestrators` — one in-memory orchestrator per tenant, each with its
  own deployment and run, built on the ``FakeOrchestrator`` ``test_etl_api.py`` already
  has (imported, not reimplemented).
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Literal

import msgspec
from fastapi import FastAPI
from loom.core.identity import Identity
from loom.rest.auth.abc import RequestCredentials

from periplo.access import Action, AuditEvent, Denied
from periplo.bootstrap import create_app
from periplo.etl.errors import Unknown
from periplo.etl.ports import (
    Attempt,
    Deployment,
    FlowRun,
    GridCell,
    GridRun,
    LogPage,
    Orchestrator,
    Process,
    RunDetail,
    RunGrid,
    RunTasks,
    Step,
    StepDetail,
    StepFacts,
)
from periplo.extensions import Extensions
from periplo.settings import Settings
from periplo.tenancy import DEFAULT_TENANT, RequestContext, Tenant, TenantUnresolved
from tests.integration.conftest import CountingOpener, LocalLister, write_lake
from tests.integration.test_etl_api import ORDERS, RECENT, RUN, FakeOrchestrator

GLOBEX: Tenant = Tenant("globex")
"""The example's second tenant; only ``default`` and ``globex`` are known."""

_KNOWN_TENANTS: dict[str, Tenant] = {DEFAULT_TENANT.id: DEFAULT_TENANT, GLOBEX.id: GLOBEX}


class HeaderAuthenticator:
    """Identity from ``X-Example-User: <subject>;<tenant>;<role,role>``.

    Without the header, or with one that is not exactly three ``;``-separated parts, or
    with an empty subject, there is no caller (``None``): the framework's own ``401``
    answers, exactly as an unconfigured product would want — never a ``500`` from a
    malformed header. The tenant travels as a verified :class:`~loom.core.identity.Identity`
    attribute, for :class:`AttributeTenants` to read back.
    """

    name = "example-header"
    provides_roles = True

    async def authenticate(self, credentials: RequestCredentials) -> Identity | None:
        header = credentials.header("x-example-user")
        if header is None:
            return None
        parts = header.split(";")
        if len(parts) != 3:
            return None
        subject, tenant, roles = parts
        if not subject:
            return None
        role_tuple = tuple(role for role in roles.split(",") if role)
        return Identity(
            subject=subject, roles=role_tuple, attributes={"tenant": tenant}, mechanism=self.name
        )


class AttributeTenants:
    """The tenant is the identity's own ``tenant`` attribute (``default`` or ``globex``).

    ``default`` is the only tenant with data while the data plane is still shared
    (``require_default_tenant``); ``globex`` exists so tests can prove a foreign tenant
    is refused, never served the single tenant's data.
    """

    async def resolve(self, identity: Identity, credentials: RequestCredentials) -> Tenant:
        tenant_id = identity.attributes.get("tenant")
        known = _KNOWN_TENANTS.get(tenant_id) if tenant_id is not None else None
        if known is None:
            raise TenantUnresolved(f"{tenant_id!r} is not a tenant of this example")
        return known


_VIEWER_ACTIONS: frozenset[Action] = frozenset({Action.READ_CATALOG, Action.QUERY, Action.VIEW_ETL})
_OPERATOR_ACTIONS: frozenset[Action] = _VIEWER_ACTIONS | frozenset({Action.OPERATE_ETL})


class RoleAuthorizer:
    """``viewer`` reads the catalog, queries and views ETLs; ``operator`` also operates.

    Any tenant :class:`AttributeTenants` resolves is known to this authorizer: unlike
    the open-core ``SwitchAuthorizer`` it is not itself a tenant boundary.
    """

    async def authorize(
        self, context: RequestContext, action: Action, target: tuple[str, ...]
    ) -> None:
        identity = context.identity
        if identity.has_role("operator"):
            allowed = _OPERATOR_ACTIONS
        elif identity.has_role("viewer"):
            allowed = _VIEWER_ACTIONS
        else:
            allowed = frozenset()
        if action not in allowed:
            raise Denied(f"No role of {identity.roles!r} allows {action}", code="example_denied")


class MemoryAudit:
    """Keeps every event in a list; ``failing`` makes ``record`` raise (audit-failure tests)."""

    def __init__(self, *, failing: bool = False) -> None:
        self.events: list[AuditEvent] = []
        self.failing = failing

    async def record(self, event: AuditEvent) -> None:
        if self.failing:
            raise RuntimeError("MemoryAudit is set to fail")
        self.events.append(event)


class _TenantOrchestrator(FakeOrchestrator):
    """A :class:`FakeOrchestrator` with everything of its own — deployment, run, grid,
    tasks and steps — not the module-level fixtures ``test_etl_api.py`` shares across
    its own tests, so two tenants never see each other's ids, even by accident.

    Only ``list_runs``, ``get_run``, ``create_run``, ``set_schedule`` and ``get_grid``
    are overridden: ``get_tasks``, ``get_step`` and ``get_logs`` are the inherited
    ``FakeOrchestrator`` ones, which already read back ``self.tasks``, ``self.step_detail``
    and ``self.step_task_runs`` — set here to this tenant's own run and task run.
    """

    def __init__(self, *, deployment_name: str, run_id: str) -> None:
        super().__init__()
        run = msgspec.structs.replace(RUN, id=run_id)
        recent = msgspec.structs.replace(RECENT, id=run_id)
        deployment = msgspec.structs.replace(
            ORDERS,
            id=f"dep-{deployment_name}",
            name=deployment_name,
            flow_name=deployment_name,
            last_run=run,
            recent=[recent],
        )
        self.deployments = [deployment]
        self.visible_runs = {run_id}
        self._current_run = run

        task_run_id = f"task-{deployment_name}"
        step = Step(
            name=f"{deployment_name}-step",
            task_run_id=task_run_id,
            state="COMPLETED",
            start_at=run.start_at,
            end_at=run.end_at,
            duration_seconds=1.0,
        )
        process = Process(
            name=deployment_name,
            task_run_id=f"proc-{deployment_name}",
            state="COMPLETED",
            start_at=run.start_at,
            end_at=run.end_at,
            duration_seconds=1.0,
            expected_steps=1,
            steps=[step],
        )
        assert run.start_at is not None  # RUN always sets it; the replace above keeps it
        self.tasks = RunTasks(
            attempts=[
                Attempt(
                    number=1,
                    state="COMPLETED",
                    started_at=run.start_at,
                    ended_at=run.end_at,
                    message=None,
                    processes=[process],
                )
            ],
            expected_steps_known=True,
        )
        self.step_detail = StepDetail(
            step=step,
            process=process.name,
            facts=StepFacts(reads=[], writes=[], rows=0, delta_version=None),
            logs=LogPage(entries=[], next=None, truncated=False),
        )
        self.step_task_runs = {run_id: {task_run_id}}
        self.grid = RunGrid(
            runs=[
                GridRun(
                    id=run_id,
                    name=run.name,
                    state=run.state,
                    start_at=run.start_at,
                    duration_seconds=run.duration_seconds,
                    cells=[
                        GridCell(process=deployment_name, state="COMPLETED", duration_seconds=1.0)
                    ],
                )
            ],
            processes=[deployment_name],
            truncated=False,
        )

    async def list_runs(self, name: str, limit: int) -> list[FlowRun]:
        self._record("list_runs", name, limit)
        self._deployment(name)
        return [self._current_run][:limit]

    async def get_run(self, run_id: str) -> RunDetail:
        self._record("get_run", run_id)
        self._run(run_id)
        return self._detail(run_id, {})

    async def create_run(self, name: str, parameters: dict[str, Any] | None) -> RunDetail:
        self._record("create_run", name, parameters)
        self._deployment(name)
        return self._detail(self._current_run.id, parameters or {})

    async def set_schedule(self, name: str, active: bool) -> Deployment:
        self._record("set_schedule", name, active)
        self._deployment(name)
        deployment = self.deployments[0]
        assert deployment.schedule is not None
        return msgspec.structs.replace(
            deployment, schedule=msgspec.structs.replace(deployment.schedule, active=active)
        )

    async def get_grid(self, name: str, limit: int) -> RunGrid:
        self._record("get_grid", name, limit)
        self._deployment(name)
        return self.grid

    async def get_step(self, run_id: str, task_run_id: str) -> StepDetail:
        # The base ``FakeOrchestrator`` compares against the module-level ``STEP``
        # fixture; this tenant's own step has its own ``task_run_id``.
        self._record("get_step", run_id, task_run_id)
        self._run(run_id)
        if task_run_id != self.step_detail.step.task_run_id:
            raise Unknown(f"Task run {task_run_id} is not known")
        return self.step_detail

    def _detail(self, run_id: str, parameters: dict[str, Any]) -> RunDetail:
        deployment = self.deployments[0]
        fields = {**msgspec.structs.asdict(self._current_run), "id": run_id}
        return RunDetail(
            **fields,
            parameters=parameters,
            deployment_id=deployment.id,
            deployment_name=deployment.name,
            flow_name=deployment.flow_name,
            terminal=True,
        )


class TenantOrchestrators:
    """One in-memory orchestrator per known tenant, each with its own ETL and run."""

    def __init__(self) -> None:
        self.by_tenant: dict[str, _TenantOrchestrator] = {
            DEFAULT_TENANT.id: _TenantOrchestrator(
                deployment_name="daily-orders", run_id="run-default-1"
            ),
            GLOBEX.id: _TenantOrchestrator(deployment_name="globex-etl", run_id="run-globex-1"),
        }

    async def for_tenant(self, tenant: Tenant) -> Orchestrator | None:
        return self.by_tenant.get(tenant.id)

    async def aclose(self) -> None:
        for orchestrator in self.by_tenant.values():
            await orchestrator.aclose()


Piece = Literal["authenticator", "tenants", "authorizer", "audit", "orchestrators"]

_ALL_PIECES: frozenset[Piece] = frozenset(
    {"authenticator", "tenants", "authorizer", "audit", "orchestrators"}
)


def build_example_app(tmp_path: Path, *, only: set[Piece] | None = None) -> FastAPI:
    """The thin factory an embedding product would write over ``create_app``.

    ``only`` composes a subset of ``{"authenticator", "tenants", "authorizer", "audit",
    "orchestrators"}``; a piece left out keeps periplo's open-core, single-tenant
    default. The ``MemoryAudit``/``TenantOrchestrators`` instances actually wired (or
    ``None``, when that piece was left at its default) are attached to ``app.state`` as
    ``example_audit``/``example_orchestrators`` — the same way ``periplo.bootstrap``
    exposes its own registry on ``app.state.metadata_registry`` — so tests can inspect
    what this toy "cloud product" recorded or served, without a bespoke return type.
    A typo in ``only`` is a type error (``Piece``), caught by mypy before any test runs.
    """
    pieces = _ALL_PIECES if only is None else only
    audit = MemoryAudit() if "audit" in pieces else None
    orchestrators = TenantOrchestrators() if "orchestrators" in pieces else None
    app = create_app(
        write_lake(tmp_path),
        settings=Settings(),
        lister=LocalLister(),
        opener=CountingOpener(),
        extensions=Extensions(
            authenticator=HeaderAuthenticator() if "authenticator" in pieces else None,
            tenants=AttributeTenants() if "tenants" in pieces else None,
            authorizer=RoleAuthorizer() if "authorizer" in pieces else None,
            audit=audit,
            orchestrators=orchestrators,
        ),
    )
    app.state.example_audit = audit
    app.state.example_orchestrators = orchestrators
    return app
