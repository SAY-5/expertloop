"""Test coverage of an instruction set: which steps and decision rules the cases exercise."""

from __future__ import annotations

from typing import Any

from expertloop.executor.run import execute


def rule_labels(document: dict[str, Any]) -> dict[str, str]:
    """Every decision rule in the document keyed ``global:<i>`` or ``<step id>:<i>``."""
    labels = {
        f"global:{i}": f"if {r['condition']} then {r['then']}"
        for i, r in enumerate(document.get("decision_rules", []))
    }
    for step in document.get("steps", []):
        for i, r in enumerate(step.get("decision_rules", [])):
            labels[f"{step['id']}:{i}"] = f"if {r['condition']} then {r['then']}"
    return labels


def coverage_report(
    document: dict[str, Any], cases: list[tuple[str, dict[str, Any]]]
) -> dict[str, Any]:
    """Execute every (name, scenario) pair and count which steps and rules were hit."""
    step_ids = [s["id"] for s in document.get("steps", [])]
    labels = rule_labels(document)
    step_hits: dict[str, list[str]] = {s: [] for s in step_ids}
    rule_hits: dict[str, list[str]] = {r: [] for r in labels}
    halting = 0
    for name, scenario in cases:
        trace = execute(document, scenario)
        for step_id in trace.steps_executed:
            step_hits[step_id].append(name)
        for label in trace.rules_fired_ids:
            rule_hits.setdefault(label, []).append(name)
        if trace.halted_at is not None:
            halting += 1
    covered_steps = [s for s in step_ids if step_hits[s]]
    covered_rules = [r for r in labels if rule_hits[r]]
    return {
        "test_cases": len(cases),
        "halting_cases": halting,
        "steps": {
            "total": len(step_ids),
            "covered": len(covered_steps),
            "uncovered": [s for s in step_ids if not step_hits[s]],
            "coverage": (len(covered_steps) / len(step_ids)) if step_ids else 1.0,
            "hits": {s: len(step_hits[s]) for s in step_ids},
        },
        "decision_rules": {
            "total": len(labels),
            "covered": len(covered_rules),
            "uncovered": [{"id": r, "rule": labels[r]} for r in labels if not rule_hits[r]],
            "coverage": (len(covered_rules) / len(labels)) if labels else 1.0,
            "hits": {r: len(rule_hits[r]) for r in labels},
        },
    }


def coverage_summary(report: dict[str, Any]) -> dict[str, Any]:
    """The part of a report worth storing on a test run."""
    return {
        "test_cases": report["test_cases"],
        "steps": report["steps"]["coverage"],
        "steps_uncovered": report["steps"]["uncovered"],
        "decision_rules": report["decision_rules"]["coverage"],
        "decision_rules_uncovered": [r["id"] for r in report["decision_rules"]["uncovered"]],
    }
