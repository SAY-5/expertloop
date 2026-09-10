/**
 * Source drift detection (port of expertloop/drift.py).
 *
 * A citation stores the hash of its source at compile or edit time. When a registered
 * source is re-hashed and the hash differs, every step that cites it is flagged stale.
 * Open flags block publication until an expert re-verifies the step or edits the set so
 * the citation carries the current hash.
 */

import { type InstructionDocument } from "./compile";
import { type SourceRegistry } from "./registry";

export interface DriftFlag {
  id: number;
  instruction_set_id: number;
  step_id: string;
  source_id: number;
  cited_hash: string;
  current_hash: string;
  detected_by: string;
  detected_at: number;
  resolved_at: number | null;
  resolved_by: string | null;
  resolution: string | null;
}

export type NewFlag = Pick<DriftFlag, "step_id" | "source_id" | "cited_hash" | "current_hash">;

/** Distinct (step id, source id, hash cited by that step) triples in a document. */
export function stepSources(document: InstructionDocument): Array<[string, number, string]> {
  const seen = new Set<string>();
  const out: Array<[string, number, string]> = [];
  for (const step of document.steps) {
    for (const cite of step.citations) {
      const sourceId = cite.source_id;
      if (!sourceId) continue;
      const key = `${step.id}:${sourceId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push([step.id, sourceId, cite.source_hash ?? ""]);
    }
  }
  return out;
}

/**
 * Compare every cited hash with the registry and return the flags that should be opened.
 * A step is skipped when a flag for the same (step, source) is already open, or when it
 * was re-verified against this exact hash.
 */
export function scanDocument(
  document: InstructionDocument,
  registry: SourceRegistry,
  existing: DriftFlag[],
  sourceId: number | null = null,
): NewFlag[] {
  const latest = new Map<string, DriftFlag>();
  for (const flag of existing) latest.set(`${flag.step_id}:${flag.source_id}`, flag);
  const created: NewFlag[] = [];
  for (const [stepId, sid, cited] of stepSources(document)) {
    if (sourceId !== null && sid !== sourceId) continue;
    const source = registry.byId(sid);
    if (!source || source.content_hash === cited) continue;
    const previous = latest.get(`${stepId}:${sid}`);
    if (previous && (previous.resolved_at === null || previous.current_hash === source.content_hash)) continue;
    created.push({ step_id: stepId, source_id: sid, cited_hash: cited, current_hash: source.content_hash });
  }
  return created;
}

export function openFlags(flags: DriftFlag[]): DriftFlag[] {
  return flags.filter((f) => f.resolved_at === null);
}

/** After an edit, the steps whose citations now carry the registry's current hash. */
export function flagsClosedByEdit(document: InstructionDocument, flags: DriftFlag[]): DriftFlag[] {
  const current = new Map<string, string>();
  for (const [stepId, sid, cited] of stepSources(document)) current.set(`${stepId}:${sid}`, cited);
  return openFlags(flags).filter((flag) => {
    const cited = current.get(`${flag.step_id}:${flag.source_id}`);
    return cited === undefined || cited === flag.current_hash;
  });
}

export interface DriftReport {
  instruction_set_id: number;
  stale: boolean;
  stale_steps: string[];
  open: number;
  resolved: number;
  flags: DriftFlag[];
}

export function driftReport(instructionSetId: number, flags: DriftFlag[]): DriftReport {
  const open = openFlags(flags);
  return {
    instruction_set_id: instructionSetId,
    stale: open.length > 0,
    stale_steps: Array.from(new Set(open.map((f) => f.step_id))).sort(),
    open: open.length,
    resolved: flags.length - open.length,
    flags,
  };
}
