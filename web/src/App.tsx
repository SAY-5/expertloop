import { CompileSection } from "./components/CompileSection";
import { Hero } from "./components/Hero";
import { ReviewSection } from "./components/ReviewSection";
import { WorldProvider } from "./store";
import "./styles/hero.css";
import "./styles/compile.css";
import "./styles/review.css";

export default function App() {
  return (
    <WorldProvider>
      <div id="top" />
      <Hero />
      <main>
        <CompileSection />
        <ReviewSection />
      </main>
    </WorldProvider>
  );
}
