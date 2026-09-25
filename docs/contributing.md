# Contributing

Bug reports, ideas, documentation and code are all welcome. The
[contributing guide](https://github.com/MassiveDataScope/periplo/blob/master/CONTRIBUTING.md)
in the repository is the reference; this page summarizes it.

By taking part you agree to follow the
[Code of Conduct](https://github.com/MassiveDataScope/periplo/blob/master/CODE_OF_CONDUCT.md).
To report a vulnerability, do not open an issue: follow {doc}`security`.

## Before you start

- Search the [existing issues](https://github.com/MassiveDataScope/periplo/issues) first.
  For a large change, open an issue to discuss it before writing code.
- Small fixes (typos, documentation, obvious bugs) can go straight to a pull request.
- Before your first pull request can be merged, you sign the
  [Contributor License Agreement](https://github.com/MassiveDataScope/periplo/blob/master/CLA.md)
  once, by commenting on the pull request. The `CLAAssistant` check explains how.

## Development setup

You need Python 3.12 and [uv](https://docs.astral.sh/uv/) for the API, Node.js 22 or
later and npm for the web console and the UI core, and Docker with Compose for the full
stack.

```sh
(cd apps/api && uv sync)
npm ci
make dev        # app on http://localhost:5173, playground on http://localhost:5174
```

## Running the checks

```sh
make test       # API, UI core and web app tests
make lint       # ruff and eslint
make type       # mypy and tsc
make web-build  # production build of the web app
make core-e2e   # Playwright end-to-end tests of the UI core
make docs       # this documentation, built strictly
```

The repository checks run with:

```sh
python3 scripts/publication_scan.py .
uv run --no-project --with pytest --with pyyaml pytest scripts/tests
node apps/web/dev/fixtures/generate-etl.mjs --check
```

The workflow contract test reads the reusable workflows the CI pins from GitHub; set
`LOOM_ACTIONS_REPO` to a local clone of `the-reacher-data/loom-actions` to run it offline.

CI also runs security scans, coverage thresholds and the documentation build.

Every pull request must keep all checks green. Add or update tests for any behavior you
change, and never skip, weaken or delete a test to make a check pass.

## Documentation

This site is built with Sphinx, the Furo theme and MyST Markdown, from the `docs`
folder. `make docs` builds it the way CI does, with every warning treated as an error:
a broken link to another page or to a heading fails the build. The site is published
when a change reaches the main branch.

Every `PERIPLO_*` setting must be documented in {doc}`configuration/environment`; a test
fails when one is missing.

## Branches, commits and releases

The branch name decides how a change affects the next version:

| Prefix | Use it for | Version bump |
| --- | --- | --- |
| `breaking/` | incompatible changes | major |
| `feat/`, `feature/`, `multifeature/` | new functionality | minor |
| `fix/`, `hotfix/`, `refactor/`, `perf/` | fixes and internal improvements | patch |
| `docs/`, `chore/`, `ci/`, `test/`, `build/` | changes that ship no new version | none |

Write commit messages and pull request titles with
[Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/). Maintainers
release by merging a pull request that carries the `release` label; release notes are
generated from the merged pull requests (see {doc}`changelog`).

## License

Periplo is licensed under the GNU Affero General Public License v3.0 only
(`AGPL-3.0-only`). Contributions are accepted under the terms of the CLA.
