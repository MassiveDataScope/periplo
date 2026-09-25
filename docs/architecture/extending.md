# Extending Periplo

Periplo's open-source build is a single-tenant console without authentication. A
product built on it (a hosted service, or an internal deployment with its own identity
provider) adds what it needs through five **extension ports**, passed explicitly to the
application factory. Nothing is discovered implicitly: no entry points, no plugins found
on the path. What runs is only what the embedding product passes in.

## The five ports

`periplo.extensions.Extensions` has one field per port. A field left `None` keeps the
open-source default.

| Field | Port | Question it answers | Default |
|-------|------|---------------------|---------|
| `authenticator` | loom's `Authenticator` | Who is calling? | `AnonymousAuthenticator`: everyone is anonymous. |
| `tenants` | `periplo.tenancy.TenantResolver` | Which tenant owns this request? | `SingleTenant`: every request belongs to the `default` tenant. |
| `authorizer` | `periplo.access.Authorizer` | May this action happen? | `SwitchAuthorizer`: only operating ETLs is gated, by `PERIPLO_ETL_ALLOW_OPERATE`. |
| `audit` | `periplo.access.AuditSink` | Who should know it happened? | `LogAuditSink`: one structured log line per event. |
| `orchestrators` | `periplo.etl.provider.OrchestratorProvider` | Which ETL orchestrator serves this tenant? | `SingleOrchestrator`: the Prefect workspace configured by the environment, or none. |

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

    async def authorize(self, context: RequestContext, action: Action, target: Target) -> None:
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
  tuple: `()` for the resource as a whole, `("etl", name)`, `("run", run_id)`,
  `("table", database, table)` or `("query", query_id)`. Run routes are authorized by run
  id alone; keeping a run within its tenant is the orchestrator provider's job.
- **Audit comes before action.** Operating an ETL records a `requested` event first. If
  the sink raises or takes longer than five seconds, the action does not happen. Outcome
  events (`succeeded`, `failed`, `cancelled`, `denied`) are best-effort and logged when
  they cannot be written. Events never carry row data; query events carry the normalized
  SQL.
- **A header sent more than once is seen as its last value** by authenticators and tenant
  resolvers.
- **Pass one orchestrator source.** `create_app` raises `ValueError` if it receives both
  `orchestrator=` and `extensions.orchestrators`.

### More than one tenant

The single-tenant defaults are tenant boundaries. `SwitchAuthorizer` and
`SingleOrchestrator` fail with `periplo.tenancy.ForeignTenant`, answered `500`, if a
resolver reports any tenant other than `default`: that is a composition error, not a
client error.

The catalog and the query engine are still one data plane shared by the whole
installation, so they serve the `default` tenant only. A request from any other tenant
to read the catalog or run a query fails the same way. What a multi-tenant product can
separate today is identity, authorization, audit and ETL.

An `OrchestratorProvider` that serves several tenants must bound each tenant's
orchestrator by that tenant's tags. The Prefect adapter,
`periplo.etl.adapters.prefect.PrefectOrchestrator`, takes `require_tags=True` to refuse
to exist without them: an untagged adapter sees every deployment and run of the
workspace.

## A complete example

The repository's test suite composes all five ports into a toy product and drives it
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

## Depending on Periplo

The API is published on PyPI as `periplo`, and its import name is also `periplo`. It
supports Python 3.12. Pin the exact version you build against: Periplo is below 1.0, and
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
