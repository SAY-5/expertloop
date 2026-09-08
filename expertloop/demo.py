"""End-to-end demo against a running ExpertLoop API and the fake business systems.

Ingests three expert notes, shows citations, applies an edit and routes it through
review, runs test cases (one set is blocked by a forbidden-action test), fixes it,
publishes the approved sets to the fake webhook and Jira targets, rolls one back and
prints a summary computed from the API's own records.
"""

from __future__ import annotations

import argparse
import copy
import sys
import time
from pathlib import Path
from typing import Any

import httpx

SAMPLES = Path(__file__).resolve().parent.parent / "samples"
KEYS = {"dana": "ek-dana", "ravi": "rk-ravi", "mei": "rk-mei", "ops": "ak-ops"}

SOURCES = [
    (
        "doc",
        "policy/refunds-v4",
        "Refund policy v4",
        "Refunds are accepted within 30 days. Refunds above 500 require manager approval before the refund is issued.",
    ),
    (
        "ticket",
        "FIN-2210",
        "Refund reply template",
        "Template: Your refund of {amount} has been issued, confirmation {id}.",
    ),
    (
        "doc",
        "onboarding/week-one",
        "Week one links",
        "Handbook, engineering wiki, on-call primer, expense policy.",
    ),
    (
        "ticket",
        "ONB-100",
        "Onboarding epic template",
        "Epic template with 12 standard onboarding tasks.",
    ),
    (
        "url",
        "https://intranet.example.com/forms/access-request",
        "Access request form",
        "Form fields: name, team, role, repositories.",
    ),
    (
        "url",
        "https://status.example.com/runbooks/triage",
        "Triage runbook",
        "Ack within 5 minutes, check dashboards, declare severity.",
    ),
    (
        "doc",
        "runbooks/service-triage",
        "Service triage runbook",
        "Scale out, roll back last deploy, fail over read replicas.",
    ),
    (
        "ticket",
        "INC-77",
        "Incident ticket template",
        "Fields: alert link, dashboard screenshot, timeline.",
    ),
]

NOTES = [
    ("Refund handling for online orders", "refund_handling_sop.md", 2),
    ("New engineer onboarding checklist", "onboarding_checklist.md", 1),
    ("Incident triage for production alerts", "incident_triage_note.md", 1),
]

TEST_CASES: dict[str, list[tuple[str, dict[str, Any], dict[str, Any]]]] = {
    "refund_handling_sop.md": [
        (
            "fraud escalates to the risk team",
            {"facts": {"reason": "fraud", "amount": 90}},
            {
                "required_actions": ["risk team"],
                "forbidden_actions": ["Issue the refund"],
                "must_halt": True,
            },
        ),
        (
            "standard refund completes",
            {"facts": {"reason": "damaged", "amount": 40}},
            {"expected_tools": ["OrderDB", "Stripe", "Zendesk"], "must_complete": True},
        ),
        (
            "high value refund needs manager approval",
            {"facts": {"reason": "damaged", "amount": 800}},
            {
                "required_actions": ["manager"],
                "forbidden_actions": ["Issue the refund"],
                "must_halt": True,
            },
        ),
    ],
    "onboarding_checklist.md": [
        (
            "contractor gets outside collaborator invite",
            {"facts": {"role": "contractor", "start_date": 1}},
            {"required_actions": ["outside collaborator"], "must_complete": True},
        ),
        (
            "far start date halts the checklist",
            {"facts": {"role": "engineer", "start_date": 10}},
            {"must_halt": True, "forbidden_actions": ["Create the Okta account"]},
        ),
        (
            "never grants admin",
            {"facts": {"role": "engineer", "start_date": 1}},
            {"forbidden_actions": ["admin"], "expected_tools": ["Okta", "GitHub", "Slack", "Jira"]},
        ),
    ],
    "incident_triage_note.md": [
        (
            "high error rate declares a SEV1",
            {"facts": {"error_rate": 7}},
            {
                "required_actions": ["SEV1"],
                "expected_tools": ["PagerDuty", "Grafana", "Jira"],
                "must_complete": True,
            },
        ),
        (
            "low error rate posts a status update",
            {"facts": {"error_rate": 2}},
            {"required_actions": ["status update"], "forbidden_actions": ["SEV1"]},
        ),
    ],
}


class Demo:
    def __init__(self, api: str, fakes: str) -> None:
        self.api = httpx.Client(base_url=api, timeout=30.0)
        self.fakes = httpx.Client(base_url=fakes, timeout=30.0)
        self.sets: dict[str, int] = {}
        self.blocked = 0

    def call(self, user: str, method: str, path: str, expect: int = 200, **kwargs: Any) -> Any:
        response = self.api.request(method, path, headers={"X-API-Key": KEYS[user]}, **kwargs)
        if response.status_code != expect:
            print(f"unexpected {response.status_code} for {method} {path}: {response.text}")
            sys.exit(1)
        return response.json() if response.content else None

    def wait(self) -> None:
        for _ in range(60):
            try:
                if (
                    self.api.get("/healthz").status_code == 200
                    and self.fakes.get("/_received").status_code == 200
                ):
                    return
            except httpx.HTTPError:
                pass
            time.sleep(1)
        print("api or fakes did not become healthy")
        sys.exit(1)

    def section(self, title: str) -> None:
        print(f"\n== {title}")

    def ingest(self) -> None:
        self.section("Registering sources with content hashes")
        for kind, ref, title, content in SOURCES:
            out = self.call(
                "dana",
                "POST",
                "/sources",
                201,
                json={"kind": kind, "ref": ref, "title": title, "content": content},
            )
            print(f"  {kind:6} {ref:52} sha256:{out['content_hash'][:12]}")
        self.section("Ingesting expert notes and compiling instruction sets")
        for title, name, approvals in NOTES:
            out = self.call(
                "dana",
                "POST",
                "/notes",
                201,
                json={
                    "title": title,
                    "body": (SAMPLES / name).read_text(),
                    "required_approvals": approvals,
                },
            )
            set_id = out["instruction_set"]["id"]
            self.sets[name] = set_id
            cov = out["coverage"]
            print(
                f"  set {set_id}: {title} -> {cov['steps']} steps, {cov['citations']} citations, coverage {cov['coverage']:.0%}, {out['sources_linked']} sources linked, needs {approvals} approval(s)"
            )

    def show_citations(self) -> None:
        set_id = self.sets["refund_handling_sop.md"]
        self.section(f"Citations for set {set_id} (refund SOP)")
        report = self.call("ravi", "GET", f"/instruction-sets/{set_id}/citations")
        for step in self.call("ravi", "GET", f"/instruction-sets/{set_id}")["document"]["steps"]:
            lines = [c for c in step["citations"] if not c.get("source_ref")][0]
            refs = [c["source_ref"] for c in step["citations"] if c.get("source_ref")]
            print(
                f"  {step['id']} note lines {lines['line_start']}-{lines['line_end']:<3} {step['action'][:58]:58} sources: {', '.join(refs) or '-'}"
            )
        print(
            f"  verified {report['verified']} / {report['verified'] + report['unverified']} citations against registry hashes"
        )

    def add_test_cases(self) -> None:
        self.section("Adding test cases")
        for name, cases in TEST_CASES.items():
            for case_name, scenario, expectations in cases:
                self.call(
                    "ravi",
                    "POST",
                    f"/instruction-sets/{self.sets[name]}/test-cases",
                    201,
                    json={"name": case_name, "scenario": scenario, "expectations": expectations},
                )
            print(f"  set {self.sets[name]}: {len(cases)} test cases")

    def edit(self, set_id: int, reason: str, mutate: Any) -> None:
        current = self.call("dana", "GET", f"/instruction-sets/{set_id}")
        document = copy.deepcopy(current["document"])
        mutate(document)
        out = self.call(
            "dana",
            "PATCH",
            f"/instruction-sets/{set_id}",
            json={"expected_version": current["version"], "reason": reason, "document": document},
        )
        added = sum(
            1
            for line in out["diff"].splitlines()
            if line.startswith("+") and not line.startswith("+++")
        )
        print(
            f"  edit {out['id']} on set {set_id}: v{out['from_version']} -> v{out['to_version']} ({added} lines added) reason: {reason}"
        )

    def review_round(self, set_id: int, reviewers: list[str]) -> None:
        out = self.call("dana", "POST", f"/instruction-sets/{set_id}/submit")
        print(f"  set {set_id}: submitted -> {out['instruction_set']['state']}")
        for reviewer in reviewers:
            out = self.call(
                reviewer,
                "POST",
                f"/instruction-sets/{set_id}/review",
                json={"decision": "approve", "comment": "verified against the source documents"},
            )
            print(
                f"  set {set_id}: {reviewer} approved ({out['approvals']}/{out['required_approvals']}) -> {out['instruction_set']['state']}"
            )

    def review(self) -> None:
        self.section("Review: edit requested on the incident note, then approvals")
        incident = self.sets["incident_triage_note.md"]
        self.call("dana", "POST", f"/instruction-sets/{incident}/submit")
        out = self.call(
            "ravi",
            "POST",
            f"/instruction-sets/{incident}/review",
            json={
                "decision": "request_changes",
                "comment": "step 6 must announce mitigation in #incidents first",
            },
        )
        print(f"  set {incident}: ravi requested changes -> {out['instruction_set']['state']}")

        def announce(document: dict[str, Any]) -> None:
            document["steps"][5]["action"] = (
                "Post the mitigation plan in #incidents, then "
                + document["steps"][5]["action"][0].lower()
                + document["steps"][5]["action"][1:]
            )
            document["steps"][5]["citations"].append(
                {"source_kind": "url", "source_ref": "https://status.example.com/runbooks/triage"}
            )

        self.edit(incident, "announce mitigation in #incidents before acting", announce)
        self.review_round(incident, ["mei"])
        self.review_round(self.sets["onboarding_checklist.md"], ["ravi"])
        self.review_round(self.sets["refund_handling_sop.md"], ["ravi", "mei"])

    def run_tests(self, set_id: int) -> dict[str, Any]:
        run = self.call("ravi", "POST", f"/instruction-sets/{set_id}/run-tests")
        print(
            f"  set {set_id} v{run['version']}: {run['status'].upper()} ({run['passed']} passed, {run['failed']} failed)"
        )
        for result in run["results"]:
            if not result["passed"]:
                print(f"    FAIL {result['name']}: " + "; ".join(result["failures"]))
        return run

    def publish(self, set_id: int) -> bool:
        response = self.api.post(
            f"/instruction-sets/{set_id}/publish", headers={"X-API-Key": KEYS["ops"]}
        )
        if response.status_code == 409:
            self.blocked += 1
            print(f"  set {set_id}: publish BLOCKED: {response.json()['detail']}")
            return False
        if response.status_code != 200:
            print(f"unexpected {response.status_code}: {response.text}")
            sys.exit(1)
        out = response.json()
        for pub in out["publications"]:
            receipt = pub["receipt"].get("receipt_id") or pub["receipt"].get("comment", {}).get(
                "id"
            )
            print(
                f"  set {set_id} v{pub['version']}: delivered to {pub['target']} (receipt {receipt})"
            )
        return True

    def gate(self) -> None:
        self.section("Running test cases and publishing approved sets")
        for name in (
            "onboarding_checklist.md",
            "incident_triage_note.md",
            "refund_handling_sop.md",
        ):
            self.run_tests(self.sets[name])
        for name in (
            "onboarding_checklist.md",
            "incident_triage_note.md",
            "refund_handling_sop.md",
        ):
            self.publish(self.sets[name])

        refund = self.sets["refund_handling_sop.md"]
        self.section(
            f"Fixing set {refund}: add the manager approval threshold from policy/refunds-v4"
        )

        def threshold(document: dict[str, Any]) -> None:
            document["steps"][3]["decision_rules"].append(
                {
                    "condition": "amount is over 500",
                    "then": "request manager approval and stop",
                    "halts": True,
                }
            )
            document["steps"][3]["citations"].append(
                {"source_kind": "doc", "source_ref": "policy/refunds-v4"}
            )

        self.edit(refund, "manager approval required above 500 (policy/refunds-v4)", threshold)
        print(
            f"  set {refund}: state after edit -> {self.call('dana', 'GET', f'/instruction-sets/{refund}')['state']}"
        )
        self.review_round(refund, ["ravi", "mei"])
        self.run_tests(refund)
        self.publish(refund)

    def rollback(self) -> None:
        onboarding = self.sets["onboarding_checklist.md"]
        self.section(f"Revising published set {onboarding}, publishing v2, then rolling back")

        def channel(document: dict[str, Any]) -> None:
            document["steps"][3]["action"] += " and #eng-oncall"

        self.edit(onboarding, "also add the on-call channel", channel)
        self.review_round(onboarding, ["ravi"])
        self.run_tests(onboarding)
        self.publish(onboarding)
        out = self.call("ops", "POST", f"/instruction-sets/{onboarding}/rollback")
        for pub in out["publications"]:
            print(
                f"  set {onboarding}: rollback delivered v{pub['version']} to {pub['target']} (receipt {pub['receipt'].get('receipt_id') or pub['receipt'].get('comment', {}).get('id')})"
            )
        print(
            f"  set {onboarding}: live version is now v{out['instruction_set']['published_version']}"
        )

    def summary(self) -> None:
        self.section("Summary")
        sets = [self.call("ravi", "GET", f"/instruction-sets/{i}") for i in self.sets.values()]
        steps = sum(len(s["document"]["steps"]) for s in sets)
        cited = sum(1 for s in sets for step in s["document"]["steps"] if step["citations"])
        citations = sum(len(step["citations"]) for s in sets for step in s["document"]["steps"])
        edits = sum(
            len(self.call("ravi", "GET", f"/instruction-sets/{s['id']}/edits")) for s in sets
        )
        reviews = [
            r
            for s in sets
            for r in self.call("ravi", "GET", f"/instruction-sets/{s['id']}/reviews")
        ]
        runs = [
            r
            for s in sets
            for r in self.call("ravi", "GET", f"/instruction-sets/{s['id']}/test-runs")
        ]
        pubs = [
            {**p, "set_id": s["id"]}
            for s in sets
            for p in self.call("ravi", "GET", f"/instruction-sets/{s['id']}/publications")
        ]
        delivered = [p for p in pubs if p["action"] == "publish" and p["status"] == "delivered"]
        versions = {(p["set_id"], p["version"]) for p in delivered}
        rollbacks = {(p["set_id"], p["version"]) for p in pubs if p["action"] == "rollback"}
        received = self.fakes.get("/_received").json()
        print(f"  notes ingested:        {len(sets)}")
        print(f"  steps compiled:        {steps}")
        print(
            f"  citations linked:      {citations} ({cited}/{steps} steps cited, {cited / steps:.0%})"
        )
        print(f"  edits recorded:        {edits}")
        print(
            f"  approvals:             {sum(1 for r in reviews if r['decision'] == 'approve')} (changes requested: {sum(1 for r in reviews if r['decision'] == 'request_changes')})"
        )
        print(
            f"  test runs:             {len(runs)} ({sum(1 for r in runs if r['status'] == 'passed')} green, {sum(1 for r in runs if r['status'] == 'failed')} red; {sum(r['passed'] for r in runs)} cases passed, {sum(r['failed'] for r in runs)} failed)"
        )
        print(f"  publishes blocked:     {self.blocked}")
        print(
            f"  publishes delivered:   {len(delivered)} deliveries ({len(versions)} versions to 2 targets), rollbacks: {len(rollbacks)}"
        )
        print(
            f"  receipts:              {len(received['webhook'])} webhook (signed), {len(received['jira_comments'])} Jira comments, {len(received['jira_attachments'])} Jira attachments"
        )
        print(
            "  states:                "
            + ", ".join(
                f"set {s['id']}={s['state']} (live v{s['published_version']})" for s in sets
            )
        )


def main() -> None:
    parser = argparse.ArgumentParser(description="ExpertLoop end-to-end demo")
    parser.add_argument("--api", default="http://localhost:8090")
    parser.add_argument("--fakes", default="http://localhost:8081")
    args = parser.parse_args()
    demo = Demo(args.api, args.fakes)
    demo.wait()
    demo.fakes.post("/_reset")
    demo.ingest()
    demo.show_citations()
    demo.add_test_cases()
    demo.review()
    demo.gate()
    demo.rollback()
    demo.summary()


if __name__ == "__main__":
    main()
