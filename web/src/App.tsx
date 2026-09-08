import { CompileSection } from "./components/CompileSection";
import { GateSection } from "./components/GateSection";
import { Hero } from "./components/Hero";
import { ReviewSection } from "./components/ReviewSection";
import { WorldProvider } from "./store";
import "./styles/hero.css";
import "./styles/compile.css";
import "./styles/review.css";
import "./styles/gate.css";

export default function App() {
  return (
    <WorldProvider>
      <div id="top" />
      <Hero />
      <main>
        <CompileSection />
        <ReviewSection />
        <GateSection />
      </main>
    </WorldProvider>
  );
}
