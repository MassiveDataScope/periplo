"""Which state Periplo proposes to Prefect to cancel or retry a run, and when it refuses.

Pure: a run's facts in, the state to propose out (or ``NotCancellable``/``NotRetryable``).
The semantics follow Prefect 3.7.4, read from its source:

Cancel
    Prefect's own UI and ``prefect flow-run cancel`` propose ``CANCELLING``
    (``prefect/cli/flow_run.py::cancel``). ``CANCELLING`` means "stop the infrastructure":

    - A run that has started is stopped by whoever watches its process: the flow-run
      executor/runner inside the job (``FlowRunCancellingObserver`` in
      ``prefect/runner/_flow_run_executor.py``) kills the flow's process and proposes
      ``CANCELLED``.
    - A run that never started but has infrastructure (``infrastructure_pid``, e.g. an
      ECS task still provisioning) is stopped by its work pool's worker
      (``BaseWorker._cancel_run`` in ``prefect/workers/base.py``): it kills the
      infrastructure, then forces ``CANCELLED``. The worker only acts on runs with no
      ``start_time``.
    - A ``SCHEDULED`` run with no ``infrastructure_pid`` never reaches ``CANCELLING``: the
      server rule ``BypassCancellingFlowRunsWithNoInfra``
      (``prefect/server/orchestration/core_policy.py``) turns it into ``CANCELLED``. That
      rule does not cover ``PENDING``: a run stuck submitting with no infrastructure
      would wait in ``CANCELLING`` for a worker that is not coming.

    So a run whose current attempt never started and has no infrastructure is proposed
    ``CANCELLED`` directly, with ``force`` (there is nothing to stop; the worker itself
    forces the same state). That holds for a retried run waiting for its next attempt too:
    Prefect keeps its first attempt's ``start_time``, so "started" is the current
    attempt's (a ``start_time`` alone would leave it in ``CANCELLING``). Every other
    cancellable run is proposed ``CANCELLING`` without ``force``, under the server's own
    rules; a retried attempt not started but with an ``infrastructure_pid`` may wait there
    for a worker, and then needs Force cancel.

    Force cancel: a run left in ``CANCELLING`` for ``FORCE_CANCEL_AFTER`` (nobody stopped
    it: no worker, or a job already gone) may be forced to ``CANCELLED``. Forcing skips the
    server's rules (``MinimalFlowPolicy``) and stops nothing: a job still alive keeps
    running, which the console warns about.

Retry
    Prefect's UI "Retry" proposes ``SCHEDULED`` named ``AwaitingRetry`` ("Retry from the
    UI") on the same run; ``prefect flow-run retry`` proposes ``Scheduled`` with ``force``.
    Without ``force``, ``HandleFlowTerminalStateTransitions`` lets a ``FAILED`` or
    ``CRASHED`` run leave its terminal state for ``SCHEDULED`` only when it has a
    deployment (else it aborts), and resets its pause metadata. No new run is created: the
    work pool's worker picks it up like any scheduled run of the deployment (the ECS worker
    included), and ``IncrementFlowRunCount`` adds one to ``run_count`` when it enters
    ``RUNNING`` again (named "Retrying" by ``RenameReruns``), which the console draws as
    "↻ N". Periplo proposes it without ``force`` so those rules still apply.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import Final

import msgspec

from periplo.etl.errors import NotCancellable, NotRetryable
from periplo.etl.ports import RunState

FORCE_CANCEL_AFTER: Final = timedelta(minutes=10)
"""How long a run must have been ``CANCELLING`` before it may be forced to ``CANCELLED``."""

_FINISHED: Final[frozenset[RunState]] = frozenset({"COMPLETED", "FAILED", "CRASHED", "CANCELLED"})
_RETRYABLE: Final[frozenset[RunState]] = frozenset({"FAILED", "CRASHED"})


class RunFacts(msgspec.Struct, frozen=True, kw_only=True):
    """What deciding a cancel or a retry needs to know of a run."""

    state: RunState
    started: bool
    """Whether its current attempt has started (a retried run waiting has not)."""
    has_infrastructure: bool
    """Whether a worker recorded infrastructure for it (Prefect's ``infrastructure_pid``)."""
    state_since: datetime | None
    """When it entered its current state."""
    has_deployment: bool


class StateProposal(msgspec.Struct, frozen=True, kw_only=True):
    """The state to propose to Prefect, and whether to force it past the server's rules."""

    type: RunState
    name: str
    force: bool


_CANCELLING: Final = StateProposal(type="CANCELLING", name="Cancelling", force=False)
_CANCELLED: Final = StateProposal(type="CANCELLED", name="Cancelled", force=True)
_AWAITING_RETRY: Final = StateProposal(type="SCHEDULED", name="AwaitingRetry", force=False)


def cancel_proposal(run: RunFacts, *, now: datetime, force: bool) -> StateProposal:
    """``CANCELLING``, or ``CANCELLED`` for a run with nothing to stop or one forced."""
    if force:
        return _forced(run, now=now)
    if run.state in _FINISHED:
        raise NotCancellable("This run has already finished")
    if run.state == "CANCELLING":
        raise NotCancellable("This run is already being cancelled")
    if not run.started and not run.has_infrastructure:
        return _CANCELLED
    return _CANCELLING


def _forced(run: RunFacts, *, now: datetime) -> StateProposal:
    if run.state != "CANCELLING":
        raise NotCancellable("Only a run stuck cancelling can be forced to cancelled")
    if run.state_since is None or now - run.state_since < FORCE_CANCEL_AFTER:
        minutes = int(FORCE_CANCEL_AFTER.total_seconds() // 60)
        raise NotCancellable(
            f"A run can be forced once it has been cancelling for {minutes} minutes"
        )
    return _CANCELLED


def retry_proposal(run: RunFacts) -> StateProposal:
    """``AwaitingRetry`` for a failed or crashed run of a deployment."""
    if run.state not in _RETRYABLE:
        raise NotRetryable("Only a failed or crashed run can be retried")
    if not run.has_deployment:
        raise NotRetryable("This run has no deployment to run it again")
    return _AWAITING_RETRY
