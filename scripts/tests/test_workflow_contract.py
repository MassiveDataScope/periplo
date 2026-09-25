"""The workflows under .github/workflows keep their contract with the reusable ones they call.

GitHub refuses a run that passes an undeclared input or secret, that leaves out a required
input, or that grants a called workflow fewer permissions than its jobs ask for, but only
once the run starts. These tests read each reusable workflow of loom-actions at the exact
commit the callers pin, so a renamed input or a job that starts asking for more fails here.

The reusable workflows are read from a local clone when ``LOOM_ACTIONS_REPO`` names one
(``git show <sha>:<path>``), and otherwise from GitHub at the pinned commit.
"""

from __future__ import annotations

import functools
import json
import os
import re
import shutil
import subprocess
import urllib.request
from pathlib import Path
from typing import Any, cast

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[2]
WORKFLOWS = ROOT / ".github" / "workflows"
CALLERS = ("ci.yml", "docs.yml", "release.yml")
REPOSITORY = "the-reacher-data/loom-actions"
PREFIX = f"{REPOSITORY}/.github/workflows/"
RAW = f"https://raw.githubusercontent.com/{REPOSITORY}"
FULL_SHA = re.compile(r"[0-9a-f]{40}")
LEVEL = {"none": 0, "read": 1, "write": 2}
REUSABLES = {
    "python-service-ci.yml",
    "node-ci.yml",
    "repo-security.yml",
    "pages.yml",
    "image-release.yml",
    "release-on-label.yml",
}

Job = dict[str, Any]


def _load(text: str) -> dict[Any, Any]:
    return cast(dict[Any, Any], yaml.safe_load(text))


def _caller(name: str) -> dict[Any, Any]:
    return _load((WORKFLOWS / name).read_text(encoding="utf-8"))


def _jobs(name: str) -> dict[str, Job]:
    return cast(dict[str, Job], _caller(name)["jobs"])


def _calls() -> list[tuple[str, str, str, Job]]:
    found = []
    for caller in CALLERS:
        for job_name, job in _jobs(caller).items():
            uses = cast(str, job.get("uses", ""))
            if uses.startswith(PREFIX):
                workflow, _, ref = uses.removeprefix(PREFIX).partition("@")
                found.append((f"{caller}:{job_name}", workflow, ref, job))
    return found


@functools.cache
def _reusable_source(workflow: str, sha: str) -> str:
    path = f".github/workflows/{workflow}"
    clone = os.environ.get("LOOM_ACTIONS_REPO")
    if clone:
        shown = subprocess.run(
            ["git", "-C", clone, "show", f"{sha}:{path}"],
            check=True,
            capture_output=True,
            text=True,
        )
        return shown.stdout
    with urllib.request.urlopen(f"{RAW}/{sha}/{path}", timeout=30) as response:
        return cast(bytes, response.read()).decode("utf-8")


def _reusable(workflow: str, sha: str) -> tuple[dict[str, Any], dict[str, Job]]:
    document = _load(_reusable_source(workflow, sha))
    # YAML 1.1 reads the bare key `on` as the boolean true.
    trigger = cast(dict[str, Any], document.get("on", document.get(True)))
    return cast(dict[str, Any], trigger["workflow_call"]), cast(dict[str, Job], document["jobs"])


CALLS = _calls()
IDS = [name for name, _, _, _ in CALLS]


def test_the_callers_use_every_reusable_workflow() -> None:
    assert {workflow for _, workflow, _, _ in CALLS} == REUSABLES


def test_every_call_pins_the_same_full_commit() -> None:
    refs = {ref for _, _, ref, _ in CALLS}

    assert len(refs) == 1, refs
    assert all(FULL_SHA.fullmatch(ref) for ref in refs), refs


def test_every_other_action_is_pinned_by_commit() -> None:
    for caller in CALLERS:
        for job_name, job in _jobs(caller).items():
            for step in cast(list[dict[str, Any]], job.get("steps", [])):
                uses = cast(str, step.get("uses", ""))
                if uses:
                    assert FULL_SHA.fullmatch(uses.partition("@")[2]), f"{caller}:{job_name}"


def test_the_callers_grant_nothing_at_the_top() -> None:
    for caller in CALLERS:
        assert _caller(caller)["permissions"] == {}, caller


@pytest.mark.parametrize(("caller", "workflow", "sha", "job"), CALLS, ids=IDS)
def test_every_input_passed_is_declared(caller: str, workflow: str, sha: str, job: Job) -> None:
    declared = _reusable(workflow, sha)[0].get("inputs", {})

    assert set(job.get("with", {})) - set(declared) == set(), caller


@pytest.mark.parametrize(("caller", "workflow", "sha", "job"), CALLS, ids=IDS)
def test_every_required_input_is_passed(caller: str, workflow: str, sha: str, job: Job) -> None:
    declared = cast(dict[str, dict[str, Any]], _reusable(workflow, sha)[0].get("inputs", {}))
    required = {name for name, spec in declared.items() if spec.get("required")}

    assert required - set(job.get("with", {})) == set(), caller


@pytest.mark.parametrize(("caller", "workflow", "sha", "job"), CALLS, ids=IDS)
def test_every_secret_passed_is_declared(caller: str, workflow: str, sha: str, job: Job) -> None:
    secrets = job.get("secrets", {})
    assert secrets != "inherit", f"{caller}: secrets are passed one by one"
    declared = _reusable(workflow, sha)[0].get("secrets", {})

    assert set(secrets) - set(declared) == set(), caller


@pytest.mark.parametrize(("caller", "workflow", "sha", "job"), CALLS, ids=IDS)
def test_the_caller_grants_what_every_called_job_asks(
    caller: str, workflow: str, sha: str, job: Job
) -> None:
    granted = cast(dict[str, str], job["permissions"])
    for called_name, called in _reusable(workflow, sha)[1].items():
        for scope, level in cast(dict[str, str], called.get("permissions", {})).items():
            have = LEVEL[granted.get(scope, "none")]
            assert have >= LEVEL[level], f"{caller} -> {called_name}: {scope}: {level}"


def test_no_workflow_inherits_secrets() -> None:
    for path in sorted(WORKFLOWS.glob("*.yml")):
        for job_name, job in cast(dict[str, Job], _load(path.read_text("utf-8"))["jobs"]).items():
            assert job.get("secrets") != "inherit", f"{path.name}:{job_name}"


def test_the_node_workspaces_exist() -> None:
    names = {
        json.loads(manifest.read_text(encoding="utf-8"))["name"]
        for manifest in (
            ROOT / "apps" / "web" / "package.json",
            ROOT / "packages" / "core" / "package.json",
        )
    }

    assert set(_jobs("ci.yml")["node"]["with"]["workspaces"].split()) == names


def test_the_gate_waits_for_every_other_job() -> None:
    jobs = _jobs("ci.yml")
    gate = jobs["gate"]

    assert set(gate["needs"]) == set(jobs) - {"gate"}
    assert gate["if"] == "${{ always() }}"
    assert gate["permissions"] == {}


def _run_gate(results: dict[str, str]) -> subprocess.CompletedProcess[str]:
    bash = shutil.which("bash")
    if bash is None or shutil.which("jq") is None:
        pytest.skip("bash and jq are needed to run the gate")
    (step,) = _jobs("ci.yml")["gate"]["steps"]
    needs = json.dumps(
        {name: {"result": result, "outputs": {}} for name, result in results.items()}
    )
    return subprocess.run(
        [bash, "-c", step["run"]],
        env={**os.environ, "NEEDS": needs},
        capture_output=True,
        text=True,
        check=False,
    )


def test_the_gate_passes_when_every_job_succeeded() -> None:
    names = _jobs("ci.yml")["gate"]["needs"]

    assert _run_gate(dict.fromkeys(names, "success")).returncode == 0


@pytest.mark.parametrize("result", ["failure", "cancelled", "skipped"])
def test_the_gate_fails_when_any_job_did_not_succeed(result: str) -> None:
    names = _jobs("ci.yml")["gate"]["needs"]
    results = dict.fromkeys(names, "success") | {names[-1]: result}

    gate = _run_gate(results)

    assert gate.returncode != 0
    assert f"{names[-1]} ({result})" in gate.stdout


def test_only_the_published_repository_releases() -> None:
    jobs = _jobs("release.yml")

    assert jobs["release"]["if"] == "${{ github.repository == 'MassiveDataScope/periplo' }}"
    assert all("release" in jobs[name]["needs"] for name in ("image", "publish"))
    assert "needs.release.outputs.version != ''" in jobs["image"]["if"]


def test_pypi_gets_only_distributions_that_were_built_and_checked() -> None:
    release = _jobs("release.yml")
    publish = release["publish"]
    upload = publish["steps"][-1]

    assert release["release"]["with"]["check-distribution"] is True
    assert publish["if"] == "${{ needs.release.outputs.distribution-built == 'true' }}"
    assert publish["environment"] == "pypi"
    assert publish["permissions"] == {"id-token": "write"}
    assert upload["uses"].startswith("pypa/gh-action-pypi-publish@")
    assert upload["with"]["skip-existing"] is True
