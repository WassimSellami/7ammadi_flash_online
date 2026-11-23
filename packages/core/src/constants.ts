/**
 * Rule constants ported verbatim from the pygame reference project
 * (`data/settings.py`, `data/color.py`, `data/player.py`).
 *
 * Only two deliberate changes are made here, both required by the plan:
 *  - the logic runs on a fixed 60 Hz tick instead of a wall clock;
 *  - the countdown spends one second per label instead of `symbol_time = 0.1`.
 */

export const D_WIDTH = 1920;
export const D_HEIGHT = 1080;

/** Logical HUD strip docked at the bottom of the screen. */
export const HUD_HEIGHT = 74;
export const PLAYFIELD_TOP = 0;
export const PLAYFIELD_BOTTOM = D_HEIGHT - HUD_HEIGHT;
export const PLAYFIELD_HEIGHT = PLAYFIELD_BOTTOM - PLAYFIELD_TOP;

/** Milliseconds of simulated time advanced by one tick. */
export const TICK_MS = 1000 / 60;
export const TICKS_PER_SECOND = 60;

/** Seconds. */
export const SPEED = 35;
export const BROKEN_TIME = 5;
export const JUMPING_TIME = 1.4;
export const BANDI_TIME = 10;
export const BEATEN_TIME = 5;
export const KNOCKBACK_TIME = 0.2;
export const PRIZE_TIME = 28;
export const ROUND_TIME = 112;
export const RAIN_DELAY = 0.05;
/** Deliberate change: 1 s per countdown label (reference used 0.1 s). */
export const SYMBOL_TIME = 1;

export const JUMP_VISUAL_HEIGHT = 110;
export const JUMP_MOVE_FACTOR = 0.8;
export const SWING_ANGLE = 20;
export const SWING_SPEED = 11;
export const SWING_UPPER_FACTOR = 0.5;
export const JUMP_SHADOW_OFFSET = 0.47;
export const IDLE_SHADOW_OFFSET = 0.47;

export const RAIN_DROPS = 45;

export const P_RADIUS = 41;
export const NORMAL_RADIUS = 36;
export const BIG_RADIUS = 45;
export const IN_ANGLE_A = 180;
export const IN_ANGLE_B = 0;
export const IN_STEP = 8;

export const ICON_SIZE = 80;
export const ICON_MARGIN = 4;

export type Mode = { readonly angle: number; readonly step: number };

export const SLOW_MODE: Mode = { angle: 6, step: 5 };
export const NORMAL_MODE: Mode = { angle: 6, step: 9 };
export const FAST_MODE: Mode = { angle: 6, step: 13 };
export const WAIT_MODE: Mode = { angle: 0, step: 0 };

export const MODES: readonly Mode[] = [WAIT_MODE, SLOW_MODE, NORMAL_MODE, FAST_MODE];

/** Encodes a mode by its movement step (0 wait, 5 slow, 9 normal, 13 fast). */
export function modeStep(mode: Mode): number {
  return mode.step;
}

export function modeFromStep(step: number): Mode {
  switch (step) {
    case 0:
      return WAIT_MODE;
    case 5:
      return SLOW_MODE;
    case 13:
      return FAST_MODE;
    default:
      return NORMAL_MODE;
  }
}

export type PaletteName = "Pink" | "Golden Yellow" | "Green" | "Blue";

export interface PaletteEntry {
  readonly name: PaletteName;
  readonly rgb: readonly [number, number, number];
}

/** `Color.paint_palette` — index order is part of the score wire format. */
export const PAINT_PALETTE: readonly PaletteEntry[] = [
  { name: "Pink", rgb: [255, 114, 170] },
  { name: "Golden Yellow", rgb: [254, 190, 80] },
  { name: "Green", rgb: [74, 202, 79] },
  { name: "Blue", rgb: [28, 154, 255] },
];

export const PALETTE_COUNT = PAINT_PALETTE.length;
export const DEFAULT_PALETTE_A = 2;
export const DEFAULT_PALETTE_B = 0;

export function paletteRgb(index: number): readonly [number, number, number] {
  return PAINT_PALETTE[((index % PALETTE_COUNT) + PALETTE_COUNT) % PALETTE_COUNT]!.rgb;
}

export const PRIZE_KINDS = [
  "rain",
  "potion",
  "bandi",
  "fat",
  "boom",
  "speed",
  "clock",
] as const;

export type PrizeKind = (typeof PRIZE_KINDS)[number];

/**
 * Testing switch: force every prize spawn to one kind. `null` restores the
 * normal per-kind rotation.
 */
export const PRIZE_TEST_OVERRIDE: PrizeKind | null = null;

/** Extra paint-stamp radius applied to every movement mode. */
export const PAINT_RADIUS_BONUS = 1;
/** Uniform scaling applied to the painted stroke width. */
export const PAINT_RADIUS_SCALE = 1.2;

/** Painted circle radius for a player's physical radius. */
export function paintRadius(radius: number): number {
  return (radius + PAINT_RADIUS_BONUS) * PAINT_RADIUS_SCALE;
}

/** Paint sentinel: a potion victim's brush has no palette colour. */
export const NO_PAINT = -1;

/** Cream bristle colour of the brush sprite, reused for potion victims. */
export const POTION_BRUSH_RGB = [247, 236, 208] as const;

export const MODE_PRIZES: ReadonlySet<PrizeKind> = new Set<PrizeKind>([
  "speed",
  "fat",
  "bandi",
]);

export const PRIZE_LABELS: Record<PrizeKind, string> = {
  speed: "SPEED UP",
  fat: "FAT BOOST",
  rain: "COLOR RAIN",
  boom: "BOOM!",
  bandi: "BANDI!",
  potion: "HIT SOMEONE",
  clock: "TIME FREEZE",
};

export const PRIZE_KIND_COUNT = new Set(PRIZE_KINDS).size;
/**
 * 112 s round in four 28 s phases. Prizes spawn at 28 s, 56 s and 84 s; the
 * last phase has no prize. The epsilon keeps the 84 s boundary from counting
 * a fourth spawn (the spawn condition is `spawn_ms < round_time * 1000`).
 */
export const PRIZES_PER_ROUND = Math.max(
  0,
  Math.floor((ROUND_TIME - 1e-9) / Math.max(1e-9, PRIZE_TIME)),
);
export const PRIZES_PER_KIND = Math.max(
  1,
  Math.ceil(PRIZES_PER_ROUND / PRIZE_KIND_COUNT),
);
export const TOTAL_PRIZE_SLOTS = PRIZES_PER_KIND * PRIZE_KIND_COUNT;

export const PRIZE_DIS = Math.floor(D_HEIGHT / 2);

/** Tick counts for the fixed simulation. */
export const ROUND_TICKS = Math.round(ROUND_TIME * TICKS_PER_SECOND);
export const COUNTDOWN_TICKS_PER_LABEL = Math.round(SYMBOL_TIME * TICKS_PER_SECOND);
export const COUNTDOWN_LABELS = ["3", "2", "1", "Go!"] as const;
export const COUNTDOWN_TICKS = COUNTDOWN_TICKS_PER_LABEL * COUNTDOWN_LABELS.length;
export const PRIZE_LIFETIME_TICKS = Math.round(PRIZE_TIME * TICKS_PER_SECOND);
export const PRIZE_SPAWN_INTERVAL_TICKS = Math.round(PRIZE_TIME * TICKS_PER_SECOND);
export const JUMPING_TICKS = Math.round(JUMPING_TIME * TICKS_PER_SECOND);
export const BROKEN_TICKS = Math.round(BROKEN_TIME * TICKS_PER_SECOND);
export const BANDI_TICKS = Math.round(BANDI_TIME * TICKS_PER_SECOND);

/** Player ids used by the reference project. */
export const PLAYER_NAMES = ["Player_A", "Player_B"] as const;
export type PlayerName = (typeof PLAYER_NAMES)[number];

export function trueColorIndex(slot: number, palettes: readonly [number, number]): number {
  return slot === 0 ? palettes[0] : palettes[1];
}

export function trueColorName(slot: number, palettes: readonly [number, number]): string {
  return PAINT_PALETTE[trueColorIndex(slot, palettes)]!.name;
}

/** Python's `round` is half-to-even; score parity depends on it. */
export function pyRound(value: number): number {
  const floor = Math.floor(value);
  const diff = value - floor;
  if (diff > 0.5) return floor + 1;
  if (diff < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

export function pyInt(value: number): number {
  return Math.trunc(value);
}

/** Margin used by `clamp_to_playfield` for the fixed 80x80 brush sprite. */
export function iconMargin(radius: number): number {
  return Math.max(radius, Math.floor(ICON_SIZE / 2));
}
