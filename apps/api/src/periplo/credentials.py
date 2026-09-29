"""Storage credentials, per tenant.

Every read of storage opens it with the :class:`ReadCredentials` a
:class:`CredentialsProvider` returns for the tenant it reads for: discovery, a table's
log, its statistics and history, and a query's data files. Every route asks for them
through one :class:`CredentialsGate`, which bounds the wait and, for a product's
provider, refuses anything but explicit keys (:func:`check_credentials`).

The open-core default, :class:`ProcessCredentials`, answers :data:`PROCESS_CREDENTIALS`
for every tenant: no storage options, so delta-rs and pyarrow use the process's own
credential chain.
"""

from __future__ import annotations

import asyncio
from collections.abc import Callable, Collection, Mapping
from datetime import UTC, datetime, timedelta
from types import MappingProxyType
from typing import Final, Protocol

from loom.core.config import ConfigError
from loom.core.logger import get_logger

from periplo.errors import CredentialsFailed, CredentialsTimeout, CredentialsUnavailable
from periplo.tenancy import Tenant

__all__ = [
    "ACCESS_KEY_ID_KEYS",
    "CONNECTION_KEYS",
    "REDIRECTING_ENVIRONMENT",
    "ENDPOINT_KEYS",
    "EXPIRY_MARGIN",
    "PROCESS_CREDENTIALS",
    "SECRET_ACCESS_KEY_KEYS",
    "SESSION_TOKEN_KEYS",
    "CredentialsGate",
    "CredentialsProvider",
    "CredentialsUnavailable",
    "ProcessCredentials",
    "ReadCredentials",
    "check_credentials",
    "check_environment",
    "check_storage_options",
    "option",
]

_log = get_logger(__name__)

ACCESS_KEY_ID_KEYS: Final = frozenset({"aws_access_key_id", "access_key_id"})
"""The names object_store reads an access key id from, compared without case."""
SECRET_ACCESS_KEY_KEYS: Final = frozenset({"aws_secret_access_key", "secret_access_key"})
"""The names object_store reads a secret access key from, compared without case."""
SESSION_TOKEN_KEYS: Final = frozenset({"aws_session_token", "aws_token", "session_token", "token"})
"""The names object_store reads a session token from, compared without case."""
ENDPOINT_KEYS: Final = frozenset({"aws_endpoint_url", "aws_endpoint"})
"""The names of the endpoint; at most one of them may be given."""
CONNECTION_KEYS: Final = frozenset(
    {
        "aws_region",
        "aws_endpoint_url",
        "aws_endpoint",
        "aws_allow_http",
        "aws_virtual_hosted_style_request",
    }
)
"""Where and how to reach storage; none of them says where credentials come from."""

_ALLOWED: Final = ACCESS_KEY_ID_KEYS | SECRET_ACCESS_KEY_KEYS | SESSION_TOKEN_KEYS | CONNECTION_KEYS

REDIRECTING_ENVIRONMENT: Final = frozenset(
    {
        "aws_skip_signature",
        "skip_signature",
        "aws_unsigned_payload",
        "unsigned_payload",
        "aws_endpoint_url",
        "aws_endpoint_url_s3",
        "aws_endpoint",
        "endpoint_url",
        "endpoint",
        "aws_allow_http",
        "allow_http",
        "aws_virtual_hosted_style_request",
        "virtual_hosted_style_request",
        "aws_s3_express",
        "s3_express",
        "aws_s3_allow_unsafe_rename",
    }
)
"""Environment variables delta-rs reads, in any case, that change where a tenant read goes
or how it is signed, whatever keys it carries."""

EXPIRY_MARGIN: Final = timedelta(minutes=1)
"""How long credentials must still work when a provider hands them over."""


class ReadCredentials:
    """What storage is opened with, for one tenant, until ``expires_at``.

    Not a dataclass: neither ``repr`` nor ``dataclasses.asdict`` ever shows the options.
    """

    __slots__ = ("_expires_at", "_storage_options")

    def __init__(
        self, storage_options: Mapping[str, str], expires_at: datetime | None = None
    ) -> None:
        """
        Args:
            storage_options: object_store configuration keys, as delta-rs takes them
                in ``storage_options``; empty means the process's own credential chain.
            expires_at: When they stop working, timezone-aware; ``None`` when they do
                not expire.

        Raises:
            ValueError: When ``expires_at`` is not timezone-aware.
        """
        if expires_at is not None and expires_at.tzinfo is None:
            raise ValueError("expires_at must be timezone-aware")
        self._storage_options = dict(storage_options)
        self._expires_at = expires_at

    @property
    def storage_options(self) -> Mapping[str, str]:
        """A read-only view of the object_store configuration keys."""
        return MappingProxyType(self._storage_options)

    @property
    def expires_at(self) -> datetime | None:
        return self._expires_at

    @property
    def uses_process_chain(self) -> bool:
        """Whether storage is reached with the process's own credential chain."""
        return not self._storage_options

    def same_storage(self, other: ReadCredentials) -> bool:
        """Whether *other* reaches storage with exactly the same options."""
        return self._storage_options == other._storage_options

    def storage_key(self) -> tuple[tuple[str, str], ...]:
        """A hashable identity of the storage options. It holds the options themselves."""
        return tuple(sorted(self._storage_options.items()))

    def __repr__(self) -> str:
        hidden = len(self._storage_options)
        return f"ReadCredentials(<{hidden} storage options>, expires_at={self._expires_at!r})"


PROCESS_CREDENTIALS: Final = ReadCredentials({})
"""No storage options: the process's own credential chain, as with no provider at all."""


class CredentialsProvider(Protocol):
    async def for_tenant(self, tenant: Tenant) -> ReadCredentials:
        """The credentials every read for *tenant* uses now.

        Asked on the event loop, once per request that reads storage and once per
        discovery, through a :class:`CredentialsGate`. Answer explicit keys only (see
        :func:`check_credentials`).

        Raises:
            CredentialsUnavailable: When there are none to give; answered ``503``.
                Anything else is answered ``500``, and logged by its type only. Neither
                is ever replaced by the process's own credentials.
        """
        ...


class ProcessCredentials:
    """Default :class:`CredentialsProvider`: :data:`PROCESS_CREDENTIALS` for every tenant."""

    async def for_tenant(self, tenant: Tenant) -> ReadCredentials:
        return PROCESS_CREDENTIALS


def check_credentials(credentials: ReadCredentials, *, now: datetime) -> None:
    """Refuse credentials that could let storage fall back to any other identity.

    Accepted: exactly one access key id, one secret access key and one session token,
    temporary credentials, under the names object_store reads (:data:`ACCESS_KEY_ID_KEYS`,
    :data:`SECRET_ACCESS_KEY_KEYS`, :data:`SESSION_TOKEN_KEYS`), plus any of
    :data:`CONNECTION_KEYS` with at most one of :data:`ENDPOINT_KEYS`; names compared
    without case, no value empty; and an
    ``expires_at`` later than *now* plus :data:`EXPIRY_MARGIN`. Anything else, a profile,
    a role or keys without a token among them, would let delta-rs complete the options
    from the process's environment.

    Raises:
        CredentialsUnavailable: Naming neither a key nor a value.
    """
    check_storage_options(credentials.storage_options)
    expires_at = credentials.expires_at
    _require(expires_at is None or expires_at > now + EXPIRY_MARGIN, "they expire too soon")


def check_storage_options(options: Mapping[str, str]) -> None:
    """The shape half of :func:`check_credentials`: explicit keys, and nothing else.

    Raises:
        CredentialsUnavailable: Naming neither a key nor a value.
    """
    names = [name.lower() for name in options]
    _require(len(set(names)) == len(names), "a storage option is given twice")
    _require(set(names) <= _ALLOWED, "a storage option is not allowed")
    _require(all(value.strip() for value in options.values()), "a storage option is empty")
    _require(_count(names, ACCESS_KEY_ID_KEYS) == 1, "exactly one access key id is needed")
    _require(_count(names, SECRET_ACCESS_KEY_KEYS) == 1, "exactly one secret key is needed")
    _require(_count(names, SESSION_TOKEN_KEYS) == 1, "exactly one session token is needed")
    _require(_count(names, ENDPOINT_KEYS) <= 1, "at most one endpoint is allowed")


def option(options: Mapping[str, str], names: frozenset[str]) -> str | None:
    """The value of whichever of *names* is in *options*, compared without case."""
    return next((value for key, value in options.items() if key.lower() in names), None)


def check_environment(environ: Mapping[str, str]) -> None:
    """Refuse to serve a credentials provider from an environment that redirects its reads.

    The process's own credentials are allowed: every answer of a provider carries its
    keys, so no tenant read is signed with them. What is refused is any of
    :data:`REDIRECTING_ENVIRONMENT`, which delta-rs would apply to every read.

    Raises:
        ConfigError: Naming the variables, never their values.
    """
    found = sorted(name for name in environ if name.lower() in REDIRECTING_ENVIRONMENT)
    if found:
        raise ConfigError(
            f"{', '.join(found)} would redirect or unsign every tenant's reads: "
            "unset it when a credentials provider is configured"
        )


def _count(names: Collection[str], group: frozenset[str]) -> int:
    return sum(name in group for name in names)


def _require(condition: bool, reason: str) -> None:
    if condition:
        return
    _log.warning("credentials.refused", reason=reason)
    raise CredentialsUnavailable("The storage credentials of this tenant are not usable")


class CredentialsGate:
    """How every route asks for a tenant's credentials.

    The wait is bounded by *timeout* (``504``); a provider that breaks is answered
    ``500`` and logged by the type of its error only, since its message may carry a
    secret. With ``checked``, what the provider answers goes through
    :func:`check_credentials` before anything reads with it.
    """

    def __init__(
        self,
        provider: CredentialsProvider,
        *,
        timeout: float,
        checked: bool,
        clock: Callable[[], datetime] = lambda: datetime.now(UTC),
    ) -> None:
        self._provider = provider
        self._timeout = timeout
        self._checked = checked
        self._clock = clock

    async def for_tenant(self, tenant: Tenant) -> ReadCredentials:
        """Raises ``CredentialsUnavailable``, ``CredentialsTimeout`` or ``CredentialsFailed``."""
        credentials = await self._fetch(tenant)
        if self._checked:
            check_credentials(credentials, now=self._clock())
        return credentials

    async def _fetch(self, tenant: Tenant) -> ReadCredentials:
        try:
            async with asyncio.timeout(self._timeout):
                return await self._provider.for_tenant(tenant)
        except CredentialsUnavailable:
            raise
        except TimeoutError:
            raise CredentialsTimeout(self._timeout) from None
        except Exception as error:  # noqa: BLE001 - logged by type: its message may hold a secret
            _log.error("credentials.provider_failed", error=type(error).__name__)
            raise CredentialsFailed from None
