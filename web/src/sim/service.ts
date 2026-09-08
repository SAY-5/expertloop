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
import { type CaseResult, type Expectations, type Scenario, runTestCase } from "./executor";
import { type Principal } from "./fixtures";
import { SourceRegistry } from "./registry";
import { EDITABLE_STATES, IllegalTransition, type State, assertTransition } from "./state";
import { type DeliveryPayload, DeliveryError, type Target } from "./targets";

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

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
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
  readonly metrics: Metrics = {
    test_runs: { passed: 0, failed: 0 },
    publishes: { delivered: 0, blocked: 0, failed: 0 },
    rollbacks: 0,
  };
  private tick = 0;
  private ids = { note: 1, set: 1, edit: 1, review: 1, audit: 1, testCase: 1, testRun: 1, publication: 1 };

  /** Monotonic clock used for audit ordering and webhook timestamps; never wall-clock time. */
  readonly clock = (): number => {
    this.tick += 1;
    return 1_700_000_000 + this.tick;
  };

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
      document,
    };
    this.sets.push(set);
    this.versions.push({ instruction_set_id: set.id, version: 1, document: clone(document) });
    const coverage = citationCoverage(document);
    this.record(set, actor, "ingest", null, "draft", { note_id: note.id, ...coverage });
    return { note, set, coverage, linked };
  }

  applyEdit(actor: Principal, setId: number, expectedVersion: number, reason: string, incoming: InstructionDocument): Edit {
    const set = this.getSet(setId);
    if (!EDITABLE_STATES.has(set.state)) throw new IllegalTransition("edit", set.state);
    if (set.version !== expectedVersion) {
      throw new Conflict(`version mismatch: expected ${expectedVersion}, current is ${set.version}`, {
        current_version: set.version,
      });
    }
    const document = clone(incoming);
    const problems = validateDocument(document);
    if (problems.length) throw new Invalid("edited document is not valid", problems);
    this.registry.resolveCitations(document);
    document.agent_prompt = renderPrompt(document);
    const diff = diffDocuments(set.document, document);
    if (!diff) throw new Conflict("edit does not change the document");

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
    if (fromState === "approved") set.state = assertTransition("edit_after_approval", fromState);
    else if (fromState === "published") set.state = assertTransition("revise", fromState);
    this.record(set, actor, "edit", fromState, set.state, {
      from_version: edit.from_version,
      to_version: newVersion,
      reason,
    });
    return edit;
  }

  transition(actor: Principal, setId: number, action: string): InstructionSet {
    const set = this.getSet(setId);
    const fromState = set.state;
    set.state = assertTransition(action, fromState);
    if (action === "submit" || action === "resubmit") set.review_round += 1;
    this.record(set, actor, action, fromState, set.state);
    return set;
  }

  /** Submit from draft or resubmit from changes_requested, matching POST /submit. */
  submit(actor: Principal, setId: number): InstructionSet {
    const set = this.getSet(setId);
    return this.transition(actor, setId, set.state === "changes_requested" ? "resubmit" : "submit");
  }

  countApprovals(set: InstructionSet): number {
    const reviewers = new Set(
      this.reviews
        .filter(
          (r) =>
            r.instruction_set_id === set.id &&
            r.version === set.version &&
            r.review_round === set.review_round &&
            r.decision === "approve",
        )
        .map((r) => r.reviewer),
    );
    return reviewers.size;
  }

  review(actor: Principal, setId: number, decision: "approve" | "request_changes", comment: string): { set: InstructionSet; approvals: number } {
    const set = this.getSet(setId);
    if (set.state !== "in_review") throw new IllegalTransition(decision, set.state);
    if (this.getNote(set.note_id).author === actor.name) {
      throw new Conflict("the author of a note cannot review their own instruction set");
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
    const approvals = this.countApprovals(set);
    if (approvals >= set.required_approvals) {
      set.state = assertTransition("approve", fromState);
      this.record(set, actor, "approve", fromState, set.state, { approvals });
    } else {
      this.record(set, actor, "approval_recorded", fromState, fromState, { approvals });
    }
    return { set, approvals };
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
