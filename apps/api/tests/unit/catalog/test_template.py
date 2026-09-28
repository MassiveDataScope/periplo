from __future__ import annotations

import pytest

from periplo.catalog.template import TemplateError, parse_template


def test_names_each_folder_level_and_ends_in_the_table() -> None:
    template = parse_template("{layer}/{domain}/{area}/{table}")

    assert template.levels == ("layer", "domain", "area")
    assert template.depth == 4


def test_a_template_may_be_just_the_table() -> None:
    assert parse_template("{table}").levels == ()


@pytest.mark.parametrize(
    ("text", "reason"),
    [
        ("{layer}/{domain}", "must end in {table}"),
        ("{table}/{layer}", "must end in {table}"),
        ("{layer}/{table}/{table}", "must end in {table}"),
        ("{layer}/{layer}/{table}", "repeated"),
        ("landing/{domain}/{table}", "not a {name}"),
        ("{Layer}/{table}", "not a {name}"),
        ("{1st}/{table}", "not a {name}"),
        ("{layer}//{table}", "not a {name}"),
        ("", "must end in {table}"),
    ],
)
def test_rejects_templates_it_cannot_apply(text: str, reason: str) -> None:
    with pytest.raises(TemplateError, match=reason):
        parse_template(text)


def test_assigns_folders_to_levels_from_left_to_right() -> None:
    match = parse_template("{layer}/{domain}/{area}/{table}").match(("core", "x", "y"))

    assert match.labels == {"layer": "core", "domain": "x", "area": "y"}
    assert match.unlabeled == ()


def test_a_shallower_path_leaves_the_last_levels_without_a_value() -> None:
    match = parse_template("{layer}/{domain}/{area}/{table}").match(("core", "x"))

    assert match.labels == {"layer": "core", "domain": "x"}
    assert match.unlabeled == ()


def test_a_deeper_path_keeps_the_extra_folders_without_a_label() -> None:
    match = parse_template("{layer}/{domain}/{table}").match(("core", "x", "y", "z"))

    assert match.labels == {"layer": "core", "domain": "x"}
    assert match.unlabeled == ("y", "z")


def test_a_table_at_the_root_has_no_labels() -> None:
    match = parse_template("{layer}/{table}").match(())

    assert match.labels == {}
    assert match.unlabeled == ()
