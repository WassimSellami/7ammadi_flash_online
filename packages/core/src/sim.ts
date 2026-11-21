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
import { createMask, scorePercent, stampCircle, EMPTY_CELL } from "./mask";
import {
  changeAngle,
  changeCoor,
  createPlayer,
  setupPlayer,
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
  type GameEvent,
  type InputState,
  type MatchPhase,
  type PlayerSnapshot,
  type PlayerState,
  type SimConfig,
  type SimState,
  type Snapshot,
} from "./types";

export function createSim(config: SimConfig): SimState {
  const palettes: [number, number] = [
    config.palettes[0] ?? DEFAULT_PALETTE_A,
    config.palettes[1] ?? DEFAULT_PALETTE_B,
  ];
  const roundTicks = config.roundTicks ?? ROUND_TICKS;
  const countdownTicksPerLabel =
    config.countdownTicksPerLabel ?? COUNTDOWN_TICKS_PER_LABEL;
  const seedText =
    config.seed ?? `sim|${palettes[0]}|${palettes[1]}|${roundTicks}`;

  const playerA = createPlayer(0, palettes[0], 1);
  const playerB = createPlayer(1, palettes[1], 2);
  setupPlayer(playerA, palettes[0], IN_ANGLE_A, 1);
  setupPlayer(playerB, palettes[1], IN_ANGLE_B, 2);
  playerA.mode = NORMAL_MODE;
  playerB.mode = NORMAL_MODE;

  const sim: SimState = {
    seed: 0,
    rng: new Rng(seedText),
    phase: "countdown",
    palettes,
    activeSlots: config.activeSlots ?? 2,
    tick: 0,
    countdownTicks: 0,
    countdownLabel: 0,
    countdownAnnounced: -1,
    countdownTicksPerLabel,
    roundTick: 0,
    roundTicks,
    players: [playerA, playerB],
    prize: createPrizeState(),
    collisionActive: false,
    jumpTicksLeft: 0,
    brokenTicksLeft: 0,
    nextPrizeIndex: 1,
    mask: createMask(),
    scores: [0, 0],
    winner: null,
    endReason: null,
    events: [],
  };
  sim.seed = sim.rng.state.s;
  return sim;
}

export function activePlayers(sim: SimState): PlayerState[] {
  return sim.players.slice(0, sim.activeSlots);
}

/**
 * `Player.paint_both` quirk, preserved deliberately: both brushes stamp only
 * when Player A is *not* jumping. The reference always passes A first, so a
 * jump by B alone does not suppress painting.
 */
export function paintFlag(sim: SimState): boolean {
  return !sim.players[0].jumping;
}

function stampPaint(sim: SimState): void {
  if (!paintFlag(sim)) return;
  for (const player of activePlayers(sim)) {
    // The plan adds knockback/beaten suppression on top of the A-jump quirk:
    // a victim does not paint a streak while being knocked to the wall.
    if (player.jumpingToWall || player.beaten) continue;
    stampCircle(sim.mask, player.x, player.y, player.radius, player.paintIndex);
  }
}

export function stepSim(
  sim: SimState,
  inputs: readonly [InputState, InputState],
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

function stepCountdown(
  sim: SimState,
  inputs: readonly [InputState, InputState],
): void {
  const elapsed = TICK_MS;
  for (const player of activePlayers(sim)) {
    if (!player.jumpingToWall) {
      changeAngle(player, inputs[player.slot] ?? NEUTRAL_INPUT, elapsed);
    }
  }

  // The reference calls `Screen.paint_players` during the countdown too.
  stampPaint(sim);

  const total = sim.countdownTicksPerLabel * COUNTDOWN_LABELS.length;
  sim.countdownTicks += 1;
  if (sim.countdownTicks < total && sim.countdownTicks % sim.countdownTicksPerLabel === 0) {
    sim.countdownLabel = Math.min(
      COUNTDOWN_LABELS.length - 1,
      sim.countdownLabel + 1,
    );
  }
  if (sim.countdownLabel !== sim.countdownAnnounced) {
    sim.countdownAnnounced = sim.countdownLabel;
    sim.events.push({
      tick: sim.tick,
      type: "count",
      label: COUNTDOWN_LABELS[sim.countdownLabel]!,
    });
  }

  if (sim.countdownTicks >= total) {
    sim.phase = "playing";
    sim.roundTick = 0;
  }
}

function stepPlaying(
  sim: SimState,
  inputs: readonly [InputState, InputState],
): void {
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

  const started =
    sim.activeSlots > 1 ? collisionCheck(sim, sim.events) : false;
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
  sim.scores = [sim.players[0].score, sim.players[1].score];
}

export function finishRound(
  sim: SimState,
  reason: "time" | "forfeit" | "abandoned",
  forcedWinner?: number | null,
): void {
  if (sim.phase === "result") return;
  refreshScores(sim);
  const [a, b] = sim.scores;
  const winner =
    forcedWinner !== undefined
      ? forcedWinner
      : reason === "abandoned"
        ? null
        : a > b
          ? 0
          : b > a
            ? 1
            : null;
  sim.phase = "result";
  sim.winner = winner;
  sim.endReason = reason;
  sim.events.push({
    tick: sim.tick,
    type: "end",
    scores: [a, b],
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

function snapshotPlayer(player: PlayerState): PlayerSnapshot {
  return {
    x: Math.round(player.x),
    y: Math.round(player.y),
    ang: roundAngle(player.angle),
    m: player.mode.step,
    r: Math.round(player.radius),
    fl: playerFlags(player),
    c: player.paintIndex,
  };
}

export function serializeSnapshot(sim: SimState): Snapshot {
  const liveScores: [number, number] = [
    scorePercent(sim.mask, sim.palettes[0]),
    scorePercent(sim.mask, sim.palettes[1]),
  ];
  sim.scores = [liveScores[0], liveScores[1]];
  const snapshot: Snapshot = {
    v: 1,
    tick: sim.tick,
    phase: sim.phase,
    a: snapshotPlayer(sim.players[0]),
    b: snapshotPlayer(sim.players[1]),
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
