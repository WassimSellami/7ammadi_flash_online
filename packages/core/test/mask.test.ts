import { describe, expect, it } from "vitest";
import {
  D_WIDTH,
  PAINT_PALETTE,
  PLAYFIELD_HEIGHT,
  PLAYFIELD_TOP,
  createMask,
  decodeMaskRle,
  encodeMaskRle,
  pyRound,
  scorePercent,
  scorePercentFullRes,
  stampCircle,
} from "../src";

interface Stamp {
  x: number;
  y: number;
  r: number;
  color: number;
}

/** Brute-force reference painter at full playfield resolution. */
function referenceScores(stamps: Stamp[]): number[] {
  const cells = new Uint8Array(D_WIDTH * PLAYFIELD_HEIGHT).fill(255);
  for (const stamp of stamps) {
    const startY = Math.max(0, Math.floor(stamp.y - stamp.r - PLAYFIELD_TOP));
    const endY = Math.min(
      PLAYFIELD_HEIGHT - 1,
      Math.ceil(stamp.y + stamp.r - PLAYFIELD_TOP),
    );
    for (let y = startY; y <= endY; y += 1) {
      const worldY = PLAYFIELD_TOP + y + 0.5;
      const dy = worldY - stamp.y;
      const dySq = dy * dy;
      const startX = Math.max(0, Math.floor(stamp.x - stamp.r));
      const endX = Math.min(D_WIDTH - 1, Math.ceil(stamp.x + stamp.r));
      for (let x = startX; x <= endX; x += 1) {
        const dx = x + 0.5 - stamp.x;
        if (dx * dx + dySq <= stamp.r * stamp.r) {
          cells[y * D_WIDTH + x] = stamp.color;
        }
      }
    }
  }

  const counts = new Array<number>(PAINT_PALETTE.length).fill(0);
  for (const value of cells) {
    if (value !== 255) counts[value] = (counts[value] ?? 0) + 1;
  }
  return counts.map((count) => pyRound((count / cells.length) * 100));
}

describe("server mask", () => {
  it("matches the reference full-resolution score within one percent", () => {
    const stamps: Stamp[] = [
      { x: 640, y: 540, r: 36, color: 2 },
      { x: 1280, y: 540, r: 36, color: 0 },
      { x: 960, y: 500, r: 200, color: 2 },
      { x: 10, y: 80, r: 36, color: 0 },
      { x: 1910, y: 1070, r: 36, color: 2 },
      { x: 100, y: 900, r: 45, color: 0 },
    ];
    const mask = createMask();
    for (const stamp of stamps) {
      stampCircle(mask, stamp.x, stamp.y, stamp.r, stamp.color);
    }
    const reference = referenceScores(stamps);
    for (let palette = 0; palette < PAINT_PALETTE.length; palette += 1) {
      const ours = scorePercentFullRes(mask, palette);
      expect(Math.abs(ours - reference[palette]!)).toBeLessThanOrEqual(1);
    }
  });

  it("keeps counters consistent when a cell is repainted", () => {
    const mask = createMask();
    stampCircle(mask, 960, 500, 200, 2);
    const green = scorePercent(mask, 2);
    expect(green).toBeGreaterThan(0);

    stampCircle(mask, 960, 500, 200, 0);
    expect(scorePercent(mask, 2)).toBe(0);
    expect(scorePercent(mask, 0)).toBe(green);
    const total = mask.counts.reduce((sum, value) => sum + value, 0);
    let painted = 0;
    for (const value of mask.cells) if (value !== 255) painted += 1;
    expect(total).toBe(painted);
  });

  it("clips stamps to the playfield", () => {
    const mask = createMask();
    stampCircle(mask, 0, PLAYFIELD_TOP, 500, 1);
    expect(mask.counts[1]).toBeGreaterThan(0);
    expect(scorePercent(mask, 1)).toBeLessThan(15);
  });

  it("round-trips through the reconnect RLE format", () => {
    const mask = createMask();
    stampCircle(mask, 640, 540, 90, 2);
    stampCircle(mask, 1280, 540, 90, 0);
    stampCircle(mask, 960, 500, 200, 2);
    const runs = encodeMaskRle(mask);
    expect(runs.length % 2).toBe(0);
    const decoded = decodeMaskRle(runs, mask.cells.length);
    expect(decoded).toEqual(mask.cells);
    expect(runs.length).toBeLessThan(mask.cells.length);
  });
});
