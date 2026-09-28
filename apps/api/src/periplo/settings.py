"""Every environment variable the API reads, validated in one place.

One typed struct, converted and validated by msgspec against ``os.environ``, failing
at start-up with the name of the offending value. Each field maps to
``PERIPLO_<FIELD>``.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Annotated

import msgspec
from loom.core.config import ConfigError

PREFIX = "PERIPLO_"

Positive = Annotated[int, msgspec.Meta(ge=1)]
Seconds = Annotated[float, msgspec.Meta(gt=0)]
NonNegativeSeconds = Annotated[float, msgspec.Meta(ge=0)]


class Settings(msgspec.Struct, frozen=True, kw_only=True):
    sources_file: str | None = None
    """Path of the sources file. Required unless the application is built with one."""
    web_dir: str | None = None
    """Built web console to serve next to the API (the all-in-one image sets it); off by default."""
    discovery_folder_budget: Positive = 20_000
    max_concurrent_queries: Positive = 2
    max_result_rows: Positive = 100_000
    max_result_bytes: Positive = 64 * 1024 * 1024
    query_timeout_seconds: Seconds = 60
    metadata_ttl_seconds: NonNegativeSeconds = 30
    """How long a table's Delta snapshot is served without checking storage; ``0`` probes always."""
    metadata_cache_bytes: Positive = 32 * 1024 * 1024
    metadata_snapshots: Positive = 64
    env: str = "dev"
    """Loom environment name: ``prod`` renders logs as JSON, anything else as console."""
    log_level: str = "INFO"
    prefect_api_url: str | None = None
    """Base of Prefect's REST API; unset switches the ETL integration off."""
    prefect_api_key: str | None = None
    """Prefect Cloud API key, sent as ``Authorization: Bearer``; wins over the auth string."""
    prefect_auth_string: str | None = None
    """``user:password`` of a self-hosted Prefect server, sent as ``Authorization: Basic``."""
    prefect_ui_url: str | None = None
    """Base of Prefect's UI for deep links; never derived from the API URL."""
    prefect_tags: str = ""
    """Comma-separated tags every Prefect query is filtered by; see ``prefect_tag_list``."""
    etl_allow_operate: bool = False
    """Whether run, resume and pause are allowed (``true``/``false``/``1``/``0``)."""
    etl_log_noise: str = ""
    """Comma-separated log prefixes folded by default in the web; see ``etl_log_noise_list``."""
    prefect_timeout_seconds: Seconds = 10
    """Limit of each call to Prefect."""

    @property
    def prefect_tag_list(self) -> tuple[str, ...]:
        """``prefect_tags`` split on commas, trimmed, without empty entries."""
        return tuple(tag for tag in (part.strip() for part in self.prefect_tags.split(",")) if tag)

    @property
    def etl_log_noise_list(self) -> tuple[str, ...]:
        """``etl_log_noise`` split on commas, trimmed, without empty entries."""
        parts = (part.strip() for part in self.etl_log_noise.split(","))
        return tuple(prefix for prefix in parts if prefix)

    @classmethod
    def from_environment(cls, environ: Mapping[str, str]) -> Settings:
        """Read ``PERIPLO_*`` from ``environ``.

        Raises:
            ConfigError: Naming the variable that is missing or malformed.
        """
        raw = {
            name: environ[PREFIX + name.upper()]
            for name in cls.__struct_fields__
            if PREFIX + name.upper() in environ
        }
        try:
            return msgspec.convert(raw, cls, strict=False)
        except msgspec.ValidationError as error:
            raise ConfigError(_explain(error)) from error


def _explain(error: msgspec.ValidationError) -> str:
    # msgspec names the field as ``$.max_rows``; the operator knows it as PERIPLO_MAX_ROWS.
    message = str(error)
    field, _, _ = message.partition(" - at `$.")[2].partition("`")
    return f"{PREFIX}{field.upper()}: {message}" if field else message
