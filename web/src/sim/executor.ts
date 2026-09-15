/**
 * Deterministic local executor (port of expertloop/executor/run.py).
 *
 * A rule-following stand-in for the agent that will receive the instruction set. It walks the
 * compiled steps against a scenario, applies decision rules, records every action and tool
 * call it would take, and stops when a rule says so. Test cases assert on that trace.
 */

import { type DecisionRule, type InstructionDocument, STOP_WORDS } from "./compile";

export interface Scenario {
  facts?: Record<string, unknown>;
  flags?: string[];
}

export interface Expectations {
  required_actions?: string[];
  forbidden_actions?: string[];
  expected_outcomes?: string[];
  expected_tools?: string[];
  must_halt?: boolean;
  must_complete?: boolean;
}

export interface ExecutionTrace {
  actions: string[];
  tool_calls: string[];
  rules_fired: string[];
  outcomes: string[];
  skipped: string[];
  halted_at: string | null;
  steps_executed: string[];
  /** "global:0", "s3:0": the rule labels the coverage report in the Python service counts. */
  rules_fired_ids: string[];
}

export interface CaseResult {
  passed: boolean;
  failures: string[];
  trace: ExecutionTrace;
}

const COMPARE_RE = new RegExp(
  "^(?<field>[a-z_][a-z0-9_ ]*?)\\s*" +
    "(?<op>>=|<=|==|!=|>|<|\\bis more than\\b|\\bis greater than\\b|\\bis at least\\b" +
    "|\\bis less than\\b|\\bis at most\\b|\\bis over\\b|\\bis under\\b|\\bis not\\b|\\bis\\b" +
    "|\\bcontains\\b|\\bequals\\b|\\bexceeds\\b|\\bover\\b|\\bunder\\b|\\bbelow\\b|\\babove\\b)" +
    "\\s*(?<value>.+)$",
  "i",
);
const NUMBER_RE = /^[$€£]?\s*(-?\d[\d,]*(?:\.\d+)?)\b/;

function coerce(value: string): unknown {
  const text = value.trim().replace(/^["']+|["']+$/g, "").replace(/\.+$/, "");
  const lowered = text.toLowerCase();
  if (lowered === "true" || lowered === "yes") return true;
  if (lowered === "false" || lowered === "no") return false;
  const number = NUMBER_RE.exec(text);
  if (number) {
    const cleaned = number[1].replace(/,/g, "");
    return cleaned.includes(".") ? parseFloat(cleaned) : parseInt(cleaned, 10);
  }
  return text;
}

function lookup(facts: Record<string, unknown>, name: string): [boolean, unknown] {
  const key = name.trim().toLowerCase().replace(/ /g, "_");
  for (const candidate of [key, key.replace("the_", ""), key.replace("customer_", "")]) {
    if (candidate in facts) return [true, facts[candidate]];
  }
  return [false, null];
}

function hasStopWord(text: string): boolean {
  const lowered = text.toLowerCase();
  return STOP_WORDS.some((w) => lowered.includes(w));
}

/**
 * Evaluate a natural-language condition against the scenario. Structured facts live in
 * scenario.facts; free-form flags in scenario.flags match a condition by exact text.
 */
export function evaluateCondition(condition: string, scenario: Scenario): boolean {
  const facts = scenario.facts ?? {};
  const flags = new Set((scenario.flags ?? []).map((f) => String(f).trim().toLowerCase()));
  const normalized = condition.trim().toLowerCase().replace(/\.+$/, "");
  if (flags.has(normalized)) return true;
  const match = COMPARE_RE.exec(normalized);
  if (!match || !match.groups) return false;
  const [found, actual] = lookup(facts, match.groups.field);
  if (!found) return false;
  const op = match.groups.op.trim();
  const expected = coerce(match.groups.value);
  let actualCmp: unknown = actual;
  let expectedCmp: unknown = expected;
  if (typeof expected === "string" && typeof actual === "string") {
    actualCmp = actual.toLowerCase();
    expectedCmp = expected.toLowerCase();
  }
  const comparable = (typeof actualCmp === "number" && typeof expectedCmp === "number") ||
    (typeof actualCmp === "string" && typeof expectedCmp === "string");
  const a = actualCmp as number;
  const b = expectedCmp as number;
  if ([">", "exceeds", "over", "above", "is more than", "is greater than", "is over"].includes(op)) {
    return comparable && a > b;
  }
  if (["<", "under", "below", "is less than", "is under"].includes(op)) return comparable && a < b;
  if ([">=", "is at least"].includes(op)) return comparable && a >= b;
  if (["<=", "is at most"].includes(op)) return comparable && a <= b;
  if (["==", "is", "equals"].includes(op)) return actualCmp === expectedCmp;
  if (["!=", "is not"].includes(op)) return actualCmp !== expectedCmp;
  if (op === "contains") return String(actualCmp).includes(String(expectedCmp));
  return false;
}

function applyRules(rules: DecisionRule[], scenario: Scenario, trace: ExecutionTrace, label: string): boolean {
  for (const [index, rule] of rules.entries()) {
    if (evaluateCondition(rule.condition, scenario)) {
      trace.rules_fired.push(`${label}: if ${rule.condition} then ${rule.then}`);
      trace.rules_fired_ids.push(`${label}:${index}`);
      trace.actions.push(rule.then);
      if (rule.halts || hasStopWord(rule.then)) {
        trace.halted_at = label;
        return true;
      }
    }
  }
  return false;
}

export function execute(document: InstructionDocument, scenario: Scenario): ExecutionTrace {
  const trace: ExecutionTrace = {
    actions: [],
    tool_calls: [],
    rules_fired: [],
    outcomes: [],
    skipped: [],
    halted_at: null,
    steps_executed: [],
    rules_fired_ids: [],
  };
  if (applyRules(document.decision_rules ?? [], scenario, trace, "global")) return trace;
  for (const step of document.steps ?? []) {
    if (step.condition && !evaluateCondition(step.condition, scenario)) {
      trace.skipped.push(step.id);
      continue;
    }
    if (applyRules(step.decision_rules ?? [], scenario, trace, step.id)) return trace;
    trace.steps_executed.push(step.id);
    trace.actions.push(step.action);
    if (step.tool) trace.tool_calls.push(step.tool);
    if (step.expected_outcome) trace.outcomes.push(step.expected_outcome);
    if (step.halts) {
      trace.halted_at = step.id;
      return trace;
    }
  }
  for (const o of document.outcomes ?? []) trace.outcomes.push(o.text);
  return trace;
}

function contains(haystack: string[], needle: string): boolean {
  const lowered = needle.toLowerCase();
  return haystack.some((item) => item.toLowerCase().includes(lowered));
}

export function runTestCase(document: InstructionDocument, scenario: Scenario, expectations: Expectations): CaseResult {
  const trace = execute(document, scenario);
  const failures: string[] = [];
  for (const needle of expectations.required_actions ?? []) {
    if (!contains(trace.actions, needle)) failures.push(`required action not taken: '${needle}'`);
  }
  for (const needle of expectations.forbidden_actions ?? []) {
    if (contains(trace.actions, needle)) failures.push(`forbidden action taken: '${needle}'`);
  }
  for (const needle of expectations.expected_outcomes ?? []) {
    if (!contains(trace.outcomes, needle)) failures.push(`expected outcome missing: '${needle}'`);
  }
  for (const tool of expectations.expected_tools ?? []) {
    if (!contains(trace.tool_calls, tool)) failures.push(`expected tool not called: '${tool}'`);
  }
  if (expectations.must_halt && trace.halted_at === null) {
    failures.push("execution was expected to halt but ran to completion");
  }
  if (expectations.must_complete && trace.halted_at !== null) {
    failures.push(`execution halted at ${trace.halted_at} but was expected to complete`);
  }
  return { passed: failures.length === 0, failures, trace };
}
