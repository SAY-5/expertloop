from expertloop.compiler import compile_note
from expertloop.executor import evaluate_condition, execute, run_test_case
from tests.conftest import sample


def test_evaluate_condition_numeric_and_text():
    assert evaluate_condition("amount is over 500", {"facts": {"amount": 800}})
    assert not evaluate_condition("amount is over 500", {"facts": {"amount": 120}})
    assert evaluate_condition("error rate exceeds 5 percent", {"facts": {"error_rate": 7.5}})
    assert evaluate_condition("reason is fraud", {"facts": {"reason": "Fraud"}})
    assert evaluate_condition("the role is contractor", {"facts": {"role": "contractor"}})
    assert evaluate_condition("customer asked in writing", {"flags": ["customer asked in writing"]})
    assert not evaluate_condition("unknown field > 1", {"facts": {}})


def test_execution_halts_on_fraud_rule():
    doc = compile_note(sample("refund_handling_sop.md"))
    trace = execute(doc, {"facts": {"reason": "fraud"}})
    assert trace.halted_at == "s2"
    assert trace.actions[-1] == "escalate to the risk team and stop"
    assert "Issue the refund in Stripe for the captured amount" not in trace.actions


def test_conditional_steps_are_skipped_when_condition_fails():
    doc = compile_note(sample("incident_triage_note.md"))
    trace = execute(doc, {"facts": {"error_rate": 2}})
    assert trace.skipped == ["s3"]
    assert "post a status update in the #incidents Slack channel" in trace.actions
    assert trace.tool_calls.count("PagerDuty") == 2


def test_run_test_case_reports_forbidden_and_missing_actions():
    doc = compile_note(sample("refund_handling_sop.md"))
    result = run_test_case(
        doc,
        {"facts": {"amount": 800, "reason": "damaged"}},
        {
            "forbidden_actions": ["Issue the refund"],
            "required_actions": ["manager"],
            "must_halt": True,
        },
    )
    assert result["passed"] is False
    assert result["failures"] == [
        "required action not taken: 'manager'",
        "forbidden action taken: 'Issue the refund'",
        "execution was expected to halt but ran to completion",
    ]
    ok = run_test_case(
        doc,
        {"facts": {"amount": 40}},
        {"expected_tools": ["Stripe", "Zendesk"], "must_complete": True},
    )
    assert ok["passed"] is True
