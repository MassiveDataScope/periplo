# syntax=docker/dockerfile:1.7
#
# Periplo, all in one: the web console and the API in a single process and a single image.
#
#   docker build -t periplo .
#   docker run --rm -p 8080:8080 -v ./my-sources.yaml:/etc/periplo/sources.yaml:ro periplo
#
# Three stages. `web` builds the console once on the build machine's own platform (its
# output is plain files, the same for every architecture); `api` resolves the locked
# Python dependencies into /venv for the target platform; the runtime stage copies only
# those two results onto a slim Python. No node, npm, uv, lock files or compilers ship.
#
# Base images are pinned by tag. For bit-for-bit reproducible builds pin them by digest
# too, e.g. `--build-arg PYTHON_IMAGE=python:3.12.14-slim-bookworm@sha256:3923…564e`, and
# let Dependabot or Renovate bump tag and digest together. Digests of the tags below, as
# of 2026-09-24 (multi-arch index):
#   python:3.12.14-slim-bookworm  sha256:392307d22300de8b5986851a12d9176dfc0fc073e65bf6523ebd7dcbeb23564e
#   node:22.23.3-bookworm-slim    sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c
#   ghcr.io/astral-sh/uv:0.9.30   sha256:538e0b39736e7feae937a65983e49d2ab75e1559d35041f9878b7b7e51de91e4

ARG PYTHON_IMAGE=python:3.12.14-slim-bookworm
ARG NODE_IMAGE=node:22.23.3-bookworm-slim
ARG UV_IMAGE=ghcr.io/astral-sh/uv:0.9.30

FROM ${UV_IMAGE} AS uv


# ---------------------------------------------------------------- web console
FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS web

ENV CI=true \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_AUDIT=false

WORKDIR /build
# Manifests first: the install layer is reused until a dependency changes.
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/
COPY packages/core/package.json packages/core/
RUN --mount=type=cache,target=/root/.npm \
    npm ci

COPY packages/core packages/core
COPY apps/web apps/web

# Optional branding of the installation, fixed at build time by Vite.
ARG VITE_BRAND_NAME=""
ARG VITE_BRAND_LOGO_URL=""
# After the build, precompress what is worth it, once, so that the API never compresses
# on the request path.
RUN npm run build -w periplo-web && node --input-type=module <<'EOF'
import { readdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { brotliCompressSync, gzipSync, constants } from "node:zlib";

const TEXT = /\.(js|mjs|css|html|svg|json|txt|map|wasm)$/;
const walk = (dir) => readdirSync(dir).flatMap((n) => {
  const p = join(dir, n);
  return statSync(p).isDirectory() ? walk(p) : [p];
});
for (const file of walk("apps/web/dist")) {
  const body = readFileSync(file);
  if (!TEXT.test(file) || body.length < 1024) continue;
  const br = brotliCompressSync(body, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } });
  const gz = gzipSync(body, { level: 9 });
  // A variant that does not save at least a tenth is not worth the extra file.
  if (br.length < body.length * 0.9) writeFileSync(file + ".br", br);
  if (gz.length < body.length * 0.9) writeFileSync(file + ".gz", gz);
}
EOF


# ---------------------------------------------------------------- API environment
FROM ${PYTHON_IMAGE} AS api

COPY --from=uv /uv /usr/local/bin/uv
ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never \
    UV_PYTHON=/usr/local/bin/python3.12 \
    UV_PROJECT_ENVIRONMENT=/venv

WORKDIR /build
COPY apps/api/pyproject.toml apps/api/uv.lock ./
# The project is a package, but only its dependencies are installed here; the sources are
# copied below.
# The heavy native libraries must come as wheels: building them from source would take
# a Rust toolchain and most of an hour, so a missing wheel fails the build instead.
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev --no-install-project \
      --no-build-package datafusion \
      --no-build-package deltalake \
      --no-build-package pyarrow
# The native wheels ship with their symbol tables; the loader only needs the dynamic
# ones, so stripping the rest changes no behaviour. pyarrow's own test suite and data
# are never imported at run time. (Distribution packages are not pinned by version:
# Debian drops superseded versions from its mirrors, which would break old builds.)
# hadolint ignore=DL3008
RUN apt-get update \
 && apt-get install --yes --no-install-recommends binutils \
 && rm -rf /venv/lib/python3.12/site-packages/pyarrow/tests \
 && find /venv -type f \( -name '*.so' -o -name '*.so.[0-9]*' \) -exec strip --strip-unneeded {} + \
 && rm -rf /var/lib/apt/lists/*

COPY apps/api/src /app/src
# Bytecode is written now, not at run time: the root filesystem may be read-only.
RUN python -m compileall -q --invalidation-mode unchecked-hash /app/src


# ---------------------------------------------------------------- runtime
FROM ${PYTHON_IMAGE} AS runtime

# tini forwards signals to uvicorn and reaps whatever a native library might leave behind.
# hadolint ignore=DL3008
RUN apt-get update \
 && apt-get install --yes --no-install-recommends tini \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --system --gid 10001 periplo \
 && useradd --system --uid 10001 --gid periplo --home-dir /nonexistent --no-create-home \
      --shell /usr/sbin/nologin periplo

# Owned by root and not writable by the process: nothing it serves can be rewritten.
COPY --from=api /venv /venv
COPY --from=api /app/src /app/src
COPY --from=web /build/apps/web/dist /app/web
# A fictional lake so that the image starts on its own; mount your sources file over it.
COPY config/sources.example.yaml /etc/periplo/sources.yaml

# Every PERIPLO_* variable is documented in apps/api/src/periplo/settings.py. uvicorn
# reads its own options from UVICORN_*, so the port can change without a new command.
ENV PATH=/venv/bin:$PATH \
    PYTHONPATH=/app/src \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    TMPDIR=/tmp \
    PERIPLO_ENV=prod \
    PERIPLO_WEB_DIR=/app/web \
    PERIPLO_SOURCES_FILE=/etc/periplo/sources.yaml \
    UVICORN_HOST=0.0.0.0 \
    UVICORN_PORT=8080 \
    UVICORN_TIMEOUT_GRACEFUL_SHUTDOWN=20

USER 10001:10001
WORKDIR /app
EXPOSE 8080
# uvicorn stops accepting on SIGTERM and lets requests in flight finish: give it the
# graceful window above plus a margin (`docker stop -t 30`, ECS stopTimeout, k8s
# terminationGracePeriodSeconds).
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD ["python", "-c", "import os, urllib.request; urllib.request.urlopen(f\"http://127.0.0.1:{os.environ.get('UVICORN_PORT', '8080')}/health/live\", timeout=2)"]

# A stop by SIGTERM is the expected end, not a failure: report it as exit code 0.
ENTRYPOINT ["/usr/bin/tini", "-e", "143", "--"]
CMD ["uvicorn", "--factory", "periplo.bootstrap:create_app"]

ARG VERSION=0.0.0-dev
ARG REVISION=unknown
ARG CREATED=unknown
ARG LICENSES=AGPL-3.0-only
ARG PYTHON_IMAGE
LABEL org.opencontainers.image.title="Periplo" \
      org.opencontainers.image.description="Open-source console for Delta Lake data lakes: catalog, SQL and web UI in one image" \
      org.opencontainers.image.source="https://github.com/MassiveDataScope/periplo" \
      org.opencontainers.image.url="https://github.com/MassiveDataScope/periplo" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}" \
      org.opencontainers.image.created="${CREATED}" \
      org.opencontainers.image.licenses="${LICENSES}" \
      org.opencontainers.image.base.name="${PYTHON_IMAGE}"
