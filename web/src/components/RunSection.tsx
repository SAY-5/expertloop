import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { README_SUMMARY, runDemo, summaryBlock } from "../sim/demo";

const TICK_MS = 110;

export function RunSection() {
  const reduced = useReducedMotion();
  const { log, summary } = useMemo(() => runDemo(), []);
  const block = useMemo(() => summaryBlock(summary), [summary]);
  const matches = block === README_SUMMARY;
  const [cursor, setCursor] = useState(reduced ? log.length : 0);
  const [playing, setPlaying] = useState(false);
  const timer = useRef<number | null>(null);
  const scroller = useRef<HTMLOListElement>(null);

  useEffect(() => {
    if (!playing) return;
    if (cursor >= log.length) {
      setPlaying(false);
      return;
    }
    timer.current = window.setTimeout(() => setCursor((c) => c + 1), reduced ? 0 : TICK_MS);
    return () => {
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, [playing, cursor, log.length, reduced]);

  useEffect(() => {
    const box = scroller.current;
    if (!box || !playing) return;
    box.scrollTop = box.scrollHeight;
  }, [cursor, playing]);

  const shown = log.slice(0, cursor);
  const done = cursor >= log.length;

  const rows: Array<[string, string]> = [
    ["notes ingested", String(summary.notes)],
    ["steps compiled", String(summary.steps)],
    ["citations linked", `${summary.citations} (${summary.cited_steps}/${summary.steps} cited)`],
    ["edits recorded", String(summary.edits)],
    ["approvals", `${summary.approvals} (changes requested: ${summary.changes_requested})`],
    ["test runs", `${summary.test_runs} (${summary.runs_green} green, ${summary.runs_red} red)`],
    ["cases", `${summary.cases_passed} passed, ${summary.cases_failed} failed`],
    ["publishes blocked", String(summary.publishes_blocked)],
    ["deliveries", `${summary.deliveries} (${summary.versions_delivered} versions to 2 targets)`],
    ["rollbacks", String(summary.rollbacks)],
    ["receipts", `${summary.webhook_receipts} webhook, ${summary.jira_comments} comments, ${summary.jira_attachments} attachments`],
  ];

  return (
    <section className="section run" id="run" aria-labelledby="run-title">
      <div className="shell">
        <div className="section-head">
          <div>
            <p className="eyebrow">07 / The whole run</p>
            <h2 id="run-title">
              The same script the repo <em>prints</em>.
            </h2>
          </div>
          <p>
            This is the demo from the repository, executed in the browser against the in-memory port: eight
            sources registered, three notes ingested, an edit routed through review, test cases run, one publish
            blocked on a red case, the fix reviewed and shipped, and one set rolled back. The summary below is
            computed from those records and compared with the block quoted in the README.
          </p>
          <span className="section-num" aria-hidden="true">
            07
          </span>
        </div>

        <div className="glass run-summary-card run-summary-top">
          <div className="panel-head">
            <div>
              <span className="eyebrow">summary computed from the records</span>
              <h3>What the demo prints</h3>
            </div>
            <span className={`chip ${matches ? "chip-ok" : "chip-bad"}`}>
              {matches ? "matches the README block character for character" : "differs from the README block"}
            </span>
          </div>
          <pre className="run-block" aria-label="demo summary block">
            {block}
          </pre>
        </div>

        <div className="run-grid">
          <div className="glass run-log-card">
            <div className="panel-head">
              <div>
                <span className="eyebrow">event log</span>
                <h3>demo run</h3>
              </div>
              <div className="run-controls">
                <span className="chip chip-plum" aria-live="polite">
                  {shown.length}/{log.length} events
                </span>
                <button type="button" className="btn btn-plum" onClick={() => (done ? (setCursor(0), setPlaying(true)) : setPlaying((p) => !p))}>
                  {done ? "Replay" : playing ? "Pause" : "Play the run"}
                </button>
                <button type="button" className="btn btn-ghost" onClick={() => { setPlaying(false); setCursor(log.length); }}>
                  Show all
                </button>
              </div>
            </div>
            <ol className="run-log" ref={scroller} aria-live="polite" aria-label="demo event log">
              {shown.length === 0 ? <li className="feed-empty">Press play to walk the run one event at a time.</li> : null}
              <AnimatePresence initial={false}>
                {shown.map((line, i) => (
                  <motion.li
                    key={i}
                    className={`run-line run-${line.kind}`}
                    initial={reduced ? false : { opacity: 0, x: -8 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ duration: 0.2 }}
                  >
                    {line.kind === "section" ? <span className="run-section">{line.text}</span> : <span className="mono">{line.text}</span>}
                  </motion.li>
                ))}
              </AnimatePresence>
            </ol>
          </div>

          <div className="run-side">
            <div className="glass run-numbers">
              <span className="eyebrow">computed from the records</span>
              <dl className="run-dl">
                {rows.map(([label, value]) => (
                  <div key={label} className="run-dl-row">
                    <dt>{label}</dt>
                    <dd className="mono">{value}</dd>
                  </div>
                ))}
              </dl>
              <div className="run-states">
                {summary.states.map((state) => (
                  <span key={state.id} className="chip chip-plum">
                    set {state.id} {state.state} (live v{state.live})
                  </span>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
