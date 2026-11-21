import type { Mode, PrizeKind } from "./constants";
import type { MaskState } from "./mask";
import type { Rng } from "./rng";

export interface Vec2 {
  x: number;
  y: number;
}

export interface InputState {
  left: boolean;
  right: boolean;
}

export const NEUTRAL_INPUT: InputState = { left: false, right: false };

export type MatchPhase = "countdown" | "playing" | "result";

export type RoundEndReason = "time" | "forfeit" | "abandoned";

export type Powerup = PrizeKind | null;

export interface PlayerState {
  slot: 0 | 1;
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
  palettes: readonly [number, number];
  /** Playing ticks in the round. Defaults to 5040 (84 s at 60 Hz). */
  roundTicks?: number;
  /** Ticks per countdown label. Defaults to 60 (1 s). */
  countdownTicksPerLabel?: number;
  /** Active slots: 1 for solo, 2 for 1v1. */
  activeSlots?: 1 | 2;
  /** Seed text. Defaults to palettes + round length. */
  seed?: string;
}

export interface SimState {
  seed: number;
  rng: Rng;
  phase: MatchPhase;
  palettes: [number, number];
  activeSlots: 1 | 2;
  /** Absolute tick since the match started (countdown included). */
  tick: number;
  countdownTicks: number;
  countdownLabel: number;
  countdownAnnounced: number;
  countdownTicksPerLabel: number;
  roundTick: number;
  roundTicks: number;
  players: [PlayerState, PlayerState];
  prize: PrizeState;
  collisionActive: boolean;
  jumpTicksLeft: number;
  brokenTicksLeft: number;
  nextPrizeIndex: number;
  mask: MaskState;
  scores: [number, number];
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
      scores: [number, number];
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
  a: PlayerSnapshot;
  b: PlayerSnapshot;
  prize: PrizeSnapshot | null;
  scores: [number, number];
  ticksLeft: number;
  /** Total playing ticks in this round. */
  total?: number;
  paint: boolean;
  /** Countdown label index while `phase === "countdown"`. */
  cd?: number;
  /** Winner slot after the round ended. */
  win?: number | null;
}
