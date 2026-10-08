"""Reading Prefect automations of the shape "when X completes, run Y" into chain links."""

from __future__ import annotations

import copy
from typing import Any

import msgspec
import structlog.testing

from periplo.etl.adapters.prefect_automations import ChainLink, chain_links, with_chains
from periplo.etl.ports import Deployment, EtlTrigger

UPSTREAM_ID = "11111111-1111-4111-8111-111111111111"
DOWNSTREAM_ID = "22222222-2222-4222-8222-222222222222"
AUTOMATION_ID = "33333333-3333-4333-8333-333333333333"


def production_automation(**overrides: Any) -> dict[str, Any]:
    """Shaped like ``respondio_message_nlp_daily__automation_1`` as Prefect 3.7.4 returns it."""
    base: dict[str, Any] = {
        "id": AUTOMATION_ID,
        "created": "2026-08-01T10:00:00Z",
        "updated": "2026-08-01T10:00:00Z",
        "name": "respondio_message_nlp_daily__automation_1",
        "description": "",
        "enabled": True,
        "tags": [],
        "trigger": {
            "type": "event",
            "id": "44444444-4444-4444-8444-444444444444",
            "match": {"prefect.resource.id": "prefect.flow-run.*"},
            "match_related": [
                {
                    "prefect.resource.name": "respondio_messages_daily",
                    "prefect.resource.role": "flow",
                },
                {
                    "prefect.resource.name": "respondio_messages_daily",
                    "prefect.resource.role": "deployment",
                },
            ],
            "after": [],
            "expect": ["prefect.flow-run.Completed"],
            "for_each": [],
            "posture": "Reactive",
            "threshold": 1,
            "within": 0.0,
        },
        "actions": [
            {
                "type": "run-deployment",
                "source": "selected",
                "deployment_id": DOWNSTREAM_ID,
                "parameters": {
                    "updated_at_to": {
                        "template": "{{ flow_run.parameters['updated_at_to'] }}",
                        "__prefect_kind": "jinja",
                    },
                    "updated_at_from": {
                        "template": '{{ flow_run.parameters["updated_at_from"] }}',
                        "__prefect_kind": "jinja",
                    },
                    "mode": "incremental",
                },
                "job_variables": None,
                "schedule_after": 0.0,
            }
        ],
        "actions_on_trigger": [],
        "actions_on_resolve": [],
    }
    return {**base, **overrides}


def raws(*automations: dict[str, Any]) -> list[msgspec.Raw]:
    return msgspec.json.decode(msgspec.json.encode(list(automations)), type=list[msgspec.Raw])


def deployment(id_: str, name: str, flow_name: str | None = None) -> Deployment:
    return Deployment(
        id=id_,
        name=name,
        flow_name=flow_name or name,
        description=None,
        tags=[],
        paused=False,
        schedule=None,
        parameters={},
        last_run=None,
        recent=[],
        next_run_at=None,
        schedule_inactive=False,
        accepts_processes=False,
        external_url=None,
        triggered_by=None,
        triggers=[],
        archived=None,
    )


def test_reads_the_production_automation_as_one_link() -> None:
    [link] = chain_links(raws(production_automation()))
    assert link == ChainLink(
        automation_id=AUTOMATION_ID,
        automation_name="respondio_message_nlp_daily__automation_1",
        upstream_names=("respondio_messages_daily",),
        upstream_ids=(),
        upstream_flows=("respondio_messages_daily",),
        downstream_id=DOWNSTREAM_ID,
        copies={"updated_at_to": "updated_at_to", "updated_at_from": "updated_at_from"},
        sets={"mode": "incremental"},
    )


def test_reads_a_template_that_is_no_plain_copy_as_neither_copied_nor_set() -> None:
    automation = production_automation()
    automation["actions"][0]["parameters"] = {
        "day": {"template": "{{ flow_run.parameters['day'] | upper }}", "__prefect_kind": "jinja"},
        "legacy": "{{ flow_run.parameters['legacy'] }}",
    }
    [link] = chain_links(raws(automation))
    assert (link.copies, link.sets) == ({"legacy": "legacy"}, {})


def test_reads_an_upstream_named_by_id_and_a_single_related_specification() -> None:
    trigger = production_automation()["trigger"] | {
        "match_related": {
            "prefect.resource.id": f"prefect.deployment.{UPSTREAM_ID}",
            "prefect.resource.role": "deployment",
        }
    }
    [link] = chain_links(raws(production_automation(trigger=trigger)))
    assert (link.upstream_names, link.upstream_ids, link.upstream_flows) == ((), (UPSTREAM_ID,), ())


def test_ignores_every_automation_it_does_not_interpret_without_failing() -> None:
    base = production_automation()
    proactive = copy.deepcopy(base)
    proactive["trigger"]["posture"] = "Proactive"
    failed = copy.deepcopy(base)
    failed["trigger"]["expect"] = ["prefect.flow-run.Failed"]
    inferred = copy.deepcopy(base)
    inferred["actions"][0] = {"type": "run-deployment", "source": "inferred", "deployment_id": None}
    no_deployment_role = copy.deepcopy(base)
    no_deployment_role["trigger"]["match_related"] = [base["trigger"]["match_related"][0]]
    compound = production_automation(trigger={"type": "compound", "triggers": [], "require": "all"})
    notify = production_automation(
        actions=[{"type": "send-notification", "block_document_id": "x"}]
    )
    odd = {"name": "something else entirely", "trigger": None}
    found = chain_links(
        raws(
            production_automation(enabled=False),
            proactive,
            failed,
            inferred,
            no_deployment_role,
            compound,
            notify,
            odd,
        )
    )
    assert found == []


def test_an_inferred_action_starts_nothing_even_naming_a_deployment() -> None:
    """``inferred`` runs whatever deployment the triggering event names: its stored
    ``deployment_id`` is not the one it runs."""
    inferred = copy.deepcopy(production_automation())
    inferred["actions"][0]["source"] = "inferred"
    assert inferred["actions"][0]["deployment_id"] == DOWNSTREAM_ID
    assert chain_links(raws(inferred)) == []


def test_skips_an_automation_it_interprets_that_does_not_decode_and_logs_the_field_path() -> None:
    broken = production_automation()
    broken["trigger"]["match_related"][1]["prefect.resource.role"] = 7
    with structlog.testing.capture_logs() as captured:
        found = chain_links(raws(broken, production_automation(id="other-automation")))
    assert [link.automation_id for link in found] == ["other-automation"]
    [skipped] = [e for e in captured if e["event"] == "etl.automation_skipped"]
    assert skipped["field"] == "$.trigger.match_related[1][...]"
    assert "respondio" not in str(skipped)


def test_keeps_only_the_run_deployment_actions_of_an_automation_with_others() -> None:
    notify = {"type": "send-notification", "block_document_id": "x", "subject": "s", "body": "b"}
    automation = production_automation(actions=[notify, *production_automation()["actions"]])
    [link] = chain_links(raws(automation))
    assert link.downstream_id == DOWNSTREAM_ID


def test_with_chains_links_the_deployments_it_holds_both_ways() -> None:
    upstream = deployment(UPSTREAM_ID, "respondio_messages_daily")
    downstream = deployment(DOWNSTREAM_ID, "respondio_message_nlp_daily")
    lonely = deployment("55555555-5555-4555-8555-555555555555", "orders_daily")
    [link] = chain_links(raws(production_automation()))
    chained = with_chains([upstream, downstream, lonely], [link])
    assert [(d.name, d.triggered_by, d.triggers) for d in chained] == [
        ("respondio_messages_daily", None, ["respondio_message_nlp_daily"]),
        (
            "respondio_message_nlp_daily",
            EtlTrigger(
                etl="respondio_messages_daily",
                on="completed",
                passes=["updated_at_from", "updated_at_to"],
                sets={"mode": "incremental"},
            ),
            [],
        ),
        ("orders_daily", None, []),
    ]


def test_with_chains_names_no_deployment_it_does_not_hold() -> None:
    """A link to a deployment outside the list (hidden, or another tenant's) is left out."""
    downstream = deployment(DOWNSTREAM_ID, "respondio_message_nlp_daily")
    [link] = chain_links(raws(production_automation()))
    [alone] = with_chains([downstream], [link])
    assert (alone.triggered_by, alone.triggers) == (None, [])


def test_with_chains_requires_the_flow_too_when_the_automation_names_one() -> None:
    """Prefect ANDs the related specifications: the deployment's name and its flow's."""
    namesake = deployment(UPSTREAM_ID, "respondio_messages_daily", flow_name="another_flow")
    downstream = deployment(DOWNSTREAM_ID, "respondio_message_nlp_daily")
    [link] = chain_links(raws(production_automation()))
    assert [(d.triggered_by, d.triggers) for d in with_chains([namesake, downstream], [link])] == [
        (None, []),
        (None, []),
    ]
