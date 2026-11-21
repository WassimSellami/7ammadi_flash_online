import { describe, expect, it } from "vitest";
import {
  COUNTDOWN_TICKS,
  NEUTRAL_INPUT,
  createSim,
  serializeSnapshot,
  stateHash,
  stepSim,
  type InputState,
} from "../src";

const neutral: [InputState, InputState] = [NEUTRAL_INPUT, NEUTRAL_INPUT];

function scriptedInput(tick: number): [InputState, InputState] {
  const phase = Math.floor(tick / 23) % 4;
  const a: InputState = {
    left: phase === 1 || phase === 2,
    right: phase === 0 || phase === 3,
  };
  const b: InputState = {
    left: phase === 0,
    right: phase === 2 || phase === 3,
  };
  return [a, b];
}

function replay(seed: string, ticks: number): string[] {
  const sim = createSim({
    palettes: [2, 0],
    countdownTicksPerLabel: 1,
    roundTicks: 1200,
    seed,
  });
  const hashes: string[] = [];
  for (let i = 0; i < ticks; i += 1) {
    stepSim(sim, scriptedInput(i));
    hashes.push(stateHash(sim));
  }
  return hashes;
}

describe("determinism", () => {
  it("produces an identical hash sequence for the same seed and inputs", () => {
    const first = replay("golden-replay", 700);
    const second = replay("golden-replay", 700);
    expect(second).toEqual(first);
  });

  it("changes the hash sequence when the seed changes", () => {
    const first = replay("seed-a", 700);
    const second = replay("seed-b", 700);
    expect(second).not.toEqual(first);
  });

  it("serializes a stable snapshot frame", () => {
    const sim = createSim({
      palettes: [2, 0],
      countdownTicksPerLabel: 1,
      roundTicks: 600,
      seed: "snapshot-seed",
    });
    for (let i = 0; i < 400; i += 1) stepSim(sim, scriptedInput(i));
    const snapshot = serializeSnapshot(sim);
    expect(snapshot.phase).toBe("playing");
    expect(snapshot.a.x).toBeTypeOf("number");
    expect(snapshot.scores[0]).toBeGreaterThanOrEqual(0);
    const size = JSON.stringify(snapshot).length;
    expect(size).toBeLessThan(400);
  });

  it("does not drift: one call advances exactly one tick", () => {
    const sim = createSim({
      palettes: [2, 0],
      countdownTicksPerLabel: 1,
      roundTicks: 5000,
    });
    for (let i = 0; i < 1000; i += 1) stepSim(sim, neutral);
    expect(sim.tick).toBe(1000);
    expect(sim.countdownTicks).toBe(4);
    expect(sim.roundTick).toBe(996);
  });
});
