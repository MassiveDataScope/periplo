# Quickstart

This page gets the console running against your own lake. You need Docker and read
access to an S3 bucket that holds Delta tables.

## 1. Run the image

The image ships with a sources file that points at a fictional bucket, so it starts on
its own:

```sh
docker run --rm -p 127.0.0.1:8080:8080 ghcr.io/massivedatascope/periplo:latest
```

Open <http://localhost:8080>. The console loads, and its discovery page reports that
`s3://example-lake/` could not be listed: the bucket does not exist. The next step points
Periplo at yours.

The same image is published on Docker Hub as `thereacherdata/periplo`. Prefer a fixed
version (`X.Y.Z`) over `latest` for anything but a first look; see
{doc}`../deployment/docker`.

## 2. Describe your lake

Create a sources file, for example `shop-sources.yaml`, that says where your tables are
and what the folders above them mean:

```yaml
version: 1

sources:
  - name: shop
    uri: s3://shop-lake/
    template: "{layer}/{domain}/{table}"
```

With this template a table stored at `s3://shop-lake/curated/sales/orders/` appears as
table `orders` in database `curated_sales`, labelled `layer: curated` and
`domain: sales`. {doc}`../configuration/sources` explains every field.

## 3. Give it credentials and start it

Periplo takes S3 credentials from the standard AWS chain: environment variables, or the
role of the machine or task it runs on. It only lists folders and reads files; give it a
read-only identity.

```sh
docker run --rm -p 127.0.0.1:8080:8080 \
  -v "$PWD/shop-sources.yaml:/etc/periplo/sources.yaml:ro" \
  -e AWS_REGION=eu-west-1 \
  -e AWS_ACCESS_KEY_ID -e AWS_SECRET_ACCESS_KEY -e AWS_SESSION_TOKEN \
  ghcr.io/massivedatascope/periplo:latest
```

The first discovery starts with the process. Until it finishes, `/health/ready` answers
`503` and the catalog is empty; then your tables appear, and the SQL editor can query
them:

```sql
SELECT * FROM curated_sales.orders LIMIT 10
```

## 4. Optional: follow your ETLs

If your pipelines run on Prefect, point Periplo at its API and the ETL section lights up:

```sh
-e PERIPLO_PREFECT_API_URL=http://prefect.internal:4200/api \
-e PERIPLO_PREFECT_TAGS=shop
```

See {doc}`../etl/console`.

## Running from a checkout

The repository has a Compose file that builds the image from source and runs it with the
same hardening you would use in production (read-only root filesystem, no capabilities,
port bound to localhost):

```sh
git clone https://github.com/MassiveDataScope/periplo.git
cd periplo
cp .env.example .env    # then set PERIPLO_SOURCES_FILE and the AWS variables
docker compose up -d --build
```

The console is then on <http://localhost:8080>, or on the port set by `PERIPLO_PORT`.

## Next steps

- {doc}`../configuration/environment`: every setting, with its default.
- {doc}`../security`: read this before anyone else can reach the console.
- {doc}`../architecture/extending`: build your own product on Periplo.
