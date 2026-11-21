import { describe, expect, it } from "vitest";
import {
  COUNTDOWN_TICKS,
  PRIZES_PER_KIND,
  PRIZES_PER_ROUND,
  PRIZE_KINDS,
  ROUND_TICKS,
  TOTAL_PRIZE_SLOTS,
  createSim,
  modeFromStep,
  modeStep,
  NEUTRAL_INPUT,
  stepSim,
  type InputState,
} from "../src";

const noInput: [InputState, InputState] = [NEUTRAL_INPUT, NEUTRAL_INPUT];

export function playingSim(roundTicks = 240) {
  const sim = createSim({
    palettes: [2, 0],
    countdownTicksPerLabel: 1,
    roundTicks,
  });
  for (let i = 0; i < COUNTDOWN_TICKS; i += 1) stepSim(sim, noInput);
  expect(sim.phase).toBe("playing");
  return sim;
}

describe("constants", () => {
  it("keeps the reference prize budget (6 spawns, 1 per kind)", () => {
    expect(PRIZES_PER_ROUND).toBe(6);
    expect(PRIZES_PER_KIND).toBe(1);
    expect(TOTAL_PRIZE_SLOTS).toBe(6);
    expect(PRIZE_KINDS).toHaveLength(6);
  });

  it("round length is 84 s at 60 Hz", () => {
    expect(ROUND_TICKS).toBe(5040);
  });

  it("round-trips mode encoding", () => {
    expect(modeStep(modeFromStep(5))).toBe(5);
    expect(modeStep(modeFromStep(9))).toBe(9);
    expect(modeStep(modeFromStep(13))).toBe(13);
    expect(modeStep(modeFromStep(0))).toBe(0);
    expect(modeStep(modeFromStep(42))).toBe(9);
  });
});
