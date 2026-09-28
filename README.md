<p align="center">
  <img src="docs/_static/logo.svg" alt="Periplo logo" width="96">
</p>

# Periplo

[![CI](https://github.com/MassiveDataScope/periplo/actions/workflows/ci.yml/badge.svg?branch=master)](https://github.com/MassiveDataScope/periplo/actions/workflows/ci.yml)
[![Docs](https://github.com/MassiveDataScope/periplo/actions/workflows/docs.yml/badge.svg?branch=master)](https://massivedatascope.github.io/periplo/)
[![Release](https://img.shields.io/github/v/release/MassiveDataScope/periplo?sort=semver&color=blue)](https://github.com/MassiveDataScope/periplo/releases/latest)
[![PyPI](https://img.shields.io/pypi/v/periplo)](https://pypi.org/project/periplo/)
[![Python versions](https://img.shields.io/pypi/pyversions/periplo?logo=python&logoColor=white)](https://pypi.org/project/periplo/)
[![Quality Gate](https://sonarcloud.io/api/project_badges/measure?project=MassiveDataScope_periplo&metric=alert_status)](https://sonarcloud.io/summary/new_code?id=MassiveDataScope_periplo)
[![Security Rating](https://sonarcloud.io/api/project_badges/measure?project=MassiveDataScope_periplo&metric=security_rating)](https://sonarcloud.io/summary/new_code?id=MassiveDataScope_periplo)
[![Vulnerabilities](https://sonarcloud.io/api/project_badges/measure?project=MassiveDataScope_periplo&metric=vulnerabilities)](https://sonarcloud.io/summary/new_code?id=MassiveDataScope_periplo)
[![Coverage](https://codecov.io/gh/MassiveDataScope/periplo/branch/master/graph/badge.svg)](https://app.codecov.io/gh/MassiveDataScope/periplo/tree/master)
[![GHCR](https://img.shields.io/badge/ghcr.io-massivedatascope%2Fperiplo-0075C4?logo=docker&logoColor=white)](https://github.com/MassiveDataScope/periplo/pkgs/container/periplo)
[![Docker Hub](https://img.shields.io/badge/dockerhub-thereacherdata%2Fperiplo-2496ED?logo=docker&logoColor=white)](https://hub.docker.com/r/thereacherdata/periplo)
[![License: AGPL-3.0-only](https://img.shields.io/badge/license-AGPL--3.0--only-blue)](LICENSE)

A console for data lakes made of Delta tables on Amazon S3: find the tables, read their
schema, statistics and history, query them with read-only SQL, and follow the Prefect
ETLs that write them. One container, one port, no database of its own.

Periplo is built by MassiveDataScope. Products built on it add identity, tenants,
authorization, audit and their own orchestrators through five extension ports, without
touching the core.

**Documentation: <https://massivedatascope.github.io/periplo/>**

## Installation

Run the image. It ships with a sources file that points at a fictional bucket, so it
starts on its own:

```sh
docker run --rm -p 127.0.0.1:8080:8080 ghcr.io/massivedatascope/periplo:latest
```

Open <http://localhost:8080>. The same image is on Docker Hub as
`thereacherdata/periplo`.

To see your own lake, describe it in a `sources.yaml`:

```yaml
version: 1

sources:
  - name: shop
    uri: s3://shop-lake/
    template: "{layer}/{domain}/{table}"
```

and mount it, with read-only AWS credentials from your environment:

```sh
docker run --rm -p 127.0.0.1:8080:8080 \
  -v "$PWD/sources.yaml:/etc/periplo/sources.yaml:ro" \
  -e AWS_REGION=eu-west-1 \
  -e AWS_ACCESS_KEY_ID -e AWS_SECRET_ACCESS_KEY -e AWS_SESSION_TOKEN \
  ghcr.io/massivedatascope/periplo:latest
```

A table stored at `s3://shop-lake/curated/sales/orders/` then appears as
`curated_sales.orders`. To follow your ETLs, add
`-e PERIPLO_PREFECT_API_URL=http://prefect.internal:4200/api`.

From a checkout, Compose builds the image and runs it hardened (read-only filesystem,
no capabilities, port bound to localhost):

```sh
git clone https://github.com/MassiveDataScope/periplo.git
cd periplo
cp .env.example .env    # then set PERIPLO_SOURCES_FILE and the AWS variables
docker compose up -d --build
```

To build your own product on Periplo, install the Python package (Python 3.12 to 3.14):

```sh
pip install periplo
```

## A simple example

A console where everyone may browse the catalog, nobody may run SQL, and every audit
event goes to standard output:

```python
# app.py
import sys

import msgspec
from fastapi import FastAPI

from periplo.access import Action, AuditEvent, Denied, Target
from periplo.bootstrap import create_app
from periplo.extensions import Extensions
from periplo.tenancy import RequestContext


class CatalogOnly:
    """Anyone may browse the catalog; nobody may run SQL."""

    async def authorize(self, context: RequestContext, action: Action, target: Target) -> None:
        if action is Action.QUERY:
            raise Denied("SQL is disabled on this console", code="sql_disabled")


class StdoutAudit:
    """One JSON line per audit event."""

    async def record(self, event: AuditEvent) -> None:
        sys.stdout.write(msgspec.json.encode(event).decode() + "\n")


def create_catalog_app() -> FastAPI:
    return create_app(extensions=Extensions(authorizer=CatalogOnly(), audit=StdoutAudit()))
```

Start it with the `sources.yaml` above and try a query:

```sh
PERIPLO_SOURCES_FILE=sources.yaml uvicorn --factory app:create_catalog_app
```

```sh
$ curl -X POST localhost:8000/api/v1/queries \
    -H 'content-type: application/json' -d '{"sql": "SELECT 1"}'
{"detail":{"code":"sql_disabled","message":"SQL is disabled on this console","retryable":false}}
```

The request is refused with `403`, and the server prints the audit event:

```json
{"at":"…","tenant":"default","subject":"","action":"query","target":[],"outcome":"denied","detail":{"sql":"SELECT 1","code":"sql_disabled"}}
```

Any port left out of `Extensions` keeps its open-source default. [Extending
Periplo](https://massivedatascope.github.io/periplo/architecture/extending.html)
describes all five ports and a complete example.

## Documentation

- [Quickstart](https://massivedatascope.github.io/periplo/getting-started/quickstart.html)
- [Configuration](https://massivedatascope.github.io/periplo/configuration/environment.html):
  every `PERIPLO_*` variable, and the [sources file](https://massivedatascope.github.io/periplo/configuration/sources.html)
- [ETL console](https://massivedatascope.github.io/periplo/etl/console.html)
- [Deployment with Docker](https://massivedatascope.github.io/periplo/deployment/docker.html)
- [Architecture](https://massivedatascope.github.io/periplo/architecture/overview.html)

## Contributing

Contributions are welcome. [CONTRIBUTING.md](CONTRIBUTING.md) explains how to set up the
repository, run the checks and open a pull request. Every contributor signs the
[Contributor License Agreement](CLA.md) once, by commenting on their first pull request.

## Security

The open-source build has no authentication: anyone who can reach the console can use
all of it. Keep it on a trusted network or behind an authenticating proxy, and read the
[security model](https://massivedatascope.github.io/periplo/security.html) before
exposing it.

To report a vulnerability, follow [SECURITY.md](SECURITY.md). Do not open a public issue.

## License

Periplo is licensed under the [GNU Affero General Public License v3.0 only](LICENSE)
(`AGPL-3.0-only`). The example configuration files (`.env.example`,
`.env.etl.example` and `config/sources.example.yaml`) are licensed under
[Apache-2.0](LICENSES/Apache-2.0.txt).
