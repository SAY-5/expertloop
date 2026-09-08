/**
 * Console self-check for the browser port. Run with `npm run selfcheck` (tsx) or import
 * `selfCheck()` in the app to assert the same invariants at startup in development.
 *
 * Checks: every sample note compiles with every step cited; the refund SOP fails the
 * forbidden-action test at amount 800 and is blocked from publishing; after the manager
 * approval rule it passes and publishes; the headline numbers match the README demo.
 */

import { citationCoverage, compileNote } from "./compile";
import { runDemo } from "./demo";
import { PEOPLE, SAMPLE_NOTES, SAMPLE_TEST_CASES } from "./fixtures";
import { createWorld, registerSources, ingestAll, addTestCases, reviewRound, runTests, publish, edit, applyManagerThreshold } from "./demo";
import { assertTransition, IllegalTransition } from "./state";
import { verifySignature } from "./targets";
import { sha256, hmacSha256 } from "./sha256";

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
  check(results, "sample test case count", Object.values(SAMPLE_TEST_CASES).flat().length === 8);
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
