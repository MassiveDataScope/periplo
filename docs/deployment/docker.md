# Deploying with Docker

Periplo is deployed as one container image that holds the API and the built web console.
One process serves both on one port.

## Images

Each release is published under the same tags in two registries:

| Registry | Image |
|----------|-------|
| GitHub Container Registry | `ghcr.io/massivedatascope/periplo` |
| Docker Hub | `thereacherdata/periplo` |

| Tag | Meaning |
|-----|---------|
| `X.Y.Z` | One release. Use this in production. |
| `X.Y` | The latest patch release of a minor line. |
| `latest` | The latest release. |

The image labels follow the OCI conventions: `org.opencontainers.image.version` is the
release, `org.opencontainers.image.revision` the commit it was built from and
`org.opencontainers.image.source` the repository.

## What the image does

| Aspect | Value |
|--------|-------|
| Command | `uvicorn --factory periplo.bootstrap:create_app`, behind `tini`. |
| Port | `8080` (`UVICORN_PORT`). |
| User | `10001:10001`, not root. Nothing the process serves is writable by it. |
| Sources file | `/etc/periplo/sources.yaml`, a fictional example: mount yours over it. |
| Web console | `/app/web` (`PERIPLO_WEB_DIR`). |
| Logs | JSON lines on standard output (`PERIPLO_ENV=prod`). |
| Health check | `GET /health/live` every 15 seconds. |
| Stop | `SIGTERM`; requests in flight get 20 seconds to finish, and the process exits with code 0. |

The root filesystem can be mounted read-only: the process only needs a writable `/tmp`.

## Running it

A hardened `docker run`, equivalent to the repository's Compose file:

```sh
docker run -d --name periplo \
  -p 127.0.0.1:8080:8080 \
  -v "$PWD/shop-sources.yaml:/etc/periplo/sources.yaml:ro" \
  -e AWS_REGION=eu-west-1 \
  --read-only --tmpfs /tmp \
  --cap-drop ALL --security-opt no-new-privileges:true \
  --memory 2g --cpus 2 \
  --stop-timeout 30 \
  ghcr.io/massivedatascope/periplo:X.Y.Z
```

- Credentials come from the standard AWS chain: pass the `AWS_*` variables, or run on a
  platform that gives the container a role. The identity only needs to list and read.
- `--stop-timeout 30` leaves the 20-second graceful window plus a margin. On other
  platforms, set the equivalent (for example `stopTimeout` on ECS or
  `terminationGracePeriodSeconds` on Kubernetes).
- Memory and CPU limits bound what a query can take from the host; tune them together
  with the query limits in {doc}`../configuration/environment`.

### With Compose

The repository's `docker-compose.yml` runs the image with these settings and reads every
variable from a `.env` file (start from `.env.example`):

```sh
cp .env.example .env
docker compose up -d --build
```

Set `PERIPLO_IMAGE=ghcr.io/massivedatascope/periplo:X.Y.Z` in `.env` and use
`docker compose up -d` without `--build` to run a published image instead of building one.

### Health probes

| Probe | Endpoint | Answer |
|-------|----------|--------|
| Liveness | `GET /health/live` | `200` as soon as the process serves. |
| Readiness | `GET /health/ready` | `503` until the first discovery has finished, then `200`, with the metadata cache counters in the body. |

Point load balancers at readiness, so that no traffic arrives before the catalog exists.

### Exposing it

The port is bound to `127.0.0.1` in these examples on purpose: the open-source build has
no authentication. Read {doc}`../security` before making it reachable by anyone else.

## Building the image

From a checkout:

```sh
docker build -t periplo .
```

The build takes these arguments:

| Argument | Meaning |
|----------|---------|
| `VITE_BRAND_NAME`, `VITE_BRAND_LOGO_URL` | Name and logo of the organization running the installation, shown by the console. Fixed at build time. |
| `VERSION`, `REVISION`, `CREATED` | Values of the OCI version, revision and creation labels. |
| `PYTHON_IMAGE`, `NODE_IMAGE`, `UV_IMAGE` | Base images. They are pinned by tag; pin them by digest as well for reproducible builds. |

To add your own code to the image instead, see
[Building on the container image](../architecture/extending.md#building-on-the-container-image).

## Verifying a release

Released images come with a build provenance attestation, made by the reusable
release workflows of `the-reacher-data/loom-actions` on behalf of this repository. Verify it with the
[GitHub CLI](https://cli.github.com/) before you deploy:

```sh
gh attestation verify oci://ghcr.io/massivedatascope/periplo:X.Y.Z \
  --repo MassiveDataScope/periplo \
  --signer-repo the-reacher-data/loom-actions

gh attestation verify oci://docker.io/thereacherdata/periplo:X.Y.Z \
  --repo MassiveDataScope/periplo \
  --signer-repo the-reacher-data/loom-actions
```

The command fails unless the image was built from a commit of this repository by a
workflow of `the-reacher-data/loom-actions`. To require the exact image workflow, pass
`--signer-workflow the-reacher-data/loom-actions/.github/workflows/image-release.yml`
instead of `--signer-repo`; `gh` refuses both at once.

## Source code for network users

Periplo is licensed under the GNU Affero General Public License v3.0 only. Its section 13
adds one condition to the GPL that matters for a web console: **if you modify Periplo and
people use your modified version over a network, you must offer those users the
Corresponding Source of that version**, at no charge, for example through a link to a
public repository that holds exactly the code you run.

In practice:

- **Unmodified images** are built from this repository. The source of the version you run
  is the release tag `vX.Y.Z` at <https://github.com/MassiveDataScope/periplo>, and the
  image labels `org.opencontainers.image.source` and `org.opencontainers.image.revision`
  point to it.
- **Modified versions**, for example an image with your own changes to Periplo's code,
  must offer their users the source of those changes as well. Publishing your fork and
  linking to it from where your users reach the console is the simplest way.

This is a summary to help you plan a deployment, not legal advice. The
[license text](https://github.com/MassiveDataScope/periplo/blob/master/LICENSE) is what
applies; ask your own counsel if you are unsure whether it covers your case.
