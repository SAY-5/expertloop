/** Seeded PRNG (mulberry32). The demo never draws from the browser's random source, so every run is identical. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Deterministic hex token of `length` chars derived from a seed and a label. */
export function token(seed: number, label: string, length = 8): string {
  let h = seed >>> 0;
  for (let i = 0; i < label.length; i++) {
    h = Math.imul(h ^ label.charCodeAt(i), 0x01000193) >>> 0;
  }
  const rand = mulberry32(h);
  let out = "";
  while (out.length < length) {
    out += Math.floor(rand() * 16).toString(16);
  }
  return out;
}
