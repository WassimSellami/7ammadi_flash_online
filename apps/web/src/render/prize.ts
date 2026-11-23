/**
 * Prize icon, rotating halo, spawn burst and expiry pulse, ported from
 * `Prize.show_prize` in `data/prize.py` (8-direction outline included).
 */

import { Container, Graphics, Sprite, type Texture } from "pixi.js";
import type { PrizeKind, PrizeSnapshot } from "@flash/core";

const ICON_TINT = 0xffcd5e;
const GLOW: RGB = [140, 72, 18];
const GLOW_DARK: RGB = [
  Math.max(0, Math.round(GLOW[0] * 0.42)),
  Math.max(0, Math.round(GLOW[1] * 0.42)),
  Math.max(0, Math.round(GLOW[2] * 0.42)),
];
const GLOW_LIGHT: RGB = [
  Math.min(255, Math.round(GLOW[0] + (255 - GLOW[0]) * 0.66)),
  Math.min(255, Math.round(GLOW[1] + (255 - GLOW[1]) * 0.66)),
  Math.min(255, Math.round(GLOW[2] + (255 - GLOW[2]) * 0.66)),
];
const ICON_SIZE = 80;
/** Per-icon display scale: the bomb is drawn 10% smaller than the others. */
const KIND_SCALE: Partial<Record<PrizeKind, number>> = { boom: 0.9 };

type RGB = [number, number, number];

function rgbNumber(color: readonly [number, number, number]): number {
  return (color[0] << 16) | (color[1] << 8) | color[2];
}

export class PrizeView {
  readonly container = new Container();
  private readonly burst = new Graphics();
  private readonly halo = new Graphics();
  private readonly icon = new Sprite();
  private readonly outlines: Sprite[] = [];
  private readonly textures: Map<PrizeKind, Texture>;
  private kind: PrizeKind | null = null;
  private spawnAge = 0;
  private elapsed = 0;
  private x = 0;
  private y = 0;

  constructor(textures: Map<PrizeKind, Texture>) {
    this.textures = textures;
    this.icon.anchor.set(0.5);
    this.container.addChild(this.burst, this.halo);
    for (let index = 0; index < 8; index += 1) {
      const outline = new Sprite();
      outline.anchor.set(0.5);
      outline.visible = false;
      this.outlines.push(outline);
      this.container.addChild(outline);
    }
    this.container.addChild(this.icon);
    this.container.visible = false;
  }

  update(prize: PrizeSnapshot | null, currentTick: number, dt: number): void {
    this.elapsed += dt;
    if (!prize) {
      this.container.visible = false;
      this.kind = null;
      return;
    }
    this.container.visible = true;
    if (this.kind !== prize.kind) {
      this.kind = prize.kind;
      const texture = this.textures.get(prize.kind)!;
      this.icon.texture = texture;
      for (const outline of this.outlines) {
        outline.texture = texture;
        outline.tint = 0x000000;
      }
      this.spawnAge = 0;
    }
    if (this.x !== prize.x || this.y !== prize.y) {
      this.x = prize.x;
      this.y = prize.y;
      this.container.position.set(prize.x, prize.y);
    }
    this.spawnAge += dt;

    const progress = Math.min(1, this.spawnAge / 0.35);
    const c1 = 1.70158;
    const c3 = c1 + 1;
    const pop = 1 + c3 * (progress - 1) ** 3 + c1 * (progress - 1) ** 2;
    let scale = 0.35 + 0.65 * pop;

    const remainingTicks = Math.max(0, prize.endsAt - currentTick);
    const expiring = remainingTicks / 60 <= 2.6;
    if (expiring) {
      scale += 0.07 * (0.5 + 0.5 * Math.sin(this.elapsed * 10));
    }
    scale *= KIND_SCALE[prize.kind] ?? 1;
    this.icon.scale.set(scale);
    this.icon.tint = ICON_TINT;

    const border = Math.max(2, Math.round(ICON_SIZE * scale * 0.05));
    const offsets: Array<[number, number]> = [
      [border, 0],
      [-border, 0],
      [0, border],
      [0, -border],
      [border, border],
      [border, -border],
      [-border, border],
      [-border, -border],
    ];
    for (let index = 0; index < this.outlines.length; index += 1) {
      const outline = this.outlines[index]!;
      outline.visible = true;
      outline.scale.set(scale);
      outline.position.set(offsets[index]![0], offsets[index]![1]);
    }

    this.drawHalo(scale, expiring);
    this.drawBurst(progress);
  }

  private drawHalo(scale: number, expiring: boolean): void {
    this.halo.clear();
    const radius = Math.round(ICON_SIZE * 0.66 * scale);
    if (radius < 6) return;

    const pulse = 0.5 + 0.5 * Math.sin(this.elapsed * 7.5);
    let alpha = Math.round(150 + 55 * pulse);
    if (expiring) alpha = Math.min(255, alpha + 55);
    const globalAlpha = alpha / 255;
    const width = Math.max(2, Math.round(3.2 * scale));
    const angle = ((this.elapsed * 120 * Math.PI) / 180) % (Math.PI * 2);
    const points: Array<[number, number]> = [];
    for (let index = 0; index < 8; index += 1) {
      const pointAngle = angle + (index * Math.PI) / 4;
      const length = index % 2 === 0 ? radius : radius * 0.48;
      points.push([Math.cos(pointAngle) * length, Math.sin(pointAngle) * length]);
    }

    const trace = (): void => {
      this.halo.moveTo(points[0]![0], points[0]![1]);
      for (let index = 1; index < points.length; index += 1) {
        this.halo.lineTo(points[index]![0], points[index]![1]);
      }
      this.halo.closePath();
    };

    trace();
    this.halo.stroke({
      width: width * 4,
      color: rgbNumber(GLOW_DARK),
      alpha: (210 / 255) * globalAlpha,
    });
    trace();
    this.halo.stroke({
      width: width * 2,
      color: rgbNumber(GLOW),
      alpha: (90 / 255) * globalAlpha,
    });
    trace();
    this.halo.stroke({
      width,
      color: rgbNumber(GLOW),
      alpha: globalAlpha,
    });

    const pip = Math.max(1, Math.round(2.5 * scale));
    for (let index = 0; index < 4; index += 1) {
      const pointAngle = angle + (index * Math.PI) / 2;
      this.halo
        .rect(
          Math.cos(pointAngle) * radius - pip,
          Math.sin(pointAngle) * radius - pip,
          pip * 2,
          pip * 2,
        )
        .fill({ color: rgbNumber(GLOW_LIGHT), alpha: (230 / 255) * globalAlpha });
    }
  }

  private drawBurst(progress: number): void {
    this.burst.clear();
    const age = this.spawnAge;
    if (age >= 1.25) return;
    const burstProgress = Math.min(1, age / 1.25);
    const fade = Math.min(1, (1 - burstProgress) / 0.3);
    const maxRadius = Math.max(16, Math.round(ICON_SIZE * 0.72));
    const ease = 1 - (1 - burstProgress) ** 3;
    const radius = Math.round(maxRadius * (0.18 + 0.82 * ease));
    const thickness = Math.max(2, Math.round(ICON_SIZE * 0.14 * (1 - 0.45 * burstProgress)));

    const trace = (r: number): void => {
      this.burst.moveTo(0, -r);
      this.burst.lineTo(r, 0);
      this.burst.lineTo(0, r);
      this.burst.lineTo(-r, 0);
      this.burst.closePath();
    };

    trace(radius);
    this.burst.stroke({
      width: thickness + 3,
      color: rgbNumber(GLOW_DARK),
      alpha: (235 / 255) * fade,
    });
    trace(radius);
    this.burst.stroke({
      width: thickness,
      color: rgbNumber(GLOW),
      alpha: (250 / 255) * fade,
    });

    if (radius > 8) {
      const inner = Math.max(2, Math.floor(radius / 3));
      trace(inner);
      this.burst.stroke({
        width: Math.max(1, Math.floor(thickness / 2)),
        color: rgbNumber(GLOW_LIGHT),
        alpha: (230 / 255) * fade,
      });
    }

    const sparkAlpha = Math.round(245 * fade);
    if (sparkAlpha > 0) {
      const sparkleColor = rgbNumber(GLOW_LIGHT);
      for (let index = 0; index < 8; index += 1) {
        const angle = ((age * 360 + index * 45) * Math.PI) / 180;
        const distance =
          radius + ICON_SIZE * (0.08 + 0.1 * Math.abs(Math.sin(age * 7 + index)));
        const sparkX = Math.cos(angle) * distance;
        const sparkY = Math.sin(angle) * distance;
        const sparkSize = Math.max(1.5, ICON_SIZE * 0.07 * (0.55 + 0.45 * fade));
        const size = Math.max(1, Math.round(sparkSize));
        const bar = Math.max(1, Math.floor(size / 3));
        this.burst.rect(sparkX - size, sparkY - bar, size * 2, bar * 2).fill({
          color: sparkleColor,
          alpha: sparkAlpha / 255,
        });
        this.burst.rect(sparkX - bar, sparkY - size, bar * 2, size * 2).fill({
          color: sparkleColor,
          alpha: sparkAlpha / 255,
        });
        this.burst.rect(sparkX - bar, sparkY - bar, bar * 2, bar * 2).fill({
          color: sparkleColor,
          alpha: Math.min(255, sparkAlpha + 10) / 255,
        });
      }
    }

    if (progress < 0.3) {
      const flash = 1 - progress / 0.3;
      const flashSize = Math.max(1, Math.round(ICON_SIZE * 0.28 * (0.4 + 0.6 * flash)));
      const flashThickness = Math.max(1, Math.round(flashSize * 0.35));
      const flashAlpha = Math.round(220 * flash) / 255;
      this.burst
        .rect(-flashSize, -flashThickness, flashSize * 2, flashThickness * 2)
        .fill({ color: rgbNumber(GLOW_LIGHT), alpha: flashAlpha });
      this.burst
        .rect(-flashThickness, -flashSize, flashThickness * 2, flashSize * 2)
        .fill({ color: rgbNumber(GLOW_LIGHT), alpha: flashAlpha });
    }
  }
}
