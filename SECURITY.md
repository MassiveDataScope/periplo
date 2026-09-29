# Security Policy

Periplo is developed by MassiveDataScope. We take the security of Periplo and of
the people who run it seriously, and we appreciate responsible disclosure.

## Supported versions

Security fixes are released for the latest minor release line. Older lines do
not receive backports; please upgrade to the latest release before reporting.

| Version               | Supported |
| --------------------- | --------- |
| Latest minor release  | Yes       |
| Older releases        | No        |

## Reporting a vulnerability

**Please do not report security vulnerabilities through public issues, pull
requests or discussions.**

Report them privately through GitHub Private Vulnerability Reporting:

1. Open the repository's **Security** tab.
2. Choose **Report a vulnerability**
   (<https://github.com/MassiveDataScope/periplo/security/advisories/new>).
3. Describe the issue, the affected version, and the steps to reproduce it.

If you cannot use GitHub, write to <info@massivedatascope.info>.

A useful report includes:

- the affected version or image tag, and how Periplo is deployed;
- the type of issue (for example injection, authentication bypass, or
  information disclosure);
- step-by-step instructions or a proof of concept to reproduce it;
- the impact you believe it has.

Please do not include real credentials or personal data in the report.

## What to expect

| Step                                  | Target                               |
| ------------------------------------- | ------------------------------------ |
| Acknowledgement of your report        | within 3 business days               |
| Initial assessment and severity       | within 7 days                        |
| Fix released and advisory published   | within 90 days of the report         |

We will keep you informed of our progress, may ask for more details, and will
agree on a disclosure date with you. If an issue is already being exploited, we
may publish a fix and an advisory sooner. With your permission, we credit
reporters in the published advisory.

## Scope

This policy covers the code in this repository and the container images and
packages built from it. Vulnerabilities in third-party dependencies should also
be reported to their maintainers; tell us if they affect Periplo.
