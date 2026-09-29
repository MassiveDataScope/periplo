# periplo

The API behind [Periplo](https://github.com/MassiveDataScope/periplo), an open-source
console for Delta Lake data lakes: a catalog of the tables it is allowed to see and a
read-only SQL endpoint over them, built on FastAPI and DataFusion.

This distribution contains only the Python package. The web console and the all-in-one
container image are published from the same repository.

## Install

```sh
pip install periplo
```

Python 3.12, 3.13 or 3.14 is required.

## Run

```sh
PERIPLO_SOURCES_FILE=sources.yaml uvicorn --factory periplo.bootstrap:create_app
```

Every `PERIPLO_*` setting is documented in `periplo.settings`.

## Embed

`create_app` is the composition root. A product built on Periplo passes its own
implementations of the public ports through `Extensions`; any field left as `None` keeps
the open, single-tenant default.

```python
from periplo.bootstrap import create_app
from periplo.extensions import Extensions


def app():
    return create_app(extensions=Extensions(authenticator=MyAuthenticator()))
```

`Extensions` accepts an `authenticator`, `tenants`, `authorizer`, `audit` and
`orchestrators`. Nothing is discovered implicitly: only what you pass in runs.

## Documentation

<https://massivedatascope.github.io/periplo/>

## License

[AGPL-3.0-only](https://github.com/MassiveDataScope/periplo/blob/HEAD/LICENSE).
