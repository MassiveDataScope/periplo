"""Opening a table with a tenant's keys must leave none of them in the process environment.

A child process inherits the C environment, which ``os.environ`` does not reflect once a
library writes to it. The open runs in a process of its own, so a leak never reaches the
environment of the tests.
"""

from __future__ import annotations

import subprocess
import sys

OPEN_THEN_SPAWN = """
import subprocess
from periplo.catalog.adapters.delta_metadata import open_table
from periplo.catalog.ports import TableUnreadable
from periplo.credentials import ReadCredentials

keys = ReadCredentials({
    "aws_access_key_id": "AKIATENANTLEAK",
    "aws_secret_access_key": "tenant-secret-leak",
    "aws_session_token": "tenant-token-leak",
    "aws_region": "eu-west-1",
    "aws_endpoint_url": "http://127.0.0.1:9",
    "aws_allow_http": "true",
})
try:
    open_table("s3://lake/landing/orders", keys)
except TableUnreadable:
    pass
print(subprocess.run(["env"], capture_output=True, text=True, check=True).stdout)
"""


def test_a_child_process_inherits_no_tenant_secret_after_a_table_is_opened() -> None:
    clean = {"PATH": "/usr/bin:/bin", "HOME": "/nonexistent"}
    child = subprocess.run(
        [sys.executable, "-c", OPEN_THEN_SPAWN],
        capture_output=True,
        text=True,
        check=True,
        env=clean,
        timeout=60,
    )

    for secret in ("AKIATENANTLEAK", "tenant-secret-leak", "tenant-token-leak"):
        assert secret not in child.stdout
