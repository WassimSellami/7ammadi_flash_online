/**
 * Prize scheduling, spawn placement, rewards and the two painting powers,
 * ported from `data/prize.py`.
 */

import {
  D_WIDTH,
  FAST_MODE,
  NORMAL_MODE,
  NORMAL_RADIUS,
  P_RADIUS,
  PLAYFIELD_BOTTOM,
  PLAYFIELD_TOP,
  PRIZE_DIS,
  PRIZE_KINDS,
  PRIZE_LABELS,
  PRIZES_PER_KIND,
  PRIZE_TIME,
  RAIN_DELAY,
  RAIN_DROPS,
  BIG_RADIUS,
  MODE_PRIZES,
} from "./constants";
import { stampCircle } from "./mask";
import { applyBigBandi, clearPowerup, clampToPlayfield } from "./player";
import type { GameEvent, PlayerState, PrizeState, SimState, Vec2 } from "./types";

function activePlayers(sim: SimState): PlayerState[] {
  return sim.activeSlots.map((slot) => sim.players[slot]!);
}

export function createPrizeState(): PrizeState {
  return {
    active: false,
    kind: null,
    x: D_WIDTH / 2,
    y: Math.floor((PLAYFIELD_TOP + PLAYFIELD_BOTTOM) / 2),
    ageMs: 0,
    haloAngle: 0,
    counts: { rain: 0, follow_me: 0, bandi: 0, fat: 0, boom: 0, speed: 0 },
    rainPending: [],
    rainAccumMs: 0,
    rainColorIndex: 0,
  };
}

export function prizeExpired(prize: PrizeState): boolean {
  // Ticks accumulate 16.666.. ms, so 720 ticks land a hair under 12000.
  return prize.ageMs >= PRIZE_TIME * 1000 - 1e-6;
}

export function prizeExpiring(prize: PrizeState): boolean {
  return PRIZE_TIME * 1000 - prize.ageMs <= 2600;
}

/** `Prize.update`: ages the active prize and drains queued rain drops. */
export function updatePrize(sim: SimState, elapsedMs: number): void {
  const dt = Math.max(0, elapsedMs) / 1000;
  const prize = sim.prize;
  if (prize.active) {
    prize.ageMs += Math.max(0, elapsedMs);
    prize.haloAngle = (prize.haloAngle + dt * 120) % 360;
  }
  updateRain(sim, dt);
}

function updateRain(sim: SimState, dt: number): void {
  const prize = sim.prize;
  if (prize.rainPending.length === 0) return;
  prize.rainAccumMs += dt * 1000;
  while (
    prize.rainPending.length > 0 &&
    prize.rainAccumMs >= RAIN_DELAY * 1000
  ) {
    prize.rainAccumMs -= RAIN_DELAY * 1000;
    paintRainDrop(sim);
  }
}

function paintRainDrop(sim: SimState): void {
  const prize = sim.prize;
  const drop = prize.rainPending.pop();
  if (!drop) return;
  stampCircle(sim.mask, drop.x, drop.y, NORMAL_RADIUS, prize.rainColorIndex);
}

/** `Prize.gen_pos`: 80 samples, fall back to the best of them. */
export function generatePrizePosition(sim: SimState): Vec2 {
  const players = activePlayers(sim);
  const minDistanceSq = PRIZE_DIS * PRIZE_DIS;
  let best: Vec2 = {
    x: Math.floor(D_WIDTH / 2),
    y: Math.floor((PLAYFIELD_TOP + PLAYFIELD_BOTTOM) / 2),
  };
  let bestDistanceSq = -1;

  for (let attempt = 0; attempt < 80; attempt += 1) {
    const x = sim.rng.intInclusive(50, D_WIDTH - 50);
    const y = sim.rng.intInclusive(PLAYFIELD_TOP + 50, PLAYFIELD_BOTTOM - 50);
    let closest = Number.POSITIVE_INFINITY;
    for (const player of players) {
      closest = Math.min(closest, (player.y - y) ** 2 + (player.x - x) ** 2);
    }
    if (closest >= minDistanceSq) return { x, y };
    if (closest > bestDistanceSq) {
      bestDistanceSq = closest;
      best = { x, y };
    }
  }
  return best;
}

/** `Prize.gen_prize`, including the per-kind budget. */
export function generatePrize(sim: SimState, events: GameEvent[]): void {
  const prize = sim.prize;
  const eligible = PRIZE_KINDS.filter(
    (kind) => (prize.counts[kind] ?? 0) < PRIZES_PER_KIND,
  );
  if (eligible.length === 0) {
    prize.active = false;
    return;
  }

  const kind = sim.rng.choice(eligible);
  prize.counts[kind] = (prize.counts[kind] ?? 0) + 1;
  prize.kind = kind;
  prize.ageMs = 0;
  prize.haloAngle = 0;
  prize.active = true;

  const margin = 40;
  prize.x = Math.max(margin, Math.min(D_WIDTH - margin, prize.x));
  prize.y = Math.max(
    PLAYFIELD_TOP + margin,
    Math.min(PLAYFIELD_BOTTOM - margin, prize.y),
  );

  events.push({ tick: sim.tick, type: "spawn", kind, x: prize.x, y: prize.y });
}

/** Spawns the next scheduled prize (`Game` loop in `main.py`). */
export function spawnPrize(sim: SimState, events: GameEvent[]): void {
  const position = generatePrizePosition(sim);
  sim.prize.x = position.x;
  sim.prize.y = position.y;
  generatePrize(sim, events);
}

/** `Game.prize_check`, called only for an active, unexpired prize. */
export function checkPrize(sim: SimState, events: GameEvent[]): void {
  const prize = sim.prize;
  if (!prize.active) return;
  const players = activePlayers(sim);
  const prizeCircle = { x: prize.x, y: prize.y, radius: P_RADIUS };
  for (const player of players) {
    if (!circleHit(prizeCircle, player)) continue;
    const other = players.find((candidate) => candidate !== player) ?? player;
    rewardPrize(sim, player, other, events);
    prize.active = false;
    return;
  }
}

function circleHit(a: { x: number; y: number; radius: number }, b: PlayerState): boolean {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy <= (a.radius + b.radius) ** 2;
}

/** `Prize.reward`. */
export function rewardPrize(
  sim: SimState,
  winner: PlayerState,
  loser: PlayerState,
  events: GameEvent[],
): void {
  const prize = sim.prize;
  const kind = prize.kind;
  if (!kind) return;

  events.push({
    tick: sim.tick,
    type: "pickup",
    kind,
    slot: winner.slot,
    x: prize.x,
    y: prize.y,
    color: winner.paintIndex,
    label: PRIZE_LABELS[kind],
  });

  if (MODE_PRIZES.has(kind)) clearPowerup(winner);

  switch (kind) {
    case "speed":
      winner.mode = FAST_MODE;
      winner.radius = NORMAL_RADIUS;
      winner.brokenVisual = false;
      winner.powerup = "speed";
      break;
    case "fat":
      winner.mode = NORMAL_MODE;
      winner.brokenVisual = false;
      winner.radius = BIG_RADIUS;
      winner.powerup = "fat";
      break;
    case "rain":
      startRain(sim, winner.paintIndex, events);
      break;
    case "boom":
      stampCircle(sim.mask, winner.x, winner.y, 200, winner.paintIndex);
      events.push({
        tick: sim.tick,
        type: "boom",
        x: winner.x,
        y: winner.y,
        color: winner.paintIndex,
        radius: 200,
      });
      break;
    case "bandi":
      applyBigBandi(winner);
      break;
    case "follow_me":
      events.push({ tick: sim.tick, type: "evil" });
      winner.paintIndex = winner.palette;
      for (const other of activePlayers(sim)) {
        if (other !== winner) other.paintIndex = winner.palette;
      }
      if (winner.powerup === null && !winner.bandi) {
        winner.powerup = "follow_me";
      }
      break;
  }

  clampToPlayfield(winner);
}

/** `Prize.rain`: 30 drops, first stamped immediately, rest over 1.5 s. */
export function startRain(
  sim: SimState,
  colorIndex: number,
  events: GameEvent[],
): void {
  const prize = sim.prize;
  const drops: Vec2[] = [];
  for (let i = 0; i < RAIN_DROPS; i += 1) {
    drops.push({
      x: sim.rng.intInclusive(20, D_WIDTH - 20),
      y: sim.rng.intInclusive(PLAYFIELD_TOP + 20, PLAYFIELD_BOTTOM - 20),
    });
  }
  prize.rainColorIndex = colorIndex;
  prize.rainPending = [...drops];
  prize.rainAccumMs = 0;
  paintRainDrop(sim);
  events.push({
    tick: sim.tick,
    type: "rain",
    drops,
    color: colorIndex,
    radius: NORMAL_RADIUS,
  });
}
