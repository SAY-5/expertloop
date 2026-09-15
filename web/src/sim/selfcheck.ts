/**
 * Console self-check for the browser port. Run with `npm run selfcheck` (tsx) or import
 * `selfCheck()` in the app to assert the same invariants at startup in development.
 *
 * Checks: every sample note compiles with every step cited; the refund SOP fails the
 * forbidden-action test at amount 800 and is blocked from publishing; after the manager
 * approval rule it passes and publishes; a changed source flags its steps and blocks
 * publication; branches merge and conflict; review policies hold approvals and escalate;
 * and the demo summary reproduces the block quoted in the README character for character.
 */

import { type InstructionDocument, citationCoverage, compileNote } from "./compile";
import { README_SUMMARY, runDemo, summaryBlock } from "./demo";
import { PEOPLE, SAMPLE_NOTES, SAMPLE_TEST_CASES } from "./fixtures";
import { createWorld, registerSources, ingestAll, addTestCases, reviewRound, runTests, publish, edit, applyManagerThreshold } from "./demo";
import { HOUR_MS } from "./reviews";
import { Conflict } from "./service";
import { assertTransition, IllegalTransition } from "./state";
import { verifySignature } from "./targets";
import { sha256, hmacSha256 } from "./sha256";
import { type Conflict as MergeConflict } from "./versioning";
import { runTestCase } from "./executor";
import compiledIncident from "../../../samples/expected/compiled_incident.json";
import compiledOnboarding from "../../../samples/expected/compiled_onboarding.json";
import compiledPhrasings from "../../../samples/expected/compiled_phrasings.json";
import compiledRefund from "../../../samples/expected/compiled_refund.json";
import goldenTraces from "../../../samples/expected/traces.json";

/** Key order does not matter when comparing with a fixture the Python suite wrote. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [key, canonical((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

function sameAsFixture(produced: unknown, fixture: unknown): boolean {
  return JSON.stringify(canonical(produced)) === JSON.stringify(canonical(fixture));
}

const COMPILED_FIXTURES: Record<string, unknown> = {
  refund: compiledRefund,
  onboarding: compiledOnboarding,
  incident: compiledIncident,
};

export interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

function check(results: CheckResult[], name: string, ok: boolean, detail = ""): void {
  results.push({ name, ok, detail });
}

export function selfCheck(): CheckResult[] {
  const results: CheckResult[] = [];

  check(results, "sha256 known vector", sha256("abc") === "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  check(
    results,
    "hmac-sha256 known vector",
    hmacSha256("key", "The quick brown fox jumps over the lazy dog") === "f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8",
  );

  const expectedSteps: Record<string, number> = { refund: 5, onboarding: 6, incident: 7 };
  for (const note of SAMPLE_NOTES) {
    const document = compileNote(note.body, 1, note.title);
    const coverage = citationCoverage(document);
    check(
      results,
      `${note.short} compiles with every step cited`,
      coverage.steps === expectedSteps[note.key] && coverage.cited_steps === coverage.steps && coverage.coverage === 1,
      `${coverage.cited_steps}/${coverage.steps} steps, ${coverage.citations} citations`,
    );
  }

  const refundDoc = compileNote(SAMPLE_NOTES[0].body, 1, SAMPLE_NOTES[0].title);
  check(results, "refund step 2 carries a halting fraud rule", refundDoc.steps[1].decision_rules.some((r) => r.condition === "reason is fraud" && r.halts));
  check(results, "refund step 3 outcome extracted", refundDoc.steps[2].expected_outcome === "warehouse scan present in OrderDB");
  check(results, "refund step 5 cites FIN-2210", refundDoc.steps[4].citations.some((c) => c.source_ref === "FIN-2210"));
  check(results, "refund tools detected", refundDoc.steps.map((s) => s.tool ?? "-").join(",") === "OrderDB,-,OrderDB,Stripe,Zendesk", refundDoc.steps.map((s) => s.tool ?? "-").join(","));

  // --- the fixtures the Python compiler and executor wrote ------------------
  for (const note of SAMPLE_NOTES) {
    const produced = compileNote(note.body, 1, note.title);
    check(
      results,
      `${note.short} compiles to the document the Python compiler produced`,
      sameAsFixture(produced, COMPILED_FIXTURES[note.key]),
      "samples/expected/compiled_" + note.key + ".json",
    );
  }
  const phrasings = compiledPhrasings as { note: string; document: unknown };
  check(
    results,
    "guards, negated stop words and unless compile the way the Python compiler reads them",
    sameAsFixture(
      compileNote(phrasings.note, 1, "Warehouse dispatch phrasings"),
      phrasings.document,
    ),
    "samples/expected/compiled_phrasings.json",
  );

  const traceFixtures = goldenTraces as Record<string, { name: string }[]>;
  const traceMismatches: string[] = [];
  for (const note of SAMPLE_NOTES) {
    const document = compileNote(note.body, 1, note.title);
    SAMPLE_TEST_CASES[note.key].forEach((testCase, index) => {
      const expected = traceFixtures[note.key]?.[index];
      const produced = { name: testCase.name, ...runTestCase(document, testCase.scenario, testCase.expectations) };
      if (!sameAsFixture(produced, expected)) traceMismatches.push(`${note.key}[${index}] ${testCase.name}`);
    });
  }
  check(
    results,
    "all eight case traces match the ones the Python executor produced",
    traceMismatches.length === 0,
    traceMismatches.join("; ") || "samples/expected/traces.json",
  );

  const world = createWorld();
  registerSources(world);
  ingestAll(world);
  addTestCases(world);
  const refund = world.sets.refund;
  reviewRound(world, refund, ["ravi", "mei"]);
  const red = runTests(world, refund);
  const failing = red.results.find((r) => !r.passed);
  check(
    results,
    "refund SOP fails forbidden-action case at amount 800",
    red.status === "failed" && failing?.name === "high value refund needs manager approval" &&
      failing.failures.includes("forbidden action taken: 'Issue the refund'"),
    failing ? failing.failures.join("; ") : "no failure",
  );
  const blocked = !publish(world, refund);
  check(results, "publish blocked while the run is red", blocked && world.service.getSet(refund).state === "approved");
  const blockedAudit = world.service.auditFor(refund).some((a) => a.action === "publish_blocked" && String(a.detail.reason).includes("high value refund needs manager approval"));
  check(results, "blocked publish is audited with the failing case named", blockedAudit);

  edit(world, refund, "manager approval required above 500 (policy/refunds-v4)", applyManagerThreshold);
  check(results, "edit after approval returns the set to draft", world.service.getSet(refund).state === "draft" && world.service.getSet(refund).version === 2);
  reviewRound(world, refund, ["ravi", "mei"]);
  const green = runTests(world, refund);
  check(results, "after the manager-approval rule all refund cases pass", green.status === "passed" && green.passed === 3);
  const published = publish(world, refund);
  check(results, "approved set with a green run publishes to both targets", published && world.service.getSet(refund).state === "published" && world.service.publicationsFor(refund).length === 2);

  const whr = world.webhook.received[0];
  check(results, "webhook fake verified the HMAC signature", Boolean(whr && whr.verified));
  check(results, "webhook signature fails with the wrong secret", whr ? !verifySignature("other", whr.timestamp, "{}", whr.signature) : false);

  let illegal = false;
  try {
    assertTransition("publish", "draft");
  } catch (error) {
    illegal = error instanceof IllegalTransition;
  }
  check(results, "illegal transition draft -> publish is rejected", illegal);

  try {
    world.service.applyEdit(PEOPLE.dana, refund, 1, "stale", world.service.getSet(refund).document);
    check(results, "stale expected_version is rejected", false);
  } catch (error) {
    check(results, "stale expected_version is rejected", (error as Error).message.startsWith("version mismatch"));
  }

  const { summary } = runDemo();
  check(results, "demo: 3 notes, 18 steps, 26 citations, 100% cited", summary.notes === 3 && summary.steps === 18 && summary.citations === 26 && summary.coverage === 1, `${summary.steps} steps, ${summary.citations} citations`);
  check(results, "demo: 3 edits, 7 approvals, 1 changes requested", summary.edits === 3 && summary.approvals === 7 && summary.changes_requested === 1);
  check(results, "demo: 5 test runs (4 green, 1 red; 13 passed, 1 failed)", summary.test_runs === 5 && summary.runs_green === 4 && summary.runs_red === 1 && summary.cases_passed === 13 && summary.cases_failed === 1);
  check(results, "demo: 1 blocked publish, 8 deliveries, 1 rollback", summary.publishes_blocked === 1 && summary.deliveries === 8 && summary.versions_delivered === 4 && summary.rollbacks === 1);
  check(results, "demo: 5 webhook receipts, 5 Jira comments, 5 Jira attachments", summary.webhook_receipts === 5 && summary.jira_comments === 5 && summary.jira_attachments === 5);
  check(
    results,
    "demo: final states",
    summary.states.map((s) => `${s.id}=${s.state}(v${s.live})`).join(",") === "1=published(v2),2=published(v1),3=published(v2)",
    summary.states.map((s) => `${s.id}=${s.state}(v${s.live})`).join(","),
  );
  check(
    results,
    "demo summary reproduces the README block exactly",
    summaryBlock(summary) === README_SUMMARY,
    summaryBlock(summary) === README_SUMMARY ? "" : summaryBlock(summary),
  );
  check(results, "sample test case count", Object.values(SAMPLE_TEST_CASES).flat().length === 8);

  // --- source drift: per-step hashes and the stale-step publish block -------
  const driftWorld = createWorld();
  registerSources(driftWorld);
  ingestAll(driftWorld);
  addTestCases(driftWorld);
  const onboarding = driftWorld.sets.onboarding;
  reviewRound(driftWorld, onboarding, ["ravi"]);
  runTests(driftWorld, onboarding);
  const weekOne = driftWorld.service.registry.find("doc", "onboarding/week-one");
  const citedHash = () =>
    driftWorld.service
      .getSet(onboarding)
      .document.steps[5].citations.find((c) => c.source_ref === "onboarding/week-one")?.source_hash;
  check(results, "a step stores the hash of the source it cites", Boolean(weekOne && citedHash() === weekOne.content_hash));
  const changed = weekOne
    ? driftWorld.service.rehashSource(PEOPLE.ops, weekOne.id, "Handbook, engineering wiki, on-call primer, expense policy, laptop pickup.")
    : false;
  check(
    results,
    "re-hashing a changed source flags every step citing it",
    changed && driftWorld.service.driftFor(onboarding).stale_steps.join(",") === "s6",
    driftWorld.service.driftFor(onboarding).stale_steps.join(","),
  );
  const staleBlocked = !publish(driftWorld, onboarding);
  check(
    results,
    "publish is blocked while a step cites a changed source",
    staleBlocked && driftWorld.service.getSet(onboarding).state === "approved",
  );
  check(
    results,
    "the blocked publish names the stale step",
    driftWorld.service
      .auditFor(onboarding)
      .some((a) => a.action === "publish_blocked" && String(a.detail.reason).includes("stale steps cite changed sources: s6")),
  );
  driftWorld.service.reverify(PEOPLE.dana, onboarding, ["s6"]);
  check(
    results,
    "re-verifying closes the flag and re-stamps the citation",
    driftWorld.service.driftFor(onboarding).open === 0 && citedHash() === weekOne?.content_hash,
  );
  check(
    results,
    "publish goes through once the drift is resolved",
    publish(driftWorld, onboarding) && driftWorld.service.getSet(onboarding).state === "published",
  );

  const keepWorld = createWorld();
  registerSources(keepWorld);
  ingestAll(keepWorld);
  const incident = keepWorld.sets.incident;
  const runbook = keepWorld.service.registry.find("doc", "runbooks/service-triage");
  if (runbook) keepWorld.service.rehashSource(PEOPLE.ops, runbook.id, "Scale out, roll back last deploy, fail over read replicas, page the DBA.");
  check(results, "the incident set's runbook step is flagged", keepWorld.service.driftFor(incident).stale_steps.join(",") === "s6");
  edit(keepWorld, incident, "record the alert id", (doc) => {
    doc.steps[0].action += " and record the alert id";
  });
  check(
    results,
    "an edit elsewhere leaves the stale step flagged",
    keepWorld.service.driftFor(incident).open === 1,
    `${keepWorld.service.driftFor(incident).open} open`,
  );
  edit(keepWorld, incident, "restate the mitigation against the new runbook", (doc) => {
    doc.steps[5].action += " (per the updated runbook)";
  });
  const afterEdit = keepWorld.service.driftFor(incident);
  check(
    results,
    "editing the stale step closes its flag as edited",
    afterEdit.open === 0 && afterEdit.resolved === 1 && afterEdit.flags[0].resolution === "edited",
  );

  // --- branches, structured diff and merge ----------------------------------
  const branchWorld = createWorld();
  registerSources(branchWorld);
  ingestAll(branchWorld);
  const parentId = branchWorld.sets.onboarding;
  const child = branchWorld.service.branch(PEOPLE.dana, parentId, "contractor variant");
  check(
    results,
    "branching copies a version into a new draft",
    child.parent_id === parentId && child.state === "draft" && child.version === 1 && child.branched_from_version === 1,
  );
  const branchEdit = (setId: number, mutate: (doc: InstructionDocument) => void, reason: string) => {
    const current = branchWorld.service.getSet(setId);
    const document = JSON.parse(JSON.stringify(current.document)) as InstructionDocument;
    mutate(document);
    branchWorld.service.applyEdit(PEOPLE.dana, setId, current.version, reason, document);
  };
  branchEdit(child.id, (doc) => {
    doc.steps[2].action += " and record the contractor end date";
  }, "contractor end date");
  branchEdit(parentId, (doc) => {
    doc.steps[3].action += " and #eng-oncall";
  }, "add the on-call channel");
  const diff = branchWorld.service.diffVersions(parentId, 1, 2);
  check(
    results,
    "the structured version diff names the changed step",
    diff.summary.steps_changed === 1 && diff.steps.changed[0].id === "s4" && "action" in diff.steps.changed[0].fields,
  );
  const mergeOut = branchWorld.service.merge(PEOPLE.dana, child.id, "merge the contractor variant");
  const mergedDoc = branchWorld.service.getSet(parentId).document;
  check(
    results,
    "a clean merge takes the one-sided change from each side",
    mergedDoc.steps[2].action.includes("contractor end date") &&
      mergedDoc.steps[3].action.includes("#eng-oncall") &&
      mergeOut.edit.to_version === 3,
  );
  check(
    results,
    "the merged branch records where it landed",
    branchWorld.service.getSet(child.id).merged_into_version === 3 && branchWorld.service.getSet(child.id).merged_at !== null,
  );

  const clashWorld = createWorld();
  registerSources(clashWorld);
  ingestAll(clashWorld);
  const clashParent = clashWorld.sets.onboarding;
  const clashChild = clashWorld.service.branch(PEOPLE.dana, clashParent, "invite variant");
  const clashEdit = (setId: number, text: string, reason: string) => {
    const current = clashWorld.service.getSet(setId);
    const document = JSON.parse(JSON.stringify(current.document)) as InstructionDocument;
    document.steps[2].action = text;
    clashWorld.service.applyEdit(PEOPLE.dana, setId, current.version, reason, document);
  };
  clashEdit(clashChild.id, "Invite the GitHub user as an outside collaborator only", "tighten the invite");
  clashEdit(clashParent, "Invite the GitHub user to the organisation with the requested team", "clarify the invite");
  check(results, "a preview reports the conflict before anything is written", clashWorld.service.previewMerge(clashChild.id).length === 1);
  let conflicts: MergeConflict[] = [];
  try {
    clashWorld.service.merge(PEOPLE.dana, clashChild.id, "merge the invite variant");
  } catch (error) {
    if (error instanceof Conflict) conflicts = (error.detail.conflicts as MergeConflict[]) ?? [];
  }
  check(
    results,
    "both sides changing one field is a merge conflict",
    conflicts.length === 1 && conflicts[0].step_id === "s3" && conflicts[0].field === "action",
    conflicts.map((c) => `${c.step_id}.${String(c.field)}`).join(","),
  );
  check(
    results,
    "a conflicting merge leaves the parent untouched",
    clashWorld.service.getSet(clashParent).version === 2 &&
      clashWorld.service.auditFor(clashParent).some((a) => a.action === "merge_conflict"),
  );

  // --- review policies: required roles, self-approval, deadlines -------------
  const policyWorld = createWorld();
  registerSources(policyWorld);
  ingestAll(policyWorld);
  const policySet = policyWorld.sets.refund;
  policyWorld.service.setReviewPolicy(PEOPLE.ops, policySet, { required_roles: ["admin"], review_deadline_hours: 4 });
  policyWorld.service.submit(PEOPLE.dana, policySet);
  policyWorld.service.review(PEOPLE.ravi, policySet, "approve", "verified against the source documents");
  policyWorld.service.review(PEOPLE.mei, policySet, "approve", "verified against the source documents");
  check(
    results,
    "a required reviewer role holds the approval open",
    policyWorld.service.getSet(policySet).state === "in_review" && policyWorld.service.missingRoles(policyWorld.service.getSet(policySet)).join(",") === "admin",
  );
  policyWorld.service.review(PEOPLE.ops, policySet, "approve", "signed off");
  check(results, "an approval from the required role releases it", policyWorld.service.getSet(policySet).state === "approved");

  const selfSet = policyWorld.sets.incident;
  const selfDoc = JSON.parse(JSON.stringify(policyWorld.service.getSet(selfSet).document)) as InstructionDocument;
  selfDoc.steps[0].action += " and record the alert id";
  policyWorld.service.applyEdit(PEOPLE.ravi, selfSet, 1, "tighten the acknowledgement", selfDoc);
  policyWorld.service.submit(PEOPLE.dana, selfSet);
  let selfMessage = "";
  try {
    policyWorld.service.review(PEOPLE.ravi, selfSet, "approve", "looks fine to me");
  } catch (error) {
    selfMessage = (error as Error).message;
  }
  check(
    results,
    "the author of the current version cannot approve it",
    selfMessage.startsWith("self-approval is not allowed") && selfMessage.includes("version 2"),
    selfMessage,
  );
  policyWorld.service.review(PEOPLE.mei, selfSet, "approve", "verified against the source documents");
  check(results, "a reviewer who did not write it can still approve", policyWorld.service.getSet(selfSet).state === "approved");

  const slaWorld = createWorld();
  registerSources(slaWorld);
  ingestAll(slaWorld);
  const slaSet = slaWorld.sets.refund;
  slaWorld.service.setReviewPolicy(PEOPLE.ops, slaSet, { review_deadline_hours: 4 });
  slaWorld.service.submit(PEOPLE.dana, slaSet);
  const submitted = slaWorld.service.getSet(slaSet);
  check(
    results,
    "submitting starts the review clock from the policy",
    submitted.submitted_at !== null && submitted.review_deadline_at === submitted.submitted_at + 4 * HOUR_MS,
  );
  check(results, "nothing escalates before the deadline", slaWorld.service.escalateOverdue(PEOPLE.ops).length === 0);
  slaWorld.service.advance(5);
  const escalated = slaWorld.service.escalateOverdue(PEOPLE.ops);
  check(
    results,
    "an overdue review escalates with an audit row",
    escalated.length === 1 && slaWorld.service.auditFor(slaSet).some((a) => a.action === "review_escalated"),
  );
  check(results, "an escalated review is not escalated twice", slaWorld.service.escalateOverdue(PEOPLE.ops).length === 0);
  const queue = slaWorld.service.workload([PEOPLE.dana, PEOPLE.ravi, PEOPLE.mei]);
  check(
    results,
    "the workload queue shows the overdue set and who it waits on",
    queue.queue.length === 1 &&
      queue.queue[0].overdue &&
      queue.queue[0].escalated &&
      queue.queue[0].waiting_on.join(",") === "mei,ravi",
    queue.queue.map((q) => `${q.instruction_set_id}:${q.waiting_on.join("+")}`).join(","),
  );

  return results;
}

/** Print results to the console; returns the number of failed checks. */
export function printSelfCheck(): number {
  const results = selfCheck();
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.detail ? `  (${r.detail})` : ""}`);
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  return failed;
}

interface NodeLike {
  process?: { argv?: string[]; exit: (code: number) => void };
}
const node = globalThis as unknown as NodeLike;
if (node.process?.argv?.some((a) => a.endsWith("selfcheck.ts"))) {
  const failed = printSelfCheck();
  if (failed) node.process.exit(1);
}
