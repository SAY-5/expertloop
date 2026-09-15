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
            a deterministic note compiler, source drift detection, an approval state machine with review policies,
            step-level versioning with branches and merges, a rule-following executor and signed delivery targets.
            The TypeScript in <code>web/src/sim</code> ports the compile, drift, review, versioning, gate and
            delivery paths; the condition plugin registry, the coverage report and the ops overview stay in the
            Python service. The numbers in the hero and in section 07 come from running that port in this
            browser, and its compiler and executor fixtures are written by the Python test suite.
          </p>
          <p className="footer-links">
            <a href="https://github.com/SAY-5/expertloop" rel="noreferrer" target="_blank">
              github.com/SAY-5/expertloop
            </a>
            <a href="https://github.com/SAY-5/expertloop/blob/main/ARCHITECTURE.md" rel="noreferrer" target="_blank">
              ARCHITECTURE.md
            </a>
            <a href="https://github.com/SAY-5/expertloop/blob/main/web/README.md" rel="noreferrer" target="_blank">
              web/README.md
            </a>
            <a href="https://github.com/SAY-5/expertloop/blob/main/CONTRIBUTING.md" rel="noreferrer" target="_blank">
              CONTRIBUTING.md
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
