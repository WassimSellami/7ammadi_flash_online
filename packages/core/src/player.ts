/**
 * Player motion, ported line-by-line from `data/player.py`.
 *
 * Everything is frame-rate independent by construction: the tick passes
 * `TICK_MS` and the math divides by `SPEED`, exactly like the reference. The
 * sub-pixel accumulators (`moveAccumX/Y`) are preserved verbatim because the
 * per-tick `int()` truncation is part of the trajectory.
 */

import {
  BIG_RADIUS,
  BANDI_TIME,
  D_HEIGHT,
  D_WIDTH,
  FAST_MODE,
  IN_ANGLE_A,
  IN_ANGLE_B,
  JUMP_MOVE_FACTOR,
  JUMPING_TIME,
  KNOCKBACK_TIME,
  NORMAL_MODE,
  NORMAL_RADIUS,
  PLAYFIELD_BOTTOM,
  PLAYFIELD_TOP,
  SLOW_MODE,
  SPEED,
  WAIT_MODE,
  iconMargin,
  type Mode,
} from "./constants";
import type { Rng } from "./rng";
import type { InputState, PlayerState, SlotIndex, Vec2 } from "./types";

const SLOT_SPAWN_ANGLES: Record<SlotIndex, number> = {
  0: 90,
  1: 270,
  2: 180,
  3: 0,
};

export type SpawnMode = "legacy" | "cross";

export interface SpawnPoint {
  x: number;
  y: number;
  angle: number;
}

/** Outward angles (degrees, y down) for the 2/3/4-player starting shapes. */
const SPAWN_ANGLES: Record<number, readonly number[]> = {
  1: [0],
  2: [180, 0],
  3: [270, 30, 150],
  4: [225, 315, 45, 135],
};

/**
 * Starting points around the middle: a 10% offset from the centre in each
 * direction, arranged as a line (2), Mercedes star (3) or cross (4).
 */
export function spawnPointsFor(count: number): SpawnPoint[] {
  const clamped = Math.max(1, Math.min(4, Math.trunc(count)));
  const angles = SPAWN_ANGLES[clamped] ?? SPAWN_ANGLES[4]!;
  const centerX = D_WIDTH / 2;
  const centerY = (PLAYFIELD_TOP + PLAYFIELD_BOTTOM) / 2;
  const radiusX = D_WIDTH * 0.1;
  const radiusY = (PLAYFIELD_BOTTOM - PLAYFIELD_TOP) * 0.1;
  return angles.map((angle) => {
    const rad = (angle * Math.PI) / 180;
    return {
      x: centerX + Math.cos(rad) * radiusX,
      y: centerY + Math.sin(rad) * radiusY,
      angle,
    };
  });
}

export function applySpawnPoint(player: PlayerState, point: SpawnPoint): void {
  player.x = point.x;
  player.y = point.y;
  player.angle = point.angle;
  clampToPlayfield(player);
}

export function createPlayer(
  slot: SlotIndex,
  palette: number,
  offset: 1 | 2 = 1,
): PlayerState {
  return {
    slot,
    x: (offset * D_WIDTH) / 3,
    y: D_HEIGHT / 2,
    angle: slot === 0 ? IN_ANGLE_A : IN_ANGLE_B,
    radius: NORMAL_RADIUS,
    mode: WAIT_MODE,
    palette,
    paintIndex: palette,
    jumping: false,
    jumpProgress: 0,
    beaten: false,
    brokenVisual: false,
    bandi: false,
    bandiTimeLeft: 0,
    powerup: null,
    moveAccumX: 0,
    moveAccumY: 0,
    wallCooldown: 0,
    wallEvent: null,
    squashing: false,
    squashElapsed: 0,
    squashDuration: 0.32,
    squashStrength: 1,
    punchContacted: false,
    jumpingToWall: false,
    collisionJumpTicks: 0,
    collisionBrokenTicks: 0,
    frozenTicks: 0,
    knockbackElapsed: 0,
    knockbackDuration: KNOCKBACK_TIME,
    knockbackStartY: D_HEIGHT / 2,
    knockbackTargetY: D_HEIGHT / 2,
    knockbackDirection: 0,
    knockbackPaused: false,
    score: 0,
  };
}

export function beginSquash(
  player: PlayerState,
  strength = 1,
  duration = 0.32,
): void {
  player.squashing = true;
  player.squashElapsed = 0;
  player.squashDuration = Math.max(0.01, duration);
  player.squashStrength = strength;
}

export function updateSquash(player: PlayerState, elapsedMs: number): void {
  if (!player.squashing) return;
  player.squashElapsed += Math.max(0, elapsedMs) / 1000;
  if (player.squashElapsed >= player.squashDuration) {
    player.squashing = false;
    player.squashElapsed = player.squashDuration;
  }
}

export function updatePowerup(player: PlayerState, elapsedMs: number): void {
  if (!player.bandi) return;
  player.bandiTimeLeft = Math.max(
    0,
    player.bandiTimeLeft - Math.max(0, elapsedMs) / 1000,
  );
  if (player.bandiTimeLeft <= 0) bandiToNormal(player);
}

export function updateJumpAnim(player: PlayerState, elapsedMs: number): void {
  if (!player.jumping) {
    player.jumpProgress = 0;
    return;
  }
  player.jumpProgress = Math.min(
    1,
    player.jumpProgress + Math.max(0, elapsedMs) / Math.max(0.001, JUMPING_TIME * 1000),
  );
}

export function clearPowerup(player: PlayerState): void {
  player.bandi = false;
  player.bandiTimeLeft = 0;
  player.radius = NORMAL_RADIUS;
  player.mode = NORMAL_MODE;
  player.brokenVisual = false;
  player.powerup = null;
}

export function restorePowerupMode(player: PlayerState): void {
  if (player.bandi || player.powerup === "speed") {
    player.mode = FAST_MODE;
  } else if (player.powerup === "fat") {
    player.mode = NORMAL_MODE;
  }
}

export function applyStaggerMode(player: PlayerState, fallback: Mode): void {
  if (player.bandi || player.powerup === "speed" || player.powerup === "fat") {
    restorePowerupMode(player);
  } else {
    player.mode = fallback;
  }
}

export function clearKnockback(player: PlayerState): void {
  player.jumpingToWall = false;
  player.knockbackElapsed = 0;
  player.knockbackDuration = KNOCKBACK_TIME;
  player.knockbackDirection = 0;
  const y = Number.isFinite(player.y) ? player.y : D_HEIGHT / 2;
  player.knockbackStartY = y;
  player.knockbackTargetY = y;
  player.knockbackPaused = false;
  player.wallEvent = null;
  player.wallCooldown = 0;
}

export function setupPlayer(
  player: PlayerState,
  palette: number,
  angle: number,
  offset: 1 | 2,
): void {
  player.palette = palette;
  player.paintIndex = palette;
  player.angle = angle;
  player.radius = NORMAL_RADIUS;
  player.bandi = false;
  player.beaten = false;
  player.jumping = false;
  clearKnockback(player);
  player.punchContacted = false;
  player.collisionJumpTicks = 0;
  player.collisionBrokenTicks = 0;
  player.frozenTicks = 0;
  player.x = (offset * D_WIDTH) / 3;
  player.y = D_HEIGHT / 2;
  player.mode = WAIT_MODE;
  player.squashing = false;
  player.squashElapsed = 0;
  player.squashStrength = 1;
  player.wallEvent = null;
  player.wallCooldown = 0;
  player.moveAccumX = 0;
  player.moveAccumY = 0;
  player.powerup = null;
  player.bandiTimeLeft = 0;
  player.jumpProgress = 0;
  player.brokenVisual = false;
  clampToPlayfield(player);
}

export function placePlayerAtSpawn(
  player: PlayerState,
  slot: SlotIndex,
  mode: SpawnMode = "legacy",
): void {
  const margin = iconMargin(player.radius);
  const midY = (PLAYFIELD_TOP + PLAYFIELD_BOTTOM) / 2;
  if (mode === "legacy" && (slot === 0 || slot === 1)) {
    player.x = ((slot === 1 ? 2 : 1) * D_WIDTH) / 3;
    player.y = D_HEIGHT / 2;
    player.angle = slot === 0 ? IN_ANGLE_A : IN_ANGLE_B;
  } else {
    switch (slot) {
      case 0:
        player.x = D_WIDTH / 2;
        player.y = PLAYFIELD_TOP + margin;
        break;
      case 1:
        player.x = D_WIDTH / 2;
        player.y = PLAYFIELD_BOTTOM - margin;
        break;
      case 2:
        player.x = D_WIDTH - margin;
        player.y = midY;
        break;
      default:
        player.x = margin;
        player.y = midY;
        break;
    }
    player.angle = SLOT_SPAWN_ANGLES[slot];
  }
  clampToPlayfield(player);
}

export function clampToPlayfield(player: PlayerState): void {
  const margin = iconMargin(player.radius);
  player.x = Math.max(margin, Math.min(D_WIDTH - margin, Math.trunc(player.x)));
  player.y = Math.max(
    PLAYFIELD_TOP + margin,
    Math.min(PLAYFIELD_BOTTOM - margin, Math.trunc(player.y)),
  );
}

export function startKnockback(player: PlayerState): void {
  if (player.jumpingToWall) return;
  clampToPlayfield(player);
  const midpoint = (PLAYFIELD_TOP + PLAYFIELD_BOTTOM) / 2;
  const direction = player.y < midpoint ? -1 : 1;
  const marginY = iconMargin(player.radius);
  const targetY =
    direction < 0 ? PLAYFIELD_TOP + marginY : PLAYFIELD_BOTTOM - marginY;

  player.jumpingToWall = true;
  player.knockbackDirection = direction;
  player.knockbackStartY = player.y;
  player.knockbackTargetY = targetY;
  player.knockbackElapsed = 0;
  player.knockbackDuration = KNOCKBACK_TIME;
  player.knockbackPaused = false;
}

export function pauseKnockback(player: PlayerState): void {
  if (player.jumpingToWall) player.knockbackPaused = true;
}

export function resumeKnockback(player: PlayerState): void {
  if (player.jumpingToWall) player.knockbackPaused = false;
}

/**
 * `Player.change_angle`. The reference checks the "positive" key first and
 * ignores the negative one when both are held; inputs keep that precedence.
 */
export function changeAngle(
  player: PlayerState,
  input: InputState,
  elapsedMs = 0,
): void {
  const factor = Math.max(0, elapsedMs) / SPEED;
  if (input.right) {
    player.angle += player.mode.angle * factor;
  } else if (input.left) {
    player.angle -= player.mode.angle * factor;
  }
}

/** `Player.change_coor`, including knockback and wall/mode restoration. */
export function changeCoor(player: PlayerState, elapsedMs = 0): void {
  player.wallCooldown = Math.max(
    0,
    player.wallCooldown - Math.max(0, elapsedMs) / 1000,
  );

  // Clock freeze: steering still runs through `changeAngle`, but the brush
  // cannot move (and cannot be knocked back) until the timer expires.
  if (player.frozenTicks > 0) return;

  if (player.jumpingToWall) {
    if (player.knockbackPaused) return;
    const durationMs = Math.max(0.001, player.knockbackDuration) * 1000;
    player.knockbackElapsed = Math.min(
      durationMs,
      player.knockbackElapsed + Math.max(0, elapsedMs),
    );
    const progress = player.knockbackElapsed / durationMs;
    player.y =
      player.knockbackStartY +
      (player.knockbackTargetY - player.knockbackStartY) * progress;
    if (progress >= 1) {
      player.y = player.knockbackTargetY;
      player.jumpingToWall = false;
      player.knockbackElapsed = durationMs;
      player.wallEvent = {
        x: player.x,
        y: player.knockbackDirection < 0 ? 0 : PLAYFIELD_BOTTOM,
      };
      player.knockbackDirection = 0;
      player.beaten = false;
      if (player.bandi || player.powerup === "speed" || player.powerup === "fat") {
        restorePowerupMode(player);
      } else {
        player.mode = NORMAL_MODE;
      }
      player.moveAccumX = 0;
      player.moveAccumY = 0;
    }
    clampToPlayfield(player);
    return;
  }

  const rad = (player.angle * Math.PI) / 180;
  let px = Math.cos(rad);
  let py = Math.sin(rad);
  const margin = iconMargin(player.radius);
  let hitSide: "top" | "bottom" | "left" | "right" | null = null;

  if (player.y <= PLAYFIELD_TOP + margin && py < 0) {
    py = 0;
    hitSide = "top";
  } else if (player.y >= PLAYFIELD_BOTTOM - margin && py > 0) {
    py = 0;
    hitSide = "bottom";
  }
  if (player.x <= margin && px < 0) {
    px = 0;
    hitSide = "left";
  } else if (player.x >= D_WIDTH - margin && px > 0) {
    px = 0;
    hitSide = "right";
  }

  let factor = Math.max(0, elapsedMs) / SPEED;
  if (player.jumping) factor *= JUMP_MOVE_FACTOR;

  player.moveAccumX += px * player.mode.step * factor;
  player.moveAccumY += py * player.mode.step * factor;
  const dx = Math.trunc(player.moveAccumX);
  const dy = Math.trunc(player.moveAccumY);
  player.moveAccumX -= dx;
  player.moveAccumY -= dy;
  player.x += dx;
  player.y += dy;
  clampToPlayfield(player);

  if (hitSide !== null && player.wallCooldown <= 0) {
    const event: Vec2 =
      hitSide === "top"
        ? { x: player.x, y: PLAYFIELD_TOP }
        : hitSide === "bottom"
          ? { x: player.x, y: PLAYFIELD_BOTTOM }
          : hitSide === "left"
            ? { x: 0, y: player.y }
            : { x: D_WIDTH, y: player.y };
    player.wallEvent = event;
    player.wallCooldown = 0.5;
  }

  if (hitSide !== null && (player.bandi || player.powerup === "speed" || player.powerup === "fat")) {
    restorePowerupMode(player);
  }
}

/** `Player.jump` — quadrant based random angle ranges, server RNG. */
export function jump(player: PlayerState, rng: Rng): void {
  player.angle = 0;
  player.jumpProgress = 0;
  const w12 = Math.floor(D_WIDTH / 5);
  const w34 = 4 * w12;
  const playHeight = PLAYFIELD_BOTTOM - PLAYFIELD_TOP;
  const h13 = PLAYFIELD_TOP + Math.floor(playHeight / 5);
  const h24 = PLAYFIELD_BOTTOM - Math.floor(playHeight / 5);

  if (player.x >= 0 && player.x < w12 && player.y >= PLAYFIELD_TOP && player.y < h13) {
    player.angle = rng.int(-20, 110);
  } else if (player.x >= w34 && player.x < D_WIDTH && player.y >= PLAYFIELD_TOP && player.y < h13) {
    player.angle = rng.int(70, 200);
  } else if (player.x >= w34 && player.x < D_WIDTH && player.y >= h24 && player.y < D_HEIGHT) {
    player.angle = rng.int(160, 290);
  } else if (player.x >= 0 && player.x < w12 && player.y >= h24 && player.y < D_HEIGHT) {
    player.angle = rng.int(250, 380);
  } else {
    player.angle = rng.int(0, 360);
  }
}

export function bandiToNormal(player: PlayerState): void {
  player.bandi = false;
  player.bandiTimeLeft = 0;
  player.mode = NORMAL_MODE;
  player.radius = NORMAL_RADIUS;
  if (player.powerup === "bandi") player.powerup = null;
}

export function beatenToNormal(player: PlayerState): void {
  player.beaten = false;
  player.mode = NORMAL_MODE;
  player.brokenVisual = false;
}

/** Helper used by prizes that set a radius/mode directly. */
export function applyBigBandi(player: PlayerState): void {
  player.bandi = true;
  player.bandiTimeLeft = BANDI_TIME;
  player.brokenVisual = false;
  player.mode = FAST_MODE;
  player.radius = BIG_RADIUS;
  player.powerup = "bandi";
}
