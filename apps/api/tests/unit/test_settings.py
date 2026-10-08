from __future__ import annotations

import pytest
from loom.core.config import ConfigError

from periplo.etl.facets import FacetConfig
from periplo.settings import Settings


def test_reads_every_variable_from_its_prefixed_name() -> None:
    settings = Settings.from_environment(
        {
            "PERIPLO_SOURCES_FILE": "/etc/periplo/sources.yaml",
            "PERIPLO_MAX_CONCURRENT_QUERIES": "4",
            "PERIPLO_QUERY_TIMEOUT_SECONDS": "2.5",
            "PERIPLO_ENV": "prod",
            "HOME": "/nowhere",
        }
    )

    assert settings.sources_file == "/etc/periplo/sources.yaml"
    assert settings.max_concurrent_queries == 4
    assert settings.query_timeout_seconds == 2.5
    assert settings.env == "prod"
    assert settings.max_result_rows == 100_000, "an unset variable keeps its default"


def test_metadata_cache_defaults() -> None:
    settings = Settings.from_environment({})

    assert settings.metadata_ttl_seconds == 30
    assert settings.metadata_cache_bytes == 32 * 1024 * 1024
    assert settings.metadata_snapshots == 64


def test_metadata_ttl_accepts_zero_to_probe_on_every_access() -> None:
    settings = Settings.from_environment({"PERIPLO_METADATA_TTL_SECONDS": "0"})

    assert settings.metadata_ttl_seconds == 0


def test_names_the_metadata_variable_that_is_malformed() -> None:
    with pytest.raises(ConfigError, match="PERIPLO_METADATA_TTL_SECONDS"):
        Settings.from_environment({"PERIPLO_METADATA_TTL_SECONDS": "-1"})
    with pytest.raises(ConfigError, match="PERIPLO_METADATA_CACHE_BYTES"):
        Settings.from_environment({"PERIPLO_METADATA_CACHE_BYTES": "0"})
    with pytest.raises(ConfigError, match="PERIPLO_METADATA_SNAPSHOTS"):
        Settings.from_environment({"PERIPLO_METADATA_SNAPSHOTS": "0"})


def test_the_web_console_is_off_unless_named() -> None:
    assert Settings.from_environment({}).web_dir is None
    assert Settings.from_environment({"PERIPLO_WEB_DIR": "/srv/web"}).web_dir == "/srv/web"


def test_names_the_variable_that_is_malformed() -> None:
    with pytest.raises(ConfigError, match="PERIPLO_MAX_RESULT_BYTES"):
        Settings.from_environment({"PERIPLO_MAX_RESULT_BYTES": "lots"})
    with pytest.raises(ConfigError, match="PERIPLO_MAX_CONCURRENT_QUERIES"):
        Settings.from_environment({"PERIPLO_MAX_CONCURRENT_QUERIES": "0"})


def test_prefect_defaults_leave_the_integration_off() -> None:
    settings = Settings.from_environment({})

    assert settings.prefect_api_url is None
    assert settings.prefect_api_key is None
    assert settings.prefect_auth_string is None
    assert settings.prefect_ui_url is None
    assert settings.etl_allow_operate is False
    assert settings.prefect_timeout_seconds == 10
    assert settings.prefect_tag_list == ()


def test_prefect_tags_are_split_trimmed_and_without_empties() -> None:
    settings = Settings.from_environment({"PERIPLO_PREFECT_TAGS": "a, b,,c "})

    assert settings.prefect_tags == "a, b,,c "
    assert settings.prefect_tag_list == ("a", "b", "c")


@pytest.mark.parametrize(
    ("raw", "expected"), [("true", True), ("1", True), ("false", False), ("0", False)]
)
def test_etl_allow_operate_reads_a_boolean(raw: str, expected: bool) -> None:
    settings = Settings.from_environment({"PERIPLO_ETL_ALLOW_OPERATE": raw})

    assert settings.etl_allow_operate is expected


def test_names_the_etl_variable_that_is_malformed() -> None:
    with pytest.raises(ConfigError, match="PERIPLO_PREFECT_TIMEOUT_SECONDS"):
        Settings.from_environment({"PERIPLO_PREFECT_TIMEOUT_SECONDS": "0"})
    with pytest.raises(ConfigError, match="PERIPLO_ETL_ALLOW_OPERATE"):
        Settings.from_environment({"PERIPLO_ETL_ALLOW_OPERATE": "yes"})


def test_etl_log_noise_defaults_and_is_split_trimmed_and_without_empties() -> None:
    settings = Settings.from_environment({})

    assert settings.etl_log_noise_list == ()

    settings = Settings.from_environment({"PERIPLO_ETL_LOG_NOISE": "a, b,,c "})

    assert settings.etl_log_noise == "a, b,,c "
    assert settings.etl_log_noise_list == ("a", "b", "c")


@pytest.mark.parametrize(
    ("environ", "allowed"),
    [
        ({}, False),
        ({"PERIPLO_ETL_ALLOW_OPERATE": "true"}, True),
        ({"PERIPLO_ETL_ALLOW_OPERATE": "true", "PERIPLO_ETL_ALLOW_ARCHIVE": "false"}, False),
        ({"PERIPLO_ETL_ALLOW_ARCHIVE": "true"}, True),
    ],
)
def test_archiving_follows_operating_unless_set_on_its_own(
    environ: dict[str, str], allowed: bool
) -> None:
    assert Settings.from_environment(environ).etl_archive_allowed is allowed


def test_etl_facets_default_to_none_configured() -> None:
    assert Settings.from_environment({}).etl_facets == {}


def test_etl_facets_read_labels_order_hidden_and_lineage_roles_from_json() -> None:
    settings = Settings.from_environment(
        {
            "PERIPLO_ETL_FACETS": (
                '{"system": {"label": "System", "order": 1, "role": "reads"},'
                ' "writes": {"role": "writes"}, "tier": {"hidden": true}}'
            )
        }
    )
    assert settings.etl_facets == {
        "system": FacetConfig(label="System", order=1, role="reads"),
        "writes": FacetConfig(role="writes"),
        "tier": FacetConfig(hidden=True),
    }


def test_etl_facets_read_an_expects_schedule_role_with_its_values() -> None:
    settings = Settings.from_environment(
        {"PERIPLO_ETL_FACETS": '{"tier": {"role": "expects_schedule", "values": ["daily"]}}'}
    )
    assert settings.etl_facets == {
        "tier": FacetConfig(role="expects_schedule", values=["daily"]),
    }


@pytest.mark.parametrize(
    "raw",
    [
        '{"system": {"role": "owns"}}',
        '{"system": {"colour": "red"}}',
        "not json",
        '["system"]',
        '{"tier": {"role": "expects_schedule"}}',
        '{"tier": {"role": "expects_schedule", "values": []}}',
        '{"tier": {"role": "reads", "values": ["daily"]}}',
        '{"tier": {"values": ["daily"]}}',
    ],
)
def test_etl_facets_that_do_not_parse_name_the_variable(raw: str) -> None:
    with pytest.raises(ConfigError, match="PERIPLO_ETL_FACETS"):
        Settings.from_environment({"PERIPLO_ETL_FACETS": raw})
