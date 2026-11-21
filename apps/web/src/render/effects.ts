/**
 * Client-side transient effects. Cosmetic only: the server never needs these.
 * Caps mirror `data/effects.py` (420 total, 180 trails, 120 bubbles).
 */

import { Container, Graphics, Sprite, Text, TextStyle, type Texture } from "pixi.js";
import { PAINT_PALETTE } from "@flash/core";
import { FONT_FAMILY } from "../config";

export const MAX_EFFECTS = 420;
export const MAX_TRAIL_EFFECTS = 180;
export const MAX_BUBBLE_EFFECTS = 120;
const TRAIL_LIFETIME = 0.45;
const TRAIL_SPACING_FACTOR = 1.4;
const TRAIL_RADIUS_FACTOR = 0.36;
const TRAIL_OFFSET_FACTOR = 1.15;
const BUBBLE_SPACING: Record<"fast" | "fat", number> = { fast: 2.2, fat: 0.8 };
const BUBBLE_COLORS: Record<"fast" | "fat", ReadonlyArray<readonly [number, number, number]>> = {
  fast: [
    [120, 240, 255],
    [255, 235, 120],
    [185, 255, 255],
  ],
  fat: [
    [255, 196, 40],
    [255, 236, 120],
    [255, 170, 40],
  ],
};

export interface ObserveState {
  name: string;
  x: number;
  y: number;
  radius: number;
  colorIndex: number;
  jumping: boolean;
  beaten: boolean;
  brokenVisual: boolean;
  knockback: boolean;
  modeStep: number;
  powerup: string | null;
}

interface CircleFx {
  sprite: Sprite;
  kind: "trail" | "bubble_fast" | "bubble_fat" | "drop" | "spark";
  age: number;
  life: number;
  size: number;
  color: [number, number, number];
  vx: number;
  vy: number;
  delay: number;
}

interface RingFx {
  graphics: Graphics;
  kind: "ring" | "boom" | "smash" | "punch";
  age: number;
  life: number;
  size: number;
  color: [number, number, number];
  delay: number;
  thickness: number;
}

interface LabelFx {
  text: Text;
  age: number;
  life: number;
  vy: number;
}

interface Tracker {
  x: number;
  y: number;
  accumulator: number;
  swingPhase: number;
  swingAngle: number;
}

/** Exact port of `_shift_hue`. */
export function shiftHue(rgb: readonly [number, number, number], degrees: number): [number, number, number] {
  const r = rgb[0] / 255;
  const g = rgb[1] / 255;
  const b = rgb[2] / 255;
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  const diff = mx - mn;
  let h = 0;
  if (diff !== 0) {
    if (mx === r) h = (((g - b) / diff) % 6 + 6) % 6;
    else if (mx === g) h = (b - r) / diff + 2;
    else h = (r - g) / diff + 4;
  }
  h = ((h * 60 + degrees) % 360 + 360) % 360;
  const s = mx === 0 ? 0 : diff / mx;
  const v = Math.min(1, mx * 1.05);
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  let r1 = 0;
  let g1 = 0;
  let b1 = 0;
  if (h < 60) [r1, g1, b1] = [c, x, 0];
  else if (h < 120) [r1, g1, b1] = [x, c, 0];
  else if (h < 180) [r1, g1, b1] = [0, c, x];
  else if (h < 240) [r1, g1, b1] = [0, x, c];
  else if (h < 300) [r1, g1, b1] = [x, 0, c];
  else [r1, g1, b1] = [c, 0, x];
  return [
    clampByte(Math.round((r1 + m) * 255)),
    clampByte(Math.round((g1 + m) * 255)),
    clampByte(Math.round((b1 + m) * 255)),
  ];
}

function clampByte(value: number): number {
  return Math.max(0, Math.min(255, value));
}

function rgbNumber(color: readonly [number, number, number]): number {
  return (color[0] << 16) | (color[1] << 8) | color[2];
}

function paletteColor(index: number): [number, number, number] {
  const rgb = PAINT_PALETTE[index]?.rgb ?? PAINT_PALETTE[0]!.rgb;
  return [rgb[0], rgb[1], rgb[2]];
}

export class EffectsManager {
  readonly container = new Container();
  private readonly circleTexture: Texture;
  private readonly circles: CircleFx[] = [];
  private readonly rings: RingFx[] = [];
  private readonly labels: LabelFx[] = [];
  private readonly spritePool: Sprite[] = [];
  private readonly graphicsPool: Graphics[] = [];
  private readonly trackers = new Map<string, Tracker>();
  private trailPhase = 0;
  private elapsed = 0;

  constructor(circleTexture: Texture) {
    this.circleTexture = circleTexture;
    this.container.eventMode = "none";
  }

  clear(): void {
    for (const fx of this.circles) this.releaseCircle(fx);
    this.circles.length = 0;
    for (const fx of this.rings) this.releaseRing(fx);
    this.rings.length = 0;
    for (const fx of this.labels) {
      this.container.removeChild(fx.text);
      fx.text.destroy();
    }
    this.labels.length = 0;
    this.trackers.clear();
    this.trailPhase = 0;
    this.elapsed = 0;
  }

  private effectCount(): number {
    return this.circles.length + this.rings.length + this.labels.length;
  }

  private countKind(kind: CircleFx["kind"]): number {
    let total = 0;
    for (const fx of this.circles) if (fx.kind === kind) total += 1;
    return total;
  }

  private acquireSprite(): Sprite {
    const sprite = this.spritePool.pop() ?? new Sprite(this.circleTexture);
    sprite.anchor.set(0.5);
    sprite.visible = true;
    this.container.addChild(sprite);
    return sprite;
  }

  private acquireGraphics(): Graphics {
    const graphics = this.graphicsPool.pop() ?? new Graphics();
    graphics.visible = true;
    graphics.alpha = 1;
    this.container.addChild(graphics);
    return graphics;
  }

  private releaseCircle(fx: CircleFx): void {
    this.container.removeChild(fx.sprite);
    fx.sprite.visible = false;
    this.spritePool.push(fx.sprite);
  }

  private releaseRing(fx: RingFx): void {
    this.container.removeChild(fx.graphics);
    fx.graphics.clear();
    fx.graphics.visible = false;
    this.graphicsPool.push(fx.graphics);
  }

  private trimForKind(kind: CircleFx["kind"]): boolean {
    const trail = kind === "trail";
    const bubble = kind === "bubble_fast" || kind === "bubble_fat";
    if (trail && this.countKind("trail") >= MAX_TRAIL_EFFECTS) {
      const index = this.circles.findIndex((fx) => fx.kind === "trail");
      if (index >= 0) {
        this.releaseCircle(this.circles[index]!);
        this.circles.splice(index, 1);
      }
    }
    if (bubble) {
      const count = this.countKind("bubble_fast") + this.countKind("bubble_fat");
      if (count >= MAX_BUBBLE_EFFECTS) {
        const index = this.circles.findIndex(
          (fx) => fx.kind === "bubble_fast" || fx.kind === "bubble_fat",
        );
        if (index >= 0) {
          this.releaseCircle(this.circles[index]!);
          this.circles.splice(index, 1);
        }
      }
    }
    if (this.effectCount() >= MAX_EFFECTS) {
      const index = this.circles.findIndex(
        (fx) =>
          fx.kind === "trail" || fx.kind === "bubble_fast" || fx.kind === "bubble_fat",
      );
      if (index >= 0) {
        this.releaseCircle(this.circles[index]!);
        this.circles.splice(index, 1);
      } else {
        return false;
      }
    }
    return true;
  }

  addCircle(
    kind: CircleFx["kind"],
    x: number,
    y: number,
    color: [number, number, number],
    life: number,
    size: number,
    vx = 0,
    vy = 0,
    delay = 0,
  ): void {
    if (!this.trimForKind(kind)) return;
    const sprite = this.acquireSprite();
    sprite.position.set(x, y);
    sprite.tint = rgbNumber(color);
    sprite.alpha = 0;
    sprite.scale.set((size * 2) / 64);
    this.circles.push({ sprite, kind, age: 0, life, size, color, vx, vy, delay });
  }

  addRing(
    kind: RingFx["kind"],
    x: number,
    y: number,
    color: [number, number, number],
    life: number,
    size: number,
    thickness = 6,
    delay = 0,
  ): void {
    if (this.effectCount() >= MAX_EFFECTS) return;
    const graphics = this.acquireGraphics();
    graphics.position.set(x, y);
    this.rings.push({ graphics, kind, age: 0, life, size, color, delay, thickness });
  }

  label(x: number, y: number, colorIndex: number, text: string): void {
    if (this.effectCount() >= MAX_EFFECTS) return;
    const color = paletteColor(colorIndex);
    const size = 26;
    const style = new TextStyle({
      fontFamily: FONT_FAMILY,
      fontSize: size,
      fontWeight: "700",
      fill: rgbNumber(color),
      stroke: { color: 0x101521, width: 4 },
      dropShadow: { color: 0x060b14, alpha: 0.75, blur: 4, distance: 2, angle: Math.PI / 2 },
    });
    const label = new Text({ text, style });
    label.anchor.set(0.5);
    label.position.set(x, y - 26);
    this.container.addChild(label);
    this.labels.push({ text: label, age: 0, life: 1, vy: -46 });
  }

  ripple(x: number, y: number, colorIndex: number): void {
    this.addRing("ring", x, y, paletteColor(colorIndex), 0.34, 30, 5);
  }

  punch(x: number, y: number, colorIndex: number): void {
    const color = paletteColor(colorIndex);
    this.addRing("punch", x, y, color, 0.4, 90, 10);
    for (let i = 0; i < 10; i += 1) {
      const angle = (i / 10) * Math.PI * 2;
      const speed = 180 + Math.random() * 120;
      this.addCircle(
        "spark",
        x,
        y,
        shiftHue(color, 20),
        0.4,
        7 + Math.random() * 5,
        Math.cos(angle) * speed,
        Math.sin(angle) * speed,
      );
    }
  }

  smash(x: number, y: number): void {
    this.addRing("smash", x, y, [255, 224, 118], 0.42, 120, 12);
    for (let i = 0; i < 14; i += 1) {
      const angle = (i / 14) * Math.PI * 2;
      const speed = 150 + Math.random() * 180;
      this.addCircle(
        "spark",
        x,
        y,
        [255, 205, 94],
        0.5,
        6 + Math.random() * 6,
        Math.cos(angle) * speed,
        Math.sin(angle) * speed,
      );
    }
  }

  pickup(x: number, y: number, colorIndex: number): void {
    const color = paletteColor(colorIndex);
    this.addRing("ring", x, y, color, 0.5, 70, 8);
    for (let i = 0; i < 8; i += 1) {
      const angle = (i / 8) * Math.PI * 2;
      this.addCircle(
        "spark",
        x,
        y,
        [255, 236, 150],
        0.55,
        6,
        Math.cos(angle) * 140,
        Math.sin(angle) * 140,
      );
    }
  }

  boom(x: number, y: number, colorIndex: number, radius = 200): void {
    const color = paletteColor(colorIndex);
    this.addRing("boom", x, y, color, 0.6, radius, 22);
    this.addRing("ring", x, y, shiftHue(color, 40), 0.75, radius * 0.7, 10, 0.05);
    for (let i = 0; i < 22; i += 1) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 200 + Math.random() * 420;
      this.addCircle(
        "spark",
        x,
        y,
        shiftHue(color, Math.random() * 80 - 40),
        0.6,
        8 + Math.random() * 10,
        Math.cos(angle) * speed,
        Math.sin(angle) * speed,
      );
    }
  }

  rain(drops: ReadonlyArray<{ x: number; y: number }>, colorIndex: number, radius = 36): void {
    const color = paletteColor(colorIndex);
    drops.forEach((drop, index) => {
      const delay = 0.05 * index;
      this.addRing("ring", drop.x, drop.y, color, 0.2, radius, 5, delay);
      this.addCircle("drop", drop.x, drop.y, shiftHue(color, 20), 0.32, radius * 0.8, 0, 0, delay);
    });
  }

  observe(players: readonly ObserveState[], dt: number): void {
    const step = Math.max(0, Math.min(dt, 0.1));
    const sharedJump = players.some((player) => player.jumping);

    for (const player of players) {
      const current = { x: player.x, y: player.y };
      let tracker = this.trackers.get(player.name);
      if (!tracker) {
        tracker = {
          x: current.x,
          y: current.y,
          accumulator: 0,
          swingPhase: player.name === "Player_A" ? 0 : Math.PI,
          swingAngle: 0,
        };
        this.trackers.set(player.name, tracker);
      }
      if (player.knockback) {
        // The renderer reports the wall event separately; do not trail across it.
        tracker.x = current.x;
        tracker.y = current.y;
        tracker.accumulator = 0;
      }

      const deltaX = current.x - tracker.x;
      const deltaY = current.y - tracker.y;
      const distance = Math.hypot(deltaX, deltaY);
      const painting =
        !sharedJump &&
        !player.jumping &&
        !player.beaten &&
        !player.brokenVisual &&
        !player.knockback &&
        player.modeStep > 0;
      const teleportLimit = Math.max(80, player.radius * 4);

      if (distance > 0.01 && distance < teleportLimit) {
        tracker.swingPhase += step * 11;
        const target = Math.sin(tracker.swingPhase) * 20;
        tracker.swingAngle += (target - tracker.swingAngle) * Math.min(1, step * 14);
      } else {
        tracker.swingPhase = player.name === "Player_A" ? 0 : Math.PI;
        tracker.swingAngle += (0 - tracker.swingAngle) * Math.min(1, step * 14);
      }

      if (!painting || distance <= 0.01 || distance >= teleportLimit) {
        if (!painting || distance >= teleportLimit) tracker.accumulator = 0;
      } else {
        const directionX = deltaX / distance;
        const directionY = deltaY / distance;
        const special =
          player.powerup === "fat" ? "fat" : player.powerup === "speed" ? "fast" : null;
        const circleRadius = special
          ? Math.max(...[special === "fast" ? 3 : 10, player.radius * (special === "fast" ? 0.3 : 0.7)])
          : Math.max(4, player.radius * TRAIL_RADIUS_FACTOR);
        const spacing = Math.max(
          8,
          circleRadius * (special ? BUBBLE_SPACING[special] : TRAIL_SPACING_FACTOR),
        );
        const offset = special === "fat" ? 0 : player.radius * TRAIL_OFFSET_FACTOR;
        let total = tracker.accumulator + distance;
        const hueOffsets = [-90, -60, -30, 0, 30, 60, 90];

        while (total >= spacing) {
          total -= spacing;
          const sampleX = current.x - directionX * total;
          const sampleY = current.y - directionY * total;
          const spawnX = sampleX - directionX * offset;
          const spawnY = sampleY - directionY * offset;
          if (!special) {
            const hue = hueOffsets[this.trailPhase % hueOffsets.length]!;
            this.trailPhase += 1;
            this.addCircle(
              "trail",
              spawnX,
              spawnY,
              shiftHue(paletteColor(player.colorIndex), hue),
              TRAIL_LIFETIME,
              circleRadius,
            );
          } else {
            this.spawnBubble(special, spawnX, spawnY, directionX, directionY, player, circleRadius);
          }
        }
        tracker.accumulator = total;
      }

      tracker.x = current.x;
      tracker.y = current.y;
    }
  }

  private spawnBubble(
    mode: "fast" | "fat",
    x: number,
    y: number,
    directionX: number,
    directionY: number,
    player: ObserveState,
    size: number,
  ): void {
    const accent = BUBBLE_COLORS[mode][Math.floor(Math.random() * BUBBLE_COLORS[mode].length)]!;
    const base = paletteColor(player.colorIndex);
    const color: [number, number, number] = [
      Math.round(accent[0] * 0.65 + base[0] * 0.35),
      Math.round(accent[1] * 0.65 + base[1] * 0.35),
      Math.round(accent[2] * 0.65 + base[2] * 0.35),
    ];
    const perpX = -directionY;
    const perpY = directionX;
    if (mode === "fast") {
      const jitter = Math.random() * 24 - 12;
      this.addCircle(
        "bubble_fast",
        x,
        y,
        color,
        0.3,
        size,
        directionX * 60 + perpX * jitter,
        directionY * 60 + perpY * jitter,
      );
    } else {
      this.addCircle("bubble_fat", x, y, color, 0.62, size);
    }
  }

  swingAngle(name: string): number {
    return this.trackers.get(name)?.swingAngle ?? 0;
  }

  update(dt: number): void {
    this.elapsed += dt;
    for (let index = this.circles.length - 1; index >= 0; index -= 1) {
      const fx = this.circles[index]!;
      fx.age += dt;
      if (fx.age < fx.delay) continue;
      const progress = Math.min(1, (fx.age - fx.delay) / fx.life);
      if (progress >= 1) {
        this.releaseCircle(fx);
        this.circles.splice(index, 1);
        continue;
      }
      fx.sprite.x += fx.vx * dt;
      fx.sprite.y += fx.vy * dt;
      if (fx.kind === "trail") {
        const remaining = 1 - progress;
        const scale = Math.max(0.05, Math.pow(remaining, 0.85));
        fx.sprite.scale.set(((fx.size * 2) / 64) * scale);
        fx.sprite.alpha = Math.min(0.92, Math.pow(remaining, 0.7) * 0.92);
        fx.sprite.tint = rgbNumber(shiftHue(fx.color, progress * 38));
      } else if (fx.kind === "bubble_fast" || fx.kind === "bubble_fat") {
        const remaining = 1 - progress;
        fx.sprite.scale.set(((fx.size * 2) / 64) * (0.6 + remaining * 0.6));
        fx.sprite.alpha = remaining * 0.85;
      } else if (fx.kind === "drop") {
        fx.sprite.scale.set(((fx.size * 2) / 64) * (1 - progress * 0.55));
        fx.sprite.alpha = (1 - progress) * 0.9;
      } else {
        fx.sprite.scale.set(((fx.size * 2) / 64) * (1 - progress * 0.4));
        fx.sprite.alpha = (1 - progress) * 0.95;
      }
    }

    for (let index = this.rings.length - 1; index >= 0; index -= 1) {
      const fx = this.rings[index]!;
      fx.age += dt;
      if (fx.age < fx.delay) continue;
      const progress = Math.min(1, (fx.age - fx.delay) / fx.life);
      if (progress >= 1) {
        this.releaseRing(fx);
        this.rings.splice(index, 1);
        continue;
      }
      const radius = fx.kind === "boom" ? fx.size * (0.2 + 0.8 * (1 - Math.pow(1 - progress, 3))) : fx.size * (0.4 + 0.6 * progress);
      const alpha = (1 - progress) * 0.85;
      fx.graphics.clear();
      fx.graphics
        .circle(0, 0, Math.max(1, radius))
        .stroke({ width: Math.max(1, fx.thickness * (1 - progress * 0.5)), color: rgbNumber(fx.color), alpha });
    }

    for (let index = this.labels.length - 1; index >= 0; index -= 1) {
      const fx = this.labels[index]!;
      fx.age += dt;
      const progress = fx.age / fx.life;
      if (progress >= 1) {
        this.container.removeChild(fx.text);
        fx.text.destroy();
        this.labels.splice(index, 1);
        continue;
      }
      fx.text.y += fx.vy * dt;
      fx.text.alpha = progress < 0.45 ? 1 : Math.max(0, 1 - (progress - 0.45) / 0.55);
    }
  }
}
