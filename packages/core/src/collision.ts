/**
 * Collision rules, ported from `data/game.py` and the `collision()` helper in
 * `main.py`.
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
  attacker: PlayerState,
  victim: PlayerState,
  tick: number,
  events: GameEvent[],
): void {
  attacker.paintIndex = attacker.palette;
  victim.paintIndex = victim.palette;
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
    slot: victim.slot,
    x: (attacker.x + victim.x) / 2,
    y: (attacker.y + victim.y) / 2,
  });
  startKnockback(victim);
}

/** `Game._start_normal_collision`. Returns true when a collision started. */
export function startNormalCollision(sim: SimState, events: GameEvent[]): boolean {
  const [p1, p2] = sim.players;
  if (p1.jumping) return false;
  sim.collisionActive = true;
  p1.jumping = true;
  p2.jumping = true;
  setToNormal(p1);
  setToNormal(p2);
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
 * which is what arms the jump and broken timers in `main.py::collision`.
 */
export function collisionCheck(sim: SimState, events: GameEvent[]): boolean {
  const [p1, p2] = sim.players;
  if (tangent(p1, p2)) {
    if (p1.bandi && p2.bandi) {
      return startNormalCollision(sim, events);
    }
    if (p1.bandi || p2.bandi) {
      const attacker = p1.bandi ? p1 : p2;
      const victim = p1.bandi ? p2 : p1;
      if (!victim.jumpingToWall && !victim.punchContacted) {
        victim.punchContacted = true;
        bandiReward(attacker, victim, sim.tick, events);
      }
      return false;
    }
    return startNormalCollision(sim, events);
  }
  p1.punchContacted = false;
  p2.punchContacted = false;
  return false;
}

/**
 * Tick version of the `jump_timer` / `broken_timer` handling in
 * `main.py::collision`.
 */
export function updateCollisionTimers(sim: SimState): void {
  const [p1, p2] = sim.players;

  if (sim.jumpTicksLeft > 0 && (p1.jumping || p2.jumping)) {
    sim.jumpTicksLeft -= 1;
    if (sim.jumpTicksLeft <= 0) {
      sim.jumpTicksLeft = 0;
      p1.jumping = false;
      p2.jumping = false;
      p1.brokenVisual = true;
      p2.brokenVisual = true;
      applyStaggerMode(p1, SLOW_MODE);
      applyStaggerMode(p2, SLOW_MODE);
    }
  }

  if (sim.brokenTicksLeft > 0) {
    sim.brokenTicksLeft -= 1;
    if (sim.brokenTicksLeft <= 0) {
      sim.brokenTicksLeft = 0;
      if (sim.collisionActive) {
        sim.collisionActive = false;
        p1.jumping = false;
        p2.jumping = false;
        p1.brokenVisual = false;
        p2.brokenVisual = false;
        applyStaggerMode(p1, NORMAL_MODE);
        applyStaggerMode(p2, NORMAL_MODE);
      }
    }
  }
}

/** Arms the timers exactly like `jump_timer.start()` + `broken_timer.start()`. */
export function armCollisionTimers(sim: SimState): void {
  sim.jumpTicksLeft = JUMPING_TICKS;
  sim.brokenTicksLeft = BROKEN_TICKS;
}

export const PLAYFIELD_BOUNDS = {
  top: PLAYFIELD_TOP,
  bottom: PLAYFIELD_BOTTOM,
};
