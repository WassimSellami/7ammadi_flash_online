import { Texture } from "pixi.js";
import { PAINT_PALETTE, PRIZE_KINDS, type PrizeKind } from "@flash/core";
import { ASSET_BASE } from "../config";

export interface BrushLayers {
  upper: Texture;
  lower: Texture;
  splitY: number;
  size: number;
}

export interface GameAssets {
  background: Texture;
  brushes: Map<number, BrushLayers>;
  prizeIcons: Map<PrizeKind, Texture>;
  musicOn: Texture;
  musicOff: Texture;
  soundOn: Texture;
  soundOff: Texture;
  whiteCircle: Texture;
}

function makeCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function context(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("2D canvas unavailable");
  return ctx;
}

async function loadImage(path: string): Promise<HTMLImageElement> {
  const image = new Image();
  image.crossOrigin = "anonymous";
  image.src = path;
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error(`failed to load ${path}`));
  });
  return image;
}

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * `_main_sprite_rect`: pygame builds a mask (alpha > 127), takes one bounding
 * rect per connected component and keeps the rect with the largest area. The
 * source PNG has a small disconnected sparkle in the bottom-right corner; using
 * the bbox of *all* pixels (the old behaviour) shrank the brush to fit that
 * sparkle and made it visibly smaller than the pygame build.
 */
function alphaBounds(image: HTMLImageElement): Rect {
  const width = image.width;
  const height = image.height;
  const canvas = makeCanvas(width, height);
  const ctx = context(canvas);
  ctx.drawImage(image, 0, 0);
  const data = ctx.getImageData(0, 0, width, height).data;

  const total = width * height;
  const mask = new Uint8Array(total);
  for (let index = 0; index < total; index += 1) {
    // `pygame.mask.from_surface` defaults to alpha > 127.
    if (data[index * 4 + 3]! > 127) mask[index] = 1;
  }

  const visited = new Uint8Array(total);
  const stack = new Int32Array(total);
  let best: Rect | null = null;
  let bestArea = 0;

  for (let start = 0; start < total; start += 1) {
    if (mask[start] === 0 || visited[start] === 1) continue;
    let top = 0;
    stack[top++] = start;
    visited[start] = 1;
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;

    while (top > 0) {
      const index = stack[--top]!;
      const x = index % width;
      const y = (index - x) / width;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;

      for (let dy = -1; dy <= 1; dy += 1) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -1; dx <= 1; dx += 1) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx;
          if (nx < 0 || nx >= width) continue;
          const neighbor = ny * width + nx;
          if (mask[neighbor] === 1 && visited[neighbor] === 0) {
            visited[neighbor] = 1;
            stack[top++] = neighbor;
          }
        }
      }
    }

    const rectWidth = maxX - minX + 1;
    const rectHeight = maxY - minY + 1;
    const area = rectWidth * rectHeight;
    if (area > bestArea) {
      bestArea = area;
      best = { x: minX, y: minY, width: rectWidth, height: rectHeight };
    }
  }

  return best ?? { x: 0, y: 0, width, height };
}

function isPaintGreen(r: number, g: number, b: number, a: number): boolean {
  return a > 16 && g > 90 && g > r * 1.35 && g > b * 1.35;
}

/** Crop, recolour the "paint green" mask and fit into an 80x80 icon. */
function buildBrushIcon(image: HTMLImageElement, paletteIndex: number): {
  canvas: HTMLCanvasElement;
  icon: HTMLCanvasElement;
} {
  const bounds = alphaBounds(image);
  const cropped = makeCanvas(bounds.width, bounds.height);
  const cropCtx = context(cropped);
  cropCtx.drawImage(
    image,
    bounds.x,
    bounds.y,
    bounds.width,
    bounds.height,
    0,
    0,
    bounds.width,
    bounds.height,
  );

  const rgb = PAINT_PALETTE[paletteIndex]?.rgb ?? PAINT_PALETTE[0]!.rgb;
  const pixels = cropCtx.getImageData(0, 0, cropped.width, cropped.height);
  const data = pixels.data;
  for (let index = 0; index < data.length; index += 4) {
    const r = data[index]!;
    const g = data[index + 1]!;
    const b = data[index + 2]!;
    const a = data[index + 3]!;
    if (isPaintGreen(r, g, b, a)) {
      data[index] = rgb[0];
      data[index + 1] = rgb[1];
      data[index + 2] = rgb[2];
    }
  }
  cropCtx.putImageData(pixels, 0, 0);

  const icon = makeCanvas(80, 80);
  const iconCtx = context(icon);
  const scale = Math.min(72 / cropped.width, 72 / cropped.height);
  const width = Math.max(1, Math.round(cropped.width * scale));
  const height = Math.max(1, Math.round(cropped.height * scale));
  iconCtx.drawImage(
    cropped,
    Math.floor((80 - width) / 2),
    Math.floor((80 - height) / 2),
    width,
    height,
  );
  return { canvas: cropped, icon };
}

/** `_bristle_top`: first row with enough cream bristle pixels. */
function bristleTop(icon: HTMLCanvasElement): number {
  const ctx = context(icon);
  const data = ctx.getImageData(0, 0, 80, 80).data;
  const threshold = Math.max(4, Math.floor(80 / 4));
  for (let y = 0; y < 80; y += 1) {
    let cream = 0;
    for (let x = 0; x < 80; x += 1) {
      const offset = (y * 80 + x) * 4;
      const r = data[offset]!;
      const g = data[offset + 1]!;
      const b = data[offset + 2]!;
      const a = data[offset + 3]!;
      if (a > 16 && r > 200 && g > 185 && b > 150 && b < 235) cream += 1;
    }
    if (cream >= threshold) return y;
  }
  return Math.floor(80 * 0.62);
}

function swingLayers(icon: HTMLCanvasElement): BrushLayers {
  const splitY = bristleTop(icon);
  const overlap = Math.max(4, Math.floor(80 / 12));
  const upperCanvas = makeCanvas(80, 80);
  context(upperCanvas).drawImage(
    icon,
    0,
    0,
    80,
    Math.min(80, splitY + overlap),
    0,
    0,
    80,
    Math.min(80, splitY + overlap),
  );
  const lowerCanvas = makeCanvas(80, 80);
  context(lowerCanvas).drawImage(
    icon,
    0,
    splitY,
    80,
    80 - splitY,
    0,
    splitY,
    80,
    80 - splitY,
  );
  return {
    upper: Texture.from(upperCanvas),
    lower: Texture.from(lowerCanvas),
    splitY,
    size: 80,
  };
}

function maxTintCanvas(
  image: HTMLImageElement,
  size: number,
  tint: readonly [number, number, number],
  cross: boolean,
): HTMLCanvasElement {
  const canvas = makeCanvas(size, size);
  const ctx = context(canvas);
  ctx.drawImage(image, 0, 0, size, size);
  const pixels = ctx.getImageData(0, 0, size, size);
  const data = pixels.data;
  for (let index = 0; index < data.length; index += 4) {
    if (data[index + 3]! === 0) continue;
    data[index] = Math.max(data[index]!, tint[0]);
    data[index + 1] = Math.max(data[index + 1]!, tint[1]);
    data[index + 2] = Math.max(data[index + 2]!, tint[2]);
  }
  ctx.putImageData(pixels, 0, 0);
  if (cross) {
    const margin = Math.max(6, Math.floor(size / 8));
    ctx.lineCap = "round";
    ctx.strokeStyle = "rgba(52, 10, 10, 0.95)";
    ctx.lineWidth = Math.max(4, Math.round(size * 0.1) + 2);
    ctx.beginPath();
    ctx.moveTo(margin, margin);
    ctx.lineTo(size - margin, size - margin);
    ctx.moveTo(size - margin, margin);
    ctx.lineTo(margin, size - margin);
    ctx.stroke();
    ctx.strokeStyle = "rgb(232, 62, 52)";
    ctx.lineWidth = Math.max(3, Math.round(size * 0.1));
    ctx.stroke();
  }
  return canvas;
}

function prizeIconCanvas(image: HTMLImageElement): HTMLCanvasElement {
  const canvas = makeCanvas(80, 80);
  const ctx = context(canvas);
  ctx.drawImage(image, 0, 0, 80, 80);
  const pixels = ctx.getImageData(0, 0, 80, 80);
  const data = pixels.data;
  for (let index = 0; index < data.length; index += 4) {
    if (data[index + 3]! === 0) continue;
    data[index] = Math.max(data[index]!, 255);
    data[index + 1] = Math.max(data[index + 1]!, 205);
    data[index + 2] = Math.max(data[index + 2]!, 94);
  }
  ctx.putImageData(pixels, 0, 0);
  return canvas;
}

function circleTexture(): Texture {
  const canvas = makeCanvas(64, 64);
  const ctx = context(canvas);
  ctx.beginPath();
  ctx.arc(32, 32, 31, 0, Math.PI * 2);
  ctx.fillStyle = "#fff";
  ctx.fill();
  return Texture.from(canvas);
}

export async function loadAssets(onProgress?: (fraction: number) => void): Promise<GameAssets> {
  const brushes = new Map<number, BrushLayers>();
  const brushSource = await loadImage(`${ASSET_BASE}/icons/bria-rmbg3-cutout.png`);
  for (let index = 0; index < PAINT_PALETTE.length; index += 1) {
    const built = buildBrushIcon(brushSource, index);
    brushes.set(index, swingLayers(built.icon));
    onProgress?.((index + 1) / (PAINT_PALETTE.length + PRIZE_KINDS.length + 3));
  }

  const prizeIcons = new Map<PrizeKind, Texture>();
  for (const kind of PRIZE_KINDS) {
    const image = await loadImage(`${ASSET_BASE}/icons/${kind}.png`);
    prizeIcons.set(kind, Texture.from(prizeIconCanvas(image)));
  }
  onProgress?.((PAINT_PALETTE.length + PRIZE_KINDS.length) / (PAINT_PALETTE.length + PRIZE_KINDS.length + 3));

  const [music, volume, background] = await Promise.all([
    loadImage(`${ASSET_BASE}/icons/music.png`),
    loadImage(`${ASSET_BASE}/icons/volume.png`),
    loadImage(`${ASSET_BASE}/icons/bg.jpg`),
  ]);

  return {
    background: Texture.from(background),
    brushes,
    prizeIcons,
    musicOn: Texture.from(maxTintCanvas(music, 96, [255, 205, 94], false)),
    musicOff: Texture.from(maxTintCanvas(music, 96, [118, 132, 156], true)),
    soundOn: Texture.from(maxTintCanvas(volume, 96, [255, 205, 94], false)),
    soundOff: Texture.from(maxTintCanvas(volume, 96, [118, 132, 156], true)),
    whiteCircle: circleTexture(),
  };
}
