"""What may be logged about a Prefect response that does not decode: the field's JSON path.

msgspec ends a validation error with the JSON path it failed at. Only that path is logged:
the rest of the message can quote a value from the response, and the adapter never logs
response content.
"""

from __future__ import annotations

import re

import msgspec

_DECODE_FIELD = re.compile(r" - at `(?P<field>\$[^`]*)`$")


def decode_field(error: msgspec.DecodeError) -> str | None:
    """The JSON path a response failed to decode at (``$[0].run_count``), if one is named."""
    match = _DECODE_FIELD.search(str(error))
    return match["field"] if match else None
