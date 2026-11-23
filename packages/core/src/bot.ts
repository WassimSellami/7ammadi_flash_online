/**
 * Bot brain for the empty room slots.
 *
 * Pure and deterministic: it only reads the authoritative simulation and a
 * per-slot base heading captured at round start, so the Node room, the
 * Cloudflare Durable Object and any replay produce the same steering.
 *
 * Behaviour:
 *  - roam: sweep the heading between +35° and -35° around the base heading,
 *    one full there-and-back per second;
 *  - prize: aim straight at the active prize (no sweep offset);
 *  - follow_me holder: keep its colours by fleeing every other brush;
 *  - bandi: charge the nearest opponent;
 *  - everybody else plays normally (prizes, then roaming);
 *  - walls: reflect an outward heading back into the playfield early enough
 *    for the limited turn rate to avoid sliding along a border.
 */

import {
  D_WIDTH,
  PLAYFIELD_BOTTOM,
  PLAYFIELD_TOP,
  iconMargin,
} from "./constants";
import {
  NEUTRAL_INPUT,
  type InputState,
  type PlayerState,
  type SimState,
  type SlotIndex,
} from "./types";

export const BOT_SWEEP_DEGREES = 35;
/** Full +35 → -35 → +35 sweep takes one second (60 ticks). */
export const BOT_SWEEP_PERIOD_TICKS = 60;
/** Below this heading error the bot stops correcting, so it runs straight. */
export const BOT_TURN_DEADBAND = 2.5;
/** How far from a border the bot starts turning back in. */
export const BOT_WALL_MARGIN = 0;

const LEFT: InputState = { left: true, right: false };
const RIGHT: InputState = { left: false, right: true };

function angleTo(from: PlayerState, x: number, y: number): number {
  return (Math.atan2(y - from.y, x - from.x) * 180) / Math.PI;
}

function normalizeDelta(degrees: number): number {
  return ((degrees + 540) % 360) - 180;
}

/** Steer with the same inputs a human would send: `right` increases the angle. */
function steer(player: PlayerState, desired: number): InputState {
  const delta = normalizeDelta(desired - player.angle);
  if (Math.abs(delta) <= BOT_TURN_DEADBAND) return NEUTRAL_INPUT;
  return delta > 0 ? RIGHT : LEFT;
}

/**
 * Turn a desired heading away from any border the bot is hugging. Roaming uses
 * a wide cone so the sweep never grinds a border; prize/chase targets only
 * reflect when they actually point outside (a prize can sit near a wall).
 */
function avoidWalls(player: PlayerState, desired: number, wide: boolean): number {
  const margin = iconMargin(player.radius) + BOT_WALL_MARGIN;
  const edge = wide ? 0.3 : 0;
  const rad = (desired * Math.PI) / 180;
  let vx = Math.cos(rad);
  let vy = Math.sin(rad);
  let bounced = false;

  if (player.x <= margin && vx < edge) {
    vx = Math.max(0.6, Math.abs(vx));
    bounced = true;
  } else if (player.x >= D_WIDTH - margin && vx > -edge) {
    vx = -Math.max(0.6, Math.abs(vx));
    bounced = true;
  }
  if (player.y <= PLAYFIELD_TOP + margin && vy < edge) {
    vy = Math.max(0.6, Math.abs(vy));
    bounced = true;
  } else if (player.y >= PLAYFIELD_BOTTOM - margin && vy > -edge) {
    vy = -Math.max(0.6, Math.abs(vy));
    bounced = true;
  }

  if (!bounced) return desired;
  return (Math.atan2(vy, vx) * 180) / Math.PI;
}

/**
 * The follow_me holder is the only brush whose palette matches its own paint
 * while somebody else is painted in that same colour. It wants the effect to
 * last, so it runs away instead of chasing.
 */
function isFollowMeHolder(sim: SimState, player: PlayerState): boolean {
  if (player.paintIndex !== player.palette) return false;
  return sim.activeSlots.some((slot) => {
    const other = sim.players[slot]!;
    return (
      other.slot !== player.slot &&
      other.palette !== player.palette &&
      other.paintIndex === player.palette
    );
  });
}

function nearestOpponent(sim: SimState, player: PlayerState): PlayerState | null {
  let best: PlayerState | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const slot of sim.activeSlots) {
    const other = sim.players[slot]!;
    if (other.slot === player.slot) continue;
    const distance = (other.x - player.x) ** 2 + (other.y - player.y) ** 2;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = other;
    }
  }
  return best;
}

/**
 * Heading that runs away from every other brush, weighted by distance so the
 * nearest threat dominates. The follow_me holder uses this to stay unpainted
 * and keep everyone else in its colour.
 */
function fleeAngle(sim: SimState, player: PlayerState): number {
  let vx = 0;
  let vy = 0;
  for (const slot of sim.activeSlots) {
    const other = sim.players[slot]!;
    if (other.slot === player.slot) continue;
    const dx = player.x - other.x;
    const dy = player.y - other.y;
    const distanceSq = Math.max(1, dx * dx + dy * dy);
    vx += dx / distanceSq;
    vy += dy / distanceSq;
  }
  if (vx === 0 && vy === 0) {
    const centerX = D_WIDTH / 2;
    const centerY = (PLAYFIELD_TOP + PLAYFIELD_BOTTOM) / 2;
    return angleTo(player, centerX, centerY);
  }
  return (Math.atan2(vy, vx) * 180) / Math.PI;
}

function sweepOffset(sim: SimState, slot: SlotIndex): number {
  const period = BOT_SWEEP_PERIOD_TICKS;
  const t = ((sim.tick + slot * 15) % period) / period;
  // Triangle wave: 0 → +1 (t=0.25) → 0 (t=0.5) → -1 (t=0.75) → 0.
  const triangle = t < 0.25 ? t * 4 : t < 0.75 ? 2 - t * 4 : t * 4 - 4;
  return triangle * BOT_SWEEP_DEGREES;
}

function roamAngle(sim: SimState, slot: SlotIndex, baseAngle: number): number {
  return baseAngle + sweepOffset(sim, slot);
}

/**
 * Deterministic per-match roaming heading that does not depend on the spawn
 * direction, so bots do not keep patrolling along the axis they started on.
 */
export function randomBotHeading(seed: number, slot: SlotIndex): number {
  let h = (seed ^ Math.imul(slot + 1, 0x9e3779b9)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return h % 360;
}

/**
 * Mirror the roaming base heading when the bot presses into a border, so a
 * wall turns the patrol around instead of parking the sweep against it.
 * Returns the (possibly) new base heading; call it once per tick.
 */
export function reflectBotHeading(player: PlayerState, baseAngle: number): number {
  const margin = iconMargin(player.radius) + BOT_WALL_MARGIN;
  const rad = (baseAngle * Math.PI) / 180;
  let vx = Math.cos(rad);
  let vy = Math.sin(rad);
  let bounced = false;

  if (player.x <= margin && vx < 0) {
    vx = -vx;
    bounced = true;
  } else if (player.x >= D_WIDTH - margin && vx > 0) {
    vx = -vx;
    bounced = true;
  }
  if (player.y <= PLAYFIELD_TOP + margin && vy < 0) {
    vy = -vy;
    bounced = true;
  } else if (player.y >= PLAYFIELD_BOTTOM - margin && vy > 0) {
    vy = -vy;
    bounced = true;
  }

  if (!bounced) return baseAngle;
  return (Math.atan2(vy, vx) * 180) / Math.PI;
}

/**
 * Input for one bot slot at the current simulation tick. `baseAngle` is the
 * bot's roaming heading for this round (captured inward at spawn, then mirrored
 * by `reflectBotHeading` at the borders).
 */
export function botInput(
  sim: SimState,
  slot: SlotIndex,
  baseAngle: number,
): InputState {
  if (sim.phase !== "playing") return NEUTRAL_INPUT;
  const player = sim.players[slot];
  if (!player || player.jumpingToWall) return NEUTRAL_INPUT;

  let desired: number;
  let wide = false;
  if (isFollowMeHolder(sim, player)) {
    // The holder keeps its colours by running away from every other brush.
    desired = fleeAngle(sim, player);
  } else if (player.bandi) {
    const target = nearestOpponent(sim, player);
    if (target) {
      desired = angleTo(player, target.x, target.y);
    } else if (sim.prize.active) {
      desired = angleTo(player, sim.prize.x, sim.prize.y);
    } else {
      desired = roamAngle(sim, slot, baseAngle);
    }
  } else if (sim.prize.active) {
    desired = angleTo(player, sim.prize.x, sim.prize.y);
  } else {
    desired = roamAngle(sim, slot, baseAngle);
    wide = true;
  }

  return steer(player, avoidWalls(player, desired, wide));
}
