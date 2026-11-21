/**
 * Persistent client paint layer.
 *
 * A 960x540 RenderTexture (playfield at 1:2) that is never cleared mid-round.
 * Stamps are hard white circles tinted per palette index and rendered into the
 * texture on the GPU; there are no per-frame CPU canvas uploads.
 */

import { Container, Graphics, RenderTexture, Sprite, Texture, type Renderer } from "pixi.js";
import { PAINT_PALETTE, decodeMaskRle } from "@flash/core";

export const PAINT_TEXTURE_WIDTH = 960;
export const PAINT_TEXTURE_HEIGHT = 540;
export const PAINT_SCALE = 2;

interface StampSource {
  x: number;
  y: number;
  radius: number;
  color: number;
}

export class PaintLayer {
  readonly container = new Container();
  private readonly renderer: Renderer;
  private readonly texture: RenderTexture;
  private readonly sprite: Sprite;
  private readonly brush: Sprite;
  private readonly clearScene = new Container();
  private readonly last = new Map<string, StampSource>();

  constructor(renderer: Renderer, circleTexture: import("pixi.js").Texture) {
    this.renderer = renderer;
    this.texture = RenderTexture.create({
      width: PAINT_TEXTURE_WIDTH,
      height: PAINT_TEXTURE_HEIGHT,
      resolution: 1,
      antialias: true,
    });
    this.sprite = new Sprite(this.texture);
    this.sprite.scale.set(PAINT_SCALE);
    this.container.addChild(this.sprite);

    const mask = new Graphics().rect(0, 74, 1920, 1006).fill(0xffffff);
    this.container.addChild(mask);
    this.sprite.mask = mask;

    this.brush = new Sprite(circleTexture);
    this.brush.anchor.set(0.5);
    this.clear();
  }

  clear(): void {
    this.renderer.render({ container: this.clearScene, target: this.texture, clear: true });
    this.last.clear();
  }

  /**
   * Rebuilds the client paint layer from the server's authoritative mask.
   * Used for late join and reconnect (the live mask is not in snapshots).
   */
  applyMask(width: number, height: number, runs: readonly number[]): void {
    if (width <= 0 || height <= 0 || width * height > 2_000_000) return;
    const cells = decodeMaskRle(runs, width * height);

    const maskCanvas = document.createElement("canvas");
    maskCanvas.width = width;
    maskCanvas.height = height;
    const maskCtx = maskCanvas.getContext("2d");
    if (!maskCtx) return;
    const image = maskCtx.createImageData(width, height);
    const data = image.data;
    for (let index = 0; index < cells.length; index += 1) {
      const value = cells[index]!;
      if (value === 255) continue;
      const rgb = PAINT_PALETTE[value]?.rgb;
      if (!rgb) continue;
      const offset = index * 4;
      data[offset] = rgb[0];
      data[offset + 1] = rgb[1];
      data[offset + 2] = rgb[2];
      data[offset + 3] = 255;
    }
    maskCtx.putImageData(image, 0, 0);

    const target = document.createElement("canvas");
    target.width = 1920 / PAINT_SCALE;
    target.height = 1080 / PAINT_SCALE;
    const targetCtx = target.getContext("2d");
    if (!targetCtx) return;
    targetCtx.imageSmoothingEnabled = false;
    // Cell (x,y) covers 4x4 world px starting at playfield y=74.
    targetCtx.drawImage(
      maskCanvas,
      0,
      74 / PAINT_SCALE,
      width * PAINT_SCALE,
      height * PAINT_SCALE,
    );

    const texture = Texture.from(target);
    const sprite = new Sprite(texture);
    this.renderer.render({ container: sprite, target: this.texture, clear: true });
    sprite.destroy();
    texture.destroy(true);
    this.last.clear();
  }

  /**
   * Stamps from the previously painted position to the current brush position.
   * Called every rendered frame (not every snapshot), so the stroke grows
   * continuously at 60 fps and follows turns without visible circle chunks.
   * A step of half the brush radius still overlaps heavily, so the stroke stays
   * solid while keeping the number of RenderTexture passes low.
   */
  stampTrail(name: string, x: number, y: number, radius: number, color: number): void {
    const previous = this.last.get(name);
    const distance = previous ? Math.hypot(x - previous.x, y - previous.y) : Infinity;
    if (!previous || distance > 420) {
      this.stamp(x, y, radius, color);
      this.last.set(name, { x, y, radius, color });
      return;
    }
    // Idle brushes repaint the same pixels every frame in the reference; skip
    // the GPU pass unless the brush actually moved or changed shape/colour.
    if (distance < 0.01 && previous.radius === radius && previous.color === color) return;
    const dx = x - previous.x;
    const dy = y - previous.y;
    const step = Math.max(4, radius * 0.5);
    const count = Math.max(1, Math.ceil(distance / step));
    for (let i = 1; i <= count; i += 1) {
      const t = i / count;
      this.stamp(previous.x + dx * t, previous.y + dy * t, radius, color);
    }
    this.last.set(name, { x, y, radius, color });
  }

  stamp(x: number, y: number, radius: number, color: number): void {
    if (y + radius < 74) return;
    this.brush.position.set(x / PAINT_SCALE, y / PAINT_SCALE);
    this.brush.tint = color;
    const scale = radius / PAINT_SCALE / 32;
    this.brush.scale.set(scale);
    this.renderer.render({
      container: this.brush,
      target: this.texture,
      clear: false,
    });
  }

  resetPlayer(name: string): void {
    this.last.delete(name);
  }

  /** Prevents a long straight smear after a teleport/knockback snap. */
  snap(name: string, x: number, y: number, radius: number, color: number): void {
    this.last.set(name, { x, y, radius, color });
  }
}
