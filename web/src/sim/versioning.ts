/**
 * Structured diff and three-way merge of instruction set documents
 * (port of expertloop/versioning.py).
 *
 * Steps are matched by id and compared field by field; section entries (preconditions,
 * decision rules, forbidden actions, outcomes) are matched by their text. Citation source
 * hashes are ignored when comparing, so a re-hashed source does not show up as an edit.
 * The merge takes a change made on one side only, keeps identical changes, and reports a
 * conflict when both sides changed the same field differently.
 */

import { type InstructionDocument, type Step } from "./compile";
import { canonicalCompact } from "./diff";

export const SECTIONS = ["preconditions", "decision_rules", "forbidden_actions", "outcomes"] as const;
export const SCALARS = ["title", "tools"] as const;
export const STEP_FIELDS = [
  "order",
  "action",
  "condition",
  "halts",
  "tool",
  "decision_rules",
  "forbidden",
  "expected_outcome",
  "citations",
] as const;

export type Section = (typeof SECTIONS)[number];
export type Scalar = (typeof SCALARS)[number];
export type StepField = (typeof STEP_FIELDS)[number];

type Doc = Record<string, unknown>;
type Entry = Record<string, unknown>;

/** Copy of `value` with citation source hashes dropped, for comparisons. */
function canon(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canon);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k !== "source_hash") out[k] = canon(v);
    }
    return out;
  }
  return value;
}

export function same(a: unknown, b: unknown): boolean {
  return canonicalCompact(canon(a)) === canonicalCompact(canon(b));
}

function entryKey(entry: Entry): string {
  if ("condition" in entry && "then" in entry) return `if ${String(entry.condition)} then ${String(entry.then)}`;
  return String(entry.text ?? "");
}

function stepsOf(document: Doc): Record<string, Entry> {
  const out: Record<string, Entry> = {};
  for (const step of (document.steps as Entry[] | undefined) ?? []) out[String(step.id)] = step;
  return out;
}

function entriesOf(document: Doc, section: Section): Record<string, Entry> {
  const out: Record<string, Entry> = {};
  for (const entry of (document[section] as Entry[] | undefined) ?? []) out[entryKey(entry)] = entry;
  return out;
}

export interface FieldChange {
  before: unknown;
  after: unknown;
}

export interface ChangedStep {
  id: string;
  fields: Partial<Record<StepField, FieldChange>>;
}

export interface SectionChange {
  added: Entry[];
  removed: Entry[];
}

export interface DiffSummary {
  steps_added: number;
  steps_removed: number;
  steps_changed: number;
  entries_added: number;
  entries_removed: number;
  fields_changed: number;
}

export interface StructuredDiff {
  steps: { added: Entry[]; removed: Entry[]; changed: ChangedStep[] };
  sections: Record<Section, SectionChange>;
  fields: Partial<Record<Scalar, FieldChange>>;
  summary: DiffSummary;
}

/** Step-level diff: added, removed and changed steps plus section entry changes. */
export function diffDocuments(oldDoc: InstructionDocument | Doc, newDoc: InstructionDocument | Doc): StructuredDiff {
  const before = stepsOf(oldDoc as Doc);
  const after = stepsOf(newDoc as Doc);
  const added = Object.keys(after).filter((id) => !(id in before)).map((id) => after[id]);
  const removed = Object.keys(before).filter((id) => !(id in after)).map((id) => before[id]);
  const changed: ChangedStep[] = [];
  for (const id of Object.keys(before)) {
    if (!(id in after)) continue;
    const fields: Partial<Record<StepField, FieldChange>> = {};
    for (const field of STEP_FIELDS) {
      if (!same(before[id][field], after[id][field])) {
        fields[field] = { before: before[id][field], after: after[id][field] };
      }
    }
    if (Object.keys(fields).length) changed.push({ id, fields });
  }
  const sections = {} as Record<Section, SectionChange>;
  for (const section of SECTIONS) {
    const oldEntries = entriesOf(oldDoc as Doc, section);
    const newEntries = entriesOf(newDoc as Doc, section);
    sections[section] = {
      added: Object.keys(newEntries).filter((k) => !(k in oldEntries)).map((k) => newEntries[k]),
      removed: Object.keys(oldEntries).filter((k) => !(k in newEntries)).map((k) => oldEntries[k]),
    };
  }
  const fields: Partial<Record<Scalar, FieldChange>> = {};
  for (const field of SCALARS) {
    const a = (oldDoc as Doc)[field];
    const b = (newDoc as Doc)[field];
    if (!same(a, b)) fields[field] = { before: a, after: b };
  }
  return {
    steps: { added, removed, changed },
    sections,
    fields,
    summary: {
      steps_added: added.length,
      steps_removed: removed.length,
      steps_changed: changed.length,
      entries_added: SECTIONS.reduce((n, s) => n + sections[s].added.length, 0),
      entries_removed: SECTIONS.reduce((n, s) => n + sections[s].removed.length, 0),
      fields_changed: Object.keys(fields).length,
    },
  };
}

export interface Conflict {
  kind: "field" | "step";
  field: string | null;
  step_id?: string;
  base: unknown;
  parent: unknown;
  branch: unknown;
  reason?: string;
}

/** Return the merged value and whether the two sides conflict. */
function mergeValue(base: unknown, ours: unknown, theirs: unknown): [unknown, boolean] {
  if (same(ours, base)) return [theirs, false];
  if (same(theirs, base) || same(ours, theirs)) return [ours, false];
  return [ours, true];
}

function copy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * Three-way merge of `theirs` (a branch) into `ours` (the parent head). The document is
 * only meaningful when the returned conflict list is empty.
 */
export function mergeDocuments(
  base: InstructionDocument,
  ours: InstructionDocument,
  theirs: InstructionDocument,
): { merged: InstructionDocument; conflicts: Conflict[] } {
  const merged = copy(ours) as InstructionDocument & Doc;
  const conflicts: Conflict[] = [];
  const baseDoc = base as unknown as Doc;
  const ourDoc = ours as unknown as Doc;
  const theirDoc = theirs as unknown as Doc;

  for (const field of SCALARS) {
    const [value, conflict] = mergeValue(baseDoc[field], ourDoc[field], theirDoc[field]);
    (merged as Doc)[field] = value;
    if (conflict) {
      conflicts.push({ kind: "field", field, base: baseDoc[field], parent: ourDoc[field], branch: theirDoc[field] });
    }
  }

  const b = stepsOf(baseDoc);
  const o = stepsOf(ourDoc);
  const t = stepsOf(theirDoc);
  const steps: Entry[] = [];
  const ids = Array.from(new Set([...Object.keys(b), ...Object.keys(o), ...Object.keys(t)])).sort();
  for (const id of ids) {
    const inBase = id in b;
    const inOurs = id in o;
    const inTheirs = id in t;
    if (!inOurs && !inTheirs) continue; // removed on both sides
    if (inOurs && inTheirs) {
      const step = copy(o[id]);
      for (const field of STEP_FIELDS) {
        const baseValue = inBase ? b[id][field] : undefined;
        const [value, conflict] = mergeValue(baseValue, o[id][field], t[id][field]);
        step[field] = value;
        if (conflict) {
          conflicts.push({
            kind: "step",
            step_id: id,
            field,
            base: baseValue,
            parent: o[id][field],
            branch: t[id][field],
          });
        }
      }
      steps.push(step);
      continue;
    }
    const present = inOurs ? o[id] : t[id];
    const side = inOurs ? "parent" : "branch";
    if (!inBase) {
      steps.push(present); // added on one side
    } else if (same(present, b[id])) {
      continue; // removed on the other side, untouched here
    } else {
      conflicts.push({
        kind: "step",
        step_id: id,
        field: null,
        base: b[id],
        parent: inOurs ? o[id] : undefined,
        branch: inTheirs ? t[id] : undefined,
        reason: `removed on one side and changed on the ${side}`,
      });
    }
  }
  steps.sort((x, y) => {
    const ox = Number(x.order ?? 0);
    const oy = Number(y.order ?? 0);
    if (ox !== oy) return ox - oy;
    return String(x.id) < String(y.id) ? -1 : String(x.id) > String(y.id) ? 1 : 0;
  });
  merged.steps = steps as unknown as Step[];

  for (const section of SECTIONS) {
    const baseEntries = entriesOf(baseDoc, section);
    const ourEntries = entriesOf(ourDoc, section);
    const theirEntries = entriesOf(theirDoc, section);
    const kept: Entry[] = [];
    for (const [key, entry] of Object.entries(ourEntries)) {
      // still on the branch, or added by the parent; otherwise the branch removed it
      if (key in theirEntries || !(key in baseEntries)) kept.push(entry);
    }
    for (const [key, entry] of Object.entries(theirEntries)) {
      if (!(key in ourEntries) && !(key in baseEntries)) kept.push(entry);
    }
    (merged as Doc)[section] = kept;
  }
  return { merged: merged as InstructionDocument, conflicts };
}
