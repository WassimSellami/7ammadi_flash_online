import { describe, expect, it } from "vitest";
import {
  NEUTRAL_INPUT,
  NO_PAINT,
  PRIZE_KINDS,
  PRIZES_PER_KIND,
  RAIN_DROPS,
  WAIT_MODE,
  createSim,
  generatePrize,
  paintedCount,
  prizeExpired,
  rewardPrize,
  startRain,
  stepSim,
  updatePrize,
  type GameEvent,
  type InputState,
} from "../src";

const noInput: [InputState, InputState] = [NEUTRAL_INPUT, NEUTRAL_INPUT];

function toPlaying(roundTicks = 600) {
  const sim = createSim({ palettes: [2, 0], countdownTicksPerLabel: 1, roundTicks });
  for (let i = 0; i < 4; i += 1) stepSim(sim, noInput);
  return sim;
}

function park(sim: ReturnType<typeof toPlaying>) {
  sim.players[0].x = 120;
  sim.players[0].y = 160;
  sim.players[0].mode = WAIT_MODE;
  sim.players[1].x = 1800;
  sim.players[1].y = 980;
  sim.players[1].mode = WAIT_MODE;
}

describe("prize budget and schedule", () => {
  it("enforces one prize per kind and never exceeds the round budget", () => {
    const sim = toPlaying(600);
    const events: GameEvent[] = [];
    for (let i = 0; i < PRIZE_KINDS.length + 2; i += 1) {
      sim.prize.active = false;
      generatePrize(sim, events);
    }
    const total = Object.values(sim.prize.counts).reduce((sum, value) => sum + value, 0);
    expect(total).toBe(PRIZES_PER_KIND * PRIZE_KINDS.length);
    expect(Object.values(sim.prize.counts).every((value) => value === PRIZES_PER_KIND)).toBe(true);
  });

  it("spawns 6 prizes at 12 s intervals over a full round", () => {
    const sim = toPlaying(5040);
    park(sim);
    const spawnTicks: number[] = [];
    const kinds: string[] = [];
    for (let i = 0; i < 5040 && sim.phase === "playing"; i += 1) {
      const events = stepSim(sim, noInput);
      for (const event of events) {
        if (event.type === "spawn") {
          spawnTicks.push(event.tick);
          kinds.push(event.kind);
        }
      }
    }
    expect(spawnTicks).toHaveLength(6);
    expect(new Set(kinds).size).toBe(6);
    const gaps = spawnTicks.slice(1).map((tick, index) => tick - spawnTicks[index]!);
    expect(gaps.every((gap) => gap === 720)).toBe(true);
    expect(spawnTicks[0]).toBe(4 + 720 - 1);
  });

  it("expires a prize after 12 s", () => {
    const sim = toPlaying();
    sim.prize.active = true;
    sim.prize.kind = "speed";
    sim.prize.ageMs = 0;
    for (let i = 0; i < 719; i += 1) updatePrize(sim, 1000 / 60);
    expect(sim.prize.active).toBe(true);
    expect(prizeExpired(sim.prize)).toBe(false);
    updatePrize(sim, 1000 / 60);
    expect(prizeExpired(sim.prize)).toBe(true);
  });
});

describe("prize rewards", () => {
  it("rain stamps 30 drops of radius 36 every 50 ms", () => {
    const sim = toPlaying();
    const events: GameEvent[] = [];
    startRain(sim, 2, events);
    const rain = events.find((event) => event.type === "rain");
    expect(rain && rain.type === "rain" ? rain.drops.length : 0).toBe(RAIN_DROPS);
    expect(sim.prize.rainPending).toHaveLength(RAIN_DROPS - 1);

    const first = paintedCount(sim.mask, 2);
    expect(first).toBeGreaterThan(0);

    updatePrize(sim, 1000 / 60);
    updatePrize(sim, 1000 / 60);
    expect(sim.prize.rainPending).toHaveLength(RAIN_DROPS - 1);
    updatePrize(sim, 1000 / 60);
    expect(sim.prize.rainPending).toHaveLength(RAIN_DROPS - 2);

    for (let i = 0; i < 3 * RAIN_DROPS; i += 1) updatePrize(sim, 1000 / 60);
    expect(sim.prize.rainPending).toHaveLength(0);
    expect(paintedCount(sim.mask, 2)).toBeGreaterThan(first);
  });

  it("boom stamps a radius-200 circle", () => {
    const sim = toPlaying();
    const before = paintedCount(sim.mask, 2);
    sim.prize.kind = "boom";
    const events: GameEvent[] = [];
    rewardPrize(sim, sim.players[0], sim.players[1], events);
    expect(events.some((event) => event.type === "boom")).toBe(true);
    expect(paintedCount(sim.mask, 2) - before).toBeGreaterThan(7000);
  });

  it("follow_me strips every brush of its colour", () => {
    const sim = toPlaying();
    const [winner, loser] = sim.players;
    winner.paintIndex = 2;
    loser.paintIndex = 0;
    sim.prize.kind = "follow_me";
    const events: GameEvent[] = [];
    rewardPrize(sim, winner, loser, events);
    expect(winner.paintIndex).toBe(NO_PAINT);
    expect(loser.paintIndex).toBe(NO_PAINT);
    expect(winner.powerup).toBe("follow_me");
    expect(events.some((event) => event.type === "evil")).toBe(true);
  });

  it("does not overwrite an active powerup marker with follow_me", () => {
    const sim = toPlaying();
    const [winner, loser] = sim.players;
    winner.powerup = "speed";
    sim.prize.kind = "follow_me";
    rewardPrize(sim, winner, loser, []);
    expect(winner.powerup).toBe("speed");
  });

  it("mode prizes clear the previous powerup before applying", () => {
    const sim = toPlaying();
    const [winner, loser] = sim.players;
    winner.powerup = "fat";
    winner.radius = 45;
    winner.bandi = true;
    sim.prize.kind = "speed";
    rewardPrize(sim, winner, loser, []);
    expect(winner.powerup).toBe("speed");
    expect(winner.radius).toBe(36);
    expect(winner.mode.step).toBe(13);
    expect(winner.bandi).toBe(false);
  });

  it("fat sets the big radius and normal movement", () => {
    const sim = toPlaying();
    const [winner, loser] = sim.players;
    sim.prize.kind = "fat";
    rewardPrize(sim, winner, loser, []);
    expect(winner.radius).toBe(45);
    expect(winner.mode.step).toBe(9);
    expect(winner.powerup).toBe("fat");
  });

  it("bandi lasts 10 s, sets fast mode and radius 45", () => {
    const sim = toPlaying(5000);
    const [winner, loser] = sim.players;
    sim.prize.kind = "bandi";
    rewardPrize(sim, winner, loser, []);
    expect(winner.bandi).toBe(true);
    expect(winner.bandiTimeLeft).toBe(10);
    expect(winner.mode.step).toBe(13);
    expect(winner.radius).toBe(45);
    // Advance 10 s of ticks; bandi expires back to normal.
    for (let i = 0; i < 600; i += 1) updatePrize(sim, 1000 / 60);
    // updatePowerup is driven by stepSim; use a tiny loop through the sim.
    for (let i = 0; i < 600 && winner.bandi; i += 1) stepSim(sim, noInput);
    expect(winner.bandi).toBe(false);
    expect(winner.mode.step).toBe(9);
  });
});
