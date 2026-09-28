# Security

## Reporting a vulnerability

**Do not report security vulnerabilities through public issues, pull requests or
discussions.** Report them privately through GitHub Private Vulnerability Reporting:
open the repository's **Security** tab and choose **Report a vulnerability**, or go
straight to
<https://github.com/MassiveDataScope/periplo/security/advisories/new>.

Security fixes are released for the latest minor release line. We aim to acknowledge a
report within 3 business days, assess it within 7 days, and release a fix with an
advisory within 90 days. The
[security policy](https://github.com/MassiveDataScope/periplo/blob/master/SECURITY.md)
is the reference: it lists what a useful report includes, the other ways to reach us, and
how disclosure is agreed.

## Security model of a deployment

What follows describes the open-source build with its defaults. A product that brings
its own extension ports (see {doc}`architecture/extending`) changes the first two points.

### No authentication

Every caller is anonymous, and everyone who can reach the console can use all of it:
browse the catalog, read table metadata and run queries. Either keep it on a network
only trusted people reach, put an authenticating proxy in front of it, or add an
`Authenticator` and an `Authorizer` of your own.

The examples in this documentation and the repository's Compose file bind the port to
`127.0.0.1` for this reason.

### Operating ETLs is off

`PERIPLO_ETL_ALLOW_OPERATE` is `false` by default, so the console can look at ETLs but
not run them or change their schedules. Turned on without authentication, anyone who can
reach the console can operate them.

### Read-only data access

- Discovery only lists folders; table metadata only reads Delta logs.
- The SQL engine runs every query with DDL, DML and other statements disabled, on a
  session that holds only the catalog tables the query names. It cannot create tables
  over other locations or write anywhere.
- Queries are bounded by the concurrency, row, byte and time limits of
  {doc}`configuration/environment`.
- Credentials come from the standard AWS chain and never from the sources file. Give
  Periplo an identity that can only list and read the buckets it serves.

Anyone who can run queries can read every table in the catalog. Scope what the catalog
contains with the sources file and with the permissions of that identity.

### Audit

State-changing actions and every query are recorded through the audit port. The default
sink writes one structured log line per event. For queries it logs a SHA-256 hash of the
normalized SQL and its first 512 characters, never the rows returned.

### The container

The image runs as an unprivileged user, works with a read-only root filesystem, and
needs no Linux capabilities. {doc}`deployment/docker` shows a `docker run` with these
restrictions, and how to verify that an image was built from this repository.
