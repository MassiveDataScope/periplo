from __future__ import annotations

from datetime import UTC, datetime

from periplo.etl.loomlog import Mark, StepFacts, is_noise, parse_facts, parse_marks

_T0 = datetime(2026, 9, 23, 8, 0, 0, tzinfo=UTC)
_T1 = datetime(2026, 9, 23, 8, 0, 5, tzinfo=UTC)


def test_parse_marks_reads_process_start_lines_and_ignores_the_rest() -> None:
    lines = [
        (_T0, "process start process=StagingCdcProcess process_run_id=abc123 nodes=2"),
        (_T1, "step start step=StagingCdcStep sources=[TableRef('x.y')]"),
    ]

    marks = parse_marks(lines)

    assert marks == [Mark(timestamp=_T0, process="StagingCdcProcess", nodes=2)]


def test_parse_marks_tolerates_a_line_without_nodes() -> None:
    marks = parse_marks([(_T0, "process start process=DimensionsProcess run=xyz")])

    assert marks == [Mark(timestamp=_T0, process="DimensionsProcess", nodes=None)]


def test_parse_facts_from_orders_snapshot_step_lines_with_a_named_ref() -> None:
    messages = [
        "read source kind=postgres ref=TableRef('shop_orders.orders_snapshot')",
        "write target ref=TableRef('shop_orders.orders_snapshot')",
        "postgres read complete rows=9779 duration_s=1.2",
        "{'event': 'delta write', 'mode': 'replace_partitions', "
        "'uri': 's3://bucket/orders_snapshot', 'version': 298, 'rows': 9779}",
        "{'event': 'delta write', 'mode': 'replace_partitions', "
        "'uri': 's3://bucket/orders_snapshot', 'version': 298, 'rows': None}",
    ]

    facts = parse_facts(messages)

    assert facts == StepFacts(
        reads=["shop_orders.orders_snapshot"],
        writes=["shop_orders.orders_snapshot"],
        rows=9779,
        delta_version=298,
    )


def test_parse_facts_falls_back_to_the_source_kind_when_ref_is_none() -> None:
    messages = [
        "read source kind=postgres ref=None",
        "write target ref=TableRef('shop_orders.orders_snapshot')",
        "{'event': 'delta write', 'mode': 'replace_partitions', 'version': 298, 'rows': 9779}",
    ]

    facts = parse_facts(messages)

    assert facts.reads == ["postgres"]
    assert facts.writes == ["shop_orders.orders_snapshot"]
    assert facts.rows == 9779
    assert facts.delta_version == 298


def test_parse_facts_prefers_the_pre_write_row_count_over_a_later_none() -> None:
    messages = [
        "{'event': 'delta write', 'mode': 'replace_partitions', 'version': 12, 'rows': 40}",
        "{'event': 'delta write', 'mode': 'replace_partitions', 'version': 12, 'rows': None}",
    ]

    facts = parse_facts(messages)

    assert facts.rows == 40
    assert facts.delta_version == 12


def test_parse_facts_with_no_matching_lines_is_empty() -> None:
    facts = parse_facts(["step start step=Foo", "not a structured line"])

    assert facts == StepFacts(reads=[], writes=[], rows=None, delta_version=None)


def test_is_noise_matches_a_configured_prefix_ignoring_leading_whitespace() -> None:
    prefixes = ["IntoHistory declared", "Retrieving ECS"]

    assert is_noise("  IntoHistory declared without 'partition_scope'", prefixes)
    assert is_noise("Retrieving ECS task definition", prefixes)
    assert not is_noise("process start process=Foo nodes=1", prefixes)
