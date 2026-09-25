# Two stages: uv resolves the locked dependencies into /venv, and the runtime image
# copies only that environment and the sources. No uv, no lock file and no build tools
# ship in the final image, and the API runs as an unprivileged user.
FROM ghcr.io/astral-sh/uv:python3.12-bookworm-slim AS builder

ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PROJECT_ENVIRONMENT=/venv

WORKDIR /build
COPY pyproject.toml uv.lock ./
# The project is a package, but only its dependencies are installed here; the sources are
# copied below.
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev --no-install-project


FROM python:3.12-slim-bookworm

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PATH=/venv/bin:$PATH \
    PYTHONPATH=/app/src

RUN groupadd --system periplo && useradd --system --gid periplo --create-home periplo

COPY --from=builder /venv /venv
COPY --chown=periplo:periplo src /app/src

USER periplo
WORKDIR /app
EXPOSE 8000

CMD ["uvicorn", "--factory", "periplo.bootstrap:create_app", "--host", "0.0.0.0", "--port", "8000"]
