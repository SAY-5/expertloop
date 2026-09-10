import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { type InstructionDocument } from "../sim/compile";
import { applyManagerThreshold, receiptId } from "../sim/demo";
import { PEOPLE } from "../sim/fixtures";
import { Conflict, type Publication, type TestRun } from "../sim/service";
import { IllegalTransition } from "../sim/state";
import { useWorld } from "../store";

const SET_KEY = "refund" as const;

interface Ledger {
  id: number;
  kind: "ok" | "bad" | "info" | "blocked";
  text: string;
}

interface Stage {
  label: string;
  hint: string;
}

const STAGES: Stage[] = [
  { label: "Submit v1, ravi and mei approve", hint: "two approvals are required for this set" },
  { label: "Run the three test cases", hint: "the executor walks every scenario against v1" },
  { label: "Publish", hint: "approved, but the latest run is red" },
  { label: "Apply the fix from policy/refunds-v4", hint: "manager approval above 500, halting rule on step 4" },
  { label: "Resubmit, ravi and mei approve v2", hint: "an edit after approval went back to draft" },
  { label: "Run the test cases again", hint: "same cases, new version" },
  { label: "Publish", hint: "approved and green: deliver to webhook and Jira" },
  { label: "Revise the published set", hint: "a small edit makes v3 and moves the head to draft" },
  { label: "Approve, test and publish v3", hint: "the full loop once more" },
  { label: "Roll back to v2", hint: "re-deliver the previous snapshot; the head stays put" },
];

function describeCase(scenario: { facts?: Record<string, unknown>; flags?: string[] }): string {
  const facts = Object.entries(scenario.facts ?? {}).map(([k, v]) => `${k}=${String(v)}`);
  return [...facts, ...(scenario.flags ?? [])].join(", ");
}

export function GateSection() {
  const { world, bump, toast } = useWorld();
  const reduced = useReducedMotion();
  const setId = world.sets[SET_KEY];
  const set = world.service.getSet(setId);
  const cases = world.service.casesFor(setId);
  const runs = world.service.runsFor(setId);
  const latest = runs[runs.length - 1] as TestRun | undefined;
  const publications = world.service.publicationsFor(setId);
  const [cursor, setCursor] = useState(0);
  const [ledger, setLedger] = useState<Ledger[]>([]);
  const [playing, setPlaying] = useState(false);
  const [gateShake, setGateShake] = useState(0);
  const timer = useRef<number | null>(null);

  const log = (kind: Ledger["kind"], text: string) => setLedger((l) => [{ id: (l[0]?.id ?? 0) + 1, kind, text }, ...l].slice(0, 40));

  const approvalsOk = set.state === "approved";
  const runOk = Boolean(latest && latest.version === set.version && latest.status === "passed");
  const runStale = Boolean(latest && latest.version !== set.version);
  const hasManagerRule = set.document.steps[3].decision_rules.some((r) => r.condition === "amount is over 500");

  const approve = () => {
    const current = world.service.getSet(setId);
    if (current.state === "approved") {
      log("info", `set ${setId} v${current.version} is already approved`);
      return;
    }
    if (current.state === "draft" || current.state === "changes_requested") {
      world.service.submit(PEOPLE.dana, setId);
      log("info", `set ${setId} v${current.version}: dana submitted -> in_review (round ${current.review_round + 1})`);
    }
    for (const who of ["ravi", "mei"] as const) {
      const out = world.service.review(PEOPLE[who], setId, "approve", "verified against the source documents");
      log("ok", `set ${setId}: ${who} approved (${out.approvals}/${out.set.required_approvals}) -> ${out.set.state}`);
    }
    bump();
  };

  const runTests = () => {
    const run = world.service.runTests(PEOPLE.ravi, setId);
    log(run.status === "passed" ? "ok" : "bad", `test run ${run.id} on v${run.version}: ${run.status.toUpperCase()} (${run.passed} passed, ${run.failed} failed)`);
    for (const r of run.results) if (!r.passed) log("bad", `FAIL ${r.name}: ${r.failures.join("; ")}`);
    toast(run.status === "passed" ? `Run ${run.id} green on v${run.version}` : `Run ${run.id} red: ${run.results.filter((r) => !r.passed).map((r) => r.name).join(", ")}`, run.status === "passed" ? "ok" : "bad");
    bump();
  };

  const publish = () => {
    try {
      const out = world.service.publish(PEOPLE.ops, setId, world.targets);
      for (const pub of out.publications) log("ok", `v${pub.version} delivered to ${pub.target} (receipt ${receiptId(pub)})`);
      toast(`v${out.set.published_version} published to webhook and Jira`, "ok");
    } catch (error) {
      if (error instanceof Conflict || error instanceof IllegalTransition) {
        world.blocked += 1;
        setGateShake((k) => k + 1);
        log("blocked", `publish BLOCKED (409): ${error.message}`);
        toast(`409: ${error.message}`, "bad");
      } else throw error;
    }
    bump();
  };

  const editDocument = (reason: string, mutate: (doc: InstructionDocument) => void) => {
    const current = world.service.getSet(setId);
    const document = JSON.parse(JSON.stringify(current.document)) as InstructionDocument;
    mutate(document);
    try {
      const edit = world.service.applyEdit(PEOPLE.dana, setId, current.version, reason, document);
      log("info", `edit ${edit.id}: v${edit.from_version} -> v${edit.to_version} (${reason}); state ${current.state} -> ${world.service.getSet(setId).state}`);
    } catch (error) {
      log("bad", `edit rejected: ${(error as Error).message}`);
    }
    bump();
  };

  const fix = () => editDocument("manager approval required above 500 (policy/refunds-v4)", applyManagerThreshold);
  const revise = () =>
    editDocument("record the confirmation number in OrderDB", (doc) => {
      doc.steps[4].action += " and record the confirmation number in OrderDB";
    });

  const rollback = () => {
    try {
      const out = world.service.rollback(PEOPLE.ops, setId, world.targets);
      for (const pub of out.publications) log("ok", `rollback delivered v${pub.version} to ${pub.target} (receipt ${receiptId(pub)})`);
      log("info", `live version is now v${out.set.published_version}; head stays v${out.set.version} in state ${out.set.state}`);
      toast(`Rolled back: v${out.set.published_version} is live again`, "ok");
    } catch (error) {
      log("bad", `rollback refused: ${(error as Error).message}`);
      toast((error as Error).message, "bad");
    }
    bump();
  };

  const STAGE_RUNNERS: Array<() => void> = [
    approve,
    runTests,
    publish,
    fix,
    approve,
    runTests,
    publish,
    revise,
    () => {
      approve();
      runTests();
      publish();
    },
    rollback,
  ];

  const runStage = (index: number) => {
    if (index >= STAGES.length) return;
    STAGE_RUNNERS[index]();
    setCursor(index + 1);
  };

  useEffect(() => {
    if (!playing) return;
    if (cursor >= STAGES.length) {
      setPlaying(false);
      return;
    }
    timer.current = window.setTimeout(() => runStage(cursor), reduced ? 30 : 1100);
    return () => {
      if (timer.current) window.clearTimeout(timer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, cursor, reduced]);

  const delivered = publications.filter((p) => p.status === "delivered");
  const versions = Array.from(new Set(world.service.versionsFor(setId).map((v) => v.version)));

  return (
    <section className="section gate" id="gate" aria-labelledby="gate-title">
      <div className="shell">
        <div className="section-head">
          <div>
            <p className="eyebrow">06 / Test gate and delivery</p>
            <h2 id="gate-title">
              Nothing ships until the <em>cases</em> say so.
            </h2>
          </div>
          <p>
            Publication needs state approved and a green run on the current version. A failing case names itself
            in the 409 and is counted and audited. Once through, the version snapshot goes to a signed webhook and
            a Jira issue with receipts, and a rollback re-delivers the previous snapshot.
          </p>
          <span className="section-num" aria-hidden="true">
            06
          </span>
        </div>

        <div className="gate-grid">
          <div className="gate-cases glass">
            <div className="panel-head">
              <div>
                <span className="eyebrow">test cases for set {set.id}</span>
                <h3>{set.document.title}</h3>
              </div>
              <div className="review-badges">
                <span className="chip chip-plum">v{set.version}</span>
                <span className={`chip state-${set.state}`}>{set.state.replace("_", " ")}</span>
                {set.published_version ? <span className="chip chip-ok">live v{set.published_version}</span> : null}
              </div>
            </div>
            <ul className="case-list">
              {cases.map((c, i) => {
                const result = latest?.results.find((r) => r.test_case_id === c.id);
                const status = !latest ? "idle" : result?.passed ? "pass" : "fail";
                return (
                  <motion.li
                    key={`${c.id}-${latest?.id ?? 0}`}
                    className={`case case-${status}`}
                    initial={reduced ? false : { opacity: 0.4, x: -10 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ duration: 0.4, delay: reduced ? 0 : i * 0.18 }}
                  >
                    <div className="case-head">
                      <span className={`case-status mono status-${status}`}>{status === "idle" ? "not run" : status === "pass" ? "PASS" : "FAIL"}</span>
                      <span className="case-name">{c.name}</span>
                    </div>
                    <div className="case-body">
                      <span className="chip">scenario: {describeCase(c.scenario)}</span>
                      {c.expectations.required_actions?.map((a) => (
                        <span key={a} className="chip chip-ok">
                          requires "{a}"
                        </span>
                      ))}
                      {c.expectations.forbidden_actions?.map((a) => (
                        <span key={a} className="chip chip-bad">
                          forbids "{a}"
                        </span>
                      ))}
                      {c.expectations.expected_tools?.map((t) => (
                        <span key={t} className="chip chip-warn">
                          tool {t}
                        </span>
                      ))}
                      {c.expectations.must_halt ? <span className="chip">must halt</span> : null}
                      {c.expectations.must_complete ? <span className="chip">must complete</span> : null}
                    </div>
                    {result ? (
                      <div className="case-trace mono">
                        <span className="trace-label">trace</span>
                        {result.trace.actions.map((a, j) => (
                          <span key={j} className={`trace-action${c.expectations.forbidden_actions?.some((f) => a.toLowerCase().includes(f.toLowerCase())) ? " trace-forbidden" : ""}`}>
                            {a}
                          </span>
                        ))}
                        <span className="trace-end">{result.trace.halted_at ? `halted at ${result.trace.halted_at}` : "ran to completion"}</span>
                        {result.failures.map((f) => (
                          <span key={f} className="trace-failure">
                            {f}
                          </span>
                        ))}
                      </div>
                    ) : null}
                  </motion.li>
                );
              })}
            </ul>
          </div>

          <div className="gate-side">
            <motion.div
              key={gateShake}
              className="glass gate-panel"
              initial={false}
              animate={gateShake && !reduced ? { x: [0, -6, 6, -4, 4, 0] } : { x: 0 }}
              transition={{ duration: 0.4 }}
            >
              <span className="eyebrow">publish gate</span>
              <div className="lamps">
                <div className={`lamp${approvalsOk ? " on" : ""}`}>
                  <span className="lamp-dot" aria-hidden="true" />
                  <span className="lamp-text">
                    state approved
                    <small>{set.state.replace("_", " ")}, {world.service.countApprovals(set)}/{set.required_approvals} approvals on v{set.version}</small>
                  </span>
                </div>
                <div className={`lamp${runOk ? " on" : ""}${latest && !runOk ? " off" : ""}`}>
                  <span className="lamp-dot" aria-hidden="true" />
                  <span className="lamp-text">
                    latest run green on v{set.version}
                    <small>
                      {!latest
                        ? "no run recorded"
                        : runStale
                          ? `run ${latest.id} covers v${latest.version}, current is v${set.version}`
                          : `run ${latest.id}: ${latest.passed} passed, ${latest.failed} failed`}
                    </small>
                  </span>
                </div>
              </div>
              <div className={`gate-bar${approvalsOk && runOk ? " open" : ""}`} aria-hidden="true">
                <motion.span className="gate-door left" animate={{ x: approvalsOk && runOk ? "-100%" : 0 }} transition={{ duration: reduced ? 0 : 0.6, ease: [0.22, 1, 0.36, 1] }} />
                <motion.span className="gate-door right" animate={{ x: approvalsOk && runOk ? "100%" : 0 }} transition={{ duration: reduced ? 0 : 0.6, ease: [0.22, 1, 0.36, 1] }} />
                <span className="gate-label mono">{approvalsOk && runOk ? "open" : "closed"}</span>
              </div>
              <div className="gate-actions">
                <button type="button" className="btn btn-plum" onClick={() => runStage(cursor)} disabled={cursor >= STAGES.length || playing}>
                  {cursor < STAGES.length ? `Next: ${STAGES[cursor].label}` : "Sequence complete"}
                </button>
                <button type="button" className="btn" onClick={() => setPlaying((p) => !p)} disabled={cursor >= STAGES.length}>
                  {playing ? "Pause" : "Autoplay"}
                </button>
              </div>
              <p className="gate-hint">{cursor < STAGES.length ? STAGES[cursor].hint : `${world.blocked} blocked, ${delivered.length} deliveries, live v${set.published_version}`}</p>
              <ol className="stages">
                {STAGES.map((s, i) => (
                  <li key={i} className={`stage${i < cursor ? " done" : ""}${i === cursor ? " current" : ""}`}>
                    <span className="stage-num mono">{String(i + 1).padStart(2, "0")}</span>
                    {s.label}
                  </li>
                ))}
              </ol>
              <details className="freeplay">
                <summary>free play</summary>
                <div className="freeplay-actions">
                  <button type="button" className="btn btn-ghost" onClick={approve}>
                    Submit + approve
                  </button>
                  <button type="button" className="btn btn-ghost" onClick={runTests}>
                    Run tests
                  </button>
                  <button type="button" className="btn btn-ghost" onClick={publish}>
                    Publish
                  </button>
                  <button type="button" className="btn btn-ghost" onClick={fix} disabled={hasManagerRule}>
                    Apply fix
                  </button>
                  <button type="button" className="btn btn-ghost" onClick={revise}>
                    Revise
                  </button>
                  <button type="button" className="btn btn-ghost" onClick={rollback}>
                    Roll back
                  </button>
                </div>
              </details>
            </motion.div>
          </div>
        </div>

        <div className="delivery-grid">
          <div className="glass ledger">
            <div className="panel-head">
              <span className="eyebrow">ledger</span>
              <span className="chip">
                {world.blocked} blocked, {delivered.length} delivered
              </span>
            </div>
            <ul className="ledger-list" aria-live="polite">
              <AnimatePresence initial={false}>
                {ledger.length === 0 ? <li className="feed-empty">Step through the sequence to fill the ledger.</li> : null}
                {ledger.map((l) => (
                  <motion.li key={l.id} className={`feed-item feed-${l.kind}`} initial={reduced ? false : { opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.25 }}>
                    {l.text}
                  </motion.li>
                ))}
              </AnimatePresence>
            </ul>
          </div>

          <div className="glass receipts">
            <div className="panel-head">
              <span className="eyebrow">receipts from the business systems</span>
              <span className="chip">
                {world.webhook.received.length} webhook, {world.jira.comments.length} Jira
              </span>
            </div>
            <div className="version-strip" aria-label="versions">
              {versions.map((v) => {
                const pubs = publications.filter((p) => p.version === v);
                const state = set.published_version === v ? "live" : pubs.some((p) => p.action === "publish" && p.status === "delivered") ? "delivered" : v === set.version ? "head" : "snapshot";
                return (
                  <span key={v} className={`version version-${state}`}>
                    v{v}
                    <small>{state}</small>
                  </span>
                );
              })}
            </div>
            <ul className="receipt-list">
              <AnimatePresence initial={false}>
                {publications.length === 0 ? <li className="feed-empty">No deliveries yet: the gate has not opened.</li> : null}
                {publications
                  .slice()
                  .reverse()
                  .map((p: Publication) => (
                    <motion.li key={p.id} className={`receipt receipt-${p.target}`} initial={reduced ? false : { opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: 0.3 }}>
                      <span className="receipt-head">
                        <span className="chip chip-plum">{p.target}</span>
                        <span className="chip">
                          {p.action} v{p.version}
                        </span>
                        <span className={`chip ${p.status === "delivered" ? "chip-ok" : "chip-bad"}`}>{p.status}</span>
                      </span>
                      <span className="receipt-body mono">
                        {p.target === "webhook" ? (
                          <>
                            receipt {String(p.receipt.receipt_id)} at t={String(p.receipt.timestamp)}
                            {"\n"}X-ExpertLoop-Signature: {String(p.receipt.signature).slice(0, 38)}...
                            {"\n"}body sha256 {String(p.receipt.body_sha256).slice(0, 24)} verified by receiver
                          </>
                        ) : (
                          <>
                            issue {String(p.receipt.issue)}: comment {(p.receipt.comment as { id: string }).id} with the agent prompt
                            {"\n"}attachment {(p.receipt.attachment as { id: string; filename: string; size: number }).id} {(p.receipt.attachment as { filename: string }).filename} ({(p.receipt.attachment as { size: number }).size} bytes)
                          </>
                        )}
                      </span>
                    </motion.li>
                  ))}
              </AnimatePresence>
            </ul>
          </div>
        </div>
      </div>
    </section>
  );
}
