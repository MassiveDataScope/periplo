# Architecture

Periplo runs as one process: a FastAPI application, built on
[loom-kernel](https://github.com/the-reacher-data/loom-py), that serves the HTTP API
under `/api/v1` and, when `PERIPLO_WEB_DIR` is set, the built web console on every other
path. The console and the API share one origin, so there is no CORS to configure and no
proxy to run.

## Components

| Component | Where | Role |
|-----------|-------|------|
| Composition root | `periplo.bootstrap.create_app` | The only place that knows the concrete implementations. It reads the settings, builds every component and wires the extension ports. |
| Catalog | `periplo.catalog` | Walks each source, builds the catalog of tables and publishes it. Reads schemas, statistics and history from the Delta logs. |
| Queries | `periplo.queries` | Checks that a query only names catalog tables, runs it on a fresh DataFusion session and streams the result as Arrow. |
| ETL | `periplo.etl` | The `Orchestrator` port and its Prefect adapter; parses the structured logs of loom-kernel pipelines into steps. |
| Identity and tenancy | `periplo.tenancy`, `periplo.http_context` | Answers who is calling and for which tenant, once per `/api/*` request. |
| Access | `periplo.access` | Authorizes each action and writes audit events. |
| Web console | `periplo.web` | Serves the built console, with long-lived caching for hashed assets. |

## Life of a request

1. **Identity and tenant.** A middleware authenticates every `/api/*` request with the
   `Authenticator` port, resolves its tenant with the `TenantResolver` port, and publishes
   both as the request context. A refusal ends the request with `401` or `403` before any
   route runs.
2. **Authorization.** The route asks `Access` whether the action (read the catalog, run
   a query, view or operate an ETL) is allowed on its target. Denials of state-changing
   actions are audited.
3. **Work.** The route does its work. Operating an ETL is audited before it happens (an
   action that cannot be audited does not happen) and again with its outcome.

In the open-source defaults every caller is anonymous and belongs to a single tenant,
and the only rule is `PERIPLO_ETL_ALLOW_OPERATE`. {doc}`extending` explains how to
replace each of these pieces.

## Catalog

At start-up the application begins the first discovery in the background and serves
liveness at once; readiness waits for that discovery. Sources are walked one after
the other, each from a pool of threads that only make listing calls (see
{doc}`../configuration/sources`). The result is published as a whole: a request always
sees one complete catalog, never a half-built one. A source whose walk fails keeps the
tables of its last successful one.

Metadata of a single table is read when it is asked for. Opened Delta snapshots are kept
in a bounded registry and revalidated after `PERIPLO_METADATA_TTL_SECONDS`; the derived
answers (schema, statistics, history) live in a byte-bounded cache. The table routes
answer conditional `GET` requests with `ETag` and `304 Not Modified`.

## Queries

A query goes through these steps:

1. It is parsed, and every table it names must be in the catalog; anything else is
   refused before a slot is taken.
2. It takes one of `PERIPLO_MAX_CONCURRENT_QUERIES` slots, or is refused with `429`.
3. It runs on a new DataFusion session that holds exactly the tables it names, each
   pinned to one Delta version, with DDL, DML and other statements disabled.
4. The result streams back as an Arrow IPC stream (`application/vnd.apache.arrow.stream`),
   cut at the row and byte limits, with its id in the `X-Query-Id` header. The id can be
   used to read the query's state or cancel it.

Every query is audited with its normalized SQL, never with row data.

## HTTP API

The API describes itself: the running application serves its OpenAPI document at
`/openapi.json` and interactive documentation at `/docs`.

| Method and path | Purpose |
|-----------------|---------|
| `GET /api/v1/catalog` | The published catalog. |
| `GET /api/v1/catalog/tables/{database}/{table}` | Schema and version of one table. |
| `GET /api/v1/catalog/tables/{database}/{table}/stats` | Statistics from the Delta log. |
| `GET /api/v1/catalog/tables/{database}/{table}/history` | Latest commits of the table. |
| `GET /api/v1/sources` | Each source with the report of its last discovery. |
| `POST /api/v1/discovery` | Start a new discovery. |
| `POST /api/v1/queries` | Run a query; the body is `{"sql": "...", "max_rows": 1000}`, with `max_rows` optional. |
| `GET /api/v1/queries/{id}`, `DELETE /api/v1/queries/{id}` | State of a query; cancel it. |
| `GET /api/v1/etl/status` | Whether the ETL integration is configured and operating is allowed. |
| `GET /api/v1/etl`, `GET /api/v1/etl/{name}/runs`, `GET /api/v1/etl/{name}/grid` | Deployments, their runs, and the process-by-run grid. |
| `GET /api/v1/etl/runs/{id}` and `/tasks`, `/logs`, `/steps/{task_run}` | One run, its attempts and steps, and its logs. |
| `POST /api/v1/etl/{name}/runs`, `POST /api/v1/etl/{name}/schedule/pause`, `POST /api/v1/etl/{name}/schedule/resume` | Operate an ETL, when allowed. |
| `GET /health/live`, `GET /health/ready` | Liveness; readiness (`503` until the first discovery) with cache counters. |
