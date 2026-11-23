/**
 * Stable FNV-1a state hashing used by golden replay tests.
 *
 * Hash only rule-relevant fields: position, angle, timers, prize budget, RNG
 * state and mask counters. Cosmetic-only values (squash envelope, halo angle)
 * are deliberately excluded so a renderer change cannot break determinism.
 */

import type { SimState } from "./types";

export function fnv1a(text: string): string {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

function num(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  return value.toFixed(6);
}

export function stateHash(sim: SimState): string {
  const parts: string[] = [
    sim.phase,
    String(sim.tick),
    String(sim.roundTick),
    String(sim.rng.state.s),
    String(sim.nextPrizeIndex),
    sim.prize.kind ?? "-",
    String(sim.collisionActive ? 1 : 0),
    String(sim.jumpTicksLeft),
    String(sim.brokenTicksLeft),
  ];

  for (const player of sim.players) {
    parts.push(
      [
        num(player.x),
        num(player.y),
        num(player.angle),
        String(player.mode.step),
        String(player.radius),
        String(player.paintIndex),
        num(player.moveAccumX),
        num(player.moveAccumY),
        player.jumping ? "j" : "-",
        player.bandi ? "b" : "-",
        player.jumpingToWall ? "k" : "-",
        num(player.bandiTimeLeft),
        player.powerup ?? "-",
        String(player.frozenTicks),
      ].join(","),
    );
  }

  parts.push(sim.mask.counts.join(","));
  return fnv1a(parts.join("|"));
}
