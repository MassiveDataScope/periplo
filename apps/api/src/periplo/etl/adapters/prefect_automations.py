"""Prefect automations of the one shape the console reads: "when X completes, run Y".

An automation is read in two passes. A lenient head says whether it is of that shape
(enabled, an event trigger expecting ``prefect.flow-run.Completed``, a ``run-deployment``
action); anything else, whatever its shape, is ignored. One that is of that shape is then
decoded strictly; if it does not decode it is skipped and the JSON path of the field that
failed is logged, never its content.

An upstream ETL is named by a ``match_related`` specification with the ``deployment``
role, by ``prefect.resource.name`` or ``prefect.resource.id`` (``prefect.deployment.<id>``).
Prefect ANDs the related specifications, so one with the ``flow`` role narrows it to the
deployments of that flow, by its name.
A ``run-deployment`` action counts only with ``source: selected``: an inferred one has no
deployment of its own to name.
"""

from __future__ import annotations

import re
from typing import Any, Literal

import msgspec
from loom.core.logger import get_logger

from periplo.etl.adapters.prefect_decode import decode_field
from periplo.etl.ports import Deployment, EtlTrigger

__all__ = ["ChainLink", "chain_links", "with_chains"]

_log = get_logger(__name__)

_COMPLETED = "prefect.flow-run.Completed"
_RUN_DEPLOYMENT = "run-deployment"
_DEPLOYMENT_ROLE = "deployment"
_NAME = "prefect.resource.name"
_ID = "prefect.resource.id"
_ROLE = "prefect.resource.role"
_FLOW_ROLE = "flow"
_DEPLOYMENT_ID_PREFIX = "prefect.deployment."
# A parameter set to a plain copy of the upstream run's own: {{ flow_run.parameters['x'] }}.
_COPIED = re.compile(r"^\{\{\s*flow_run\.parameters\[(['\"])(?P<name>[^'\"]+)\1\]\s*\}\}$")
# A Jinja template, in Prefect 3's shape ({"template": ..., "__prefect_kind": "jinja"}) or
# a version 1 string: anything else an action sets is a constant.
_JINJA = "{{"


class ChainLink(msgspec.Struct, frozen=True, kw_only=True):
    """One automation's "when an upstream deployment's run completes, run this one"."""

    automation_id: str
    automation_name: str
    upstream_names: tuple[str, ...]
    upstream_ids: tuple[str, ...]
    upstream_flows: tuple[str, ...]
    """The upstream's flow, by name, when the automation names one; any flow when empty."""
    downstream_id: str
    copies: dict[str, str]
    """Each parameter the action copies from the upstream run, with the one it copies."""
    sets: dict[str, Any]
    """Each parameter the action sets to a constant. One set by any other template is in
    neither: it is neither the upstream's value nor a fixed one."""

    def follows(self, name: str | None, id_: str | None, flow_name: str | None) -> bool:
        """Whether a deployment (by name, id and flow) is this link's upstream."""
        named = name in self.upstream_names or id_ in self.upstream_ids
        return named and (not self.upstream_flows or flow_name in self.upstream_flows)

    def same_chain_run(self, downstream: dict[str, Any], upstream: dict[str, Any]) -> bool | None:
        """Whether a downstream run's copied values are an upstream run's: None when no
        copied value is on both, so nothing tells."""
        pairs = [
            (downstream[name], upstream[source])
            for name, source in self.copies.items()
            if name in downstream and source in upstream
        ]
        return all(mine == theirs for mine, theirs in pairs) if pairs else None


# --- the lenient head: is it of the shape at all -------------------------------------


class _HeadTrigger(msgspec.Struct):
    type: str = ""
    expect: list[str] = []


class _HeadAction(msgspec.Struct):
    type: str = ""


class _Head(msgspec.Struct):
    trigger: _HeadTrigger
    enabled: bool = True
    actions: list[_HeadAction] = []


# --- the strict shape of the automations read ----------------------------------------

_Specification = dict[str, str | list[str]]


class _EventTrigger(msgspec.Struct):
    type: Literal["event"]
    posture: Literal["Reactive", "Proactive"]
    expect: list[str]
    match_related: _Specification | list[_Specification]


class _Automation(msgspec.Struct):
    id: str
    name: str
    enabled: bool
    trigger: _EventTrigger
    actions: list[msgspec.Raw]


class _RunDeployment(msgspec.Struct):
    type: Literal["run-deployment"]
    source: Literal["selected", "inferred"]
    deployment_id: str | None = None
    parameters: dict[str, Any] | None = None


def chain_links(automations: list[msgspec.Raw]) -> list[ChainLink]:
    """The chain links among *automations*, in their order; the rest is ignored."""
    links: list[ChainLink] = []
    for index, raw in enumerate(automations):
        if not _of_the_shape(raw):
            continue
        try:
            automation = msgspec.json.decode(raw, type=_Automation)
            actions = [_run_deployment(action) for action in automation.actions]
        except msgspec.DecodeError as error:
            _log.warning("etl.automation_skipped", index=index, field=decode_field(error))
            continue
        links.extend(_links_of(automation, [a for a in actions if a is not None]))
    return links


def with_chains(deployments: list[Deployment], links: list[ChainLink]) -> list[Deployment]:
    """*deployments* with what starts each and what each starts, among themselves only."""
    by_id = {deployment.id: deployment for deployment in deployments}
    return [
        msgspec.structs.replace(
            deployment,
            triggered_by=_trigger_of(deployment, deployments, links),
            triggers=sorted(
                {
                    by_id[link.downstream_id].name
                    for link in links
                    if _follows(link, deployment) and link.downstream_id in by_id
                }
            ),
        )
        for deployment in deployments
    ]


def _of_the_shape(raw: msgspec.Raw) -> bool:
    try:
        head = msgspec.json.decode(raw, type=_Head)
    except msgspec.DecodeError:
        return False
    return (
        head.enabled
        and head.trigger.type == "event"
        and _COMPLETED in head.trigger.expect
        and any(action.type == _RUN_DEPLOYMENT for action in head.actions)
    )


def _run_deployment(raw: msgspec.Raw) -> _RunDeployment | None:
    if msgspec.json.decode(raw, type=_HeadAction).type != _RUN_DEPLOYMENT:
        return None
    return msgspec.json.decode(raw, type=_RunDeployment)


def _links_of(automation: _Automation, actions: list[_RunDeployment]) -> list[ChainLink]:
    trigger = automation.trigger
    if trigger.posture != "Reactive":
        return []
    names, ids, flows = _upstreams(trigger.match_related)
    if not names and not ids:
        return []
    return [
        ChainLink(
            automation_id=automation.id,
            automation_name=automation.name,
            upstream_names=names,
            upstream_ids=ids,
            upstream_flows=flows,
            downstream_id=action.deployment_id,
            copies=_copies(action.parameters or {}),
            sets={
                name: value
                for name, value in (action.parameters or {}).items()
                if not _is_template(value)
            },
        )
        for action in actions
        if action.source == "selected" and action.deployment_id is not None
    ]


def _upstreams(
    match_related: _Specification | list[_Specification],
) -> tuple[tuple[str, ...], tuple[str, ...], tuple[str, ...]]:
    """The deployments named by the related specifications with the deployment role, and
    the flows named by those with the flow role."""
    specifications = match_related if isinstance(match_related, list) else [match_related]
    names: list[str] = []
    ids: list[str] = []
    flows: list[str] = []
    for specification in specifications:
        roles = _values(specification.get(_ROLE))
        if _FLOW_ROLE in roles:
            flows.extend(_values(specification.get(_NAME)))
        if _DEPLOYMENT_ROLE not in roles:
            continue
        names.extend(_values(specification.get(_NAME)))
        ids.extend(
            value.removeprefix(_DEPLOYMENT_ID_PREFIX)
            for value in _values(specification.get(_ID))
            if value.startswith(_DEPLOYMENT_ID_PREFIX)
        )
    return tuple(names), tuple(ids), tuple(flows)


def _values(value: str | list[str] | None) -> list[str]:
    if value is None:
        return []
    return [value] if isinstance(value, str) else value


def _template(value: object) -> str | None:
    """The Jinja template a parameter is set to, if it is set to one."""
    template = value.get("template") if isinstance(value, dict) else value
    return template if isinstance(template, str) and _JINJA in template else None


def _is_template(value: object) -> bool:
    return _template(value) is not None


def _copies(parameters: dict[str, Any]) -> dict[str, str]:
    """Each parameter set to a plain copy of an upstream one, with the one it copies."""
    copies: dict[str, str] = {}
    for name, value in parameters.items():
        match = _COPIED.match((_template(value) or "").strip())
        if match is not None:
            copies[name] = match["name"]
    return copies


def _follows(link: ChainLink, deployment: Deployment) -> bool:
    return link.follows(deployment.name, deployment.id, deployment.flow_name)


def _trigger_of(
    deployment: Deployment, deployments: list[Deployment], links: list[ChainLink]
) -> EtlTrigger | None:
    """The first link (by automation name) that starts *deployment* from one in the list.
    One upstream is read: an ETL several automations start says the first one's."""
    for link in sorted(links, key=lambda link: link.automation_name):
        if link.downstream_id != deployment.id:
            continue
        upstream = next((d for d in deployments if _follows(link, d)), None)
        if upstream is not None:
            return EtlTrigger(
                etl=upstream.name, on="completed", passes=sorted(link.copies), sets=link.sets
            )
    return None
