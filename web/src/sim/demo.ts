/**
 * End-to-end demo (port of expertloop/demo.py) against the in-memory service and fakes.
 * Ingests three expert notes, applies an edit and routes it through review, runs test cases
 * (the refund SOP is blocked by a forbidden-action test), fixes it, publishes to the fake
 * webhook and Jira targets, rolls one set back and computes a summary from the records.
 */

import { type InstructionDocument } from "./compile";
import { PEOPLE, SAMPLE_NOTES, SAMPLE_SOURCES, SAMPLE_TEST_CASES, type NoteKey } from "./fixtures";
import { Conflict, ExpertLoopService, type Publication, type TestRun } from "./service";
import { IllegalTransition } from "./state";
import { FakeJira, FakeWebhookReceiver, JiraTarget, type Target, WebhookTarget } from "./targets";

export const WEBHOOK_SECRET = "demo-secret";
export const JIRA_ISSUE = "OPS-1";

export interface DemoLine {
  kind: "section" | "info" | "ok" | "fail" | "blocked";
  text: string;
}

export interface DemoSummary {
  notes: number;
  steps: number;
  cited_steps: number;
  citations: number;
  coverage: number;
  edits: number;
  approvals: number;
  changes_requested: number;
  test_runs: number;
  runs_green: number;
  runs_red: number;
  cases_passed: number;
  cases_failed: number;
  publishes_blocked: number;
  deliveries: number;
  versions_delivered: number;
  rollbacks: number;
  webhook_receipts: number;
  jira_comments: number;
  jira_attachments: number;
  states: { id: number; state: string; live: number | null }[];
}

export interface DemoWorld {
  service: ExpertLoopService;
  webhook: FakeWebhookReceiver;
  jira: FakeJira;
  targets: Target[];
  sets: Record<NoteKey, number>;
  blocked: number;
}

export function createWorld(): DemoWorld {
  const service = new ExpertLoopService();
  const webhook = new FakeWebhookReceiver(WEBHOOK_SECRET);
  const jira = new FakeJira();
  const targets: Target[] = [
    new WebhookTarget("http://fakes:8081/webhook", WEBHOOK_SECRET, webhook),
    new JiraTarget("http://fakes:8081", JIRA_ISSUE, jira),
  ];
  return { service, webhook, jira, targets, sets: { refund: 0, onboarding: 0, incident: 0 }, blocked: 0 };
}

export function registerSources(world: DemoWorld): void {
  for (const source of SAMPLE_SOURCES) {
    world.service.registry.register(source.kind, source.ref, source.content, source.title);
  }
}

export function ingestAll(world: DemoWorld, log: DemoLine[] = []): void {
  for (const note of SAMPLE_NOTES) {
    const out = world.service.ingestNote(PEOPLE.dana, note.title, note.body, note.required_approvals);
    world.sets[note.key] = out.set.id;
    log.push({
      kind: "info",
      text: `set ${out.set.id}: ${note.title} -> ${out.coverage.steps} steps, ${out.coverage.citations} citations, coverage ${Math.round(out.coverage.coverage * 100)}%, ${out.linked} sources linked, needs ${note.required_approvals} approval(s)`,
    });
  }
}

export function addTestCases(world: DemoWorld, log: DemoLine[] = []): void {
  for (const key of Object.keys(SAMPLE_TEST_CASES) as NoteKey[]) {
    for (const tc of SAMPLE_TEST_CASES[key]) {
      world.service.addTestCase(PEOPLE.ravi, world.sets[key], tc.name, tc.scenario, tc.expectations);
    }
    log.push({ kind: "info", text: `set ${world.sets[key]}: ${SAMPLE_TEST_CASES[key].length} test cases` });
  }
}

export function edit(world: DemoWorld, setId: number, reason: string, mutate: (doc: InstructionDocument) => void, log: DemoLine[] = []): void {
  const current = world.service.getSet(setId);
  const document = JSON.parse(JSON.stringify(current.document)) as InstructionDocument;
  mutate(document);
  const out = world.service.applyEdit(PEOPLE.dana, setId, current.version, reason, document);
  const added = out.diff.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++")).length;
  log.push({ kind: "info", text: `edit ${out.id} on set ${setId}: v${out.from_version} -> v${out.to_version} (${added} lines added) reason: ${reason}` });
}

export function reviewRound(world: DemoWorld, setId: number, reviewers: string[], log: DemoLine[] = []): void {
  const submitted = world.service.submit(PEOPLE.dana, setId);
  log.push({ kind: "info", text: `set ${setId}: submitted -> ${submitted.state}` });
  for (const reviewer of reviewers) {
    const out = world.service.review(PEOPLE[reviewer], setId, "approve", "verified against the source documents");
    log.push({ kind: "ok", text: `set ${setId}: ${reviewer} approved (${out.approvals}/${out.set.required_approvals}) -> ${out.set.state}` });
  }
}

export function runTests(world: DemoWorld, setId: number, log: DemoLine[] = []): TestRun {
  const run = world.service.runTests(PEOPLE.ravi, setId);
  log.push({
    kind: run.status === "passed" ? "ok" : "fail",
    text: `set ${setId} v${run.version}: ${run.status.toUpperCase()} (${run.passed} passed, ${run.failed} failed)`,
  });
  for (const result of run.results) {
    if (!result.passed) log.push({ kind: "fail", text: `  FAIL ${result.name}: ${result.failures.join("; ")}` });
  }
  return run;
}

export function receiptId(pub: Publication): string {
  const receipt = pub.receipt as { receipt_id?: string; comment?: { id?: string } };
  return receipt.receipt_id ?? receipt.comment?.id ?? "?";
}

export function publish(world: DemoWorld, setId: number, log: DemoLine[] = []): boolean {
  try {
    const out = world.service.publish(PEOPLE.ops, setId, world.targets);
    for (const pub of out.publications) {
      log.push({ kind: "ok", text: `set ${setId} v${pub.version}: delivered to ${pub.target} (receipt ${receiptId(pub)})` });
    }
    return true;
  } catch (error) {
    if (error instanceof Conflict || error instanceof IllegalTransition) {
      world.blocked += 1;
      log.push({ kind: "blocked", text: `set ${setId}: publish BLOCKED: ${error.message}` });
      return false;
    }
    throw error;
  }
}

export const MANAGER_RULE = { condition: "amount is over 500", then: "request manager approval and stop", halts: true };

export function applyManagerThreshold(document: InstructionDocument): void {
  document.steps[3].decision_rules.push({ ...MANAGER_RULE });
  document.steps[3].citations.push({
    note_id: document.steps[3].citations[0].note_id,
    line_start: document.steps[3].citations[0].line_start,
    line_end: document.steps[3].citations[0].line_end,
    source_kind: "doc",
    source_ref: "policy/refunds-v4",
  });
}

export function announceMitigation(document: InstructionDocument): void {
  const step = document.steps[5];
  step.action = "Post the mitigation plan in #incidents, then " + step.action[0].toLowerCase() + step.action.slice(1);
  step.citations.push({
    note_id: step.citations[0].note_id,
    line_start: step.citations[0].line_start,
    line_end: step.citations[0].line_end,
    source_kind: "url",
    source_ref: "https://status.example.com/runbooks/triage",
  });
}

export function addOncallChannel(document: InstructionDocument): void {
  document.steps[3].action += " and #eng-oncall";
}

/** Run the whole demo script and return the log plus the summary computed from the records. */
export function runDemo(): { world: DemoWorld; log: DemoLine[]; summary: DemoSummary } {
  const world = createWorld();
  const log: DemoLine[] = [];
  const section = (title: string) => log.push({ kind: "section", text: title });

  section("Registering sources with content hashes");
  registerSources(world);
  for (const source of world.service.registry.list()) {
    log.push({ kind: "info", text: `${source.kind.padEnd(6)} ${source.ref.padEnd(52)} sha256:${source.content_hash.slice(0, 12)}` });
  }
  section("Ingesting expert notes and compiling instruction sets");
  ingestAll(world, log);
  section("Adding test cases");
  addTestCases(world, log);

  section("Review: edit requested on the incident note, then approvals");
  const incident = world.sets.incident;
  world.service.submit(PEOPLE.dana, incident);
  const changes = world.service.review(PEOPLE.ravi, incident, "request_changes", "step 6 must announce mitigation in #incidents first");
  log.push({ kind: "info", text: `set ${incident}: ravi requested changes -> ${changes.set.state}` });
  edit(world, incident, "announce mitigation in #incidents before acting", announceMitigation, log);
  reviewRound(world, incident, ["mei"], log);
  reviewRound(world, world.sets.onboarding, ["ravi"], log);
  reviewRound(world, world.sets.refund, ["ravi", "mei"], log);

  section("Running test cases and publishing approved sets");
  for (const key of ["onboarding", "incident", "refund"] as NoteKey[]) runTests(world, world.sets[key], log);
  for (const key of ["onboarding", "incident", "refund"] as NoteKey[]) publish(world, world.sets[key], log);

  const refund = world.sets.refund;
  section(`Fixing set ${refund}: add the manager approval threshold from policy/refunds-v4`);
  edit(world, refund, "manager approval required above 500 (policy/refunds-v4)", applyManagerThreshold, log);
  log.push({ kind: "info", text: `set ${refund}: state after edit -> ${world.service.getSet(refund).state}` });
  reviewRound(world, refund, ["ravi", "mei"], log);
  runTests(world, refund, log);
  publish(world, refund, log);

  const onboarding = world.sets.onboarding;
  section(`Revising published set ${onboarding}, publishing v2, then rolling back`);
  edit(world, onboarding, "also add the on-call channel", addOncallChannel, log);
  reviewRound(world, onboarding, ["ravi"], log);
  runTests(world, onboarding, log);
  publish(world, onboarding, log);
  const rolled = world.service.rollback(PEOPLE.ops, onboarding, world.targets);
  for (const pub of rolled.publications) {
    log.push({ kind: "ok", text: `set ${onboarding}: rollback delivered v${pub.version} to ${pub.target} (receipt ${receiptId(pub)})` });
  }
  log.push({ kind: "info", text: `set ${onboarding}: live version is now v${rolled.set.published_version}` });

  return { world, log, summary: summarize(world) };
}

export function summarize(world: DemoWorld): DemoSummary {
  const { service } = world;
  const sets = service.sets;
  const steps = sets.reduce((n, s) => n + s.document.steps.length, 0);
  const cited = sets.reduce((n, s) => n + s.document.steps.filter((st) => st.citations.length > 0).length, 0);
  const citations = sets.reduce((n, s) => n + s.document.steps.reduce((m, st) => m + st.citations.length, 0), 0);
  const delivered = service.publications.filter((p) => p.action === "publish" && p.status === "delivered");
  const versions = new Set(delivered.map((p) => `${p.instruction_set_id}:${p.version}`));
  const rollbacks = new Set(service.publications.filter((p) => p.action === "rollback").map((p) => `${p.instruction_set_id}:${p.version}`));
  return {
    notes: sets.length,
    steps,
    cited_steps: cited,
    citations,
    coverage: steps ? cited / steps : 1,
    edits: service.edits.length,
    approvals: service.reviews.filter((r) => r.decision === "approve").length,
    changes_requested: service.reviews.filter((r) => r.decision === "request_changes").length,
    test_runs: service.testRuns.length,
    runs_green: service.testRuns.filter((r) => r.status === "passed").length,
    runs_red: service.testRuns.filter((r) => r.status === "failed").length,
    cases_passed: service.testRuns.reduce((n, r) => n + r.passed, 0),
    cases_failed: service.testRuns.reduce((n, r) => n + r.failed, 0),
    publishes_blocked: world.blocked,
    deliveries: delivered.length,
    versions_delivered: versions.size,
    rollbacks: rollbacks.size,
    webhook_receipts: world.webhook.received.length,
    jira_comments: world.jira.comments.length,
    jira_attachments: world.jira.attachments.length,
    states: sets.map((s) => ({ id: s.id, state: s.state, live: s.published_version })),
  };
}
