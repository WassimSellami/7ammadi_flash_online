/**
 * Collision rules, generalized to every active slot.
 *
 * Two-player behaviour is preserved: the pair loop visits (A, B) first, and
 * the same jump/broken timers still drive the whole arena.
 */

import {
  BROKEN_TICKS,
  JUMPING_TICKS,
  NORMAL_RADIUS,
  NORMAL_MODE,
  PLAYFIELD_BOTTOM,
  PLAYFIELD_TOP,
  SLOW_MODE,
} from "./constants";
import {
  applyStaggerMode,
  beginSquash,
  clampToPlayfield,
  clearPowerup,
  jump,
  startKnockback,
} from "./player";
import type { GameEvent, PlayerState, SimState } from "./types";

function activePlayers(sim: SimState): PlayerState[] {
  return sim.activeSlots.map((slot) => sim.players[slot]!);
}

/**
 * `follow_me` only ends for the brushes that actually collide. Victims that
 * stayed clear keep the winner's colour until their own collision.
 */
function restoreTrueColors(...players: PlayerState[]): void {
  for (const player of players) player.paintIndex = player.palette;
}

function armPlayerCollision(player: PlayerState): void {
  player.collisionJumpTicks = JUMPING_TICKS;
  player.collisionBrokenTicks = BROKEN_TICKS;
}

export interface Circle {
  x: number;
  y: number;
  radius: number;
}

/** `Game.tangent`. */
export function tangent(a: Circle, b: Circle): boolean {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy <= (a.radius + b.radius) ** 2;
}

/** `Game.set_to_normal`. */
export function setToNormal(player: PlayerState): void {
  player.radius = NORMAL_RADIUS;
  player.paintIndex = player.palette;
  player.mode = NORMAL_MODE;
  player.bandi = false;
  player.bandiTimeLeft = 0;
  player.powerup = null;
  player.brokenVisual = false;
  clampToPlayfield(player);
}

/** `Game.bandi_reward`. */
export function bandiReward(
  sim: SimState,
  attacker: PlayerState,
  victim: PlayerState,
  tick: number,
  events: GameEvent[],
): void {
  victim.beaten = false;
  victim.brokenVisual = false;
  if (victim.bandi || victim.powerup === "speed" || victim.powerup === "fat") {
    clearPowerup(victim);
  } else {
    victim.mode = NORMAL_MODE;
  }
  events.push({
    tick,
    type: "punch",
    // The reference draws the punch effect in the attacker's colour.
    slot: attacker.slot,
    x: (attacker.x + victim.x) / 2,
    y: (attacker.y + victim.y) / 2,
  });
  restoreTrueColors(attacker, victim);
  startKnockback(victim);
}

/** `Game._start_normal_collision`. Returns true when a collision started. */
export function startNormalCollision(
  sim: SimState,
  p1: PlayerState,
  p2: PlayerState,
  events: GameEvent[],
): boolean {
  if (p1.jumping || p2.jumping) return false;
  sim.collisionActive = true;
  p1.jumping = true;
  p2.jumping = true;
  armPlayerCollision(p1);
  armPlayerCollision(p2);
  setToNormal(p1);
  setToNormal(p2);
  restoreTrueColors(p1, p2);
  jump(p1, sim.rng);
  jump(p2, sim.rng);
  beginSquash(p1, 1);
  beginSquash(p2, 1);
  events.push({
    tick: sim.tick,
    type: "smash",
    x: (p1.x + p2.x) / 2,
    y: (p1.y + p2.y) / 2,
  });
  return true;
}

/**
 * `Game.collision_check`. Returns true when a *new* normal collision started,
 * which is what arms the jump and broken timers.
 */
export function collisionCheck(sim: SimState, events: GameEvent[]): boolean {
  const players = activePlayers(sim);
  let started = false;
  const touching = new Set<number>();

  for (let i = 0; i < players.length; i += 1) {
    const p1 = players[i]!;
    for (let j = i + 1; j < players.length; j += 1) {
      const p2 = players[j]!;
      if (!tangent(p1, p2)) continue;
      touching.add(p1.slot);
      touching.add(p2.slot);

      if (p1.bandi && p2.bandi) {
        started = startNormalCollision(sim, p1, p2, events) || started;
        continue;
      }
      if (p1.bandi || p2.bandi) {
        const attacker = p1.bandi ? p1 : p2;
        const victim = p1.bandi ? p2 : p1;
        if (!victim.jumpingToWall && !victim.punchContacted) {
          victim.punchContacted = true;
          bandiReward(sim, attacker, victim, sim.tick, events);
        }
        continue;
      }
      started = startNormalCollision(sim, p1, p2, events) || started;
    }
  }

  for (const player of players) {
    if (!touching.has(player.slot)) player.punchContacted = false;
  }
  return started;
}

/**
 * Tick version of the per-player `jump_timer` / `broken_timer` handling.
 * Only players that actually collided enter jumping/broken mode.
 */
export function updateCollisionTimers(sim: SimState): void {
  const players = activePlayers(sim);
  let maxJump = 0;
  let maxBroken = 0;

  for (const player of players) {
    if (player.collisionJumpTicks > 0) {
      if (!player.jumping) {
        player.collisionJumpTicks = 0;
      } else {
        player.collisionJumpTicks -= 1;
        if (player.collisionJumpTicks <= 0) {
          player.collisionJumpTicks = 0;
          player.jumping = false;
          player.brokenVisual = true;
          applyStaggerMode(player, SLOW_MODE);
        }
      }
    }

    if (player.collisionBrokenTicks > 0) {
      player.collisionBrokenTicks -= 1;
      if (player.collisionBrokenTicks <= 0) {
        player.collisionBrokenTicks = 0;
        player.jumping = false;
        player.brokenVisual = false;
        applyStaggerMode(player, NORMAL_MODE);
      }
    }

    maxJump = Math.max(maxJump, player.collisionJumpTicks);
    maxBroken = Math.max(maxBroken, player.collisionBrokenTicks);
  }

  sim.jumpTicksLeft = maxJump;
  sim.brokenTicksLeft = maxBroken;
  sim.collisionActive = players.some(
    (player) =>
      player.collisionJumpTicks > 0 || player.collisionBrokenTicks > 0,
  );
}

/** Arms the timers exactly like `jump_timer.start()` + `broken_timer.start()`. */
export function armCollisionTimers(sim: SimState): void {
  let maxJump = 0;
  let maxBroken = 0;
  for (const player of activePlayers(sim)) {
    if (!player.jumping) continue;
    armPlayerCollision(player);
    maxJump = Math.max(maxJump, player.collisionJumpTicks);
    maxBroken = Math.max(maxBroken, player.collisionBrokenTicks);
  }
  sim.jumpTicksLeft = maxJump;
  sim.brokenTicksLeft = maxBroken;
}

export const PLAYFIELD_BOUNDS = {
  top: PLAYFIELD_TOP,
  bottom: PLAYFIELD_BOTTOM,
};
