/**
 * Deterministic PRNG (mulberry32) with a serializable state.
 *
 * The core may not use `Math.random`, so every random decision in the rules
 * (jump angles, prize kind, prize position, rain drops) goes through this.
 */

export interface RngState {
  s: number;
}

export function hashSeed(text: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

export class Rng {
  private s: number;

  constructor(seed: number | string) {
    const value = typeof seed === "string" ? hashSeed(seed) : seed >>> 0;
    this.s = value === 0 ? 0x9e3779b9 : value >>> 0;
  }

  get state(): RngState {
    return { s: this.s };
  }

  set state(next: RngState) {
    this.s = next.s >>> 0;
  }

  /** Uniform float in [0, 1). */
  next(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Uniform integer in [min, max). Mirrors Python `random.randrange`. */
  int(min: number, maxExclusive: number): number {
    if (maxExclusive <= min) return min;
    return min + Math.floor(this.next() * (maxExclusive - min));
  }

  /** Uniform integer in [min, max]. Mirrors Python `random.randint`. */
  intInclusive(min: number, max: number): number {
    return this.int(min, max + 1);
  }

  float(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  choice<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error("Rng.choice: empty list");
    return items[this.int(0, items.length)]!;
  }
}
