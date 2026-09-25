"""Suite-wide test isolation, shared by every test package under ``tests/``."""

from __future__ import annotations

from collections.abc import Iterator
from typing import Any

import pytest
import structlog


@pytest.fixture(autouse=True)
def _isolated_structlog() -> Iterator[None]:
    """Give every test a clean, non-leaking ``structlog`` global configuration.

    ``create_app`` drives loom's ``configure_logging_from_values``, which calls
    ``structlog.configure(..., cache_logger_on_first_use=True)`` on *every* call,
    replacing the global processors list wholesale. Once a module logger (e.g.
    ``periplo.bootstrap``'s) has really logged through an older list, structlog's
    ``BoundLoggerLazyProxy`` permanently overwrites its own ``bind`` with the
    processors that were active at that moment (that is what "cache on first use"
    means). A later ``structlog.configure()`` call only ever replaces
    ``structlog``'s *current* list, so that logger keeps writing through the
    stale one forever. ``structlog.testing.capture_logs()`` intercepts events by
    mutating the *current* list in place, so it silently never sees anything
    from an already cache-bound logger - the root cause of this suite's test
    order sensitivity.

    Forcing ``cache_logger_on_first_use=False`` for the duration of every test
    stops any logger from ever going stale: each real log call re-resolves
    structlog's current processors instead of reusing a cached bind, so
    ``capture_logs()`` always observes it, regardless of what any earlier test
    or ``create_app()`` call did. The pre-test configuration is snapshotted and
    restored afterwards, so nothing a test configures (directly, or through
    ``create_app``) can leak into the next one either.
    """
    saved_config = structlog.get_config()
    original_configure = structlog.configure

    def _configure_without_caching(*args: Any, **kwargs: Any) -> None:
        kwargs["cache_logger_on_first_use"] = False
        original_configure(*args, **kwargs)

    structlog.configure = _configure_without_caching
    _configure_without_caching(**saved_config)
    try:
        yield
    finally:
        structlog.configure = original_configure
        original_configure(**saved_config)
