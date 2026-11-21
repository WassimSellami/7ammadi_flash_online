import { describe, expect, it } from "vitest";
import {
  D_WIDTH,
  JUMP_MOVE_FACTOR,
  NORMAL_MODE,
  SPEED,
  TICK_MS,
  WAIT_MODE,
  changeAngle,
  changeCoor,
  clampToPlayfield,
  createPlayer,
  setToNormal,
  setupPlayer,
  startKnockback,
} from "../src";

const TICK_FACTOR = TICK_MS / SPEED;

describe("motion", () => {
  it("uses the exact sub-pixel accumulation of the reference", () => {
    const player = createPlayer(1, 0, 2);
    setupPlayer(player, 0, 0, 2);
    player.angle = 0;
    player.mode = NORMAL_MODE;
    const start = player.x;
    const increments: number[] = [];
    for (let i = 0; i < 4; i += 1) {
      const before = player.x;
      changeCoor(player, TICK_MS);
      increments.push(player.x - before);
    }
    // 9 * (1000/60) / 35 = 4.2857..., truncated through the accumulator.
    expect(increments).toEqual([4, 4, 4, 5]);
    expect(player.x - start).toBe(17);
    expect(9 * TICK_FACTOR).toBeCloseTo(4.285714285714286, 12);
  });

  it("applies the 0.8 movement factor while jumping", () => {
    const player = createPlayer(1, 0, 2);
    setupPlayer(player, 0, 0, 2);
    player.angle = 0;
    player.mode = NORMAL_MODE;
    player.jumping = true;
    const increments: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      const before = player.x;
      changeCoor(player, TICK_MS);
      increments.push(player.x - before);
    }
    expect(increments).toEqual([3, 3, 4]);
    expect(JUMP_MOVE_FACTOR).toBe(0.8);
  });

  it("clamps to the playfield with the 80x80 icon margin", () => {
    const player = createPlayer(0, 2, 1);
    setupPlayer(player, 2, 180, 1);
    player.x = -50;
    player.y = 0;
    clampToPlayfield(player);
    expect(player.x).toBe(40);
    expect(player.y).toBe(114);

    player.x = D_WIDTH + 100;
    player.y = 10000;
    clampToPlayfield(player);
    expect(player.x).toBe(D_WIDTH - 40);
    expect(player.y).toBe(1040);
  });

  it("steers with right taking precedence when both keys are held", () => {
    const player = createPlayer(0, 2, 1);
    setupPlayer(player, 2, 180, 1);
    player.mode = NORMAL_MODE;
    changeAngle(player, { left: true, right: true }, TICK_MS);
    expect(player.angle).toBeCloseTo(180 + 6 * TICK_FACTOR, 12);
    changeAngle(player, { left: true, right: false }, TICK_MS);
    expect(player.angle).toBeCloseTo(180, 12);
  });

  it("restores the powerup mode after a wall hit but keeps the powerup", () => {
    const player = createPlayer(1, 0, 2);
    setupPlayer(player, 0, 0, 2);
    player.x = D_WIDTH - 40;
    player.powerup = "speed";
    player.mode = NORMAL_MODE;
    changeCoor(player, TICK_MS);
    expect(player.powerup).toBe("speed");
    expect(player.mode.step).toBe(13);
    expect(player.wallCooldown).toBeGreaterThan(0);
  });

  it("knocks the victim to the nearest wall in 0.2 s", () => {
    const player = createPlayer(0, 2, 1);
    setupPlayer(player, 2, 180, 1);
    player.y = 900;
    player.radius = 45;
    startKnockback(player);
    expect(player.jumpingToWall).toBe(true);
    expect(player.knockbackTargetY).toBe(1035);
    for (let i = 0; i < 13; i += 1) changeCoor(player, TICK_MS);
    expect(player.jumpingToWall).toBe(false);
    expect(player.y).toBe(1035);
    expect(player.wallEvent).not.toBeNull();
    expect(player.mode.step).toBe(9);
  });

  it("reset-to-normal restores the true palette and radius", () => {
    const player = createPlayer(0, 2, 1);
    setupPlayer(player, 2, 180, 1);
    player.paintIndex = 0;
    player.radius = 45;
    player.bandi = true;
    player.powerup = "bandi";
    setToNormal(player);
    expect(player.paintIndex).toBe(2);
    expect(player.radius).toBe(36);
    expect(player.bandi).toBe(false);
    expect(player.mode.step).toBe(9);
  });

  it("keeps the wait mode from moving the player", () => {
    const player = createPlayer(0, 2, 1);
    setupPlayer(player, 2, 87, 1);
    player.mode = WAIT_MODE;
    const x = player.x;
    const y = player.y;
    for (let i = 0; i < 10; i += 1) changeCoor(player, TICK_MS);
    expect(player.x).toBe(x);
    expect(player.y).toBe(y);
  });
});
