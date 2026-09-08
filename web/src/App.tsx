import { Hero } from "./components/Hero";
import { WorldProvider } from "./store";
import "./styles/hero.css";

export default function App() {
  return (
    <WorldProvider>
      <div id="top" />
      <Hero />
      <main />
    </WorldProvider>
  );
}
