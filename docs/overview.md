# Overview

Periplo is a console for data lakes made of Delta tables on Amazon S3. You point it at
one or more buckets, and it gives the people who work with that lake one place to find
tables, understand them, query them and follow the ETLs that write them.

It ships as a single container image. One process serves the web console and the API
that backs it, on one port, with no proxy and no database of its own: everything it
shows is read from the Delta logs in your buckets and, when configured, from your ETL
orchestrator.

## What it does

| Area | What you get |
|------|--------------|
| Catalog | Tables discovered by listing your buckets, named after the folders above them, grouped and labelled the way your lake is laid out. |
| Tables | Schema and version, statistics taken from the Delta log (rows, files and bytes, per-column nulls, minimum and maximum, per-partition totals) and the commit history, without reading data files. |
| SQL | Read-only SQL over the catalog, run by [DataFusion](https://datafusion.apache.org/) inside the API and streamed back as Apache Arrow, within limits you set. |
| ETL | A dashboard of the deployments of a [Prefect](https://www.prefect.io/) workspace: runs, schedules, a process-by-run grid, the pipeline of a run and its logs. |

Read {doc}`getting-started/quickstart` to have it running in a few minutes.

## What it is not

- **Not a query engine for large jobs.** Each query runs on a single node inside the API
  process, with a row, byte and time limit. It is meant for looking at data, not for
  moving it.
- **Not a writer.** The SQL engine refuses DDL, DML and any other statement that is not a
  query, and nothing in Periplo writes to your buckets.
- **Not an access-control system, yet.** The open-source build has no authentication:
  whoever can reach it can use it. See {doc}`security` before exposing it.

## How the pieces fit

- **Web console** (`apps/web`): a React single-page application, built into static files
  that the API process serves.
- **UI core** (`packages/core`): the typed client and building blocks the console is made
  of.
- **API** (`apps/api`, the `periplo` Python package): a FastAPI application built on
  [loom-kernel](https://github.com/MassiveDataScope/loom-py). It discovers the catalog,
  reads Delta metadata with [delta-rs](https://delta-io.github.io/delta-rs/), runs queries
  and talks to the orchestrator.

{doc}`architecture/overview` describes the API in more detail, and
{doc}`architecture/extending` explains how a product built on Periplo can add
authentication, tenants, authorization and audit through five extension ports.

## License

Periplo is licensed under the GNU Affero General Public License v3.0 only
(`AGPL-3.0-only`). The example configuration files are licensed under Apache-2.0 so you
can copy them freely. If you run a modified version for others over a network, read
[the network-use section of the deployment guide](deployment/docker.md#source-code-for-network-users).
