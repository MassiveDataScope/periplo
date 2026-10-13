# Environment variables

Periplo is configured with environment variables. Every setting is named
`PERIPLO_<SETTING>`, is read once when the application starts, and is validated before
anything else happens: a missing or malformed value stops the start-up with an error
that names the variable, for example ``PERIPLO_MAX_RESULT_ROWS: Expected `int` >= 1``.

Numbers are written as plain digits (`67108864`, not `64MiB`). Booleans accept `true`,
`false`, `1` and `0`. Lists are comma-separated; spaces around each item are ignored and
empty items are dropped.

Where the container image sets a value different from the application default, both are
given.

## Catalog and sources

| Variable | Default | Meaning |
|----------|---------|---------|
| `PERIPLO_SOURCES_FILE` | unset; image: `/etc/periplo/sources.yaml` | Path of the {doc}`sources file <sources>`. Required: the application refuses to start without one. |
| `PERIPLO_DISCOVERY_FOLDER_BUDGET` | `20000` | Most folders one discovery may list per source. Reaching it stops the walk and reports the result as partial, instead of listing a huge bucket forever. |

## Queries

| Variable | Default | Meaning |
|----------|---------|---------|
| `PERIPLO_MAX_CONCURRENT_QUERIES` | `2` | Queries that may run at the same time. |
| `PERIPLO_MAX_RESULT_ROWS` | `100000` | Most rows a query returns; a longer result is cut and marked as truncated. A request may ask for fewer rows, never for more. |
| `PERIPLO_MAX_RESULT_BYTES` | `67108864` (64 MiB) | Size of the Arrow stream after which a query sends no further batches; the result is marked as truncated. |
| `PERIPLO_QUERY_TIMEOUT_SECONDS` | `60` | Time limit of each query, in seconds; must be greater than 0. A query that runs longer ends with a `timeout` error. |

## Table metadata

Schemas, statistics and history come from each table's Delta log. Periplo keeps the
snapshots it has opened, and what it derived from them, in memory.

| Variable | Default | Meaning |
|----------|---------|---------|
| `PERIPLO_METADATA_TTL_SECONDS` | `30` | How long a table's snapshot is served without checking storage for a newer version. `0` checks on every access. |
| `PERIPLO_METADATA_CACHE_BYTES` | `33554432` (32 MiB) | Memory budget of the derived metadata cache. |
| `PERIPLO_METADATA_SNAPSHOTS` | `64` | Open Delta snapshots kept in memory. |

`/health/ready` reports the counters of both caches (hits, misses, evictions, bytes)
next to the readiness state.

## Web console and logging

| Variable | Default | Meaning |
|----------|---------|---------|
| `PERIPLO_WEB_DIR` | unset; image: `/app/web` | Directory of the built web console, served by the API process on the same port. Unset serves the API only. |
| `PERIPLO_ENV` | `dev`; image: `prod` | `prod` writes logs as JSON lines; any other value writes a human-readable console format. |
| `PERIPLO_LOG_LEVEL` | `INFO` | Level of the service log, as a standard level name such as `DEBUG`, `INFO` or `WARNING`. An unknown name stops the start-up. |

## ETL orchestrator

The ETL section talks to [Prefect](https://www.prefect.io/). It is off until
`PERIPLO_PREFECT_API_URL` is set; everything else keeps working without it. See
{doc}`../etl/console` for what it shows.

| Variable | Default | Meaning |
|----------|---------|---------|
| `PERIPLO_PREFECT_API_URL` | unset (ETL off) | Base URL of Prefect's REST API, for example `http://prefect.internal:4200/api`, or `https://api.prefect.cloud/api/accounts/<account>/workspaces/<workspace>` for Prefect Cloud. An empty value also switches the integration off. |
| `PERIPLO_PREFECT_API_KEY` | unset | Prefect Cloud API key, sent as `Authorization: Bearer`. Wins over `PERIPLO_PREFECT_AUTH_STRING` when both are set. |
| `PERIPLO_PREFECT_AUTH_STRING` | unset | `user:password` of a self-hosted Prefect server with basic authentication, sent as `Authorization: Basic`. |
| `PERIPLO_PREFECT_UI_URL` | unset | Base URL of Prefect's own UI, used for the "Open in orchestrator" links. It must be reachable from the user's browser. Unset shows no links; it is never derived from the API URL. |
| `PERIPLO_PREFECT_TAGS` | empty | Comma-separated tags. Only deployments that carry **all** of them are shown, and the runs Periplo asks Prefect for are filtered by them. Empty shows every deployment of the workspace. |
| `PERIPLO_PREFECT_TIMEOUT_SECONDS` | `10` | Time limit of each call to Prefect, in seconds. |
| `PERIPLO_ETL_ALLOW_OPERATE` | `false` | Whether the console may start runs and pause or resume schedules. Read {ref}`the warning below <allow-operate>` before turning it on. |
| `PERIPLO_ETL_ALLOW_ARCHIVE` | same as `PERIPLO_ETL_ALLOW_OPERATE` | Whether the console may archive and restore ETLs (kept by Periplo; nothing changes in the orchestrator). |
| `PERIPLO_ETL_FACETS` | empty | How the console names the facets your ETL tags form: a JSON object keyed by tag prefix, each with optional `label`, `order`, `hidden` and `role` (`reads` or `writes` for lineage; `expects_schedule` with a non-empty `values` list for the values that mean an ETL should be scheduled). See {ref}`ETL facets <etl-facets>`. |
| `PERIPLO_ETL_LOG_NOISE` | empty | Comma-separated log line prefixes that the log viewer folds as noise by default. Empty folds nothing. |

(allow-operate)=
:::{warning}
The open-source build has no authentication. With `PERIPLO_ETL_ALLOW_OPERATE=true`,
anyone who can reach the console can run ETLs and pause or resume their schedules. Keep
it off, or put an authenticating layer in front of Periplo (see {doc}`../security`).
:::

## Outside Periplo's own settings

These are read by the libraries Periplo runs on, not by Periplo itself.

| Variable | Read by | Meaning |
|----------|---------|---------|
| `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN` | the S3 clients | Credentials and region from the standard AWS chain. Without them, the chain falls back to the role of the machine or task. |
| `UVICORN_HOST`, `UVICORN_PORT` | uvicorn | Address the server listens on. The image sets `0.0.0.0` and `8080`. |
| `UVICORN_TIMEOUT_GRACEFUL_SHUTDOWN` | uvicorn | Seconds requests in flight get to finish after `SIGTERM`. The image sets `20`. |

The Compose file of the repository also reads `PERIPLO_PORT` (host port, `8080` by default)
and `PERIPLO_IMAGE` (image to run). They configure Compose, not the application.
