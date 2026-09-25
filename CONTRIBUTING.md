# Contributing to Periplo

Thanks for your interest in Periplo, by MassiveDataScope. Bug reports, ideas, documentation
and code are all welcome.

By taking part you agree to follow our [Code of Conduct](CODE_OF_CONDUCT.md). To report a
security vulnerability, **do not open an issue**: follow [SECURITY.md](SECURITY.md).

## Before you start

- Search the existing issues first. For a large change, open an issue to discuss it before
  writing code, so that your work fits the direction of the project.
- Small fixes (typos, documentation, obvious bugs) can go straight to a pull request.

## Contributor License Agreement

Before we can merge your first pull request you must sign the
[Contributor License Agreement](CLA.md). You sign once, by commenting on your pull request; the
`CLAAssistant` check explains how and turns green when every author has signed. We use a CLA,
not a Developer Certificate of Origin, so you do not need `Signed-off-by` lines.

## Development setup

You need:

- Python 3.12 and [uv](https://docs.astral.sh/uv/) for the API (`apps/api`);
- Node.js 22 or later and npm for the web app (`apps/web`) and the UI core (`packages/core`);
- Docker with Compose, to run the full stack.

Install the dependencies:

```sh
(cd apps/api && uv sync)
npm ci
```

Run the stack with live reload against a simulated API:

```sh
make dev        # app on http://localhost:5173, playground on http://localhost:5174
make dev-logs
make dev-down
```

## Running the checks

Run the main checks before you open a pull request (CI also runs security scans, coverage
thresholds and the documentation build):

```sh
make test       # API, UI core and web app tests
make lint       # ruff and eslint
make type       # mypy and tsc
make web-build  # production build of the web app
make core-e2e   # Playwright end-to-end tests of the UI core
make docs       # documentation site, warnings as errors
```

The repository checks run with:

```sh
python3 scripts/publication_scan.py .
uv run --no-project --with pytest --with pyyaml pytest scripts/tests
node apps/web/dev/fixtures/generate-etl.mjs --check
```

The workflow contract test reads the reusable workflows the CI pins from GitHub; set
`LOOM_ACTIONS_REPO` to a local clone of `the-reacher-data/loom-actions` to run it offline.

Every pull request must keep all checks green. Add or update tests for any behavior you change,
and never skip, weaken or delete a test to make a check pass.

## Branches

Branch names decide how a change affects the next version:

| Prefix | Use it for | Version bump |
| --- | --- | --- |
| `breaking/` | incompatible changes | major |
| `feat/`, `feature/`, `multifeature/` | new functionality | minor |
| `fix/`, `hotfix/`, `refactor/`, `perf/` | fixes and internal improvements | patch |
| `docs/`, `chore/`, `ci/`, `test/`, `build/` | changes that ship no new version | none |

Maintainers decide when to release: merging a pull request that carries the `release` label
publishes a new version. Contributors do not need to add it.

## Commits and pull requests

- Write commit messages and pull request titles with
  [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/), for example
  `fix(web): keep the filter when the page reloads` or `feat(api)!: …` for a breaking change.
- Keep each pull request focused on one change, and fill in the pull request template.
- Update the documentation when behavior changes. Release notes are generated from the merged
  pull requests, so there is no changelog to edit by hand.
- Never commit credentials, tokens or personal data. Use obviously fake values in examples
  and tests.

## Optional pre-push hook

The repository ships a pre-push hook that runs the publication scan on the commits you are
about to push, so that internal references, account identifiers or keys are caught before they
reach a pull request. It needs Python 3.11 or later. Enable it once per clone:

```sh
git config core.hooksPath scripts/hooks
```

## License

Periplo is licensed under the GNU Affero General Public License v3.0 only (`AGPL-3.0-only`).
Files that carry a different license say so in their header. Contributions are accepted under
the terms of the [CLA](CLA.md).
