.PHONY: api-test api-coverage api-lint api-type core-test core-coverage core-lint core-type core-e2e web-test web-coverage web-lint web-type web-build docs test coverage lint type build up dev dev-real dev-down dev-logs

api-test:
	cd apps/api && uv run pytest

# Same pytest-cov pin and options as CI, so the local number is the one CI gates on;
# --with keeps pytest-cov out of the locked dev dependencies.
api-coverage:
	cd apps/api && uv run --locked --with "pytest-cov==7.1.0" pytest tests --cov=src --cov-report=term-missing:skip-covered --cov-report=xml:coverage.xml

api-lint:
	cd apps/api && uv run ruff check src tests

api-type:
	cd apps/api && uv run mypy src tests

core-test:
	npm run test -w @periplo/core

core-coverage:
	npm run test:coverage -w @periplo/core

core-lint:
	npm run lint -w @periplo/core

core-type:
	npm run typecheck -w @periplo/core

core-e2e:
	npm run test:e2e -w @periplo/core

web-test:
	npm run test -w periplo-web

web-coverage:
	npm run test:coverage -w periplo-web

web-lint:
	npm run lint -w periplo-web

web-type:
	npm run typecheck -w periplo-web

web-build:
	npm run build -w periplo-web

# Strict build, as in CI: any warning, a broken cross-reference included, fails it. It runs in
# the apps/api project so autodoc imports the real package and the version comes from it.
docs:
	uv run --project apps/api --locked --with-requirements docs/requirements.txt \
	  sphinx-build -E -W --keep-going -b html docs docs/_build/html

test: api-test core-test web-test

# apps/api/coverage.xml plus packages/core/coverage/lcov.info and apps/web/coverage/lcov.info.
coverage: api-coverage core-coverage web-coverage

lint: api-lint core-lint web-lint

type: api-type core-type web-type

build:
	docker compose build

up:
	docker compose up -d

# Live-reloading UI in containers against a simulated API (docker-compose.dev.yml).
dev:
	docker compose -f docker-compose.dev.yml up -d
	@echo "app: http://localhost:5173  playground: http://localhost:5174"

# Same UI, but against the real API and the sources of config/sources.local.yaml, read-only.
# Temporary credentials come from the AWS CLI profile and only live in this process.
dev-real:
	@eval "$$(aws configure export-credentials --profile $${AWS_PROFILE:-default} --format env)" && \
	PERIPLO_API_URL=http://api:8000 docker compose -f docker-compose.dev.yml --profile real up -d --force-recreate api web
	@echo "app: http://localhost:5173 (real API on http://localhost:8000)"

dev-logs:
	docker compose -f docker-compose.dev.yml logs -f --tail 50

dev-down:
	docker compose -f docker-compose.dev.yml down
