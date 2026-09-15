import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import {
  type DemoLine,
  type DemoSummary,
  type DemoWorld,
  addTestCases,
  createWorld,
  ingestAll,
  registerSources,
  runDemo,
} from "./sim/demo";

export type ToastKind = "ok" | "bad" | "info";

interface WorldContextValue {
  world: DemoWorld;
  /** Increments after every mutation so components re-read the mutable service. */
  version: number;
  bump: () => void;
  toast: (text: string, kind?: ToastKind) => void;
  /** The demo script, run once for the whole page: the hero and section 07 both read it. */
  demo: { log: DemoLine[]; summary: DemoSummary };
}

const WorldContext = createContext<WorldContextValue | null>(null);

function buildWorld(): DemoWorld {
  const world = createWorld();
  registerSources(world);
  ingestAll(world);
  addTestCases(world);
  return world;
}

export function WorldProvider({ children }: { children: ReactNode }) {
  const worldRef = useRef<DemoWorld | null>(null);
  if (worldRef.current === null) worldRef.current = buildWorld();
  const demoRef = useRef<{ log: DemoLine[]; summary: DemoSummary } | null>(null);
  if (demoRef.current === null) {
    const { log, summary } = runDemo();
    demoRef.current = { log, summary };
  }
  const [version, setVersion] = useState(0);
  const [toasts, setToasts] = useState<{ id: number; text: string; kind: ToastKind }[]>([]);
  const toastId = useRef(0);
  const reduced = useReducedMotion();

  const bump = useCallback(() => setVersion((v) => v + 1), []);
  const toast = useCallback((text: string, kind: ToastKind = "info") => {
    const id = ++toastId.current;
    setToasts((list) => [...list.slice(-2), { id, text, kind }]);
    window.setTimeout(() => setToasts((list) => list.filter((t) => t.id !== id)), 4200);
  }, []);

  const value = useMemo<WorldContextValue>(
    () => ({
      world: worldRef.current as DemoWorld,
      version,
      bump,
      toast,
      demo: demoRef.current as { log: DemoLine[]; summary: DemoSummary },
    }),
    [version, bump, toast],
  );

  return (
    <WorldContext.Provider value={value}>
      {children}
      <div aria-live="polite" aria-atomic="false" className="toast-stack">
        <AnimatePresence>
          {toasts.map((t) => (
            <motion.div
              key={t.id}
              className={`toast glass toast-${t.kind}`}
              initial={reduced ? false : { opacity: 0, y: 16, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 8, scale: 0.98 }}
              transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
            >
              {t.text}
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </WorldContext.Provider>
  );
}

export function useWorld(): WorldContextValue {
  const value = useContext(WorldContext);
  if (!value) throw new Error("useWorld must be used inside WorldProvider");
  return value;
}
