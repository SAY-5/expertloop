from expertloop.compiler import compile_note, parse_note
from expertloop.compiler.compile import citation_coverage, validate_document
from expertloop.executor import execute
from tests.conftest import sample


def test_refund_sop_steps_cite_note_lines_and_sources():
    doc = compile_note(sample("refund_handling_sop.md"), note_id=7, name="refunds")
    assert citation_coverage(doc) == {"steps": 5, "cited_steps": 5, "citations": 7, "coverage": 1.0}
    assert validate_document(doc) == []
    assert doc["tools"] == ["Stripe", "Zendesk", "OrderDB"]
    assert [s["ref"] for s in doc["sources"]] == ["policy/refunds-v4", "FIN-2210"]
    step2 = doc["steps"][1]
    assert step2["citations"][0] == {"note_id": 7, "line_start": 14, "line_end": 15}
    assert step2["citations"][1]["source_ref"] == "policy/refunds-v4"
    assert step2["decision_rules"] == [
        {
            "condition": "reason is fraud",
            "then": "escalate to the risk team and stop",
            "halts": True,
        }
    ]
    assert doc["steps"][2]["expected_outcome"] == "warehouse scan present in OrderDB"
    assert doc["steps"][3]["tool"] == "Stripe"
    assert [f["text"] for f in doc["forbidden_actions"]] == [
        "refund to a different card than the one charged",
        "issue store credit instead of a refund unless the customer asks for it in writing",
    ]
    assert len(doc["preconditions"]) == 2 and len(doc["outcomes"]) == 1


def test_onboarding_note_has_nested_rule_and_global_rule():
    doc = compile_note(sample("onboarding_checklist.md"), note_id=1)
    assert citation_coverage(doc)["coverage"] == 1.0
    assert len(doc["steps"]) == 6
    step3 = doc["steps"][2]
    assert step3["citations"][0]["line_start"] == 16 and step3["citations"][0]["line_end"] == 17
    assert step3["decision_rules"][0]["condition"] == "the role is contractor"
    assert doc["decision_rules"][0]["halts"] is True
    assert {s["kind"] for s in doc["sources"]} == {"url", "ticket", "doc"}


def test_incident_note_compiles_conditional_steps():
    doc = compile_note(sample("incident_triage_note.md"), note_id=1)
    assert citation_coverage(doc)["coverage"] == 1.0
    assert doc["steps"][2]["condition"] == "error rate exceeds 5 percent"
    assert doc["steps"][2]["action"] == "declare a SEV1 in Slack and page the service owner"
    assert doc["steps"][3]["condition"] == "error rate is under 5 percent"
    assert "3. Only if error rate exceeds 5 percent:" in doc["agent_prompt"]


def test_parser_line_ranges_and_sections():
    parsed = parse_note(
        "# T\n\n## Steps\n1. one\n   more\n2. two https://x.io/a.\n\n## Never\n- never do it\n"
    )
    assert parsed.title == "T"
    steps = parsed.section("steps")
    assert [(i.line_start, i.line_end) for i in steps] == [(4, 5), (6, 6)]
    assert steps[0].text == "one\nmore"
    assert steps[1].sources[0].ref == "https://x.io/a"
    assert parsed.section("forbidden")[0].text == "never do it"


def test_validate_document_rejects_uncited_steps():
    doc = compile_note("# X\n1. do a thing\n")
    doc["steps"][0]["citations"] = []
    assert validate_document(doc) == ["step s1 has no citations"]


def test_do_not_proceed_until_is_a_guard_not_a_forbidden_action():
    doc = compile_note(
        "# W\n\n## Steps\n"
        "1. Wait for the warehouse scan and do not proceed until it is present.\n"
        "2. Ship the parcel.\n",
        note_id=1,
    )
    step = doc["steps"][0]
    assert step["action"] == "Wait for the warehouse scan"
    assert step["expected_outcome"] == "it is present"
    assert step["halts"] is False and step["forbidden"] == []
    assert doc["forbidden_actions"] == []
    trace = execute(doc, {"facts": {}})
    assert trace.steps_executed == ["s1", "s2"] and trace.halted_at is None


def test_must_not_proceed_before_is_the_same_guard():
    doc = compile_note(
        "# W\n\n## Steps\n"
        "1. Confirm the packing slip and must not proceed before the scan lands.\n",
        note_id=1,
    )
    step = doc["steps"][0]
    assert step["action"] == "Confirm the packing slip"
    assert step["expected_outcome"] == "the scan lands"
    assert doc["forbidden_actions"] == []


def test_negated_stop_word_does_not_halt_the_step():
    doc = compile_note(
        "# N\n\n## Steps\n1. Answer the ticket and do not escalate to the risk team.\n",
        note_id=1,
    )
    step = doc["steps"][0]
    assert step["halts"] is False
    assert step["forbidden"] == ["escalate to the risk team"]
    assert execute(doc, {"facts": {}}).halted_at is None


def test_unless_clause_stays_in_the_action():
    doc = compile_note(
        "# U\n\n## Steps\n1. Issue the refund unless the order is flagged.\n", note_id=1
    )
    step = doc["steps"][0]
    assert step["action"] == "Issue the refund unless the order is flagged"
    assert step["condition"] is None and step["forbidden"] == []


def test_otherwise_clause_is_not_compiled_into_a_second_branch():
    """A limitation the README states: the else branch stays in the conditional step."""
    doc = compile_note(
        "# O\n\n## Steps\n"
        "1. If the scan is present, ship the parcel, otherwise hold it.\n"
        "2. Log the outcome.\n",
        note_id=1,
    )
    step = doc["steps"][0]
    assert step["condition"] == "the scan is present"
    assert step["action"] == "ship the parcel, otherwise hold it"
    assert execute(doc, {"facts": {}}).skipped == ["s1"]
