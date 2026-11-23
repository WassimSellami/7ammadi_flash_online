/**
 * Match simulation: the single source of truth for both the Cloudflare/Node
 * rooms and the offline Web Worker.
 *
 * `stepSim` never reads a clock, a socket, storage or `Math.random`. One call
 * advances exactly one 60 Hz tick. Everything the clients need to rebuild the
 * scene is in `serializeSnapshot`; events only add transients.
 */

import {
  COUNTDOWN_LABELS,
  COUNTDOWN_TICKS_PER_LABEL,
  DEFAULT_PALETTE_A,
  DEFAULT_PALETTE_B,
  D_WIDTH,
  IN_ANGLE_A,
  IN_ANGLE_B,
  NORMAL_MODE,
  PRIZE_KINDS,
  PRIZE_LIFETIME_TICKS,
  PRIZE_TIME,
  ROUND_TICKS,
  ROUND_TIME,
  TICK_MS,
  type PrizeKind,
} from "./constants";
import { armCollisionTimers, collisionCheck, updateCollisionTimers } from "./collision";
import { createMask, scorePercent, stampCircle } from "./mask";
import {
  applySpawnPoint,
  changeAngle,
  changeCoor,
  createPlayer,
  placePlayerAtSpawn,
  setupPlayer,
  spawnPointsFor,
  updateJumpAnim,
  updatePowerup,
  updateSquash,
} from "./player";
import {
  checkPrize,
  createPrizeState,
  prizeExpired,
  spawnPrize,
  updatePrize,
} from "./prize";
import { Rng } from "./rng";
import {
  FLAG_BANDI,
  FLAG_BEATEN,
  FLAG_BROKEN,
  FLAG_FAT,
  FLAG_JUMPING,
  FLAG_KNOCKBACK,
  FLAG_SPEED,
  FLAG_SQUASH,
  NEUTRAL_INPUT,
  SLOT_INDICES,
  type GameEvent,
  type InputState,
  type MatchPhase,
  type PlayerSnapshot,
  type PlayerState,
  type SimConfig,
  type SimState,
  type Snapshot,
} from "./types";

const DEFAULT_SLOT_PALETTES: readonly number[] = [
  DEFAULT_PALETTE_A,
  DEFAULT_PALETTE_B,
  1,
  3,
];

function normalizeActiveSlots(value: number | readonly number[] | undefined): number[] {
  if (typeof value === "number") {
    const count = Math.max(1, Math.min(SLOT_INDICES.length, Math.trunc(value)));
    return SLOT_INDICES.slice(0, count);
  }
  if (Array.isArray(value)) {
    const unique = new Set<number>();
    for (const slot of value) {
      if (Number.isInteger(slot) && slot >= 0 && slot < SLOT_INDICES.length) {
        unique.add(slot);
      }
    }
    if (unique.size > 0) return [...unique].sort((a, b) => a - b);
  }
  return [0, 1];
}

function normalizeTeams(
  value: readonly (readonly number[])[] | null | undefined,
  activeSlots: readonly number[],
): readonly (readonly number[])[] | null {
  if (!value || value.length !== 2) return null;
  const active = new Set(activeSlots);
  const teams: number[][] = [];
  for (const roster of value) {
    const slots: number[] = [];
    for (const slot of roster) {
      if (active.has(slot) && !slots.includes(slot)) slots.push(slot);
    }
    if (slots.length === 0) return null;
    teams.push(slots);
  }
  const [first, second] = teams;
  if (first.some((slot) => second!.includes(slot))) return null;
  return teams;
}

export function createSim(config: SimConfig): SimState {
  const palettes = SLOT_INDICES.map(
    (slot) => config.palettes[slot] ?? DEFAULT_SLOT_PALETTES[slot]!,
  );
  const roundTicks = config.roundTicks ?? ROUND_TICKS;
  const countdownTicksPerLabel =
    config.countdownTicksPerLabel ?? COUNTDOWN_TICKS_PER_LABEL;
  const readyTicks = Math.max(0, Math.floor(config.readyTicks ?? 0));
  const seedText =
    config.seed ?? `sim|${palettes.join(",")}|${roundTicks}`;
  const activeSlots = normalizeActiveSlots(config.activeSlots);
  const teams = normalizeTeams(config.teams, activeSlots);

  const players = SLOT_INDICES.map((slot) => {
    const offset: 1 | 2 = slot === 1 ? 2 : 1;
    const angle = slot === 1 ? IN_ANGLE_B : IN_ANGLE_A;
    const player = createPlayer(slot, palettes[slot]!, offset);
    setupPlayer(player, palettes[slot]!, angle, offset);
    placePlayerAtSpawn(player, slot, config.spawn ?? "legacy");
    player.mode = NORMAL_MODE;
    return player;
  });

  if ((config.spawn ?? "legacy") === "cross") {
    const points = spawnPointsFor(activeSlots.length);
    activeSlots.forEach((slot, index) => {
      const point = points[index];
      if (point) applySpawnPoint(players[slot]!, point);
    });
  }

  const sim: SimState = {
    seed: 0,
    rng: new Rng(seedText),
    phase: "countdown",
    palettes,
    activeSlots,
    teams,
    prizeOverride: config.prizeOverride ?? null,
    tick: 0,
    countdownTicks: 0,
    countdownReadyTicks: readyTicks,
    countdownLabel: readyTicks > 0 ? -1 : 0,
    countdownAnnounced: -1,
    countdownTicksPerLabel,
    roundTick: 0,
    roundTicks,
    players,
    prize: createPrizeState(),
    collisionActive: false,
    jumpTicksLeft: 0,
    brokenTicksLeft: 0,
    nextPrizeIndex: 1,
    mask: createMask(),
    scores: activeSlots.map((slot) => players[slot]!.score),
    winner: null,
    endReason: null,
    events: [],
  };
  sim.seed = sim.rng.state.s;
  return sim;
}

export function activePlayers(sim: SimState): PlayerState[] {
  return sim.activeSlots.map((slot) => sim.players[slot]!);
}

/**
 * `Player.paint_both` quirk, preserved deliberately: brushes stamp only when
 * the first active player is *not* jumping. The reference always passes A
 * first, so a jump by B alone does not suppress painting.
 */
function paintSuppressedQuirk(sim: SimState): boolean {
  const players = activePlayers(sim);
  // Reference quirk only for the original 1v1: A jumping suppresses B too.
  return players.length <= 2 && (players[0]?.jumping ?? false);
}

function canPlayerPaint(player: PlayerState): boolean {
  // Colourless brushes (follow_me) stamp nothing; airborne brushes wait.
  return (
    player.paintIndex >= 0 &&
    !(player.jumping || player.jumpingToWall || player.beaten)
  );
}

export function paintFlag(sim: SimState): boolean {
  if (paintSuppressedQuirk(sim)) return false;
  return activePlayers(sim).some(canPlayerPaint);
}

function stampPaint(sim: SimState): void {
  if (paintSuppressedQuirk(sim)) return;
  for (const player of activePlayers(sim)) {
    if (!canPlayerPaint(player)) continue;
    stampCircle(sim.mask, player.x, player.y, player.radius, player.paintIndex);
  }
}

export function stepSim(
  sim: SimState,
  inputs: readonly InputState[],
): GameEvent[] {
  sim.events = [];
  if (sim.phase === "result") return sim.events;

  if (sim.phase === "countdown") {
    stepCountdown(sim, inputs);
  } else {
    stepPlaying(sim, inputs);
  }

  sim.tick += 1;
  return sim.events;
}

function stepCountdown(sim: SimState, inputs: readonly InputState[]): void {
  const elapsed = TICK_MS;
  // Steering is locked until the round starts; the warm-up and countdown only
  // stamp paint, so a held arrow cannot rotate a brush early.
  for (const player of activePlayers(sim)) {
    if (!player.jumpingToWall) {
      changeAngle(player, NEUTRAL_INPUT, elapsed);
    }
  }

  // The reference calls `Screen.paint_players` during the countdown too.
  stampPaint(sim);

  const total = sim.countdownTicksPerLabel * COUNTDOWN_LABELS.length;
  if (sim.countdownReadyTicks > 0) {
    // Warm-up window: every client shows "Ready!" for the same ticks before
    // the numeric labels, so all screens start the 3-2-1-Go in step.
    sim.countdownReadyTicks -= 1;
    if (sim.countdownReadyTicks === 0) sim.countdownLabel = 0;
  } else {
    sim.countdownTicks += 1;
    if (sim.countdownTicks < total && sim.countdownTicks % sim.countdownTicksPerLabel === 0) {
      sim.countdownLabel = Math.min(
        COUNTDOWN_LABELS.length - 1,
        sim.countdownLabel + 1,
      );
    }
    if (sim.countdownTicks >= total) {
      sim.phase = "playing";
      sim.roundTick = 0;
    }
  }
  if (sim.countdownLabel >= 0 && sim.countdownLabel !== sim.countdownAnnounced) {
    sim.countdownAnnounced = sim.countdownLabel;
    sim.events.push({
      tick: sim.tick,
      type: "count",
      label: COUNTDOWN_LABELS[sim.countdownLabel]!,
    });
  }
}

function stepPlaying(sim: SimState, inputs: readonly InputState[]): void {
  const elapsed = TICK_MS;
  const players = activePlayers(sim);

  for (const player of players) {
    updateSquash(player, elapsed);
    updatePowerup(player, elapsed);
    updateJumpAnim(player, elapsed);
    if (!player.jumpingToWall) {
      changeAngle(player, inputs[player.slot] ?? NEUTRAL_INPUT, elapsed);
    }
    changeCoor(player, elapsed);
  }

  stampPaint(sim);

  const started = players.length > 1 ? collisionCheck(sim, sim.events) : false;
  if (started) armCollisionTimers(sim);
  updateCollisionTimers(sim);

  sim.roundTick += 1;

  const spawnMs = sim.nextPrizeIndex * PRIZE_TIME * 1000;
  if (
    spawnMs < ROUND_TIME * 1000 &&
    spawnMs <= sim.roundTick * TICK_MS
  ) {
    sim.nextPrizeIndex += 1;
    spawnPrize(sim, sim.events);
  }

  updatePrize(sim, elapsed);
  if (sim.prize.active) {
    if (prizeExpired(sim.prize)) {
      sim.prize.active = false;
    } else {
      checkPrize(sim, sim.events);
    }
  }

  refreshScores(sim);

  if (sim.roundTick >= sim.roundTicks) {
    finishRound(sim, "time");
  }
}

function refreshScores(sim: SimState): void {
  for (const player of sim.players) {
    player.score = scorePercent(sim.mask, player.palette);
  }
  sim.scores = activePlayers(sim).map((player) => player.score);
}

export function finishRound(
  sim: SimState,
  reason: "time" | "forfeit" | "abandoned",
  forcedWinner?: number | null,
): void {
  if (sim.phase === "result") return;
  refreshScores(sim);
  const players = activePlayers(sim);
  const scores = players.map((player) => player.score);
  let winner: number | null;
  if (forcedWinner !== undefined) {
    winner = forcedWinner;
  } else if (reason === "abandoned") {
    winner = null;
  } else if (sim.teams) {
    // Team battle: compare the combined paint of each team, then award the
    // winning team's best individual slot (clients share the trophy).
    const totals = sim.teams.map((team) =>
      team.reduce((sum, slot) => sum + (sim.players[slot]?.score ?? 0), 0),
    );
    if (totals[0] === totals[1]) {
      winner = null;
    } else {
      const winning = totals[0]! > totals[1]! ? sim.teams[0]! : sim.teams[1]!;
      let best = -1;
      let bestSlot: number | null = null;
      for (const slot of winning) {
        const player = sim.players[slot];
        if (player && player.score > best) {
          best = player.score;
          bestSlot = player.slot;
        }
      }
      winner = bestSlot;
    }
  } else {
    let best = -1;
    let bestSlot: number | null = null;
    let tied = false;
    for (const player of players) {
      if (player.score > best) {
        best = player.score;
        bestSlot = player.slot;
        tied = false;
      } else if (player.score === best) {
        tied = true;
      }
    }
    winner = tied ? null : bestSlot;
  }
  sim.phase = "result";
  sim.winner = winner;
  sim.scores = scores;
  sim.endReason = reason;
  sim.events.push({
    tick: sim.tick,
    type: "end",
    scores,
    winner,
    reason,
  });
}

function playerFlags(player: PlayerState): number {
  let flags = 0;
  if (player.jumping) flags |= FLAG_JUMPING;
  if (player.bandi) flags |= FLAG_BANDI;
  if (player.powerup === "speed") flags |= FLAG_SPEED;
  if (player.powerup === "fat") flags |= FLAG_FAT;
  if (player.beaten) flags |= FLAG_BEATEN;
  if (player.jumpingToWall) flags |= FLAG_KNOCKBACK;
  if (player.brokenVisual) flags |= FLAG_BROKEN;
  if (player.squashing) flags |= FLAG_SQUASH;
  return flags;
}

function roundAngle(angle: number): number {
  const value = Math.round(angle * 100) / 100;
  return Object.is(value, -0) ? 0 : value;
}

function snapshotPlayer(sim: SimState, player: PlayerState): PlayerSnapshot {
  return {
    slot: player.slot,
    x: Math.round(player.x),
    y: Math.round(player.y),
    ang: roundAngle(player.angle),
    m: player.mode.step,
    r: Math.round(player.radius),
    fl: playerFlags(player),
    c: player.paintIndex,
    pt: !paintSuppressedQuirk(sim) && canPlayerPaint(player),
  };
}

export function serializeSnapshot(sim: SimState): Snapshot {
  const players = activePlayers(sim);
  const liveScores = players.map((player) =>
    scorePercent(sim.mask, player.palette),
  );
  sim.scores = [...liveScores];
  const snapshot: Snapshot = {
    v: 1,
    tick: sim.tick,
    phase: sim.phase,
    players: players.map((player) => snapshotPlayer(sim, player)),
    prize: sim.prize.active
      ? {
          kind: sim.prize.kind!,
          x: Math.round(sim.prize.x),
          y: Math.round(sim.prize.y),
          endsAt:
            sim.tick +
            Math.max(
              0,
              Math.ceil((PRIZE_LIFETIME_TICKS * TICK_MS - sim.prize.ageMs) / TICK_MS),
            ),
        }
      : null,
    scores: liveScores,
    ticksLeft:
      sim.phase === "playing"
        ? Math.max(0, sim.roundTicks - sim.roundTick)
        : sim.roundTicks,
    total: sim.roundTicks,
    paint: paintFlag(sim),
  };

  if (sim.phase === "countdown") snapshot.cd = sim.countdownLabel;
  if (sim.phase === "result") snapshot.win = sim.winner;
  return snapshot;
}

/** Prize kinds still available in the current round budget (debug/tests). */
export function remainingPrizeKinds(sim: SimState): PrizeKind[] {
  return PRIZE_KINDS.filter((kind) => (sim.prize.counts[kind] ?? 0) === 0);
}

/** Fraction of the mask that has ever been painted (solo target feedback). */
export function paintedCoverage(sim: SimState): number {
  let painted = 0;
  for (const count of sim.mask.counts) painted += count;
  return painted / sim.mask.cells.length;
}
