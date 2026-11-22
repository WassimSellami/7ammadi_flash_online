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

  it("spawns near the middle as a line, Mercedes star or cross", () => {
    const centerY = (74 + 1080) / 2;
    const three = createSim({
      palettes: [2, 0, 1, 3],
      activeSlots: 3,
      spawn: "cross",
      countdownTicksPerLabel: 1,
    });
    expect(three.players.slice(0, 3).map((player) => player.angle)).toEqual([270, 30, 150]);
    for (const player of three.players.slice(0, 3)) {
      expect(Math.abs(player.x - 960)).toBeLessThanOrEqual(192);
      expect(Math.abs(player.y - centerY)).toBeLessThanOrEqual(101);
      expect(Math.hypot(player.x - 960, player.y - centerY)).toBeGreaterThan(80);
    }

    const four = createSim({
      palettes: [2, 0, 1, 3],
      activeSlots: 4,
      spawn: "cross",
      countdownTicksPerLabel: 1,
    });
    expect(four.players.map((player) => player.angle)).toEqual([270, 90, 0, 180]);
  });
});
