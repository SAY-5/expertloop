/**
 * Rule-based compiler from a parsed note to an InstructionSet document
 * (port of expertloop/compiler/compile.py). Every step carries at least one citation:
 * the line range of the note item it came from plus any source references found on it.
 */

import { type NoteItem, type ParsedNote, type SourceRef, parseNote, sectionItems } from "./parser";

export interface Citation {
  note_id: number | null;
  line_start: number;
  line_end: number;
  source_kind?: string;
  source_ref?: string;
  source_id?: number;
  source_hash?: string;
}

export interface DecisionRule {
  condition: string;
  then: string;
  halts: boolean;
  citations?: Citation[];
}

export interface Step {
  id: string;
  order: number;
  action: string;
  condition: string | null;
  halts: boolean;
  tool: string | null;
  decision_rules: DecisionRule[];
  forbidden: string[];
  expected_outcome: string | null;
  citations: Citation[];
}

export interface CitedText {
  text: string;
  citations: Citation[];
}

export interface InstructionDocument {
  name: string;
  title: string;
  preconditions: CitedText[];
  steps: Step[];
  decision_rules: DecisionRule[];
  tools: string[];
  outcomes: CitedText[];
  forbidden_actions: CitedText[];
  sources: SourceRef[];
  agent_prompt: string;
}

const TOOL_RE = /\b(?:in|via|using|through|open|call|from)\s+([A-Z][A-Za-z0-9]+(?:\s[A-Z][A-Za-z0-9]+)?)/;
const RULE_RE = /^\s*(?:if|when)\s+(.+?)\s*(?:,|then)\s*(.+)$/i;
const FORBIDDEN_RE = /\b(?:never|do not|don't|must not)\s+(.+)/i;
const OUTCOME_RE = /\b(?:so that|until|expected:|result:)\s*(.+)$/i;
export const STOP_WORDS = ["stop", "halt", "escalate", "do not proceed", "hand off", "hand it off", "pause"];

function rstripDot(value: string): string {
  return value.replace(/\.+$/, "");
}

function hasStopWord(text: string): boolean {
  const lowered = text.toLowerCase();
  return STOP_WORDS.some((word) => lowered.includes(word));
}

function citation(item: NoteItem, noteId: number | null, ref?: SourceRef): Citation {
  const cite: Citation = { note_id: noteId, line_start: item.line_start, line_end: item.line_end };
  if (ref) {
    cite.source_kind = ref.kind;
    cite.source_ref = ref.ref;
  }
  return cite;
}

function citations(item: NoteItem, noteId: number | null): Citation[] {
  return [citation(item, noteId), ...item.sources.map((ref) => citation(item, noteId, ref))];
}

function firstLine(text: string): string {
  return text.split("\n", 1)[0].trim();
}

function detectTool(text: string, knownTools: string[]): string | null {
  const lowered = text.toLowerCase();
  for (const tool of knownTools) {
    if (lowered.includes(tool.toLowerCase())) return tool;
  }
  const match = TOOL_RE.exec(text);
  return match ? match[1] : null;
}

interface SplitResult {
  action: string;
  condition: string | null;
  rules: DecisionRule[];
  forbidden: string[];
  outcome: string | null;
}

/**
 * Separate a step into action, gating condition, decision rules, forbidden clauses and outcome.
 * A step whose first line is itself "if X, Y" is conditional: it runs only when X holds and its
 * action is Y. Rules on later lines are decision rules evaluated before the action.
 */
function splitRules(text: string): SplitResult {
  const actionLines: string[] = [];
  let condition: string | null = null;
  const rules: DecisionRule[] = [];
  const forbidden: string[] = [];
  let outcome: string | null = null;
  text.split("\n").forEach((rawLine, index) => {
    let line = rawLine;
    const rule = RULE_RE.exec(line);
    if (rule && index === 0) {
      condition = rule[1].trim();
      line = rule[2].trim();
    } else if (rule) {
      const then = rstripDot(rule[2].trim());
      rules.push({ condition: rule[1].trim(), then, halts: hasStopWord(then) });
      return;
    }
    const banned = FORBIDDEN_RE.exec(line);
    if (banned) {
      forbidden.push(rstripDot(banned[1].trim()));
      return;
    }
    const result = OUTCOME_RE.exec(line);
    if (result && outcome === null) {
      const captured = result[1].trim();
      const split = captured.indexOf(". ");
      let rest = "";
      if (split >= 0) {
        outcome = captured.slice(0, split);
        rest = captured.slice(split + 2);
      } else {
        outcome = captured;
      }
      outcome = rstripDot(outcome);
      line = line.slice(0, result.index).trim().replace(/,+$/, "");
      if (line) actionLines.push(line);
      if (rest) actionLines.push(rest.trim());
      return;
    }
    actionLines.push(line.trim());
  });
  const action = actionLines.filter(Boolean).join(" ").trim();
  return { action, condition, rules, forbidden, outcome };
}

export function compileParsed(parsed: ParsedNote, noteId: number | null, name: string): InstructionDocument {
  const tools = sectionItems(parsed, "tools").map((item) => rstripDot(firstLine(item.text)));
  const steps: Step[] = [];
  const globalRules: DecisionRule[] = [];
  const forbiddenActions: CitedText[] = [];
  const preconditions = sectionItems(parsed, "preconditions").map((item) => ({
    text: rstripDot(firstLine(item.text)),
    citations: citations(item, noteId),
  }));
  const outcomes = sectionItems(parsed, "outcomes").map((item) => ({
    text: rstripDot(firstLine(item.text)),
    citations: citations(item, noteId),
  }));

  for (const item of sectionItems(parsed, "decision_rules")) {
    const rule = RULE_RE.exec(firstLine(item.text));
    if (rule) {
      const then = rstripDot(rule[2].trim());
      globalRules.push({
        condition: rule[1].trim(),
        then,
        halts: hasStopWord(then),
        citations: citations(item, noteId),
      });
    } else {
      globalRules.push({
        condition: rstripDot(firstLine(item.text)),
        then: "apply rule",
        halts: false,
        citations: citations(item, noteId),
      });
    }
  }

  for (const item of sectionItems(parsed, "forbidden")) {
    const banned = FORBIDDEN_RE.exec(item.text);
    const text = banned ? banned[1] : firstLine(item.text);
    forbiddenActions.push({ text: rstripDot(text.trim()), citations: citations(item, noteId) });
  }

  sectionItems(parsed, "steps").forEach((item, i) => {
    const index = i + 1;
    const { condition, rules, forbidden, outcome, action: split } = splitRules(item.text);
    const action = split || firstLine(item.text);
    steps.push({
      id: `s${index}`,
      order: index,
      action: rstripDot(action),
      condition,
      halts: hasStopWord(action),
      tool: detectTool(item.text, tools),
      decision_rules: rules,
      forbidden,
      expected_outcome: outcome,
      citations: citations(item, noteId),
    });
    for (const text of forbidden) {
      forbiddenActions.push({ text, citations: citations(item, noteId) });
    }
  });

  const document: InstructionDocument = {
    name,
    title: parsed.title ?? name,
    preconditions,
    steps,
    decision_rules: globalRules,
    tools,
    outcomes,
    forbidden_actions: forbiddenActions,
    sources: parsed.sources.map((ref) => ({ kind: ref.kind, ref: ref.ref })),
    agent_prompt: "",
  };
  document.agent_prompt = renderPrompt(document);
  return document;
}

export function compileNote(body: string, noteId: number | null = null, name?: string): InstructionDocument {
  const parsed = parseNote(body);
  return compileParsed(parsed, noteId, name ?? parsed.title ?? "untitled");
}

/** Render the instruction set as the text an agent will receive. */
export function renderPrompt(document: InstructionDocument): string {
  const lines: string[] = [`# ${document.title}`, ""];
  if (document.preconditions.length) {
    lines.push("Before starting, confirm:");
    for (const p of document.preconditions) lines.push(`- ${p.text}`);
    lines.push("");
  }
  lines.push("Follow these steps in order:");
  for (const step of document.steps) {
    const tool = step.tool ? ` (tool: ${step.tool})` : "";
    const gate = step.condition ? `Only if ${step.condition}: ` : "";
    lines.push(`${step.order}. ${gate}${step.action}${tool}`);
    for (const rule of step.decision_rules) lines.push(`   - if ${rule.condition}: ${rule.then}`);
    if (step.expected_outcome) lines.push(`   - expected: ${step.expected_outcome}`);
  }
  if (document.decision_rules.length) {
    lines.push("", "Decision rules:");
    for (const r of document.decision_rules) lines.push(`- if ${r.condition}: ${r.then}`);
  }
  if (document.forbidden_actions.length) {
    lines.push("", "Never:");
    for (const f of document.forbidden_actions) lines.push(`- ${f.text}`);
  }
  if (document.outcomes.length) {
    lines.push("", "Done when:");
    for (const o of document.outcomes) lines.push(`- ${o.text}`);
  }
  return lines.join("\n");
}

export interface Coverage {
  steps: number;
  cited_steps: number;
  citations: number;
  coverage: number;
}

export function citationCoverage(document: InstructionDocument): Coverage {
  const steps = document.steps;
  const cited = steps.filter((s) => s.citations.length > 0);
  const total = steps.length;
  return {
    steps: total,
    cited_steps: cited.length,
    citations: steps.reduce((sum, s) => sum + s.citations.length, 0),
    coverage: total ? cited.length / total : 1,
  };
}

/** Return a list of problems; an empty list means the document is acceptable. */
export function validateDocument(document: Partial<InstructionDocument>): string[] {
  const problems: string[] = [];
  for (const key of ["title", "steps", "preconditions", "decision_rules", "forbidden_actions"] as const) {
    if (!(key in document)) problems.push(`missing field: ${key}`);
  }
  const steps = document.steps ?? [];
  for (const step of steps) {
    if (!step.id) problems.push("step without id");
    if (!step.action) problems.push(`step ${step.id} has no action`);
    if (!step.citations || step.citations.length === 0) problems.push(`step ${step.id} has no citations`);
  }
  const ids = steps.map((s) => s.id);
  if (ids.length !== new Set(ids).size) problems.push("duplicate step ids");
  return problems;
}
