import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { compileNote, type Step } from "../sim/compile";
import { SAMPLE_NOTES } from "../sim/fixtures";
import { useWorld } from "../store";
import { NotePaper } from "./NotePaper";

function useCountUp(target: number, duration = 1400, delay = 200): number {
  const reduced = useReducedMotion();
  const [value, setValue] = useState(reduced ? target : 0);
  useEffect(() => {
    if (reduced) {
      setValue(target);
      return;
    }
    let frame = 0;
    let start: number | null = null;
    const tick = (now: number) => {
      if (start === null) start = now + delay;
      const t = Math.min(1, Math.max(0, (now - start) / duration));
      const eased = 1 - Math.pow(1 - t, 3);
      setValue(Math.round(eased * target));
      if (t < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [target, duration, delay, reduced]);
  return value;
}

function Stat({ value, suffix, label, delay }: { value: number; suffix?: string; label: string; delay: number }) {
  const shown = useCountUp(value, 1400, delay);
  return (
    <div className="hero-stat">
      <span className="hero-stat-value" aria-hidden="true">
        {shown}
        {suffix}
      </span>
      <span className="hero-stat-label" aria-hidden="true">
        {label}
      </span>
      {/* the ticking number is decorative; the settled figure is what gets announced */}
      <span className="sr-only" aria-live="polite">
        {shown === value ? `${value}${suffix ?? ""} ${label}` : ""}
      </span>
    </div>
  );
}

const REFUND = SAMPLE_NOTES[0];
const CYCLE_MS = 11000;

function citationLabel(step: Step): string {
  const line = step.citations[0];
  return line.line_start === line.line_end ? `L${line.line_start}` : `L${line.line_start}-${line.line_end}`;
}

export function Hero() {
  const reduced = useReducedMotion();
  const { demo } = useWorld();
  const summary = demo.summary;
  const document = useMemo(() => compileNote(REFUND.body, 1, REFUND.title), []);
  const [phase, setPhase] = useState(0);
  const [cycle, setCycle] = useState(0);
  const timers = useRef<number[]>([]);

  useEffect(() => {
    timers.current.forEach((t) => window.clearTimeout(t));
    timers.current = [];
    if (reduced) {
      setPhase(document.steps.length);
      return;
    }
    setPhase(0);
    document.steps.forEach((_, i) => {
      timers.current.push(window.setTimeout(() => setPhase(i + 1), 1300 + i * 950));
    });
    timers.current.push(window.setTimeout(() => setCycle((c) => c + 1), CYCLE_MS));
    return () => timers.current.forEach((t) => window.clearTimeout(t));
  }, [cycle, reduced, document.steps]);

  const activeStep = phase > 0 ? document.steps[Math.min(phase, document.steps.length) - 1] : null;
  const highlight = activeStep ? ([activeStep.citations[0].line_start, activeStep.citations[0].line_end] as [number, number]) : null;
  const revealUpTo = activeStep ? activeStep.citations[0].line_end : 11;

  return (
    <header className="hero">
      <div className="shell hero-inner">
        <nav className="hero-nav" aria-label="primary">
          <a className="hero-brand" href="#top">
            <span className="hero-mark" aria-hidden="true" />
            ExpertLoop
          </a>
          <div className="hero-links">
            <a href="#compile">Compile</a>
            <a href="#drift">Drift</a>
            <a href="#review">Review</a>
            <a href="#workload">Workload</a>
            <a href="#versions">Versions</a>
            <a href="#gate">Gate</a>
            <a href="#run">Run</a>
            <a href="https://github.com/SAY-5/expertloop" rel="noreferrer" target="_blank">
              Repo
            </a>
          </div>
        </nav>

        <div className="hero-grid">
          <div className="hero-copy">
            <motion.p
              className="eyebrow"
              initial={reduced ? false : { opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6 }}
            >
              Review desk / browser port of the FastAPI service
            </motion.p>
            <motion.h1
              className="hero-title"
              initial={reduced ? false : { opacity: 0, y: 24 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.8, delay: 0.1, ease: [0.22, 1, 0.36, 1] }}
            >
              Expert notes in.
              <br />
              <em>Tested</em> instructions out.
            </motion.h1>
            <motion.p
              className="hero-lede"
              initial={reduced ? false : { opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.7, delay: 0.25 }}
            >
              A deterministic compiler turns task notes into agent instructions where every step cites its
              source lines. Edits are diffed and versioned, reviewers approve through a state machine, and
              test cases gate publication before anything reaches a business system.
            </motion.p>
            <motion.div
              className="hero-stats"
              initial={reduced ? false : { opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.6, delay: 0.4 }}
              aria-label="demo headline numbers"
            >
              <Stat value={summary.steps} label="steps compiled" delay={400} />
              <Stat value={Math.round(summary.coverage * 100)} suffix="%" label="steps cited" delay={550} />
              <Stat value={summary.publishes_blocked} label="publish blocked" delay={700} />
              <Stat value={summary.deliveries} label="deliveries" delay={850} />
            </motion.div>
            <p className="hero-stat-note">
              from the demo run, computed in this browser and compared with the README block in section 07
            </p>
            <motion.div
              className="hero-actions"
              initial={reduced ? false : { opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6, delay: 0.55 }}
            >
              <a className="btn btn-plum" href="#gate">
                Run the publish gate
              </a>
              <a className="btn btn-ghost" href="#compile">
                See the citations
              </a>
            </motion.div>
          </div>

          <motion.div
            className="hero-visual"
            initial={reduced ? false : { opacity: 0, scale: 0.97, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            transition={{ duration: 0.9, delay: 0.3, ease: [0.22, 1, 0.36, 1] }}
            aria-hidden="true"
          >
            <div className="hero-note">
              <NotePaper body={REFUND.body} title="samples/refund_handling_sop.md" highlight={highlight} revealUpTo={revealUpTo} compact maxHeight={470} />
            </div>
            <div className="hero-beam">
              <svg viewBox="0 0 80 400" preserveAspectRatio="none">
                <defs>
                  <linearGradient id="beam" x1="0" x2="1" y1="0" y2="0">
                    <stop offset="0" stopColor="#e04fd6" stopOpacity="0" />
                    <stop offset="0.5" stopColor="#e04fd6" stopOpacity="0.9" />
                    <stop offset="1" stopColor="#e04fd6" stopOpacity="0" />
                  </linearGradient>
                </defs>
                {document.steps.map((step, i) => (
                  <motion.path
                    key={`${cycle}-${step.id}`}
                    d={`M0 ${40 + i * 78} C 40 ${40 + i * 78}, 40 ${60 + i * 66}, 80 ${60 + i * 66}`}
                    fill="none"
                    stroke="url(#beam)"
                    strokeWidth="1.5"
                    initial={{ pathLength: 0, opacity: 0 }}
                    animate={phase > i ? { pathLength: 1, opacity: 1 } : { pathLength: 0, opacity: 0 }}
                    transition={{ duration: 0.7, ease: "easeOut" }}
                  />
                ))}
              </svg>
            </div>
            <div className="hero-steps glass">
              <div className="hero-steps-head">
                <span className="eyebrow">instruction set v1</span>
                <span className="chip chip-plum">{Math.min(phase, document.steps.length)}/{document.steps.length} cited</span>
              </div>
              <ol className="hero-step-list">
                <AnimatePresence initial={false}>
                  {document.steps.slice(0, phase).map((step) => (
                    <motion.li
                      key={`${cycle}-${step.id}`}
                      className="hero-step"
                      initial={reduced ? false : { opacity: 0, x: 18, filter: "blur(6px)" }}
                      animate={{ opacity: 1, x: 0, filter: "blur(0px)" }}
                      transition={{ duration: 0.55, ease: [0.22, 1, 0.36, 1] }}
                    >
                      <span className="hero-step-id mono">{step.id}</span>
                      <span className="hero-step-action">
                        {step.condition ? <em>only if {step.condition}: </em> : null}
                        {step.action}
                      </span>
                      <span className="hero-step-cites">
                        <span className="chip chip-plum">{citationLabel(step)}</span>
                        {step.citations
                          .filter((c) => c.source_ref)
                          .map((c) => (
                            <span key={c.source_ref} className="chip">
                              {c.source_kind}:{c.source_ref}
                            </span>
                          ))}
                        {step.tool ? <span className="chip chip-warn">{step.tool}</span> : null}
                        {step.decision_rules.length ? <span className="chip chip-bad">halts on {step.decision_rules[0].condition}</span> : null}
                      </span>
                    </motion.li>
                  ))}
                </AnimatePresence>
              </ol>
            </div>
          </motion.div>
        </div>
      </div>
    </header>
  );
}
