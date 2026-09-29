# ETL console

The ETL section of the console follows the deployments of a
[Prefect](https://www.prefect.io/) workspace: what ran, what is running, what failed
and what comes next. It works with any Prefect deployment, and shows more detail for
pipelines built with [loom-kernel](https://github.com/MassiveDataScope/loom-py), whose
structured logs describe processes and steps.

The section is off until `PERIPLO_PREFECT_API_URL` is set. Without it, the console
reports the ETL integration as not configured and everything else keeps working.

## Connecting to Prefect

A self-hosted Prefect server with basic authentication:

```sh
PERIPLO_PREFECT_API_URL=http://prefect.internal:4200/api
PERIPLO_PREFECT_AUTH_STRING=periplo:change-me
PERIPLO_PREFECT_UI_URL=http://prefect.internal:4200
PERIPLO_PREFECT_TAGS=shop
```

Prefect Cloud:

```sh
PERIPLO_PREFECT_API_URL=https://api.prefect.cloud/api/accounts/<account>/workspaces/<workspace>
PERIPLO_PREFECT_API_KEY=<api key>
PERIPLO_PREFECT_UI_URL=https://app.prefect.cloud/account/<account>/workspace/<workspace>
PERIPLO_PREFECT_TAGS=shop
```

The repository's `.env.etl.example` has both variants with fake values. When Periplo
runs in a container and Prefect on the host, the host is `host.docker.internal`; the
repository's Compose file maps it on Linux too.

**Tags draw the boundary.** Only deployments that carry every tag in
`PERIPLO_PREFECT_TAGS` are shown, and runs are fetched through the same filter. Use them
to show one lake's ETLs, not the whole workspace. Every setting is described in
{doc}`../configuration/environment`.

## What it shows

### Dashboard

- A summary line: how many ETLs, how many are running, how many need attention, and the
  next scheduled run.
- A chart of runs over the last 24 hours or 7 days, with failures and what is scheduled
  next.
- **Running now**: each running run with its current step and how its elapsed time
  compares with its typical duration.
- **Needs attention**: for example a schedule that was switched off after a failed run,
  a last run that crashed, or a daily ETL without a schedule.
- The list of ETLs in two tabs, **Scheduled** and **On demand**, each with its schedule,
  last run, next run and a strip of its last 12 runs. It can be filtered by name, tag and
  state, and the filters are kept in the URL so a view can be shared.

### One ETL

- The history of its runs, as durations coloured by state, against its typical duration.
- The list of runs, with who or what started each one and its parameters.
- A process-by-run grid, for loom-kernel pipelines, that shows at a glance which process
  failed in which run.

### One run

- Its attempts, processes and steps, drawn as a pipeline graph.
- A log window that follows the run live, with search, a minimum level, line wrapping
  and copy. It can be scoped to a step, a process or the whole run. Lines that start with
  one of the `PERIPLO_ETL_LOG_NOISE` prefixes are folded by default.
- For each loom-kernel step: the tables it read and wrote, the rows it moved and the
  Delta version it wrote, taken from its logs.
- A link to the same run in Prefect's UI, when `PERIPLO_PREFECT_UI_URL` is set.

## Operating ETLs

With `PERIPLO_ETL_ALLOW_OPERATE=true` the console can:

- start a run of a deployment, with its parameters as a JSON object;
- re-run from the failed process, for deployments that accept a `processes` parameter;
- pause and resume a deployment's schedule.

Every such action is audited before it happens and again with its outcome (see
{doc}`../architecture/extending`).

:::{warning}
The open-source build has no authentication. With operating allowed, anyone who can
reach the console can run and pause ETLs. Keep it off unless access to the console is
restricted by other means; see {doc}`../security`.
:::
