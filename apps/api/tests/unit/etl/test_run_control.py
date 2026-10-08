"""Which state Periplo proposes to Prefect to cancel or retry a run, and when it refuses."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from periplo.etl.errors import NotCancellable, NotRetryable
from periplo.etl.run_control import (
    FORCE_CANCEL_AFTER,
    RunFacts,
    StateProposal,
    cancel_proposal,
    retry_proposal,
)

NOW = datetime(2026, 10, 8, 9, 0, tzinfo=UTC)
_FORCE_AFTER_MINUTES = f"{FORCE_CANCEL_AFTER // timedelta(minutes=1)} minutes"


def facts(**overrides: object) -> RunFacts:
    base: dict[str, object] = {
        "state": "RUNNING",
        "started": True,
        "has_infrastructure": True,
        "state_since": NOW - timedelta(minutes=1),
        "has_deployment": True,
    }
    return RunFacts(**{**base, **overrides})  # type: ignore[arg-type]


CANCELLING = StateProposal(type="CANCELLING", name="Cancelling", force=False)
CANCELLED = StateProposal(type="CANCELLED", name="Cancelled", force=True)


@pytest.mark.parametrize("state", ["RUNNING", "PENDING", "PAUSED", "SCHEDULED"])
def test_a_run_with_infrastructure_goes_to_cancelling_for_the_worker_to_stop(state: str) -> None:
    proposal = cancel_proposal(facts(state=state), now=NOW, force=False)
    assert proposal == CANCELLING


@pytest.mark.parametrize("state", ["PENDING", "SCHEDULED", "PAUSED"])
def test_a_run_that_never_started_and_has_no_infrastructure_is_cancelled_at_once(
    state: str,
) -> None:
    never_started = facts(state=state, started=False, has_infrastructure=False)
    assert cancel_proposal(never_started, now=NOW, force=False) == CANCELLED


@pytest.mark.parametrize("state", ["COMPLETED", "FAILED", "CRASHED", "CANCELLED"])
def test_a_finished_run_cannot_be_cancelled(state: str) -> None:
    with pytest.raises(NotCancellable, match="finished"):
        cancel_proposal(facts(state=state), now=NOW, force=False)


def test_a_run_already_cancelling_is_not_cancelled_again() -> None:
    with pytest.raises(NotCancellable, match="already being cancelled"):
        cancel_proposal(facts(state="CANCELLING"), now=NOW, force=False)


def test_a_run_stuck_cancelling_long_enough_can_be_forced_to_cancelled() -> None:
    stuck = facts(state="CANCELLING", state_since=NOW - FORCE_CANCEL_AFTER)
    assert cancel_proposal(stuck, now=NOW, force=True) == CANCELLED


def test_force_waits_for_the_worker_first() -> None:
    recent = facts(state="CANCELLING", state_since=NOW - FORCE_CANCEL_AFTER + timedelta(seconds=1))
    with pytest.raises(NotCancellable, match=_FORCE_AFTER_MINUTES):
        cancel_proposal(recent, now=NOW, force=True)


@pytest.mark.parametrize("state", ["RUNNING", "FAILED"])
def test_force_is_only_for_a_run_stuck_cancelling(state: str) -> None:
    with pytest.raises(NotCancellable, match="Only a run stuck cancelling"):
        cancel_proposal(facts(state=state), now=NOW, force=True)


def test_force_without_a_known_time_in_cancelling_is_refused() -> None:
    with pytest.raises(NotCancellable, match=_FORCE_AFTER_MINUTES):
        cancel_proposal(facts(state="CANCELLING", state_since=None), now=NOW, force=True)


@pytest.mark.parametrize("state", ["FAILED", "CRASHED"])
def test_a_failed_or_crashed_run_is_retried_as_awaiting_retry(state: str) -> None:
    assert retry_proposal(facts(state=state)) == StateProposal(
        type="SCHEDULED", name="AwaitingRetry", force=False
    )


@pytest.mark.parametrize("state", ["COMPLETED", "CANCELLED", "RUNNING", "PENDING"])
def test_only_a_failed_or_crashed_run_is_retried(state: str) -> None:
    with pytest.raises(NotRetryable, match="failed or crashed"):
        retry_proposal(facts(state=state))


def test_a_run_without_a_deployment_cannot_be_retried() -> None:
    with pytest.raises(NotRetryable, match="deployment"):
        retry_proposal(facts(state="FAILED", has_deployment=False))


def test_the_refusals_are_409_with_their_own_codes() -> None:
    assert (NotCancellable.status, NotCancellable.code) == (409, "etl_run_not_cancellable")
    assert (NotRetryable.status, NotRetryable.code) == (409, "etl_run_not_retryable")
