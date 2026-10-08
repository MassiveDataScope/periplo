# Extending Periplo

Periplo's open-source build is a single-tenant console without authentication. A
product built on it (a hosted service, or an internal deployment with its own identity
provider) adds what it needs through seven **extension ports**, passed explicitly to the
application factory. Nothing is discovered implicitly: no entry points, no plugins found
on the path. What runs is only what the embedding product passes in.

## The seven ports

`periplo.extensions.Extensions` has one field per port. A field left `None` keeps the
open-source default.

| Field | Port | Question it answers | Default |
|-------|------|---------------------|---------|
| `authenticator` | loom's `Authenticator` | Who is calling? | `AnonymousAuthenticator`: everyone is anonymous. |
| `tenants` | `periplo.tenancy.TenantResolver` | Which tenant owns this request? | `SingleTenant`: every request belongs to the `default` tenant. |
| `authorizer` | `periplo.access.Authorizer` | May this action happen? | `SwitchAuthorizer`: only operating and archiving ETLs are gated, by `PERIPLO_ETL_ALLOW_OPERATE` and `PERIPLO_ETL_ALLOW_ARCHIVE`. |
| `audit` | `periplo.access.AuditSink` | Who should know it happened? | `LogAuditSink`: one structured log line per event. |
| `orchestrators` | `periplo.etl.provider.OrchestratorProvider` | Which ETL orchestrator serves this tenant? | `SingleOrchestrator`: the Prefect workspace configured by the environment, or none. |
| `credentials` | `periplo.credentials.CredentialsProvider` | Which storage credentials does this tenant read with? | `ProcessCredentials`: the process's own credential chain. |
| `data_planes` | `periplo.data_plane.DataPlanes` | Which sources, catalog, caches and query engine serve this tenant? | `SinglePlane`: the sources file and storage of the environment, for the `default` tenant. |

Each port is a `typing.Protocol`: implement its methods and pass an instance; there is
nothing to inherit. The {doc}`../reference/api` documents every signature.

## Composing a product

The factory is `periplo.bootstrap.create_app`. A product writes its own factory that
calls it with an `Extensions`, and starts that factory instead of Periplo's. Settings are
still read from the `PERIPLO_*` variables.

This example, for a fictional shop, trusts the user name set by an authenticating proxy,
lets only operators run ETLs, and writes every audit event to its own stream:

```python
"""shop_console/app.py: Periplo with the shop's identity, rules and audit trail."""

from __future__ import annotations

import sys
from enum import StrEnum

import msgspec
from fastapi import FastAPI
from loom.core.identity import Identity
from loom.rest.auth.abc import RequestCredentials

from periplo.access import Action, AuditEvent, Denied, Target
from periplo.bootstrap import create_app
from periplo.extensions import Extensions
from periplo.tenancy import RequestContext

OPERATORS = frozenset({"ana", "luis"})


class ProxyUserAuthenticator:
    """The user name an authenticating proxy puts in ``X-Shop-User``.

    Only safe when every request reaches Periplo through that proxy, and the proxy
    removes the header from whatever clients send.
    """

    name = "shop-proxy"
    provides_roles = True

    async def authenticate(self, credentials: RequestCredentials) -> Identity | None:
        user = credentials.header("x-shop-user")
        if not user:
            return None  # answered with 401
        roles = ("operator",) if user in OPERATORS else ("viewer",)
        return Identity(subject=user, roles=roles, mechanism=self.name)


class ShopAuthorizer:
    """Everyone may look; only operators may run ETLs or change their schedules."""

    async def authorize(self, context: RequestContext, action: StrEnum, target: Target) -> None:
        if action is Action.OPERATE_ETL and not context.identity.has_role("operator"):
            raise Denied("Only shop operators can operate ETLs", code="shop_operator_required")


class StdoutAudit:
    """One JSON line per audit event, for the platform's log collector."""

    async def record(self, event: AuditEvent) -> None:
        sys.stdout.write(msgspec.json.encode(event).decode() + "\n")


def create_shop_app() -> FastAPI:
    return create_app(
        extensions=Extensions(
            authenticator=ProxyUserAuthenticator(),
            authorizer=ShopAuthorizer(),
            audit=StdoutAudit(),
        )
    )
```

Start it with uvicorn's factory mode:

```sh
uvicorn --factory shop_console.app:create_shop_app
```

## Rules every extension follows

- **A replaced default is replaced entirely.** With your own `authorizer`,
  `PERIPLO_ETL_ALLOW_OPERATE` is no longer consulted: your authorizer decides alone.
- **Refusals are exceptions with a meaning.**
  - An `Authenticator` refuses by returning `None` or raising loom's `Unauthenticated`
    (`401`), or by raising loom's `Forbidden` (`403`).
  - A `TenantResolver` raises `periplo.tenancy.TenantUnresolved` when it cannot
    attribute a request (`401`, without revealing which tenants exist).
  - An `Authorizer` returns to allow and raises `periplo.access.Denied` (or loom's
    `Forbidden`) to refuse, which always answers `403`. Any other exception fails the
    request; it is never read as permission.
- **Targets follow one convention.** An `Authorizer` receives what an action is about as a
  tuple: `()` for the resource as a whole, `("etl", name)`, `("run", run_id, etl)`,
  `("table", database, table)` or `("query", query_id)`. Read the deployment of an `etl`
  or `run` target with `periplo.access.etl_of`, never by position. A run target carries
  the name of its deployment when the orchestrator can resolve it (see
  [Orchestrator capabilities](#orchestrator-capabilities)), and `""` when it cannot, or
  when that deployment no longer exists. An authorizer must deny `""` unless it grants
  runs without a deployment explicitly. Keeping a run within its tenant is the
  orchestrator provider's job.
- **`403` comes from `authorize`, `404` only from `visible`.** A refusal always answers
  `403`, and is never turned into a `404`. An item is answered "not found" only when a
  filtering authorizer leaves it out, and then exactly as if it did not exist.
- **Audit comes before action.** Operating an ETL records a `requested` event first. If
  the sink raises or takes longer than five seconds, the action does not happen. Outcome
  events (`succeeded`, `failed`, `cancelled`, `denied`) are best-effort and logged when
  they cannot be written. Events never carry row data; query events carry the normalized
  SQL.
- **A header sent more than once is seen as its last value** by authenticators and tenant
  resolvers.
- **Pass one orchestrator source.** `create_app` raises `ValueError` if it receives both
  `orchestrator=` and `extensions.orchestrators`, and likewise for any of `lister=`,
  `reader=` and `opener=` with `extensions.data_planes`.
- **Each port is independent.** A port you leave out keeps its default, whatever the
  others are, and a port you bring that fails fails the request instead of falling back
  to the default.

## The core actions

`periplo.access.Action` holds the actions of the core:

| Action | What it covers |
|--------|----------------|
| `read_catalog` | The catalog, a table's detail, statistics and history, and which tables a query may name. Also required, on `()`, to run a query and to reach the sources and discovery. |
| `admin_catalog` | The sources, their discovery reports, and starting a discovery, in addition to `read_catalog`. |
| `query` | Running a query, in addition to `read_catalog`; reading its status and cancelling it. |
| `view_etl` | The deployment list, a deployment's runs and grid, and a run with its tasks, steps and logs. |
| `operate_etl` | Launching, cancelling or retrying a run, and pausing or resuming a schedule. |
| `archive_etl` | Archiving or restoring an ETL in Periplo. |

`SwitchAuthorizer` allows all of them but `operate_etl`, which follows
`PERIPLO_ETL_ALLOW_OPERATE`, and `archive_etl`, which follows `PERIPLO_ETL_ALLOW_ARCHIVE`
(`PERIPLO_ETL_ALLOW_OPERATE` when unset).

## Filtering collections

An authorizer that also implements `periplo.access.FilteringAuthorizer` decides which
items of a collection the caller sees:

```python
async def visible(
    self, context: RequestContext, action: StrEnum, targets: Sequence[Target]
) -> Collection[Target]: ...
```

Periplo asks once per listing, with every target of it, never once per item, and only
after `authorize(context, action, ())` has allowed the action. It keeps the answer only
where it names one of the targets it asked about, in its own order, so the result is
never wider than the collection. Raise as in `authorize` to refuse the collection as a
whole; any other exception fails the request, and the full collection is never returned
instead.

Every route follows the same rule:

- **A listing** authorizes the whole resource with `authorize(context, action, ())`, then
  asks `visible` once about its items.
- **A single item** is `authorize` on its target with a plain authorizer, answering `403`
  on a refusal. With a filtering authorizer it is `authorize` on `()`, then `visible`
  about that item alone, and an item left out answers the route's own `404`, byte for
  byte the answer for an item that does not exist. Routes do this through
  `Access.reveal`, which raises the route's not-found error itself.
- **An operation on an item** (launching a run, pausing or resuming a schedule) first
  checks, with a filtering authorizer, that the caller may view the item, through
  `Access.operate_revealed`. A refusal is audited as a denied operation, and a hidden
  item is audited as denied with the code `hidden` before it answers `404`.

What a caller cannot see does not count either:

- **The catalog** lists the visible tables only, and reports a name conflict only when
  its name is visible. Groups and counts are computed from the tables it lists.
- **A query** asks `visible` about every table it names, whether it exists or not, so a
  refusal says nothing about which tables exist. A hidden table fails as if it were not
  in the catalog, and the query is audited as denied with the code `hidden`.
- **The deployment list** is asked again with only the visible names when anything is
  hidden, so its summary, running runs and histories cover those alone. If that answer
  names any other deployment, the route fails with `502` rather than trust its counts.

Without `visible`, each listing is all or nothing, decided by `authorize` on `()`.

Implement `visible` as an allow-list: keep the targets the caller is granted, not
everything but the ones it is denied. With a deny-list, timing can tell which denied
names exist. A denied name stops at the authorizer, while an allowed name that does not
exist goes on to the orchestrator or the catalog, and takes longer to answer.

## Product actions

A product declares its own actions as another `StrEnum` and passes them through the same
`periplo.access.Access` the core uses:

```python
class ShopAction(StrEnum):
    MANAGE_MEMBERS = "shop.manage_members"


async def add_member(access: Access, team: str, member: str) -> str:
    async def work() -> str:
        return member

    return await access.operate(ShopAction.MANAGE_MEMBERS, ("team", team), work)
```

- **Prefix each value with a namespace of your own,** dotted: `"shop.manage_members"`,
  never a bare `"manage_members"`. The core's own values are bare, and `Access` raises
  `ValueError` for a product action whose value is one of them, so a product action can
  never be taken for a core one.
- **The authorizer receives the enum member itself,** so `action is ShopAction.MANAGE_MEMBERS`
  works, as does `action is Action.OPERATE_ETL` for the core's. Compare action values
  exactly: never fold case or strip whitespace, so no value can stand for another.
  `Access` raises `TypeError` for an action that is not a `StrEnum` member.
- **An action is state-changing when it is performed through `Access.operate`.** It is
  audited as `requested` before it happens and with its outcome after, and a refusal is
  always audited as `denied`. `Access.require` records denials only for `operate_etl`.
- **Audit events carry the action's value.** `AuditEvent.action` holds the member, and it
  is encoded as its string value.
- **`authorize` may return a `periplo.access.Justification`,** naming the grant that
  allowed the action. `Access.operate` records its `grant` in the detail of each of its
  events. Returning `None` records no grant.

## Orchestrator capabilities

An `Orchestrator` may do more than the protocol requires:

- **`list_deployments(only=...)`** lists only the deployments named in `only`, any
  collection of names, with the summary, running runs and histories counted over those
  alone. Periplo passes it when a filtering authorizer hides part of the list. An adapter
  must honour it: the counts are what a caller could otherwise learn about deployments
  it cannot see.
- **`periplo.etl.ports.RunResolver`** adds `run_etl(run_id)`, the name of the run's
  deployment, or `None` when that deployment is gone. It raises `Unknown` for a run that
  does not exist. With it, a run route authorizes `view_etl` on `()`, resolves the run,
  and only then asks about `("run", run_id, etl)`. An unknown run answers `404` before
  its target reaches the authorizer, and before the route's own input is checked: a
  malformed log cursor on an unknown run is `404`, not `400`, and so is a log request
  naming only malformed task runs, which a known run answers with an empty page. With a
  plain authorizer, a
  run it refuses answers `403` after the run resolves, so that caller can tell the run
  exists; only a filtering authorizer makes a hidden run indistinguishable from a
  missing one. The Prefect adapter implements it.

## Authorizer requirements

An `Authorizer` implementing only `authorize` gets no filtering: every listing is all
or nothing.

- `authorize`'s `action` parameter must accept any `StrEnum`, not only `Action`;
  comparing with `Action` members still works.
- A run target always has a third element, the name of its deployment or `""`.
- `/sources` and `/discovery` are authorized as `read_catalog` and then `admin_catalog`,
  and a query as `query` and then `read_catalog`. An authorizer that lists the actions
  it allows must include them.
- `authorize` may return a `Justification`, or `None`.

### More than one tenant

The single-tenant defaults are tenant boundaries. `SwitchAuthorizer`,
`SingleOrchestrator` and `SinglePlane` fail with `periplo.tenancy.ForeignTenant`,
answered `500`, if a resolver reports any tenant other than `default`: that is a
composition error, not a client error.

With the default data plane, the catalog and the query engine serve the `default` tenant
only, and a request from any other tenant to read the catalog or run a query fails the
same way. A product that serves several tenants brings its own `data_planes`, and
usually its own `credentials`, as the next section describes.

An `OrchestratorProvider` that serves several tenants must bound each tenant's
orchestrator by that tenant's tags. The Prefect adapter,
`periplo.etl.adapters.prefect.PrefectOrchestrator`, takes `require_tags=True` to refuse
to exist without them: an untagged adapter sees every deployment and run of the
workspace.

## Credentials and data planes

Every catalog and query route first resolves the **data plane** of the request's tenant,
through `DataPlanes.for_tenant`, before it authorizes anything. A
`periplo.data_plane.DataPlane` holds everything that reads one tenant's data: its
configuration, its catalog, its metadata readers and its query engine, and it is bound
to its tenant. A route reads nothing outside the plane it resolved, so the same logical
table, say `sales.orders`, can live at a different location for each tenant, and a
snapshot or a cached statistic of one tenant never serves another.

- **Build planes with `periplo.planes.build_data_plane`,** the same code that builds the
  default plane. Give it the tenant, its configuration, a storage factory such as
  `periplo.catalog.adapters.s3_lister.S3Storage`, the settings, and the metadata cache
  from `periplo.planes.metadata_cache`. The plane is bound to the tenant and keys its
  cached metadata under it. Build the cache once and give it to every plane, so they
  share one byte budget; a second call builds a second cache and leaves the first as it
  is.
- **Answer each tenant with its own plane.** A tenant without a plane raises
  `periplo.data_plane.NoDataPlane`. A plane bound to another tenant than the request's
  is refused. Both answer `500`, and Periplo never falls back to another plane.
- **Discovery is yours to start.** Periplo only runs the first discovery of the default
  plane. Start each of yours in a worker thread, with the tenant's credentials:

  ```python
  credentials = await provider.for_tenant(tenant)
  await asyncio.to_thread(plane.state.discover, credentials)
  ```

  `/health/ready` then reports liveness only.
- **`aclose`** is awaited on shutdown; close each plane with `DataPlane.aclose`.

The **credentials** port gives the storage credentials of a tenant, as a
`periplo.credentials.ReadCredentials`: object_store configuration keys, the
`storage_options` of delta-rs, and when they expire. Periplo asks for them after
authorization, on every request for a table's detail, statistics or history, on every
query once it is admitted, and on every discovery. It passes them to every read: listing
a source, probing and opening a table's log, and reading a query's data files. A table
is only ever read through the options it was opened with: a request that brings other
options opens it again with its own.

Periplo checks what your provider answers before anything reads with it, and answers
`503` for anything else:

- exactly one access key id, under `aws_access_key_id` or `access_key_id`;
- exactly one secret access key, under `aws_secret_access_key` or `secret_access_key`;
- exactly one session token, under `aws_session_token`, `aws_token`, `session_token` or
  `token`: temporary credentials only, since delta-rs would take a missing token from the
  environment;
- optionally `aws_region`, one of `aws_endpoint_url` and `aws_endpoint`, `aws_allow_http`
  and `aws_virtual_hosted_style_request`;
- names in any case, no value empty, nothing else, and an `expires_at` at least a minute
  away.

Anything else would let delta-rs complete the options from the process's own
environment: empty options, a region or endpoint alone, a misspelled key, a profile, a
role, or keys without a token. The keys go to delta-rs as they are, and to pyarrow when a
source is listed.

- **Refuse with `periplo.credentials.CredentialsUnavailable`,** answered `503`. Anything
  else your provider raises is answered `500` and logged by its type only, since its
  message may hold a secret. Neither ever falls back to the process's credentials.
- **Every route waits for credentials no longer than a query may run,**
  `PERIPLO_QUERY_TIMEOUT_SECONDS`, and answers `504` with the code `timeout` after that.

The process's own credentials may be present, and a provider usually relies on them to
call STS; tenant reads never use them. `create_app` refuses to start with a provider when
the environment would redirect or unsign tenant reads, such as `AWS_ENDPOINT_URL` or
`AWS_SKIP_SIGNATURE` (see {doc}`../security`).

Credentials and data planes are the boundary between tenants: give each tenant
credentials that can only reach its own storage (see {doc}`../security`). Row policies,
a later port, will be a boundary between the users of one tenant, never between tenants.

The `lister=` and `opener=` arguments of `create_app` are test seams that read with the
process's own credentials; `create_app` refuses them with `extensions.credentials` or
`extensions.data_planes`.

## A complete example

The repository's test suite composes all seven ports into a toy product and drives it
through two tenants. Its pieces are a good starting point; they live in
`apps/api/tests/extension_example/__init__.py` and only import public names from
`periplo`.

An authenticator that reads identity from a test-only header:

```{literalinclude} ../../apps/api/tests/extension_example/__init__.py
:language: python
:pyobject: HeaderAuthenticator
```

A tenant resolver that reads the tenant from the verified identity:

```{literalinclude} ../../apps/api/tests/extension_example/__init__.py
:language: python
:pyobject: AttributeTenants
```

A role-based authorizer:

```{literalinclude} ../../apps/api/tests/extension_example/__init__.py
:language: python
:pyobject: RoleAuthorizer
```

An audit sink that keeps events in memory:

```{literalinclude} ../../apps/api/tests/extension_example/__init__.py
:language: python
:pyobject: MemoryAudit
```

An orchestrator provider with one orchestrator per tenant:

```{literalinclude} ../../apps/api/tests/extension_example/__init__.py
:language: python
:pyobject: TenantOrchestrators
```

A credentials provider that gives each tenant options of its own:

```{literalinclude} ../../apps/api/tests/extension_example/__init__.py
:language: python
:pyobject: TenantCredentials
```

A data plane provider with one plane per tenant, each over its own lake:

```{literalinclude} ../../apps/api/tests/extension_example/__init__.py
:language: python
:pyobject: TenantPlanes
```

## Depending on Periplo

The API is published on PyPI as `periplo`, and its import name is also `periplo`. It
supports Python 3.12, 3.13 and 3.14. Pin the exact version you build against: Periplo is below 1.0, and
under Semantic Versioning a minor release may still change the extension ports.

```sh
pip install "periplo==X.Y.Z"
```

The web console is not part of the Python package; it ships in the container image.

## Building on the container image

The image already holds Periplo, its dependencies and the built console, so a product
image can start `FROM` it, add its own module and change the command. Use the same
`X.Y.Z` for the image and for the `periplo` version your code is written against.

In the image, Periplo's sources are on `PYTHONPATH` under `/app/src`, its dependencies are
in the virtual environment at `/venv`, and the process runs as the unprivileged user
`10001`. A module that only needs what Periplo already depends on can be copied next to
Periplo's sources:

```dockerfile
FROM ghcr.io/massivedatascope/periplo:X.Y.Z

COPY shop_console /app/src/shop_console
CMD ["uvicorn", "--factory", "shop_console.app:create_shop_app"]
```

The environment in `/venv` has no `pip`. To add dependencies of your own, install them
with `uv` as root, then drop back to the unprivileged user:

```dockerfile
FROM ghcr.io/massivedatascope/periplo:X.Y.Z

COPY --from=ghcr.io/astral-sh/uv:0.9.30 /uv /usr/local/bin/uv
USER root
RUN uv pip install --python /venv/bin/python --no-cache "shop-identity-client==1.2.0"
USER 10001:10001

COPY shop_console /app/src/shop_console
CMD ["uvicorn", "--factory", "shop_console.app:create_shop_app"]
```

Do not install the `periplo` package itself into the image: the copy under `/app/src`
comes first on the path, so a second one would only hide which version runs.

The entry point, health check, port and environment of the base image stay as they are;
see {doc}`../deployment/docker`. If you distribute the result or offer it to users over
a network, read [the network-use section](../deployment/docker.md#source-code-for-network-users)
as well.
