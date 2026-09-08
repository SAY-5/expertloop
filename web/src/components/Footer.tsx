import { useMemo } from "react";
import { selfCheck } from "../sim/selfcheck";

export function Footer() {
  const checks = useMemo(() => selfCheck(), []);
  const failed = checks.filter((c) => !c.ok);
  return (
    <footer className="footer">
      <div className="shell footer-inner">
        <div className="footer-col">
          <span className="hero-brand">
            <span className="hero-mark" aria-hidden="true" />
            ExpertLoop
          </span>
          <p>
            This page is a browser port of the real service: a FastAPI API over PostgreSQL with Alembic migrations,
            a deterministic note compiler, an approval state machine, a rule-following executor and signed delivery
            targets. The TypeScript in <code>web/src/sim</code> mirrors <code>expertloop/</code> module for module;
            the numbers in the hero are computed by running the same demo script in memory.
          </p>
          <p>
            <a href="https://github.com/SAY-5/expertloop" rel="noreferrer" target="_blank">
              github.com/SAY-5/expertloop
            </a>
          </p>
        </div>
        <div className="footer-col">
          <span className="eyebrow">self-check in this browser</span>
          <p className={`footer-check mono ${failed.length ? "bad" : "ok"}`} aria-live="polite">
            {checks.length - failed.length}/{checks.length} checks pass
          </p>
          <ul className="footer-checks">
            {checks.map((c) => (
              <li key={c.name} className={c.ok ? "ok" : "bad"}>
                <span aria-hidden="true">{c.ok ? "✓" : "✗"}</span> {c.name}
              </li>
            ))}
          </ul>
        </div>
      </div>
      <div className="shell footer-meta">
        <span className="mono">no network calls, no wall clock in render, seeded and repeatable</span>
        <span className="mono">MIT</span>
      </div>
    </footer>
  );
}
