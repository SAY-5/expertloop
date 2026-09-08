import { CompileSection } from "./components/CompileSection";
import { Hero } from "./components/Hero";
import { WorldProvider } from "./store";
import "./styles/hero.css";
import "./styles/compile.css";

export default function App() {
  return (
    <WorldProvider>
      <div id="top" />
      <Hero />
      <main>
        <CompileSection />
      </main>
    </WorldProvider>
  );
}
