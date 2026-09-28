"""Results must be readable by every Arrow client, not only by the newest ones."""

import pyarrow as pa

from periplo.queries.portable import portable_batch, portable_schema


def test_view_types_become_their_classic_equivalents() -> None:
    schema = pa.schema([("label", pa.string_view()), ("blob", pa.binary_view()), ("n", pa.int64())])

    assert portable_schema(schema) == pa.schema(
        [("label", pa.string()), ("blob", pa.binary()), ("n", pa.int64())]
    )


def test_a_schema_without_views_is_returned_untouched() -> None:
    schema = pa.schema(
        [("name", pa.string()), ("amount", pa.decimal128(10, 2))], metadata={"k": "v"}
    )

    assert portable_schema(schema) is schema


def test_views_inside_lists_and_structs_are_converted_too() -> None:
    schema = pa.schema(
        [("tags", pa.list_(pa.string_view())), ("who", pa.struct([("name", pa.string_view())]))]
    )

    assert portable_schema(schema) == pa.schema(
        [("tags", pa.list_(pa.string())), ("who", pa.struct([("name", pa.string())]))]
    )


def test_batches_keep_their_values_and_nulls() -> None:
    batch = pa.record_batch(
        {"label": pa.array(["a", None, "ccc"], pa.string_view()), "n": pa.array([1, 2, 3])}
    )

    converted = portable_batch(batch, portable_schema(batch.schema))

    assert converted.schema.field("label").type == pa.string()
    assert converted.to_pydict() == {"label": ["a", None, "ccc"], "n": [1, 2, 3]}
