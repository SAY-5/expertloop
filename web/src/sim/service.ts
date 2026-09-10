/**
 * In-memory port of expertloop/service.py: every state change goes through here and is audited.
 * Tables become arrays on the store; ids are sequential so a run is fully deterministic.
 */

import {
  type Coverage,
  type InstructionDocument,
  citationCoverage,
  compileNote,
  renderPrompt,
  validateDocument,
} from "./compile";
import { diffDocuments } from "./diff";
import {
  type DriftFlag,
  type DriftReport,
  driftReport,
  flagsClosedByEdit,
  openFlags,
  scanDocument,
} from "./drift";
import { type CaseResult, type Expectations, type Scenario, runTestCase } from "./executor";
import { type Principal } from "./fixtures";
import { SourceRegistry, contentHash } from "./registry";
import {
  type ApprovalRow,
  type QueueRow,
  type ReviewPolicy,
  type Workload,
  deadlineFrom,
  isOverdue,
  missingRoles,
  normalisePolicy,
  policySatisfied,
  unknownRoles,
} from "./reviews";
import { EDITABLE_STATES, IllegalTransition, type State, assertTransition } from "./state";
import { type DeliveryPayload, DeliveryError, type Target } from "./targets";
import {
  type Conflict as MergeConflict,
  type StructuredDiff,
  diffDocuments as diffStructured,
  mergeDocuments,
} from "./versioning";

export class NotFound extends Error {}

export class Conflict extends Error {
  readonly detail: Record<string, unknown>;
  constructor(message: string, detail: Record<string, unknown> = {}) {
    super(message);
    this.name = "Conflict";
    this.detail = detail;
  }
}

export class Invalid extends Error {
  readonly problems: string[];
  constructor(message: string, problems: string[]) {
    super(message);
    this.name = "Invalid";
    this.problems = problems;
  }
}

export interface Note {
  id: number;
  title: string;
  author: string;
  body: string;
}

export interface InstructionSet {
  id: number;
  note_id: number;
  name: string;
  state: State;
  version: number;
  published_version: number | null;
  required_approvals: number;
  review_round: number;
  review_policy: ReviewPolicy;
  submitted_at: number | null;
  review_deadline_at: number | null;
  escalated_at: number | null;
  parent_id: number | null;
  branched_from_version: number | null;
  merged_at: number | null;
  merged_into_version: number | null;
  document: InstructionDocument;
}

export interface VersionSnapshot {
  instruction_set_id: number;
  version: number;
  document: InstructionDocument;
}

export interface Edit {
  id: number;
  instruction_set_id: number;
  author: string;
  from_version: number;
  to_version: number;
  reason: string;
  diff: string;
}

export interface ReviewDecision {
  id: number;
  instruction_set_id: number;
  reviewer: string;
  reviewer_role: string;
  version: number;
  review_round: number;
  decision: "approve" | "request_changes";
  comment: string;
}

export interface AuditEvent {
  id: number;
  instruction_set_id: number;
  actor: string;
  action: string;
  from_state: State | null;
  to_state: State | null;
  detail: Record<string, unknown>;
  at: number;
}

export interface TestCase {
  id: number;
  instruction_set_id: number;
  name: string;
  author: string;
  scenario: Scenario;
  expectations: Expectations;
}

export interface TestRunResult extends CaseResult {
  test_case_id: number;
  name: string;
}

export interface TestRun {
  id: number;
  instruction_set_id: number;
  version: number;
  triggered_by: string;
  status: "passed" | "failed";
  passed: number;
  failed: number;
  results: TestRunResult[];
}

export interface Publication {
  id: number;
  instruction_set_id: number;
  version: number;
  actor: string;
  action: "publish" | "rollback";
  target: string;
  status: "delivered" | "failed";
  receipt: Record<string, unknown>;
}

export interface Metrics {
  test_runs: { passed: number; failed: number };
  publishes: { delivered: number; blocked: number; failed: number };
  rollbacks: number;
}

/** Fixed virtual epoch (2023-11-14T22:13:20Z) so rendered timestamps are stable. */
export const EPOCH_MS = 1_700_000_000_000;
const HOUR_MS = 3_600_000;

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function withoutHashes(step: { citations?: unknown[] } & Record<string, unknown>): string {
  const body: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(step)) if (k !== "citations") body[k] = v;
  const cites = ((step.citations ?? []) as Array<Record<string, unknown>>).map((c) => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(c)) if (k !== "source_hash") out[k] = v;
    return out;
  });
  return JSON.stringify([body, cites]);
}

/**
 * Only steps that actually changed pick up the registry's current source hashes.
 * Restoring the previous hashes on untouched steps keeps their drift flags open until an
 * expert edits or re-verifies them (port of _keep_hashes_of_unchanged_steps).
 */
function keepHashesOfUnchangedSteps(oldDoc: InstructionDocument, newDoc: InstructionDocument): void {
  const previous = new Map(oldDoc.steps.map((s) => [s.id, s]));
  for (const step of newDoc.steps) {
    const before = previous.get(step.id);
    if (before && withoutHashes(before as never) === withoutHashes(step as never)) {
      step.citations = clone(before.citations);
    }
  }
}

export class ExpertLoopService {
  readonly registry = new SourceRegistry();
  readonly notes: Note[] = [];
  readonly sets: InstructionSet[] = [];
  readonly versions: VersionSnapshot[] = [];
  readonly edits: Edit[] = [];
  readonly reviews: ReviewDecision[] = [];
  readonly audit: AuditEvent[] = [];
  readonly testCases: TestCase[] = [];
  readonly testRuns: TestRun[] = [];
  readonly publications: Publication[] = [];
  readonly driftFlags: DriftFlag[] = [];
  readonly metrics: Metrics = {
    test_runs: { passed: 0, failed: 0 },
    publishes: { delivered: 0, blocked: 0, failed: 0 },
    rollbacks: 0,
  };
  private tick = 0;
  /** Virtual wall time in milliseconds, moved only by `advance`; never read from the host. */
  private virtualNow = EPOCH_MS;
  private ids = { note: 1, set: 1, edit: 1, review: 1, audit: 1, testCase: 1, testRun: 1, publication: 1, flag: 1 };

  /** Monotonic clock used for audit ordering and webhook timestamps; never wall-clock time. */
  readonly clock = (): number => {
    this.tick += 1;
    return 1_700_000_000 + this.tick;
  };

  /** Current virtual instant in milliseconds. */
  now(): number {
    return this.virtualNow;
  }

  /** Move the virtual clock forward; review deadlines and escalation read it. */
  advance(hours: number): number {
    this.virtualNow += Math.max(0, hours) * HOUR_MS;
    return this.virtualNow;
  }

  private record(
    set: InstructionSet,
    actor: Principal,
    action: string,
    fromState: State | null,
    toState: State | null,
    detail: Record<string, unknown> = {},
  ): void {
    this.audit.push({
      id: this.ids.audit++,
      instruction_set_id: set.id,
      actor: actor.name,
      action,
      from_state: fromState,
      to_state: toState,
      detail,
      at: this.clock(),
    });
  }

  getSet(id: number): InstructionSet {
    const set = this.sets.find((s) => s.id === id);
    if (!set) throw new NotFound(`instruction set ${id} not found`);
    return set;
  }

  getNote(id: number): Note {
    const note = this.notes.find((n) => n.id === id);
    if (!note) throw new NotFound(`note ${id} not found`);
    return note;
  }

  ingestNote(
    actor: Principal,
    title: string,
    body: string,
    requiredApprovals: number,
    policy?: Partial<ReviewPolicy> | null,
  ): { note: Note; set: InstructionSet; coverage: Coverage; linked: number } {
    const note: Note = { id: this.ids.note++, title, author: actor.name, body };
    this.notes.push(note);
    const document = compileNote(body, note.id, title);
    const linked = this.registry.resolveCitations(document);
    const problems = validateDocument(document);
    if (problems.length) throw new Invalid("compiled document is not valid", problems);
    const set: InstructionSet = {
      id: this.ids.set++,
      note_id: note.id,
      name: title,
      state: "draft",
      version: 1,
      published_version: null,
      required_approvals: requiredApprovals,
      review_round: 0,
      review_policy: normalisePolicy(policy),
      submitted_at: null,
      review_deadline_at: null,
      escalated_at: null,
      parent_id: null,
      branched_from_version: null,
      merged_at: null,
      merged_into_version: null,
      document,
    };
    this.sets.push(set);
    this.versions.push({ instruction_set_id: set.id, version: 1, document: clone(document) });
    const coverage = citationCoverage(document);
    this.record(set, actor, "ingest", null, "draft", { note_id: note.id, ...coverage });
    return { note, set, coverage, linked };
  }

  /** Validate a full document, store it as the next version and record the edit. */
  private commitDocument(
    actor: Principal,
    set: InstructionSet,
    incoming: InstructionDocument,
    reason: string,
    action: string,
    detail: Record<string, unknown> = {},
  ): Edit {
    if (!EDITABLE_STATES.has(set.state)) throw new IllegalTransition(action, set.state);
    const document = clone(incoming);
    const problems = validateDocument(document);
    if (problems.length) throw new Invalid("edited document is not valid", problems);
    this.registry.resolveCitations(document);
    keepHashesOfUnchangedSteps(set.document, document);
    document.agent_prompt = renderPrompt(document);
    const diff = diffDocuments(set.document, document);
    if (!diff) throw new Conflict(`${action} does not change the document`);

    const fromState = set.state;
    const newVersion = set.version + 1;
    const edit: Edit = {
      id: this.ids.edit++,
      instruction_set_id: set.id,
      author: actor.name,
      from_version: set.version,
      to_version: newVersion,
      reason,
      diff,
    };
    this.edits.push(edit);
    this.versions.push({ instruction_set_id: set.id, version: newVersion, document: clone(document) });
    set.document = document;
    set.version = newVersion;
    const resolved = this.resolveAfterEdit(actor, set);
    if (fromState === "approved") set.state = assertTransition("edit_after_approval", fromState);
    else if (fromState === "published") set.state = assertTransition("revise", fromState);
    this.record(set, actor, action, fromState, set.state, {
      from_version: edit.from_version,
      to_version: newVersion,
      reason,
      ...(resolved.length ? { drift_resolved: resolved.map((f) => f.step_id) } : {}),
      ...detail,
    });
    return edit;
  }

  applyEdit(actor: Principal, setId: number, expectedVersion: number, reason: string, incoming: InstructionDocument): Edit {
    const set = this.getSet(setId);
    if (!EDITABLE_STATES.has(set.state)) throw new IllegalTransition("edit", set.state);
    if (set.version !== expectedVersion) {
      throw new Conflict(`version mismatch: expected ${expectedVersion}, current is ${set.version}`, {
        current_version: set.version,
      });
    }
    return this.commitDocument(actor, set, incoming, reason, "edit");
  }

  transition(actor: Principal, setId: number, action: string): InstructionSet {
    const set = this.getSet(setId);
    const fromState = set.state;
    set.state = assertTransition(action, fromState);
    if (action === "submit" || action === "resubmit") {
      set.review_round += 1;
      this.startReviewClock(set);
    }
    this.record(set, actor, action, fromState, set.state);
    return set;
  }

  /** Submitting starts the review clock; the deadline comes from the set's policy. */
  private startReviewClock(set: InstructionSet): void {
    set.submitted_at = this.virtualNow;
    set.review_deadline_at = deadlineFrom(set.review_policy, this.virtualNow);
    set.escalated_at = null;
  }

  setReviewPolicy(actor: Principal, setId: number, policy: Partial<ReviewPolicy>): InstructionSet {
    const set = this.getSet(setId);
    if (set.state === "in_review") throw new Conflict("the review policy cannot change while the set is in review");
    const unknown = unknownRoles(policy);
    if (unknown.length) throw new Invalid("review policy is not valid", unknown.map((r) => `unknown reviewer role: ${r}`));
    set.review_policy = normalisePolicy(policy);
    this.record(set, actor, "policy_set", set.state, set.state, { review_policy: set.review_policy });
    return set;
  }

  /** Whoever produced the current version: the note author for v1, else the last editor. */
  versionAuthor(set: InstructionSet): string {
    if (set.version === 1) return this.getNote(set.note_id).author;
    const edit = this.edits.find((e) => e.instruction_set_id === set.id && e.to_version === set.version);
    return edit?.author ?? this.getNote(set.note_id).author;
  }

  isSelfApproval(set: InstructionSet, actor: Principal): boolean {
    if (set.review_policy.allow_self_approval) return false;
    return actor.name === this.getNote(set.note_id).author || actor.name === this.versionAuthor(set);
  }

  private approvalsThisRound(set: InstructionSet): ApprovalRow[] {
    return this.reviews.filter(
      (r) =>
        r.instruction_set_id === set.id &&
        r.version === set.version &&
        r.review_round === set.review_round &&
        r.decision === "approve",
    );
  }

  /** Reviewer roles the policy still demands on this round. */
  missingRoles(set: InstructionSet): string[] {
    return missingRoles(set.review_policy, this.approvalsThisRound(set));
  }

  /** Submit from draft or resubmit from changes_requested, matching POST /submit. */
  submit(actor: Principal, setId: number): InstructionSet {
    const set = this.getSet(setId);
    return this.transition(actor, setId, set.state === "changes_requested" ? "resubmit" : "submit");
  }

  countApprovals(set: InstructionSet): number {
    return new Set(this.approvalsThisRound(set).map((r) => r.reviewer)).size;
  }

  review(actor: Principal, setId: number, decision: "approve" | "request_changes", comment: string): { set: InstructionSet; approvals: number } {
    const set = this.getSet(setId);
    if (set.state !== "in_review") throw new IllegalTransition(decision, set.state);
    if (this.isSelfApproval(set, actor)) {
      throw new Conflict(
        `self-approval is not allowed: ${actor.name} authored version ${set.version} of this instruction set`,
        { author: actor.name },
      );
    }
    if (actor.role !== "reviewer" && actor.role !== "admin") {
      throw new Conflict(`role ${actor.role} may not review`);
    }
    this.reviews.push({
      id: this.ids.review++,
      instruction_set_id: set.id,
      reviewer: actor.name,
      reviewer_role: actor.role,
      version: set.version,
      review_round: set.review_round,
      decision,
      comment,
    });
    const fromState = set.state;
    if (decision === "request_changes") {
      set.state = assertTransition("request_changes", fromState);
      this.record(set, actor, "request_changes", fromState, set.state, { comment });
      return { set, approvals: 0 };
    }
    const [approvals, missing] = policySatisfied(set.review_policy, this.approvalsThisRound(set));
    if (approvals >= set.required_approvals && missing.length === 0) {
      set.state = assertTransition("approve", fromState);
      this.record(set, actor, "approve", fromState, set.state, { approvals });
    } else {
      this.record(set, actor, "approval_recorded", fromState, fromState, { approvals, missing_roles: missing });
    }
    return { set, approvals };
  }

  /** Write a review_escalated event for every overdue set that has not been escalated yet. */
  escalateOverdue(actor: Principal): InstructionSet[] {
    const now = this.virtualNow;
    const escalated: InstructionSet[] = [];
    for (const set of this.sets) {
      if (!isOverdue(set.state, set.review_deadline_at, now) || set.escalated_at !== null) continue;
      set.escalated_at = now;
      const [approvals, missing] = policySatisfied(set.review_policy, this.approvalsThisRound(set));
      this.record(set, actor, "review_escalated", set.state, set.state, {
        deadline: set.review_deadline_at,
        overdue_seconds: Math.floor((now - (set.review_deadline_at ?? now)) / 1000),
        approvals,
        required_approvals: set.required_approvals,
        missing_roles: missing,
        review_round: set.review_round,
      });
      escalated.push(set);
    }
    return escalated;
  }

  /** The review queue and, per reviewer, what still waits on them. */
  workload(reviewers: Principal[]): Workload {
    const now = this.virtualNow;
    const pending: Record<string, number[]> = {};
    const overdue: Record<string, number> = {};
    const decided: Record<string, number> = {};
    for (const person of reviewers) {
      pending[person.name] = [];
      overdue[person.name] = 0;
      decided[person.name] = this.reviews.filter((r) => r.reviewer === person.name).length;
    }
    const queue: QueueRow[] = this.sets
      .filter((s) => s.state === "in_review")
      .sort((a, b) => (a.review_deadline_at ?? Infinity) - (b.review_deadline_at ?? Infinity) || a.id - b.id)
      .map((set) => {
        const already = new Set(
          this.reviews
            .filter((r) => r.instruction_set_id === set.id && r.version === set.version && r.review_round === set.review_round)
            .map((r) => r.reviewer),
        );
        const [approvals, missing] = policySatisfied(set.review_policy, this.approvalsThisRound(set));
        const late = isOverdue(set.state, set.review_deadline_at, now);
        const author = this.versionAuthor(set);
        const noteAuthor = this.getNote(set.note_id).author;
        const waitingOn = reviewers
          .filter(
            (person) =>
              !already.has(person.name) &&
              (set.review_policy.allow_self_approval || (person.name !== author && person.name !== noteAuthor)) &&
              (missing.length === 0 || missing.includes(person.role) || approvals < set.required_approvals),
          )
          .map((person) => person.name)
          .sort();
        for (const name of waitingOn) {
          pending[name]?.push(set.id);
          if (late) overdue[name] = (overdue[name] ?? 0) + 1;
        }
        return {
          instruction_set_id: set.id,
          name: set.name,
          version: set.version,
          review_round: set.review_round,
          submitted_at: set.submitted_at,
          review_deadline_at: set.review_deadline_at,
          overdue: late,
          escalated: set.escalated_at !== null,
          approvals,
          required_approvals: set.required_approvals,
          missing_roles: missing,
          waiting_on: waitingOn,
        };
      });
    return {
      generated_at: now,
      queue,
      reviewers: reviewers.map((person) => ({
        name: person.name,
        role: person.role,
        pending: pending[person.name] ?? [],
        overdue: overdue[person.name] ?? 0,
        decided: decided[person.name] ?? 0,
      })),
    };
  }

  addTestCase(actor: Principal, setId: number, name: string, scenario: Scenario, expectations: Expectations): TestCase {
    const set = this.getSet(setId);
    const testCase: TestCase = { id: this.ids.testCase++, instruction_set_id: set.id, name, author: actor.name, scenario, expectations };
    this.testCases.push(testCase);
    this.record(set, actor, "test_case_added", null, null, { name });
    return testCase;
  }

  casesFor(setId: number): TestCase[] {
    return this.testCases.filter((c) => c.instruction_set_id === setId);
  }

  runTests(actor: Principal, setId: number): TestRun {
    const set = this.getSet(setId);
    const cases = this.casesFor(setId);
    if (!cases.length) throw new Conflict("instruction set has no test cases");
    const results: TestRunResult[] = cases.map((c) => ({
      test_case_id: c.id,
      name: c.name,
      ...runTestCase(set.document, c.scenario, c.expectations),
    }));
    const passed = results.filter((r) => r.passed).length;
    const failed = results.length - passed;
    const run: TestRun = {
      id: this.ids.testRun++,
      instruction_set_id: set.id,
      version: set.version,
      triggered_by: actor.name,
      status: failed === 0 ? "passed" : "failed",
      passed,
      failed,
      results,
    };
    this.testRuns.push(run);
    this.metrics.test_runs[run.status] += 1;
    this.record(set, actor, "test_run", null, null, { status: run.status, passed, failed });
    return run;
  }

  latestTestRun(set: InstructionSet): TestRun | undefined {
    const runs = this.testRuns.filter((r) => r.instruction_set_id === set.id);
    return runs[runs.length - 1];
  }

  private publishGate(set: InstructionSet): TestRun {
    if (set.state !== "approved") throw new IllegalTransition("publish", set.state);
    const stale = Array.from(new Set(this.openDriftFlags(set.id).map((f) => f.step_id))).sort();
    if (stale.length) {
      throw new Conflict("publish blocked: stale steps cite changed sources: " + stale.join(", "), { stale_steps: stale });
    }
    const run = this.latestTestRun(set);
    if (!run) throw new Conflict("publish blocked: no test run recorded for this instruction set");
    if (run.version !== set.version) {
      throw new Conflict(`publish blocked: latest test run covers version ${run.version}, current is ${set.version}`, {
        test_run_id: run.id,
      });
    }
    if (run.status !== "passed") {
      const failing = run.results.filter((r) => !r.passed).map((r) => r.name);
      throw new Conflict("publish blocked: failing test cases: " + failing.join(", "), {
        test_run_id: run.id,
        failing_cases: failing,
      });
    }
    return run;
  }

  private deliver(
    actor: Principal,
    set: InstructionSet,
    version: number,
    document: InstructionDocument,
    action: "publish" | "rollback",
    targets: Target[],
    extra: Record<string, unknown>,
  ): Publication[] {
    const payload: DeliveryPayload = {
      event: `instruction_set.${action}`,
      action,
      instruction_set_id: set.id,
      name: set.name,
      version,
      document,
      ...extra,
    };
    const publications: Publication[] = [];
    for (const target of targets) {
      let status: Publication["status"];
      let body: Record<string, unknown>;
      try {
        const receipt = target.deliver(payload, this.clock);
        status = receipt.status;
        body = receipt.receipt;
      } catch (error) {
        if (!(error instanceof DeliveryError)) throw error;
        status = "failed";
        body = { error: error.message };
      }
      const publication: Publication = {
        id: this.ids.publication++,
        instruction_set_id: set.id,
        version,
        actor: actor.name,
        action,
        target: target.name,
        status,
        receipt: body,
      };
      this.publications.push(publication);
      publications.push(publication);
    }
    return publications;
  }

  publish(actor: Principal, setId: number, targets: Target[]): { set: InstructionSet; publications: Publication[] } {
    const set = this.getSet(setId);
    if (actor.role !== "admin") throw new Conflict(`role ${actor.role} may not publish`);
    let run: TestRun;
    try {
      run = this.publishGate(set);
    } catch (error) {
      if (error instanceof Conflict || error instanceof IllegalTransition) {
        this.metrics.publishes.blocked += 1;
        this.record(set, actor, "publish_blocked", set.state, set.state, { reason: error.message });
      }
      throw error;
    }
    const fromState = set.state;
    const publications = this.deliver(actor, set, set.version, set.document, "publish", targets, {
      test_run_id: run.id,
      approvals: this.countApprovals(set),
    });
    const failed = publications.filter((p) => p.status !== "delivered");
    if (failed.length) {
      this.metrics.publishes.failed += 1;
      this.record(set, actor, "publish_failed", fromState, fromState, { targets: failed.map((p) => p.target) });
      throw new Conflict("publish failed: " + failed.map((p) => `${p.target}: ${String(p.receipt.error)}`).join(", "), {
        targets: failed.map((p) => p.target),
      });
    }
    set.state = assertTransition("publish", fromState);
    set.published_version = set.version;
    this.metrics.publishes.delivered += 1;
    this.record(set, actor, "publish", fromState, set.state, {
      version: set.version,
      targets: publications.map((p) => p.target),
    });
    return { set, publications };
  }

  rollback(actor: Principal, setId: number, targets: Target[]): { set: InstructionSet; publications: Publication[] } {
    const set = this.getSet(setId);
    if (actor.role !== "admin") throw new Conflict(`role ${actor.role} may not roll back`);
    if (set.published_version === null) throw new Conflict("nothing is published for this instruction set");
    const live = set.published_version;
    const deliveredVersions = Array.from(
      new Set(
        this.publications
          .filter((p) => p.instruction_set_id === set.id && p.action === "publish" && p.status === "delivered" && p.version < live)
          .map((p) => p.version),
      ),
    ).sort((a, b) => a - b);
    if (!deliveredVersions.length) {
      throw new Conflict(`no earlier published version to roll back to (live is v${live})`);
    }
    const previous = deliveredVersions[deliveredVersions.length - 1];
    const snapshot = this.versions.find((v) => v.instruction_set_id === set.id && v.version === previous);
    if (!snapshot) throw new NotFound(`version ${previous} snapshot missing`);
    const publications = this.deliver(actor, set, previous, snapshot.document, "rollback", targets, {
      rolled_back_from: live,
    });
    const failed = publications.filter((p) => p.status !== "delivered");
    if (failed.length) throw new Conflict("rollback failed: " + failed.map((p) => p.target).join(", "));
    set.published_version = previous;
    this.metrics.rollbacks += 1;
    this.record(set, actor, "rollback", set.state, set.state, { from_version: live, to_version: previous });
    return { set, publications };
  }

  retire(actor: Principal, setId: number): InstructionSet {
    if (actor.role !== "admin") throw new Conflict(`role ${actor.role} may not retire`);
    return this.transition(actor, setId, "retire");
  }

  // --- source drift -------------------------------------------------------

  flagsFor(setId: number): DriftFlag[] {
    return this.driftFlags.filter((f) => f.instruction_set_id === setId);
  }

  openDriftFlags(setId: number): DriftFlag[] {
    return openFlags(this.flagsFor(setId));
  }

  driftFor(setId: number): DriftReport {
    return driftReport(setId, this.flagsFor(setId));
  }

  /** Re-hash a source (optionally with new content); returns true when the hash changed. */
  rehashSource(actor: Principal, sourceId: number, content?: string | null): boolean {
    const source = this.registry.byId(sourceId);
    if (!source) throw new NotFound(`source ${sourceId} not found`);
    if (content !== undefined && content !== null) source.content = content;
    const next = contentHash(source.content, source.ref);
    const changed = next !== source.content_hash;
    source.content_hash = next;
    if (changed) this.scanDrift(actor, sourceId);
    return changed;
  }

  /** Flag every step whose cited hash differs from the registry; returns the new flags. */
  scanDrift(actor: Principal, sourceId: number | null = null): DriftFlag[] {
    const created: DriftFlag[] = [];
    for (const set of this.sets) {
      if (set.state === "retired") continue;
      const fresh = scanDocument(set.document, this.registry, this.flagsFor(set.id), sourceId);
      if (!fresh.length) continue;
      const flags = fresh.map((f) => {
        const flag: DriftFlag = {
          id: this.ids.flag++,
          instruction_set_id: set.id,
          detected_by: actor.name,
          detected_at: this.virtualNow,
          resolved_at: null,
          resolved_by: null,
          resolution: null,
          ...f,
        };
        this.driftFlags.push(flag);
        return flag;
      });
      this.record(set, actor, "drift_detected", set.state, set.state, {
        steps: flags.map((f) => f.step_id),
        sources: Array.from(new Set(flags.map((f) => f.source_id))).sort((a, b) => a - b),
      });
      created.push(...flags);
    }
    return created;
  }

  private closeFlags(actor: Principal, flags: DriftFlag[], resolution: string): DriftFlag[] {
    for (const flag of flags) {
      flag.resolved_at = this.virtualNow;
      flag.resolved_by = actor.name;
      flag.resolution = resolution;
    }
    return flags;
  }

  private resolveAfterEdit(actor: Principal, set: InstructionSet): DriftFlag[] {
    return this.closeFlags(actor, flagsClosedByEdit(set.document, this.flagsFor(set.id)), "edited");
  }

  /** An expert re-reads the changed source and confirms the steps still hold. */
  reverify(actor: Principal, setId: number, stepIds?: string[]): DriftFlag[] {
    const set = this.getSet(setId);
    const wanted = stepIds && stepIds.length ? new Set(stepIds) : null;
    const target = this.openDriftFlags(setId).filter((f) => (wanted ? wanted.has(f.step_id) : true));
    if (!target.length) {
      throw new Conflict("no open drift flags to verify" + (wanted ? ` for ${Array.from(wanted).sort().join(", ")}` : ""));
    }
    const resolved = this.closeFlags(actor, target, "reverified");
    for (const flag of resolved) {
      for (const step of set.document.steps) {
        if (step.id !== flag.step_id) continue;
        for (const cite of step.citations) {
          if (cite.source_id === flag.source_id) cite.source_hash = flag.current_hash;
        }
      }
    }
    this.record(set, actor, "drift_reverified", set.state, set.state, {
      steps: Array.from(new Set(resolved.map((f) => f.step_id))).sort(),
    });
    return resolved;
  }

  // --- versions, branches and merges ---------------------------------------

  versionDocument(setId: number, version: number): InstructionDocument {
    const snapshot = this.versions.find((v) => v.instruction_set_id === setId && v.version === version);
    if (!snapshot) throw new NotFound(`version ${version} of instruction set ${setId} not found`);
    return snapshot.document;
  }

  /** Structured, step-level diff between two versions of a set. */
  diffVersions(setId: number, fromVersion: number, toVersion: number): StructuredDiff & { instruction_set_id: number; from_version: number; to_version: number } {
    return {
      instruction_set_id: setId,
      from_version: fromVersion,
      to_version: toVersion,
      ...diffStructured(this.versionDocument(setId, fromVersion), this.versionDocument(setId, toVersion)),
    };
  }

  branchesOf(setId: number): InstructionSet[] {
    return this.sets.filter((s) => s.parent_id === setId);
  }

  /** Copy a version of a set into a new draft that can be edited and merged back. */
  branch(actor: Principal, setId: number, name: string | null = null, fromVersion: number | null = null): InstructionSet {
    const parent = this.getSet(setId);
    if (parent.parent_id !== null) throw new Conflict("branches cannot be branched again; branch the parent instead");
    const version = fromVersion ?? parent.published_version ?? parent.version;
    const document = clone(this.versionDocument(parent.id, version));
    const branchName = name ?? `${parent.name} (branch of v${version})`;
    document.name = branchName;
    const child: InstructionSet = {
      id: this.ids.set++,
      note_id: parent.note_id,
      name: branchName,
      state: "draft",
      version: 1,
      published_version: null,
      required_approvals: parent.required_approvals,
      review_round: 0,
      review_policy: { ...parent.review_policy, required_roles: [...parent.review_policy.required_roles] },
      submitted_at: null,
      review_deadline_at: null,
      escalated_at: null,
      parent_id: parent.id,
      branched_from_version: version,
      merged_at: null,
      merged_into_version: null,
      document,
    };
    this.sets.push(child);
    this.versions.push({ instruction_set_id: child.id, version: 1, document: clone(document) });
    this.record(child, actor, "branch", null, "draft", { parent_id: parent.id, from_version: version });
    this.record(parent, actor, "branched", parent.state, parent.state, { branch_id: child.id, from_version: version });
    return child;
  }

  /** Three-way merge a branch head into its parent's head; a Conflict carries the list. */
  merge(actor: Principal, branchId: number, reason = "", expectedParentVersion: number | null = null): { parent: InstructionSet; edit: Edit; summary: StructuredDiff["summary"] } {
    const child = this.getSet(branchId);
    if (child.parent_id === null) throw new Conflict(`instruction set ${child.id} is not a branch`);
    if (child.merged_at !== null) {
      throw new Conflict(`branch ${child.id} was already merged into version ${child.merged_into_version}`);
    }
    const parent = this.getSet(child.parent_id);
    if (expectedParentVersion !== null && parent.version !== expectedParentVersion) {
      throw new Conflict(`version mismatch: expected ${expectedParentVersion}, current is ${parent.version}`, {
        current_version: parent.version,
      });
    }
    if (!EDITABLE_STATES.has(parent.state)) throw new IllegalTransition("merge", parent.state);
    const base = this.versionDocument(parent.id, child.branched_from_version ?? 1);
    const { merged, conflicts } = mergeDocuments(base, parent.document, child.document);
    if (conflicts.length) {
      this.record(parent, actor, "merge_conflict", parent.state, parent.state, {
        branch_id: child.id,
        conflicts: conflicts.map((c) => (c.kind === "step" ? `${c.step_id}.${c.field ?? "step"}` : `${c.field}`)),
      });
      throw new Conflict(
        `merge blocked: ${conflicts.length} conflict(s) between branch ${child.id} and version ${parent.version}`,
        { conflicts, branch_id: child.id, parent_version: parent.version },
      );
    }
    merged.name = parent.document.name;
    const edit = this.commitDocument(actor, parent, merged, reason || `merge branch ${child.id} (${child.name})`, "merge", {
      branch_id: child.id,
      branch_version: child.version,
      base_version: child.branched_from_version,
    });
    child.merged_at = this.virtualNow;
    child.merged_into_version = parent.version;
    this.record(child, actor, "merged", child.state, child.state, { into_version: parent.version });
    return { parent, edit, summary: diffStructured(base, merged).summary };
  }

  /** Conflicts a merge of this branch would report right now, without changing anything. */
  previewMerge(branchId: number): MergeConflict[] {
    const child = this.getSet(branchId);
    if (child.parent_id === null) return [];
    const parent = this.getSet(child.parent_id);
    const base = this.versionDocument(parent.id, child.branched_from_version ?? 1);
    return mergeDocuments(base, parent.document, child.document).conflicts;
  }

  editsFor(setId: number): Edit[] {
    return this.edits.filter((e) => e.instruction_set_id === setId);
  }

  reviewsFor(setId: number): ReviewDecision[] {
    return this.reviews.filter((r) => r.instruction_set_id === setId);
  }

  runsFor(setId: number): TestRun[] {
    return this.testRuns.filter((r) => r.instruction_set_id === setId);
  }

  publicationsFor(setId: number): Publication[] {
    return this.publications.filter((p) => p.instruction_set_id === setId);
  }

  auditFor(setId: number): AuditEvent[] {
    return this.audit.filter((a) => a.instruction_set_id === setId);
  }

  versionsFor(setId: number): VersionSnapshot[] {
    return this.versions.filter((v) => v.instruction_set_id === setId);
  }
}
