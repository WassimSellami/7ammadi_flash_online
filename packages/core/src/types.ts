import type { Mode, PrizeKind } from "./constants";
import type { MaskState } from "./mask";
import type { Rng } from "./rng";

export interface Vec2 {
  x: number;
  y: number;
}

/** Online rooms support up to four brushes. */
export type SlotIndex = 0 | 1 | 2 | 3;

export const SLOT_INDICES: readonly SlotIndex[] = [0, 1, 2, 3];
export const MAX_PLAYERS = SLOT_INDICES.length;

export interface InputState {
  left: boolean;
  right: boolean;
}

export const NEUTRAL_INPUT: InputState = { left: false, right: false };

export type MatchPhase = "countdown" | "playing" | "result";

export type RoundEndReason = "time" | "forfeit" | "abandoned";

export type Powerup = PrizeKind | null;

export interface PlayerState {
  slot: SlotIndex;
  x: number;
  y: number;
  angle: number;
  radius: number;
  mode: Mode;
  /** Fixed true palette index chosen in the lobby. */
  palette: number;
  /** Current stamping palette index (`follow_me` can change it). */
  paintIndex: number;
  jumping: boolean;
  jumpProgress: number;
  beaten: boolean;
  brokenVisual: boolean;
  bandi: boolean;
  bandiTimeLeft: number;
  powerup: Powerup;
  moveAccumX: number;
  moveAccumY: number;
  wallCooldown: number;
  wallEvent: Vec2 | null;
  squashing: boolean;
  squashElapsed: number;
  squashDuration: number;
  squashStrength: number;
  punchContacted: boolean;
  jumpingToWall: boolean;
  /** Per-player collision jump timer (ticks). */
  collisionJumpTicks: number;
  /** Per-player broken/slow timer (ticks). */
  collisionBrokenTicks: number;
  knockbackElapsed: number;
  knockbackDuration: number;
  knockbackStartY: number;
  knockbackTargetY: number;
  knockbackDirection: number;
  knockbackPaused: boolean;
  score: number;
}

export interface PrizeState {
  active: boolean;
  kind: PrizeKind | null;
  x: number;
  y: number;
  ageMs: number;
  haloAngle: number;
  counts: Record<PrizeKind, number>;
  rainPending: Vec2[];
  rainAccumMs: number;
  rainColorIndex: number;
}

export interface SimConfig {
  /** Palette per slot. Missing entries fall back to that slot's default. */
  palettes: readonly number[];
  /** Playing ticks in the round. Defaults to 5040 (84 s at 60 Hz). */
  roundTicks?: number;
  /** Ticks per countdown label. Defaults to 60 (1 s). */
  countdownTicksPerLabel?: number;
  /**
   * Warm-up ticks at the start of the countdown where every client shows
   * "Ready!" before the 3-2-1-Go labels. Defaults to 0.
   */
  readyTicks?: number;
  /** Active slots: a count (1-4) or explicit slot indices. */
  activeSlots?: number | readonly number[];
  /** Legacy spawns A-left/B-right; cross uses the four playfield midpoints. */
  spawn?: "legacy" | "cross";
  /** Seed text. Defaults to palettes + round length. */
  seed?: string;
}

export interface SimState {
  seed: number;
  rng: Rng;
  phase: MatchPhase;
  palettes: number[];
  /** Room slot indices that take part in the match. */
  activeSlots: number[];
  /** Absolute tick since the match started (countdown included). */
  tick: number;
  countdownTicks: number;
  /** Ticks left in the "Ready!" warm-up before the numeric labels start. */
  countdownReadyTicks: number;
  /** `-1` during the "Ready!" warm-up, then a `COUNTDOWN_LABELS` index. */
  countdownLabel: number;
  countdownAnnounced: number;
  countdownTicksPerLabel: number;
  roundTick: number;
  roundTicks: number;
  /** Always four players; only `activeSlots` are stepped and painted. */
  players: PlayerState[];
  prize: PrizeState;
  collisionActive: boolean;
  jumpTicksLeft: number;
  brokenTicksLeft: number;
  nextPrizeIndex: number;
  mask: MaskState;
  /** Active-player scores, in active-slot order. */
  scores: number[];
  winner: number | null;
  endReason: RoundEndReason | null;
  events: GameEvent[];
}

export type GameEvent = {
  tick: number;
} & (
  | { type: "smash"; x: number; y: number }
  /** `slot` is the attacker, so the effect uses the attacker's colour. */
  | { type: "punch"; slot: number; x: number; y: number }
  | {
      type: "pickup";
      kind: PrizeKind;
      slot: number;
      x: number;
      y: number;
      color: number;
      label: string;
    }
  | { type: "boom"; x: number; y: number; color: number; radius: number }
  | { type: "rain"; drops: Vec2[]; color: number; radius: number }
  | { type: "evil" }
  | { type: "wall"; slot: number; x: number; y: number }
  | { type: "spawn"; kind: PrizeKind; x: number; y: number }
  | { type: "count"; label: string }
  | {
      type: "end";
      scores: number[];
      winner: number | null;
      reason: RoundEndReason;
    }
);

/** Snapshot player flags. */
export const FLAG_JUMPING = 1;
export const FLAG_BANDI = 2;
export const FLAG_SPEED = 4;
export const FLAG_FAT = 8;
export const FLAG_BEATEN = 16;
export const FLAG_KNOCKBACK = 32;
export const FLAG_BROKEN = 64;
export const FLAG_SQUASH = 128;

export interface PlayerSnapshot {
  slot: SlotIndex;
  x: number;
  y: number;
  /** Angle in degrees, rounded to 2 decimals. */
  ang: number;
  /** Mode step: 0 wait, 5 slow, 9 normal, 13 fast. */
  m: number;
  r: number;
  fl: number;
  /** Paint palette index. */
  c: number;
  /** Whether this player is currently allowed to stamp paint. */
  pt: boolean;
}

export interface PrizeSnapshot {
  kind: PrizeKind;
  x: number;
  y: number;
  /** Absolute sim tick at which the prize expires. */
  endsAt: number;
}

export interface Snapshot {
  v: 1;
  tick: number;
  phase: MatchPhase;
  /** Active players in slot order. */
  players: PlayerSnapshot[];
  prize: PrizeSnapshot | null;
  /** Active-player scores, aligned with `players`. */
  scores: number[];
  ticksLeft: number;
  /** Total playing ticks in this round. */
  total?: number;
  paint: boolean;
  /** Countdown label index while `phase === "countdown"`; `-1` means "Ready!". */
  cd?: number;
  /** Winner slot after the round ended. */
  win?: number | null;
}
