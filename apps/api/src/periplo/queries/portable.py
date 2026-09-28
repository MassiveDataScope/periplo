"""Keeps results readable by every Arrow client.

DataFusion answers string work (``CAST(x AS VARCHAR)``, most text functions) with the
view layouts added in Arrow 1.4. Browsers' Arrow libraries do not decode them yet, so
the API speaks the classic layouts on the wire. The values are identical.
"""

from __future__ import annotations

import pyarrow as pa


def _portable_type(data_type: pa.DataType) -> pa.DataType:
    if pa.types.is_string_view(data_type):
        return pa.string()
    if pa.types.is_binary_view(data_type):
        return pa.binary()
    if pa.types.is_list(data_type):
        return pa.list_(_portable_field(data_type.value_field))
    if pa.types.is_large_list(data_type):
        return pa.large_list(_portable_field(data_type.value_field))
    if pa.types.is_struct(data_type):
        return pa.struct([_portable_field(field) for field in data_type.fields])
    return data_type


def _portable_field(field: pa.Field) -> pa.Field:
    return field.with_type(_portable_type(field.type))


def portable_schema(schema: pa.Schema) -> pa.Schema:
    """``schema`` with view types replaced; the very same object when it has none."""
    fields = [_portable_field(field) for field in schema]
    if all(new.type == old.type for new, old in zip(fields, schema, strict=True)):
        return schema
    return pa.schema(fields, metadata=schema.metadata)


def portable_batch(batch: pa.RecordBatch, schema: pa.Schema) -> pa.RecordBatch:
    """``batch`` cast to ``schema``; free when it already has it."""
    return batch if batch.schema is schema or batch.schema == schema else batch.cast(schema)
