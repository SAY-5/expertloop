"""Deterministic local executor.

The executor is a rule-following stand-in for the agent that will eventually receive
the instruction set. It walks the compiled steps against a scenario, applies decision
rules, records every action and tool call it would take, and stops when a rule says so.
Test cases assert on that trace: required actions, forbidden actions, expected
outcomes and tool calls.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

COMPARE_RE = re.compile(
    r"^(?P<field>[a-z_][a-z0-9_ ]*?)\s*"
    r"(?P<op>>=|<=|==|!=|>|<|\bis not\b|\bis\b|\bcontains\b|\bequals\b"
    r"|\bexceeds\b|\bover\b|\bunder\b|\bbelow\b|\babove\b)"
    r"\s*(?P<value>.+)$",
    re.IGNORECASE,
)
STOP_WORDS = ("stop", "halt", "escalate", "do not proceed", "hand off", "hand it off", "pause")


@dataclass
class ExecutionTrace:
    actions: list[str] = field(default_factory=list)
    tool_calls: list[str] = field(default_factory=list)
    rules_fired: list[str] = field(default_factory=list)
    outcomes: list[str] = field(default_factory=list)
    halted_at: str | None = None

    def as_dict(self) -> dict[str, Any]:
        return {
            "actions": self.actions,
            "tool_calls": self.tool_calls,
            "rules_fired": self.rules_fired,
            "outcomes": self.outcomes,
            "halted_at": self.halted_at,
        }


def _coerce(value: str) -> Any:
    text = value.strip().strip("\"'").rstrip(".")
    lowered = text.lower()
    if lowered in ("true", "yes"):
        return True
    if lowered in ("false", "no"):
        return False
    cleaned = text.replace(",", "").lstrip("$")
    try:
        return float(cleaned) if "." in cleaned else int(cleaned)
    except ValueError:
        return text


def _lookup(facts: dict[str, Any], name: str) -> tuple[bool, Any]:
    key = name.strip().lower().replace(" ", "_")
    for candidate in (key, key.replace("the_", ""), key.replace("customer_", "")):
        if candidate in facts:
            return True, facts[candidate]
    return False, None


def evaluate_condition(condition: str, scenario: dict[str, Any]) -> bool:
    """Evaluate a natural-language condition against the scenario.

    Structured facts live in ``scenario["facts"]``; free-form flags in ``scenario["flags"]``
    match a condition by exact (case-insensitive) text.
    """
    facts = scenario.get("facts", {})
    flags = {str(f).strip().lower() for f in scenario.get("flags", [])}
    normalized = condition.strip().lower().rstrip(".")
    if normalized in flags:
        return True
    match = COMPARE_RE.match(normalized)
    if not match:
        return False
    found, actual = _lookup(facts, match.group("field"))
    if not found:
        return False
    op = match.group("op").strip()
    expected = _coerce(match.group("value"))
    if isinstance(expected, str) and isinstance(actual, str):
        actual_cmp, expected_cmp = actual.lower(), expected.lower()
    else:
        actual_cmp, expected_cmp = actual, expected
    try:
        if op in (">", "exceeds", "over", "above"):
            return actual_cmp > expected_cmp
        if op in ("<", "under", "below"):
            return actual_cmp < expected_cmp
        if op == ">=":
            return actual_cmp >= expected_cmp
        if op == "<=":
            return actual_cmp <= expected_cmp
        if op in ("==", "is", "equals"):
            return actual_cmp == expected_cmp
        if op in ("!=", "is not"):
            return actual_cmp != expected_cmp
        if op == "contains":
            return str(expected_cmp) in str(actual_cmp)
    except TypeError:
        return False
    return False


def _apply_rules(
    rules: list[dict[str, Any]], scenario: dict[str, Any], trace: ExecutionTrace, label: str
) -> bool:
    """Fire matching rules. Return True when execution must halt."""
    for rule in rules:
        if evaluate_condition(rule["condition"], scenario):
            trace.rules_fired.append(f"{label}: if {rule['condition']} then {rule['then']}")
            trace.actions.append(rule["then"])
            if rule.get("halts") or any(w in rule["then"].lower() for w in STOP_WORDS):
                trace.halted_at = label
                return True
    return False


def execute(document: dict[str, Any], scenario: dict[str, Any]) -> ExecutionTrace:
    trace = ExecutionTrace()
    if _apply_rules(document.get("decision_rules", []), scenario, trace, "global"):
        return trace
    for step in document.get("steps", []):
        if _apply_rules(step.get("decision_rules", []), scenario, trace, step["id"]):
            return trace
        trace.actions.append(step["action"])
        if step.get("tool"):
            trace.tool_calls.append(step["tool"])
        if step.get("expected_outcome"):
            trace.outcomes.append(step["expected_outcome"])
    trace.outcomes.extend(o["text"] for o in document.get("outcomes", []))
    return trace


def _contains(haystack: list[str], needle: str) -> bool:
    needle = needle.lower()
    return any(needle in item.lower() for item in haystack)


def run_test_case(
    document: dict[str, Any], scenario: dict[str, Any], expectations: dict[str, Any]
) -> dict[str, Any]:
    trace = execute(document, scenario)
    failures: list[str] = []
    for needle in expectations.get("required_actions", []):
        if not _contains(trace.actions, needle):
            failures.append(f"required action not taken: {needle!r}")
    for needle in expectations.get("forbidden_actions", []):
        if _contains(trace.actions, needle):
            failures.append(f"forbidden action taken: {needle!r}")
    for needle in expectations.get("expected_outcomes", []):
        if not _contains(trace.outcomes, needle):
            failures.append(f"expected outcome missing: {needle!r}")
    for tool in expectations.get("expected_tools", []):
        if not _contains(trace.tool_calls, tool):
            failures.append(f"expected tool not called: {tool!r}")
    if expectations.get("must_halt") and trace.halted_at is None:
        failures.append("execution was expected to halt but ran to completion")
    if expectations.get("must_complete") and trace.halted_at is not None:
        failures.append(f"execution halted at {trace.halted_at} but was expected to complete")
    return {"passed": not failures, "failures": failures, "trace": trace.as_dict()}
