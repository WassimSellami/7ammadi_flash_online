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
 *  - bandi: hunt every opponent in turn, starting with the closest, then the
 *    closest of the remaining ones (knocked-down players count as handled and
 *    teammates are never chased, though a collision with one still counts);
 *  - colorless (potion victim): up to two bots chase the potion user, the rest
 *    chase the nearest other colorless bot; a bot never chases the bot that
 *    just caught it, and a collision immediately retargets the caught bot;
 *  - everybody else plays normally (prizes, then roaming);
 *  - walls: reflect an outward heading back into the playfield early enough
 *    for the limited turn rate to avoid sliding along a border.
 */

import {
  D_WIDTH,
  NO_PAINT,
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
/** Boundary tolerance used to detect the bot being pinned in a corner. */
const BOT_CORNER_EPSILON = 2;

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

  // A bot pinned in a corner can steer between two walls forever: both
  // components get clamped and the reflected headings keep cancelling out.
  // Escape by heading for the middle of the playfield until it is clear.
  const atLeft = player.x <= margin + BOT_CORNER_EPSILON;
  const atRight = player.x >= D_WIDTH - margin - BOT_CORNER_EPSILON;
  const atTop = player.y <= PLAYFIELD_TOP + margin + BOT_CORNER_EPSILON;
  const atBottom = player.y >= PLAYFIELD_BOTTOM - margin - BOT_CORNER_EPSILON;
  if ((atLeft || atRight) && (atTop || atBottom)) {
    const centerX = D_WIDTH / 2;
    const centerY = (PLAYFIELD_TOP + PLAYFIELD_BOTTOM) / 2;
    return (Math.atan2(centerY - player.y, centerX - player.x) * 180) / Math.PI;
  }

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

/** Teammates are never bandi targets, though a brush collision still counts. */
function teammateSlots(sim: SimState, player: PlayerState): SlotIndex[] {
  if (!sim.teams) return [];
  const roster = sim.teams.find((team) => team.includes(player.slot));
  if (!roster) return [];
  return roster.filter((slot) => slot !== player.slot) as SlotIndex[];
}

function chaseExclusions(
  handled: readonly SlotIndex[],
  mates: readonly SlotIndex[],
): SlotIndex[] {
  return [...handled, ...mates];
}

function nearestOpponent(
  sim: SimState,
  player: PlayerState,
  exclude?: readonly SlotIndex[],
  mates: readonly SlotIndex[] = teammateSlots(sim, player),
): PlayerState | null {
  let best: PlayerState | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const slot of sim.activeSlots) {
    const other = sim.players[slot]!;
    if (other.slot === player.slot) continue;
    if (mates.includes(other.slot)) continue;
    if (exclude?.includes(other.slot)) continue;
    const distance = (other.x - player.x) ** 2 + (other.y - player.y) ** 2;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = other;
    }
  }
  return best;
}

/**
 * Per-bot bandi chase bookkeeping: opponents already knocked down during the
 * current bandi are skipped, so the bot sweeps the closest target, then the
 * closest of the remaining ones instead of camping the same brush.
 */
export interface BotChaseState {
  active: boolean;
  handled: SlotIndex[];
  target: SlotIndex | null;
  /** True while the bot is running the colorless (potion victim) chase. */
  colorless: boolean;
  /** The bot that just caught this one; never chased while colorless. */
  caughtBy: SlotIndex | null;
  /** Sticky colorless target, kept even after it regains its colour. */
  colorlessTarget: SlotIndex | null;
}

export function createBotChaseState(): BotChaseState {
  return {
    active: false,
    handled: [],
    target: null,
    colorless: false,
    caughtBy: null,
    colorlessTarget: null,
  };
}

function isColorless(player: PlayerState): boolean {
  return player.paintIndex === NO_PAINT;
}

/** Active colorless slots among the bot slots, in stable slot order. */
function colorlessSlots(sim: SimState, botSlots: readonly SlotIndex[]): SlotIndex[] {
  return botSlots.filter((slot) => {
    const other = sim.players[slot];
    return other !== undefined && sim.activeSlots.includes(slot) && isColorless(other);
  });
}

function nearestPlayer(
  player: PlayerState,
  candidates: readonly PlayerState[],
): PlayerState | null {
  let best: PlayerState | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const other of candidates) {
    const distance = (other.x - player.x) ** 2 + (other.y - player.y) ** 2;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = other;
    }
  }
  return best;
}

/** Nearest active teammate currently frozen by the clock prize. */
function frozenTeammate(
  sim: SimState,
  player: PlayerState,
  mates: readonly SlotIndex[],
): PlayerState | null {
  const frozen: PlayerState[] = [];
  for (const slot of mates) {
    if (!sim.activeSlots.includes(slot)) continue;
    const mate = sim.players[slot];
    if (mate && mate.frozenTicks > 0) frozen.push(mate);
  }
  return nearestPlayer(player, frozen);
}

/** Nearest active player currently holding the potion powerup. */
function nearestPotionUser(
  sim: SimState,
  player: PlayerState,
  exclude: SlotIndex | null,
): PlayerState | null {
  const users: PlayerState[] = [];
  for (const slot of sim.activeSlots) {
    if (slot === player.slot || slot === exclude) continue;
    const other = sim.players[slot]!;
    if (other.powerup === "potion") users.push(other);
  }
  return nearestPlayer(player, users);
}

/** Another colorless bot touching this one just caught it. */
function touchingColorlessBot(
  sim: SimState,
  player: PlayerState,
  botSlots: readonly SlotIndex[],
): SlotIndex | null {
  for (const slot of colorlessSlots(sim, botSlots)) {
    if (slot === player.slot) continue;
    const other = sim.players[slot]!;
    const dx = other.x - player.x;
    const dy = other.y - player.y;
    const reach = other.radius + player.radius;
    if (dx * dx + dy * dy <= reach * reach) return slot;
  }
  return null;
}

/**
 * Colorless target: the first two colorless bots chase the potion user; any
 * remaining ones chase the nearest other colorless bot. The bot that caught
 * this one is never targeted.
 */
function colorlessTarget(
  sim: SimState,
  player: PlayerState,
  chase: BotChaseState | undefined,
  botSlots: readonly SlotIndex[],
): PlayerState | null {
  const caughtBy = chase?.caughtBy ?? null;

  // Keep chasing the previous target even if it already regained its colour:
  // once a colorless bot commits to a chase, it must not give up mid-way.
  if (chase && chase.colorlessTarget !== null) {
    const kept = sim.players[chase.colorlessTarget];
    if (
      kept &&
      kept.slot !== player.slot &&
      kept.slot !== caughtBy &&
      sim.activeSlots.includes(kept.slot)
    ) {
      return kept;
    }
    chase.colorlessTarget = null;
  }

  const colorless = colorlessSlots(sim, botSlots);
  const rank = colorless.indexOf(player.slot);
  let target: PlayerState | null = null;
  if (rank >= 0 && rank < 2) {
    target = nearestPotionUser(sim, player, caughtBy);
  }
  if (!target) {
    const others: PlayerState[] = [];
    for (const slot of colorless) {
      if (slot === player.slot || slot === caughtBy) continue;
      others.push(sim.players[slot]!);
    }
    target = nearestPlayer(player, others);
  }
  if (chase) chase.colorlessTarget = target ? target.slot : null;
  return target;
}

function bandiTarget(
  sim: SimState,
  player: PlayerState,
  chase: BotChaseState,
  mates: readonly SlotIndex[],
): PlayerState | null {
  if (!chase.active) {
    chase.active = true;
    chase.handled.length = 0;
    chase.target = null;
  }
  if (chase.target !== null) {
    const current = sim.players[chase.target];
    if (
      !current ||
      !sim.activeSlots.includes(current.slot) ||
      current.slot === player.slot ||
      mates.includes(current.slot) ||
      current.jumpingToWall ||
      current.brokenVisual
    ) {
      chase.handled.push(chase.target);
      chase.target = null;
    }
  }
  if (chase.target === null) {
    let next = nearestOpponent(sim, player, chaseExclusions(chase.handled, mates), mates);
    while (next && (next.jumpingToWall || next.brokenVisual)) {
      chase.handled.push(next.slot);
      next = nearestOpponent(sim, player, chaseExclusions(chase.handled, mates), mates);
    }
    if (next) {
      chase.target = next.slot;
    } else if (chase.handled.length > 0) {
      // Every opponent was handled or is still down: start another sweep
      // from the closest brush that is back on its feet.
      chase.handled.length = 0;
      let restart = nearestOpponent(sim, player, chaseExclusions([], mates), mates);
      while (restart && (restart.jumpingToWall || restart.brokenVisual)) {
        chase.handled.push(restart.slot);
        restart = nearestOpponent(sim, player, chaseExclusions(chase.handled, mates), mates);
      }
      if (restart) {
        chase.target = restart.slot;
      } else {
        // Nobody is available; roam instead of hovering over a downed brush.
        chase.handled.length = 0;
        chase.target = null;
      }
    }
  }
  return chase.target === null ? null : (sim.players[chase.target] ?? null);
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
 * Bots do not pounce on a fresh prize instantly: the n-th active bot waits
 * 1 s, 1.5 s, 2 s, ... before it starts steering toward it.
 */
function prizeReactionReady(
  sim: SimState,
  slot: SlotIndex,
  botSlots: readonly SlotIndex[],
): boolean {
  const activeBots = botSlots.filter((candidate) => sim.activeSlots.includes(candidate));
  const rank = Math.max(0, activeBots.indexOf(slot));
  return sim.prize.ageMs >= (rank + 2) * 500;
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
  chase?: BotChaseState,
  excludeSlots: readonly SlotIndex[] = [],
  botSlots: readonly SlotIndex[] = sim.activeSlots as readonly SlotIndex[],
): InputState {
  if (sim.phase !== "playing") return NEUTRAL_INPUT;
  const player = sim.players[slot];
  if (!player || player.jumpingToWall) return NEUTRAL_INPUT;
  const mates = [...new Set([...teammateSlots(sim, player), ...excludeSlots])];

  if (!player.bandi && chase) {
    chase.active = false;
    chase.handled.length = 0;
    chase.target = null;
  }

  const colorless = isColorless(player);
  if (chase) {
    if (!colorless) {
      chase.colorless = false;
      chase.caughtBy = null;
      chase.colorlessTarget = null;
    } else if (!chase.colorless) {
      chase.colorless = true;
      chase.caughtBy = null;
      chase.colorlessTarget = null;
      chase.target = null;
    } else {
      // Touching another colorless bot means it just caught this one.
      const catcher = touchingColorlessBot(sim, player, botSlots);
      if (catcher !== null) {
        chase.caughtBy = catcher;
        chase.colorlessTarget = null;
        chase.target = null;
      }
    }
  }

  let desired: number;
  let wide = false;
  // Team play first: rush the nearest frozen teammate so the contact frees them.
  const rescue = player.frozenTicks > 0 ? null : frozenTeammate(sim, player, mates);
  if (rescue) {
    desired = angleTo(player, rescue.x, rescue.y);
  } else if (colorless) {
    const target = colorlessTarget(sim, player, chase, botSlots);
    if (chase) chase.target = target ? target.slot : null;
    if (target) {
      desired = angleTo(player, target.x, target.y);
    } else {
      desired = roamAngle(sim, slot, baseAngle);
      wide = true;
    }
  } else if (player.bandi) {
    const target = chase
      ? bandiTarget(sim, player, chase, mates)
      : nearestOpponent(sim, player, undefined, mates);
    if (target) {
      desired = angleTo(player, target.x, target.y);
    } else if (sim.prize.active && prizeReactionReady(sim, slot, botSlots)) {
      desired = angleTo(player, sim.prize.x, sim.prize.y);
    } else {
      desired = roamAngle(sim, slot, baseAngle);
    }
  } else if (sim.prize.active && prizeReactionReady(sim, slot, botSlots)) {
    desired = angleTo(player, sim.prize.x, sim.prize.y);
  } else {
    desired = roamAngle(sim, slot, baseAngle);
    wide = true;
  }

  return steer(player, avoidWalls(player, desired, wide));
}
