"""The compose files forward the settings the API reads, so an operator can set them.

The settings are read from ``settings.py`` with ``ast`` (see ``test_docs_env``): these tests
run with the standard library, pytest and PyYAML only, without the API's dependencies.
"""

from __future__ import annotations

import pytest
import yaml
from test_docs_env import ROOT, _variables

# Set by the compose file or the image itself rather than taken from the operator.
NOT_FORWARDED = {
    # The image sets it to its built console; an empty value would switch the console off.
    "docker-compose.yml": {"PERIPLO_WEB_DIR"},
    "docker-compose.dev.yml": {
        # The development API serves no web console; Vite serves it on its own port.
        "PERIPLO_WEB_DIR",
        # Logging and query limits keep the application defaults: both stacks read the same
        # .env, where .env.example sets them for the deployable one (PERIPLO_ENV=prod).
        "PERIPLO_ENV",
        "PERIPLO_LOG_LEVEL",
        "PERIPLO_MAX_CONCURRENT_QUERIES",
        "PERIPLO_QUERY_TIMEOUT_SECONDS",
        "PERIPLO_MAX_RESULT_ROWS",
        "PERIPLO_MAX_RESULT_BYTES",
        "PERIPLO_DISCOVERY_FOLDER_BUDGET",
        "PERIPLO_METADATA_TTL_SECONDS",
        "PERIPLO_METADATA_CACHE_BYTES",
        "PERIPLO_METADATA_SNAPSHOTS",
    },
}
SERVICES = {"docker-compose.yml": "periplo", "docker-compose.dev.yml": "api"}


def _forwarded(compose: str) -> set[str]:
    document = yaml.safe_load((ROOT / compose).read_text(encoding="utf-8"))
    environment = document["services"][SERVICES[compose]]["environment"]
    assert isinstance(environment, dict), f"{compose}: environment must be a mapping"
    return set(environment)


@pytest.mark.parametrize("compose", sorted(SERVICES))
def test_compose_forwards_every_setting(compose: str) -> None:
    expected = set(_variables()) - NOT_FORWARDED[compose]

    missing = sorted(expected - _forwarded(compose))

    assert not missing, f"{compose} does not forward {missing}"


@pytest.mark.parametrize("compose", sorted(SERVICES))
def test_every_exclusion_is_still_a_setting(compose: str) -> None:
    stale = sorted(NOT_FORWARDED[compose] - set(_variables()))

    assert not stale, f"NOT_FORWARDED[{compose!r}] names no setting: {stale}"
