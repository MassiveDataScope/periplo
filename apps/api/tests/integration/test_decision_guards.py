"""Assertions about external premises the rest of the suite relies on, checked directly.

The native Delta provider of datafusion-python is not exercised here: tables reach
the engine as pyarrow datasets built from the Delta log, which ``test_api.py``
covers end to end.
"""

from __future__ import annotations

import inspect

from datafusion import SessionContext


def test_datafusion_binding_does_not_expose_a_proven_execution_cancel_handle() -> None:
    """Fails once DataFusion exposes a cancel/abort/interrupt member on its dataframe.

    Python task cancellation does not prove that already-running Rust execution stops,
    so each production query is isolated in a child process instead.
    """
    context = SessionContext()
    dataframe = context.sql("SELECT 1")
    exposed = {
        name
        for name, _ in inspect.getmembers(dataframe)
        if any(token in name.lower() for token in ("cancel", "abort", "interrupt"))
    }

    assert exposed == set()
