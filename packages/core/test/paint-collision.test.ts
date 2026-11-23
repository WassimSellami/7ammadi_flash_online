import { describe, expect, it } from "vitest";
import {
  BIG_RADIUS,
  COUNTDOWN_TICKS,
  NEUTRAL_INPUT,
  NO_PAINT,
  WAIT_MODE,
  armCollisionTimers,
  collisionCheck,
  createSim,
  paintedCount,
  startKnockback,
  stepSim,
  updateCollisionTimers,
  type GameEvent,
  type InputState,
} from "../src";

const noInput: [InputState, InputState] = [NEUTRAL_INPUT, NEUTRAL_INPUT];

function toPlaying() {
  const sim = createSim({ palettes: [2, 0], countdownTicksPerLabel: 1, roundTicks: 2000 });
  for (let i = 0; i < 4; i += 1) stepSim(sim, noInput);
  return sim;
}

describe("paint suppression quirk", () => {
  it("stamps during the countdown", () => {
    const sim = createSim({ palettes: [2, 0], countdownTicksPerLabel: 1 });
    stepSim(sim, noInput);
    expect(paintedCount(sim.mask, 2)).toBeGreaterThan(0);
    expect(paintedCount(sim.mask, 0)).toBeGreaterThan(0);
  });

  it("stops player B stamping while it jumps", () => {
    const sim = toPlaying();
    sim.players[0].mode = WAIT_MODE;
    sim.players[1].mode = WAIT_MODE;
    sim.players[1].x = 1500;
    sim.players[1].y = 800;
    const beforeB = paintedCount(sim.mask, 0);
    sim.players[1].jumping = true;
    stepSim(sim, noInput);
    expect(paintedCount(sim.mask, 0)).toBe(beforeB);
  });

  it("suppresses painting for both players while player A jumps", () => {
    const sim = toPlaying();
    sim.players[0].mode = WAIT_MODE;
    sim.players[1].mode = WAIT_MODE;
    const before = sim.mask.counts.slice();
    sim.players[0].x = 300;
    sim.players[0].y = 900;
    sim.players[1].x = 1700;
    sim.players[1].y = 200;
    sim.players[0].jumping = true;
    stepSim(sim, noInput);
    expect(sim.mask.counts).toEqual(before);
  });

  it("keeps painting while idle, every tick", () => {
    const sim = toPlaying();
    sim.players[0].mode = WAIT_MODE;
    sim.players[1].mode = WAIT_MODE;
    sim.players[0].x = 400;
    sim.players[0].y = 400;
    sim.players[1].x = 1500;
    sim.players[1].y = 800;
    stepSim(sim, noInput);
    const first = sim.mask.counts.slice();
    expect(paintedCount(sim.mask, 2)).toBeGreaterThan(0);
    stepSim(sim, noInput);
    expect(sim.mask.counts).toEqual(first);
  });

  it("does not stamp a player who is being knocked to the wall", () => {
    const sim = toPlaying();
    const [p1, p2] = sim.players;
    p1.mode = WAIT_MODE;
    p2.mode = WAIT_MODE;
    p1.x = 300;
    p1.y = 200;
    p2.x = 1600;
    p2.y = 900;
    startKnockback(p1);
    const before = sim.mask.counts.reduce((sum, value) => sum + value, 0);
    stepSim(sim, noInput);
    const after = sim.mask.counts.reduce((sum, value) => sum + value, 0);
    // Only player B's fresh circle is added (~250 cells), not both (~500).
    expect(after - before).toBeGreaterThan(100);
    expect(after - before).toBeLessThan(400);
  });
});

describe("collisions", () => {
  it("starts a normal collision: both jump, then slow, then normal", () => {
    const sim = toPlaying();
    const [p1, p2] = sim.players;
    p1.mode = WAIT_MODE;
    p2.mode = WAIT_MODE;
    p1.x = 900;
    p1.y = 500;
    p2.x = 940;
    p2.y = 500;

    const events: GameEvent[] = [];
    const started = collisionCheck(sim, events);
    expect(started).toBe(true);
    expect(events[0]?.type).toBe("smash");
    expect(p1.jumping && p2.jumping).toBe(true);
    armCollisionTimers(sim);

    // Move them apart so the follow-up slow collision cannot restart timers.
    p1.x = 200;
    p2.x = 1700;

    for (let i = 0; i < 84; i += 1) updateCollisionTimers(sim);
    expect(p1.jumping).toBe(false);
    expect(p1.brokenVisual).toBe(true);
    expect(p1.mode.step).toBe(5);

    for (let i = 0; i < 216; i += 1) updateCollisionTimers(sim);
    expect(p1.brokenVisual).toBe(false);
    expect(p1.mode.step).toBe(9);
    expect(sim.collisionActive).toBe(false);
  });

  it("cancels bandi-vs-bandi into a normal collision", () => {
    const sim = toPlaying();
    const [p1, p2] = sim.players;
    p1.bandi = true;
    p2.bandi = true;
    p1.radius = BIG_RADIUS;
    p2.radius = BIG_RADIUS;
    p1.x = 900;
    p1.y = 500;
    p2.x = 940;
    p2.y = 500;
    const events: GameEvent[] = [];
    expect(collisionCheck(sim, events)).toBe(true);
    expect(p1.bandi).toBe(false);
    expect(p2.bandi).toBe(false);
    expect(p1.jumping).toBe(true);
  });

  it("punches with bandi, keeps bandi, and sends the victim to the wall", () => {
    const sim = toPlaying();
    const [p1, p2] = sim.players;
    p1.bandi = true;
    p1.powerup = "bandi";
    p1.radius = BIG_RADIUS;
    p1.mode = { angle: 6, step: 13 };
    p1.x = 900;
    p1.y = 500;
    p2.x = 940;
    p2.y = 500;
    const events: GameEvent[] = [];
    collisionCheck(sim, events);
    expect(events.some((event) => event.type === "punch")).toBe(true);
    expect(p1.bandi).toBe(true);
    expect(p2.jumpingToWall).toBe(true);
    expect(p2.jumping).toBe(false);
  });

  it("does not punch the same victim twice while the punch is active", () => {
    const sim = toPlaying();
    const [p1, p2] = sim.players;
    p1.bandi = true;
    p1.radius = BIG_RADIUS;
    p1.x = 900;
    p1.y = 500;
    p2.x = 940;
    p2.y = 500;
    collisionCheck(sim, []);
    const events: GameEvent[] = [];
    collisionCheck(sim, events);
    expect(events).toHaveLength(0);
  });

  it("only breaks the players that actually collided", () => {
    const sim = createSim({
      palettes: [2, 0, 1, 3],
      activeSlots: 3,
      countdownTicksPerLabel: 1,
      roundTicks: 2000,
    });
    for (let i = 0; i < 4; i += 1) stepSim(sim, noInput);
    const [p1, p2, p3] = sim.players;
    p1!.mode = WAIT_MODE;
    p2!.mode = WAIT_MODE;
    p3!.mode = WAIT_MODE;
    p1!.x = 900;
    p1!.y = 500;
    p2!.x = 940;
    p2!.y = 500;
    p3!.x = 1600;
    p3!.y = 800;

    expect(collisionCheck(sim, [])).toBe(true);
    armCollisionTimers(sim);
    for (let i = 0; i < 84; i += 1) updateCollisionTimers(sim);

    expect(p1!.brokenVisual).toBe(true);
    expect(p2!.brokenVisual).toBe(true);
    expect(p3!.brokenVisual).toBe(false);
    expect(p3!.jumping).toBe(false);
    expect(p3!.mode.step).toBe(WAIT_MODE.step);

    p3!.x = 1200;
    p3!.y = 300;
    const before = paintedCount(sim.mask, p3!.palette);
    stepSim(sim, noInput);
    expect(paintedCount(sim.mask, p3!.palette)).toBeGreaterThan(before);
  });

  it("restores potion colours only for the brushes that collide", () => {
    const sim = createSim({
      palettes: [2, 0, 1, 3],
      activeSlots: 4,
      countdownTicksPerLabel: 1,
      roundTicks: 2000,
    });
    for (let i = 0; i < 4; i += 1) stepSim(sim, noInput);
    const [winner, a, b, bystander] = sim.players;
    for (const player of sim.players) player.mode = WAIT_MODE;
    // Potion: the winner stays coloured, every victim loses its paint.
    winner!.paintIndex = winner!.palette;
    for (const player of sim.players) {
      if (player !== winner) player.paintIndex = NO_PAINT;
    }
    a!.x = 900;
    a!.y = 500;
    b!.x = 940;
    b!.y = 500;
    bystander!.x = 1600;
    bystander!.y = 800;

    collisionCheck(sim, []);

    expect(a!.paintIndex).toBe(a!.palette);
    expect(b!.paintIndex).toBe(b!.palette);
    // A victim that stayed clear stays white.
    expect(bystander!.paintIndex).toBe(NO_PAINT);
    expect(winner!.paintIndex).toBe(winner!.palette);
  });
});
