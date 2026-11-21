/**
 * Server-side paint mask.
 *
 * The pygame game paints into a 1920x1006 background and counts exact palette
 * pixels at round end. The browser product keeps the same palette-index model
 * but rasterises into a 480x252 grid (4 px cells, playfield mapped 1:4) with a
 * per-index counter so a score read is O(1). `serializeSnapshot` only ships the
 * counters; the mask itself never leaves the server.
 */

import {
  D_WIDTH,
  PAINT_PALETTE,
  PLAYFIELD_HEIGHT,
  PLAYFIELD_TOP,
  pyRound,
  type PaletteName,
} from "./constants";

export const MASK_SCALE = 4;
export const MASK_COLS = Math.floor(D_WIDTH / MASK_SCALE);
export const MASK_ROWS = Math.ceil(PLAYFIELD_HEIGHT / MASK_SCALE);
export const MASK_CELLS = MASK_COLS * MASK_ROWS;

/** Sentinel for "not painted". */
export const EMPTY_CELL = 255;

export interface MaskState {
  readonly cols: number;
  readonly rows: number;
  readonly cells: Uint8Array;
  /** Painted cell count per palette index. */
  readonly counts: number[];
}

export function createMask(): MaskState {
  return {
    cols: MASK_COLS,
    rows: MASK_ROWS,
    cells: new Uint8Array(MASK_CELLS).fill(EMPTY_CELL),
    counts: new Array<number>(PAINT_PALETTE.length).fill(0),
  };
}

export function clearMask(mask: MaskState): void {
  mask.cells.fill(EMPTY_CELL);
  mask.counts.fill(0);
}

export function cloneMask(mask: MaskState): MaskState {
  return {
    cols: mask.cols,
    rows: mask.rows,
    cells: new Uint8Array(mask.cells),
    counts: [...mask.counts],
  };
}

function paintCell(mask: MaskState, cx: number, cy: number, paletteIndex: number): void {
  if (cx < 0 || cy < 0 || cx >= mask.cols || cy >= mask.rows) return;
  const index = cy * mask.cols + cx;
  const previous = mask.cells[index]!;
  if (previous === paletteIndex) return;
  if (previous !== EMPTY_CELL) {
    const oldCount = mask.counts[previous] ?? 0;
    mask.counts[previous] = Math.max(0, oldCount - 1);
  }
  mask.cells[index] = paletteIndex;
  mask.counts[paletteIndex] = (mask.counts[paletteIndex] ?? 0) + 1;
}

/**
 * Stamp a filled circle. World coordinates are in the 1920x1080 logical space,
 * with the HUD occupying y < PLAYFIELD_TOP. Matches `p.draw.circle` clipped to
 * the playfield, sampled at cell centres.
 */
export function stampCircle(
  mask: MaskState,
  worldX: number,
  worldY: number,
  radius: number,
  paletteIndex: number,
): void {
  if (radius <= 0) return;
  const radiusSq = radius * radius;
  const minCx = Math.ceil((worldX - radius) / MASK_SCALE);
  const maxCx = Math.floor((worldX + radius) / MASK_SCALE);
  const minCy = Math.ceil((worldY - radius - PLAYFIELD_TOP) / MASK_SCALE);
  const maxCy = Math.floor((worldY + radius - PLAYFIELD_TOP) / MASK_SCALE);
  const startCx = Math.max(0, minCx);
  const endCx = Math.min(mask.cols - 1, maxCx);
  const startCy = Math.max(0, minCy);
  const endCy = Math.min(mask.rows - 1, maxCy);

  for (let cy = startCy; cy <= endCy; cy += 1) {
    const cellY = PLAYFIELD_TOP + cy * MASK_SCALE + MASK_SCALE / 2;
    const dy = cellY - worldY;
    const dySq = dy * dy;
    for (let cx = startCx; cx <= endCx; cx += 1) {
      const cellX = cx * MASK_SCALE + MASK_SCALE / 2;
      const dx = cellX - worldX;
      if (dx * dx + dySq <= radiusSq) paintCell(mask, cx, cy, paletteIndex);
    }
  }
}

/** Number of cells painted with a palette index. */
export function paintedCount(mask: MaskState, paletteIndex: number): number {
  return mask.counts[paletteIndex] ?? 0;
}

/** Percentage of the playfield covered, rounded like `Screen.score`. */
export function scorePercent(mask: MaskState, paletteIndex: number): number {
  return pyRound((paintedCount(mask, paletteIndex) / MASK_CELLS) * 100);
}

/**
 * Reference-equivalent percentage at full playfield resolution. Used by the
 * parity test (the reference implementation counts 1920x1006 pixels).
 */
export function scorePercentFullRes(mask: MaskState, paletteIndex: number): number {
  const paintedPixels = paintedCount(mask, paletteIndex) * MASK_SCALE * MASK_SCALE;
  return pyRound((paintedPixels / (D_WIDTH * PLAYFIELD_HEIGHT)) * 100);
}

export function paletteLabel(index: number): PaletteName {
  return PAINT_PALETTE[index]?.name ?? PAINT_PALETTE[0]!.name;
}

/**
 * Compact transfer format for reconnects: `[value, runLength, value, ...]`.
 * 255 marks empty cells. Typical runs compress an early-round mask to a few KB.
 */
export function encodeMaskRle(mask: MaskState): number[] {
  const runs: number[] = [];
  let current = mask.cells[0] ?? EMPTY_CELL;
  let count = 0;
  for (const value of mask.cells) {
    if (value === current) {
      count += 1;
    } else {
      runs.push(current, count);
      current = value;
      count = 1;
    }
  }
  if (count > 0) runs.push(current, count);
  return runs;
}

export function decodeMaskRle(runs: readonly number[], length: number): Uint8Array {
  const cells = new Uint8Array(length).fill(EMPTY_CELL);
  let position = 0;
  for (let index = 0; index + 1 < runs.length; index += 2) {
    const value = runs[index]! & 0xff;
    const count = Math.max(0, runs[index + 1]!);
    const end = Math.min(length, position + count);
    if (value !== EMPTY_CELL) cells.fill(value, position, end);
    position = end;
    if (position >= length) break;
  }
  return cells;
}
