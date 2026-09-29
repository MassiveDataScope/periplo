"""What Periplo accepts from a credentials provider, and how every route waits for it."""

from __future__ import annotations

import asyncio
import dataclasses
from datetime import UTC, datetime, timedelta

import pytest
from loom.core.config import ConfigError
from loom.rest.errors import HttpErrorMapper

from periplo.credentials import (
    EXPIRY_MARGIN,
    PROCESS_CREDENTIALS,
    CredentialsGate,
    CredentialsUnavailable,
    ProcessCredentials,
    ReadCredentials,
    check_credentials,
    check_environment,
)
from periplo.errors import CredentialsFailed, CredentialsTimeout
from periplo.tenancy import DEFAULT_TENANT, Tenant

NOW = datetime(2026, 9, 28, 12, 0, tzinfo=UTC)
KEYS = {
    "aws_access_key_id": "AKIATENANT",
    "aws_secret_access_key": "s3cr3t",
    "aws_session_token": "token",
}
WITHOUT_TOKEN = {"aws_access_key_id": "AKIATENANT", "aws_secret_access_key": "s3cr3t"}


@pytest.mark.parametrize(
    "options",
    [
        KEYS,
        {**WITHOUT_TOKEN, "session_token": "token"},
        {"AWS_ACCESS_KEY_ID": "AKIATENANT", "Secret_Access_Key": "s3cr3t", "TOKEN": "t"},
        {
            **KEYS,
            "aws_region": "eu-west-1",
            "aws_endpoint_url": "http://minio:9000",
            "aws_allow_http": "true",
        },
    ],
    ids=["keys", "token-alias", "any-case-aliases", "connection"],
)
def test_explicit_keys_are_accepted(options: dict[str, str]) -> None:
    check_credentials(ReadCredentials(options, NOW + timedelta(hours=1)), now=NOW)
    check_credentials(ReadCredentials(options), now=NOW)


@pytest.mark.parametrize(
    "options",
    [
        {},
        {"aws_region": "eu-west-1", "aws_endpoint_url": "http://minio:9000"},
        {"aws_acess_key_id": "AKIATENANT", "aws_secret_access_key": "s3cr3t"},
        {"aws_access_key_id": "AKIATENANT"},
        {"aws_secret_access_key": "s3cr3t"},
        {**KEYS, "aws_access_key_id": ""},
        {**KEYS, "access_key_id": "AKIAOTHER"},
        {"aws_access_key_id": "AKIATENANT", "AWS_ACCESS_KEY_ID": "x", "secret_access_key": "s"},
        {**KEYS, "token": "b"},
        WITHOUT_TOKEN,
        {"aws_profile": "tenant"},
        {**KEYS, "aws_profile": "tenant"},
        {**KEYS, "aws_role_arn": "arn:aws:iam::000000000000:role/tenant"},
        {**KEYS, "aws_skip_signature": "true"},
        {**KEYS, "aws_imdsv1_fallback": "true"},
        {**KEYS, "aws_endpoint_url": "http://a:9000", "aws_endpoint": "http://b:9000"},
    ],
    ids=[
        "empty",
        "connection-only",
        "misspelled",
        "key-only",
        "secret-only",
        "empty-value",
        "two-key-ids",
        "same-name-twice",
        "two-tokens",
        "no-token",
        "profile",
        "keys-and-profile",
        "role",
        "unsigned",
        "instance-metadata",
        "two-endpoints",
    ],
)
def test_anything_that_could_fall_back_to_another_identity_is_refused(
    options: dict[str, str],
) -> None:
    with pytest.raises(CredentialsUnavailable) as refused:
        check_credentials(ReadCredentials(options), now=NOW)

    assert "s3cr3t" not in refused.value.message
    assert "AKIA" not in refused.value.message


@pytest.mark.parametrize("left", [-timedelta(hours=1), timedelta(0), EXPIRY_MARGIN])
def test_credentials_that_expire_within_the_margin_are_refused(left: timedelta) -> None:
    with pytest.raises(CredentialsUnavailable):
        check_credentials(ReadCredentials(KEYS, NOW + left), now=NOW)


def test_credentials_never_show_their_options() -> None:
    keys = ReadCredentials(KEYS, NOW)

    assert "s3cr3t" not in repr(keys)
    assert not dataclasses.is_dataclass(keys)
    with pytest.raises(TypeError):
        dataclasses.asdict(keys)  # type: ignore[call-overload]
    with pytest.raises(TypeError):
        keys.storage_options["aws_secret_access_key"] = "x"  # type: ignore[index]


def test_credentials_expire_at_an_aware_instant() -> None:
    with pytest.raises(ValueError, match="timezone-aware"):
        ReadCredentials({}, datetime(2026, 9, 28))


def test_process_credentials_reach_storage_through_the_process_chain() -> None:
    assert PROCESS_CREDENTIALS.uses_process_chain
    assert not ReadCredentials(KEYS).uses_process_chain
    assert ReadCredentials(dict(KEYS)).same_storage(ReadCredentials(KEYS, NOW))
    assert not ReadCredentials(KEYS).same_storage(PROCESS_CREDENTIALS)


class _Provider:
    def __init__(self, answer: ReadCredentials | Exception, *, delay: float = 0) -> None:
        self._answer = answer
        self._delay = delay

    async def for_tenant(self, tenant: Tenant) -> ReadCredentials:
        await asyncio.sleep(self._delay)
        if isinstance(self._answer, Exception):
            raise self._answer
        return self._answer


def _gate(answer: ReadCredentials | Exception, *, delay: float = 0) -> CredentialsGate:
    return CredentialsGate(_Provider(answer, delay=delay), timeout=0.05, checked=True)


@pytest.mark.asyncio
async def test_the_default_gate_answers_the_process_credentials_unchecked() -> None:
    gate = CredentialsGate(ProcessCredentials(), timeout=1, checked=False)

    assert await gate.for_tenant(DEFAULT_TENANT) is PROCESS_CREDENTIALS


@pytest.mark.asyncio
async def test_a_checked_gate_refuses_the_process_chain_from_a_product() -> None:
    with pytest.raises(CredentialsUnavailable):
        await _gate(PROCESS_CREDENTIALS).for_tenant(DEFAULT_TENANT)


@pytest.mark.asyncio
async def test_a_checked_gate_passes_explicit_keys_through() -> None:
    keys = ReadCredentials(KEYS)

    assert await _gate(keys).for_tenant(DEFAULT_TENANT) is keys


@pytest.mark.asyncio
async def test_a_slow_provider_is_a_timeout() -> None:
    with pytest.raises(CredentialsTimeout):
        await _gate(ReadCredentials(KEYS), delay=1).for_tenant(DEFAULT_TENANT)


@pytest.mark.asyncio
async def test_a_broken_provider_fails_without_its_message() -> None:
    with pytest.raises(CredentialsFailed) as failed:
        await _gate(RuntimeError("secret AKIALEAK")).for_tenant(DEFAULT_TENANT)

    assert "AKIALEAK" not in failed.value.message
    assert failed.value.__cause__ is None
    assert failed.value.__suppress_context__


@pytest.mark.asyncio
async def test_a_provider_that_has_none_to_give_keeps_its_own_answer() -> None:
    with pytest.raises(CredentialsUnavailable, match="rotating"):
        await _gate(CredentialsUnavailable("Keys are rotating")).for_tenant(DEFAULT_TENANT)


def test_each_failure_answers_its_own_status() -> None:
    statuses = HttpErrorMapper._STATUS
    assert statuses[CredentialsUnavailable().code] == 503
    assert statuses[CredentialsTimeout(1).code] == 504
    assert statuses[CredentialsFailed().code] == 500


@pytest.mark.parametrize(
    "name",
    [
        "AWS_SKIP_SIGNATURE",
        "skip_signature",
        "AWS_ENDPOINT_URL",
        "AWS_ENDPOINT_URL_S3",
        "AWS_ENDPOINT",
        "ENDPOINT_URL",
        "ENDPOINT",
        "AWS_ALLOW_HTTP",
        "ALLOW_HTTP",
        "AWS_S3_ALLOW_UNSAFE_RENAME",
        "AWS_VIRTUAL_HOSTED_STYLE_REQUEST",
        "AWS_UNSIGNED_PAYLOAD",
        "AWS_S3_EXPRESS",
    ],
)
def test_an_environment_that_redirects_or_unsigns_tenant_reads_is_refused(name: str) -> None:
    with pytest.raises(ConfigError) as refused:
        check_environment({"PATH": "/usr/bin", name: "http://attacker.invalid"})

    assert name in str(refused.value)
    assert "attacker" not in str(refused.value)


def test_ambient_process_credentials_are_allowed() -> None:
    check_environment(
        {
            "AWS_ACCESS_KEY_ID": "AKIAPROCESS",
            "AWS_SECRET_ACCESS_KEY": "process-secret",
            "AWS_SESSION_TOKEN": "process-token",
            "AWS_REGION": "eu-west-1",
            "AWS_DEFAULT_REGION": "eu-west-1",
            "AWS_ROLE_ARN": "arn:aws:iam::000000000000:role/periplo",
            "AWS_WEB_IDENTITY_TOKEN_FILE": "/var/run/token",
            "AWS_PROFILE": "periplo",
            "HTTPS_PROXY": "http://proxy:3128",
        }
    )
