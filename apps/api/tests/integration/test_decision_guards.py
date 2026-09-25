"""Guards of earlier architecture decisions: they fail when a premise stops holding.

The native Delta provider of datafusion-python is not what production uses (it cannot
read S3 there), so nothing here exercises it: tables reach the engine as pyarrow
datasets built from the Delta log, which ``test_api.py`` covers end to end.
"""

from __future__ import annotations

import inspect

from datafusion import SessionContext


def test_datafusion_binding_does_not_expose_a_proven_execution_cancel_handle() -> None:
    """Guard the decision to isolate each production query in a child process.

    Python task cancellation is insufficient: it does not prove that already-running
    Rust execution stops. Revisit this assertion only when DataFusion exposes a native,
    awaitable execution handle with a documented cancellation-completion contract.
    """
    context = SessionContext()
    dataframe = context.sql("SELECT 1")
    exposed = {
        name
        for name, _ in inspect.getmembers(dataframe)
        if any(token in name.lower() for token in ("cancel", "abort", "interrupt"))
    }

    assert exposed == set()
