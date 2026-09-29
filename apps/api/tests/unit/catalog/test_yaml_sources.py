from __future__ import annotations

from pathlib import Path

import pytest

from periplo.catalog.adapters.yaml_sources import ConfigurationError, load_configuration

VALID = """
version: 1
sources:
  - name: lake
    uri: s3://example-lake/
    template: "{layer}/{domain}/{table}"
    include: [a, b]
    labels: { environment: prod }
  - name: sandbox
    uri: s3://example-sandbox/tables/
    template: "{table}"
    database_prefix: sbx_
explorer:
  group_by: layer
  values:
    layer:
      a: { title: "Layer A", description: "First", order: 1 }
      b: { title: "Layer B" }
"""


def write(tmp_path: Path, text: str) -> Path:
    path = tmp_path / "sources.yaml"
    path.write_text(text)
    return path


def test_reads_sources_and_explorer_settings(tmp_path: Path) -> None:
    configuration = load_configuration(write(tmp_path, VALID))

    lake, sandbox = configuration.sources
    assert (lake.name, lake.uri, lake.template.levels) == (
        "lake",
        "s3://example-lake/",
        ("layer", "domain"),
    )
    assert lake.include == frozenset({"a", "b"})
    assert lake.labels == {"environment": "prod"}
    assert (sandbox.database_prefix, sandbox.include, sandbox.labels) == ("sbx_", None, {})
    assert configuration.group_by == ("layer",)
    assert [
        (v.value, v.title, v.description, v.order) for v in configuration.label_values["layer"]
    ] == [
        ("a", "Layer A", "First", 1),
        ("b", "Layer B", None, None),
    ]


def test_explorer_settings_are_optional(tmp_path: Path) -> None:
    text = 'version: 1\nsources:\n  - {name: x, uri: "s3://b/", template: "{table}"}\n'
    configuration = load_configuration(write(tmp_path, text))

    assert configuration.group_by == ()
    assert configuration.label_values == {}


@pytest.mark.parametrize(
    ("text", "reason"),
    [
        ("version: 2\nsources: []\n", "version"),
        ("version: 1\nsources: []\n", "at least one source"),
        (
            'version: 1\nsources:\n  - {name: x, uri: "s3://b/", template: "{table}", colour: red}\n',
            "colour",
        ),
        ('version: 1\nsources:\n  - {name: x, uri: "s3://b/"}\n', "template"),
        (
            'version: 1\nsources:\n  - {name: x, uri: "s3://b/", template: "{layer}"}\n',
            "source 'x'",
        ),
        ('version: 1\nsources:\n  - {name: x, uri: "https://b/", template: "{table}"}\n', "s3://"),
        (
            'version: 1\nsources:\n  - {name: "Bad Name", uri: "s3://b/", template: "{table}"}\n',
            "name",
        ),
        (
            'version: 1\nsources:\n  - {name: x, uri: "s3://b/", template: "{table}"}\n'
            '  - {name: x, uri: "s3://c/", template: "{table}"}\n',
            "more than once",
        ),
        (
            'version: 1\nsources:\n  - {name: x, uri: "s3://b/", template: "{layer}/{table}", labels: {layer: a}}\n',
            "both a level and a fixed label",
        ),
        (
            'version: 1\nsources:\n  - {name: x, uri: "s3://b/", template: "{table}"}\nsecrets: {}\n',
            "secrets",
        ),
        ("not: [valid", "could not be read"),
    ],
)
def test_refuses_to_start_on_a_configuration_it_does_not_understand(
    tmp_path: Path, text: str, reason: str
) -> None:
    with pytest.raises(ConfigurationError, match=reason):
        load_configuration(write(tmp_path, text))


def test_a_missing_file_is_a_configuration_error(tmp_path: Path) -> None:
    with pytest.raises(ConfigurationError, match="could not be read"):
        load_configuration(tmp_path / "nope.yaml")


DERIVED = """
version: 1
sources:
  - {name: lake, uri: "s3://b/", template: "{zone}/{domain}/{table}"}
explorer:
  group_by: [layer, sublayer]
  values:
    zone:
      core: { labels: { layer: prepared, sublayer: general } }
      vault: { title: "Protected zone", labels: { layer: prepared, sublayer: protected } }
    layer:
      prepared: { title: "Prepared", order: 2 }
"""


def test_a_folder_value_can_stand_for_several_labels_and_grouping_can_nest(tmp_path: Path) -> None:
    configuration = load_configuration(write(tmp_path, DERIVED))

    assert configuration.group_by == ("layer", "sublayer")
    assert configuration.derived_labels == {
        "zone": {
            "core": {"layer": "prepared", "sublayer": "general"},
            "vault": {"layer": "prepared", "sublayer": "protected"},
        }
    }
    assert configuration.label_values["layer"][0].title == "Prepared"


def test_a_single_group_by_may_still_be_written_as_text(tmp_path: Path) -> None:
    assert load_configuration(write(tmp_path, VALID)).group_by == ("layer",)


@pytest.mark.parametrize(
    ("values", "reason"),
    [
        ("zone:\n      core: { labels: { domain: x } }", "already a level or a fixed label"),
        ("zone:\n      core: { labels: { zone: x } }", "already a level or a fixed label"),
        ("zone:\n      core: { labels: [a] }", "must be a mapping"),
    ],
)
def test_a_derived_label_cannot_redefine_one_that_comes_from_the_path(
    tmp_path: Path, values: str, reason: str
) -> None:
    text = (
        'version: 1\nsources:\n  - {name: lake, uri: "s3://b/", template: "{zone}/{domain}/{table}"}\n'
        f"explorer:\n  values:\n    {values}\n"
    )
    with pytest.raises(ConfigurationError, match=reason):
        load_configuration(write(tmp_path, text))
