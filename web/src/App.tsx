import { CompileSection } from "./components/CompileSection";
import { DriftSection } from "./components/DriftSection";
import { Footer } from "./components/Footer";
import { GateSection } from "./components/GateSection";
import { Hero } from "./components/Hero";
import { ReviewSection } from "./components/ReviewSection";
import { RunSection } from "./components/RunSection";
import { VersionSection } from "./components/VersionSection";
import { WorkloadSection } from "./components/WorkloadSection";
import { WorldProvider } from "./store";
import "./styles/hero.css";
import "./styles/compile.css";
import "./styles/drift.css";
import "./styles/review.css";
import "./styles/workload.css";
import "./styles/versions.css";
import "./styles/gate.css";
import "./styles/run.css";

export default function App() {
  return (
    <WorldProvider>
      <a className="skip-link" href="#main">
        Skip to the walkthrough
      </a>
      <div id="top" />
      <Hero />
      <main id="main">
        <CompileSection />
        <DriftSection />
        <ReviewSection />
        <WorkloadSection />
        <VersionSection />
        <GateSection />
        <RunSection />
      </main>
      <Footer />
    </WorldProvider>
  );
}
