/**
 * Client-side transient effects, ported from `data/effects.py`.
 *
 * The reference draws every effect into one transparent playfield-sized layer,
 * clipped to the arena. This module does the same with one `Graphics` object
 * that is cleared and rebuilt each frame; labels are real `Text` objects drawn
 * above the players, exactly like `draw_labels` runs after the prize.
 */

import { Container, Graphics, Text, TextStyle } from "pixi.js";
import {
  D_WIDTH,
  PAINT_PALETTE,
  PLAYFIELD_BOTTOM,
  PLAYFIELD_TOP,
  RAIN_DELAY,
} from "@flash/core";
import { FONT_FAMILY, FX_SCALE } from "../config";

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
  fat: [[255, 196, 40]],
};

type RGB = [number, number, number];

type FxKind =
  | "drop"
  | "trail"
  | "bubble_fast"
  | "bubble_fat"
  | "ring"
  | "pixel_ring"
  | "flash"
  | "shard"
  | "puff"
  | "burst_star"
  | "star"
  | "label";

interface Fx {
  kind: FxKind;
  x: number;
  y: number;
  color: RGB;
  life: number;
  size: number;
  vx: number;
  vy: number;
  age: number;
  delay: number;
  text: string;
  body?: Text;
  shadow?: Text;
}

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

interface Tracker {
  x: number;
  y: number;
  accumulator: number;
  swingPhase: number;
  swingAngle: number;
}

/** Exact port of `_shift_hue`. */
export function shiftHue(rgb: readonly [number, number, number], degrees: number): RGB {
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

function paletteColor(index: number): RGB {
  const rgb = PAINT_PALETTE[index]?.rgb ?? PAINT_PALETTE[0]!.rgb;
  return [rgb[0], rgb[1], rgb[2]];
}

function lighten(color: RGB, amount: number): RGB {
  return [
    Math.min(255, color[0] + Math.round((255 - color[0]) * amount)),
    Math.min(255, color[1] + Math.round((255 - color[1]) * amount)),
    Math.min(255, color[2] + Math.round((255 - color[2]) * amount)),
  ];
}

function playfieldMask(): Graphics {
  return new Graphics()
    .rect(0, PLAYFIELD_TOP, D_WIDTH, PLAYFIELD_BOTTOM - PLAYFIELD_TOP)
    .fill(0xffffff);
}

function polygon(graphics: Graphics, points: ReadonlyArray<readonly [number, number]>): void {
  const first = points[0]!;
  graphics.moveTo(first[0], first[1]);
  for (let index = 1; index < points.length; index += 1) {
    const point = points[index]!;
    graphics.lineTo(point[0], point[1]);
  }
  graphics.closePath();
}

export class EffectsManager {
  readonly container = new Container();
  /** Labels live above players and the prize, like `draw_labels` in the loop. */
  readonly labels = new Container();
  private readonly graphics = new Graphics();
  private readonly items: Fx[] = [];
  private readonly trackers = new Map<string, Tracker>();
  private trailPhase = 0;
  private elapsed = 0;

  constructor() {
    const mask = playfieldMask();
    this.container.addChild(this.graphics, mask);
    this.container.mask = mask;
    this.container.eventMode = "none";

    const labelMask = playfieldMask();
    this.labels.addChild(labelMask);
    this.labels.mask = labelMask;
    this.labels.eventMode = "none";
  }

  clear(): void {
    for (const fx of this.items) this.destroyText(fx);
    this.items.length = 0;
    this.graphics.clear();
    this.trackers.clear();
    this.trailPhase = 0;
    this.elapsed = 0;
  }

  private destroyText(fx: Fx): void {
    if (fx.body) {
      this.labels.removeChild(fx.body);
      fx.body.destroy();
      fx.body = undefined;
    }
    if (fx.shadow) {
      this.labels.removeChild(fx.shadow);
      fx.shadow.destroy();
      fx.shadow = undefined;
    }
  }

  private removeAt(index: number): void {
    const [fx] = this.items.splice(index, 1);
    if (fx) this.destroyText(fx);
  }

  private countKind(predicate: (fx: Fx) => boolean): number {
    let total = 0;
    for (const fx of this.items) if (predicate(fx)) total += 1;
    return total;
  }

  private dropFirst(predicate: (fx: Fx) => boolean): boolean {
    const index = this.items.findIndex(predicate);
    if (index < 0) return false;
    this.removeAt(index);
    return true;
  }

  private isLimited(fx: Fx): boolean {
    return fx.kind === "trail" || fx.kind === "bubble_fast" || fx.kind === "bubble_fat";
  }

  add(
    kind: FxKind,
    x: number,
    y: number,
    color: readonly [number, number, number],
    life: number,
    size: number,
    vx = 0,
    vy = 0,
    delay = 0,
    text = "",
  ): void {
    if (kind === "trail") {
      if (this.countKind((fx) => fx.kind === "trail") >= MAX_TRAIL_EFFECTS) {
        this.dropFirst((fx) => fx.kind === "trail");
      }
    } else if (kind === "bubble_fast" || kind === "bubble_fat") {
      if (
        this.countKind((fx) => fx.kind === "bubble_fast" || fx.kind === "bubble_fat") >=
        MAX_BUBBLE_EFFECTS
      ) {
        this.dropFirst((fx) => fx.kind === "bubble_fast" || fx.kind === "bubble_fat");
      }
    }

    if (this.items.length >= MAX_EFFECTS) {
      if (!this.dropFirst((fx) => this.isLimited(fx))) return;
    }

    const fx: Fx = {
      kind,
      x,
      y,
      color: [color[0], color[1], color[2]],
      life,
      size,
      vx,
      vy,
      age: 0,
      delay,
      text,
    };

    if (kind === "label") {
      const fontSize = Math.max(12, Math.round(size));
      const body = new Text({
        text,
        style: new TextStyle({
          fontFamily: FONT_FAMILY,
          fontSize,
          fontWeight: "700",
          fill: rgbNumber(fx.color),
        }),
      });
      body.anchor.set(0.5);
      const shadow = new Text({
        text,
        style: new TextStyle({
          fontFamily: FONT_FAMILY,
          fontSize,
          fontWeight: "700",
          fill: 0x101521,
        }),
      });
      shadow.anchor.set(0.5);
      body.position.set(x, y);
      shadow.position.set(x + 2, y + 2);
      this.labels.addChild(shadow, body);
      fx.body = body;
      fx.shadow = shadow;
    }

    this.items.push(fx);
  }

  burst(x: number, y: number, color: readonly [number, number, number], count = 10, speed = 150, delay = 0): void {
    for (let index = 0; index < count; index += 1) {
      const angle = Math.random() * Math.PI * 2;
      const velocity = (speed * (0.35 + Math.random() * 0.65)) * FX_SCALE;
      this.add(
        "drop",
        x,
        y,
        color,
        0.2 + Math.random() * 0.2,
        (2 + Math.random() * 3) * FX_SCALE,
        Math.cos(angle) * velocity,
        Math.sin(angle) * velocity,
        delay,
      );
    }
  }

  pickup(x: number, y: number, colorIndex: number): void {
    const color = paletteColor(colorIndex);
    this.add("ring", x, y, color, 0.32, 48 * FX_SCALE);
    this.burst(x, y, color, 12);
  }

  punch(x: number, y: number, colorIndex: number): void {
    const color = paletteColor(colorIndex);
    this.add("star", x, y, [255, 227, 130], 0.2, 40 * FX_SCALE);
    this.burst(x, y, color, 16, 260);
  }

  explosion(x: number, y: number, color: RGB, radius = 40, delay = 0): void {
    const large = radius >= 80;
    this.add("pixel_ring", x, y, [120, 64, 18], 0.34, radius * 1.45, 0, 0, delay);
    this.add("pixel_ring", x, y, [255, 214, 90], 0.3, radius * 1.3, 0, 0, delay);
    this.add("burst_star", x, y, [255, 200, 50], 0.22, radius * (large ? 1 : 0.8), 0, 0, delay);
    if (large) {
      this.add("pixel_ring", x, y, [230, 120, 30], 0.26, radius * 0.75, 0, 0, delay);
      this.add("flash", x, y, [255, 248, 205], 0.15, radius * 0.22, 0, 0, delay);
    }

    const shardColors: RGB[] = [
      [255, 200, 50],
      [230, 120, 30],
      [255, 240, 190],
      color,
    ];
    const count = large ? 16 : 4;
    const sizeScale = large ? 1.6 : 1;
    const speedScale = large ? 1.8 : 1;
    for (let index = 0; index < count; index += 1) {
      const angle = (index * Math.PI * 2) / count + (Math.random() * 0.5 - 0.25);
      const speed = (100 + Math.random() * 160) * FX_SCALE * speedScale;
      this.add(
        "shard",
        x,
        y,
        shardColors[index % shardColors.length]!,
        0.25 + Math.random() * 0.2,
        (3 + Math.random() * 3) * FX_SCALE * sizeScale,
        Math.cos(angle) * speed,
        Math.sin(angle) * speed,
        delay,
      );
    }

    const puffs = large ? 5 : 1;
    for (let index = 0; index < puffs; index += 1) {
      const angle = Math.random() * Math.PI * 2;
      const speed = (20 + Math.random() * 50) * FX_SCALE;
      this.add(
        "puff",
        x + (Math.random() * 2 - 1) * radius * 0.18,
        y + (Math.random() * 2 - 1) * radius * 0.18,
        [140, 74, 24],
        0.35 + Math.random() * 0.25,
        radius * (large ? 0.38 : 0.3),
        Math.cos(angle) * speed,
        Math.sin(angle) * speed,
        delay,
      );
    }
  }

  boom(x: number, y: number, colorIndex: number, radius = 200): void {
    this.explosion(x, y, paletteColor(colorIndex), radius);
  }

  rain(
    drops: ReadonlyArray<{ x: number; y: number }>,
    colorIndex: number,
    radius = 36,
  ): void {
    const color = paletteColor(colorIndex);
    drops.forEach((drop, index) => {
      const delay = RAIN_DELAY * index;
      this.add("pixel_ring", drop.x, drop.y, color, 0.2, radius, 0, 0, delay);
      this.explosion(drop.x, drop.y, color, radius, delay);
    });
  }

  label(x: number, y: number, colorIndex: number, text: string): void {
    this.add(
      "label",
      x,
      y - 26 * FX_SCALE,
      paletteColor(colorIndex),
      1,
      Math.max(16, Math.round(26 * FX_SCALE)),
      0,
      -46 * FX_SCALE,
      0,
      text,
    );
  }

  ripple(x: number, y: number, colorIndex: number): void {
    const color = paletteColor(colorIndex);
    this.add("ring", x, y, color, 0.34, 30 * FX_SCALE);
    this.add("ring", x, y, color, 0.5, 44 * FX_SCALE, 0, 0, 0.07);
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
          ? Math.max(special === "fast" ? 3 : 10, player.radius * (special === "fast" ? 0.3 : 0.7))
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
            this.add(
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
    const accent =
      BUBBLE_COLORS[mode][Math.floor(Math.random() * BUBBLE_COLORS[mode].length)]!;
    const base = paletteColor(player.colorIndex);
    const color: RGB = [
      Math.round(accent[0] * 0.65 + base[0] * 0.35),
      Math.round(accent[1] * 0.65 + base[1] * 0.35),
      Math.round(accent[2] * 0.65 + base[2] * 0.35),
    ];
    const perpX = -directionY;
    const perpY = directionX;
    if (mode === "fast") {
      const jitter = Math.random() * 24 - 12;
      this.add(
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
      this.add("bubble_fat", x, y, color, 0.62, size);
    }
  }

  swingAngle(name: string): number {
    return this.trackers.get(name)?.swingAngle ?? 0;
  }

  update(dt: number): void {
    const stepDt = Math.max(0, dt);
    this.elapsed += stepDt;
    this.graphics.clear();

    const alive: Fx[] = [];
    for (const fx of this.items) {
      let activeDt = stepDt;
      if (fx.delay > 0) {
        fx.delay -= stepDt;
        if (fx.delay > 0) {
          alive.push(fx);
          continue;
        }
        activeDt = -fx.delay;
        fx.delay = 0;
      }

      fx.age += activeDt;
      if (fx.age >= fx.life) {
        this.destroyText(fx);
        continue;
      }

      fx.x += fx.vx * activeDt;
      fx.y += fx.vy * activeDt;

      if (fx.kind === "drop") {
        const damp = Math.exp(-5 * activeDt);
        fx.vx *= damp;
        fx.vy *= damp;
      } else if (fx.kind === "shard") {
        const damp = Math.exp(-4 * activeDt);
        fx.vx *= damp;
        fx.vy *= damp;
      } else if (fx.kind === "puff") {
        const damp = Math.exp(-2.5 * activeDt);
        fx.vx *= damp;
        fx.vy *= damp;
      } else if (fx.kind === "bubble_fast") {
        const damp = Math.exp(-4 * activeDt);
        fx.vx *= damp;
        fx.vy *= damp;
      }

      if (fx.kind === "label") {
        this.updateLabel(fx);
      } else {
        this.drawFx(fx);
      }
      alive.push(fx);
    }
    this.items.length = 0;
    this.items.push(...alive);
  }

  private updateLabel(fx: Fx): void {
    const progress = fx.age / fx.life;
    const fade = 1 - Math.max(0, (progress - 0.45) / 0.55);
    const alpha = Math.max(0, Math.min(255, Math.round(255 * fade)));
    if (fx.body) {
      fx.body.position.set(fx.x, fx.y);
      fx.body.alpha = alpha / 255;
      fx.body.visible = alpha > 0;
    }
    if (fx.shadow) {
      fx.shadow.position.set(fx.x + 2, fx.y + 2);
      fx.shadow.alpha = Math.min(alpha, 190) / 255;
      fx.shadow.visible = alpha > 0;
    }
  }

  private drawFx(fx: Fx): void {
    const g = this.graphics;
    const progress = Math.min(1, fx.age / fx.life);
    const alpha = Math.round(220 * (1 - progress)) / 255;
    if (alpha <= 0) return;
    const color = fx.color;
    const x = fx.x;
    const y = fx.y;

    if (fx.kind === "drop") {
      const radius = Math.max(1, Math.round(fx.size * (1 - progress * 0.6)));
      g.circle(x, y, radius).fill({ color: rgbNumber(color), alpha });
      return;
    }

    if (fx.kind === "trail") {
      const remaining = Math.max(0, 1 - progress);
      const scaled = remaining ** 0.85;
      const radius = Math.round(fx.size * scaled);
      if (radius < 1) return;
      const trailAlpha = Math.max(0, Math.min(230, Math.round(230 * remaining ** 0.7))) / 255;
      const shifted = shiftHue(color, progress * 38);
      const glowRadius = radius + Math.max(1, Math.round(2.5 * FX_SCALE));
      g.circle(x, y, glowRadius).fill({
        color: rgbNumber(shifted),
        alpha: trailAlpha * 0.28,
      });
      g.circle(x, y, radius).fill({
        color: rgbNumber(lighten(shifted, 0.22)),
        alpha: trailAlpha,
      });
      if (radius >= 3) {
        const offset = Math.max(1, Math.floor(radius / 4));
        g.circle(x - offset, y - offset, Math.max(1, Math.round(radius * 0.45))).fill({
          color: rgbNumber(lighten(shifted, 0.72)),
          alpha: Math.min(245, Math.round(trailAlpha * 255 * 0.95)) / 255,
        });
      }
      if (radius >= 2) {
        const ringColor: RGB = [
          Math.round(color[0] * 0.45),
          Math.round(color[1] * 0.45),
          Math.round(color[2] * 0.45),
        ];
        g.circle(x, y, radius).stroke({
          width: Math.max(1, Math.round(1.5 * FX_SCALE)),
          color: rgbNumber(ringColor),
          alpha: Math.min(240, Math.round(trailAlpha * 255 * 0.85)) / 255,
        });
      }
      return;
    }

    if (fx.kind === "bubble_fast") {
      const remaining = Math.max(0, 1 - progress);
      const bubbleAlpha = Math.min(235, Math.round(235 * remaining ** 0.7)) / 255;
      const speed = Math.hypot(fx.vx, fx.vy);
      const ux = speed > 0.001 ? fx.vx / speed : 1;
      const uy = speed > 0.001 ? fx.vy / speed : 0;
      const px = -uy;
      const py = ux;
      const length = fx.size * (1.1 + 1.4 * remaining);
      const width = fx.size * (0.35 + 0.25 * remaining);
      const tip: [number, number] = [x + ux * length, y + uy * length];
      const tail: [number, number] = [x - ux * length * 0.7, y - uy * length * 0.7];
      const left: [number, number] = [x + px * width, y + py * width];
      const right: [number, number] = [x - px * width, y - py * width];
      polygon(g, [tip, left, tail, right]);
      g.fill({ color: rgbNumber(lighten(color, 0.35)), alpha: bubbleAlpha });
      g.moveTo(tail[0], tail[1]).lineTo(tip[0], tip[1]).stroke({
        width: Math.max(1, Math.round(1.2 * FX_SCALE)),
        color: 0xffffff,
        alpha: bubbleAlpha,
      });
      return;
    }

    if (fx.kind === "bubble_fat") {
      const remaining = Math.max(0, 1 - progress);
      if (remaining <= 0) return;
      const bubbleAlpha = Math.min(235, Math.round(235 * remaining ** 0.7)) / 255;
      const radius = Math.max(2, Math.round(fx.size * (0.28 + 0.72 * progress)));
      const border = Math.max(1, Math.round(1.4 * FX_SCALE));
      const thickness = Math.max(2, Math.round(radius * 0.38));
      g.circle(x, y, radius + border).stroke({
        width: thickness + 2 * border,
        color: 0x703e06,
        alpha: bubbleAlpha,
      });
      g.circle(x, y, radius).stroke({
        width: thickness,
        color: 0xffc428,
        alpha: bubbleAlpha,
      });
      if (thickness >= 4) {
        g.circle(x, y, Math.max(1, radius - Math.floor(thickness / 2))).stroke({
          width: Math.max(1, Math.round(thickness * 0.32)),
          color: 0xfff6a8,
          alpha: bubbleAlpha * 0.9,
        });
      }
      return;
    }

    if (fx.kind === "ring") {
      const eased = 1 - (1 - progress) ** 3;
      const radius = Math.max(1, Math.round(fx.size * eased));
      const width = Math.min(radius, Math.max(1, Math.round(3 * FX_SCALE)));
      g.circle(x, y, radius).stroke({ width, color: rgbNumber(color), alpha });
      return;
    }

    if (fx.kind === "pixel_ring") {
      const eased = 1 - (1 - progress) ** 3;
      const radius = Math.max(1, Math.round(fx.size * eased));
      const width = Math.min(radius, Math.max(1, Math.round(3 * FX_SCALE)));
      polygon(g, [
        [x, y - radius],
        [x + radius, y],
        [x, y + radius],
        [x - radius, y],
      ]);
      g.stroke({ width, color: rgbNumber(color), alpha });
      return;
    }

    if (fx.kind === "flash") {
      const size = Math.max(1, Math.round(fx.size * (1 - progress * 0.3)));
      const thickness = Math.max(1, Math.round(Math.max(2, fx.size * 0.35)));
      g.rect(x - size - 2, y - thickness - 2, size * 2 + 4, thickness * 2 + 4).fill({
        color: 0x50280c,
        alpha,
      });
      g.rect(x - thickness - 2, y - size - 2, thickness * 2 + 4, size * 2 + 4).fill({
        color: 0x50280c,
        alpha,
      });
      g.rect(x - size, y - thickness, size * 2, thickness * 2).fill({
        color: rgbNumber(color),
        alpha,
      });
      g.rect(x - thickness, y - size, thickness * 2, size * 2).fill({
        color: rgbNumber(color),
        alpha,
      });
      const core = Math.max(1, Math.round(Math.max(2, fx.size * 0.22)));
      g.rect(x - core, y - core, core * 2, core * 2).fill({ color: 0xffffeb, alpha });
      return;
    }

    if (fx.kind === "shard") {
      const size = Math.max(1, Math.round(fx.size * (1 - progress * 0.55)));
      g.rect(x - size, y - size, size * 2, size * 2).fill({
        color: rgbNumber(color),
        alpha,
      });
      if (size >= 2) {
        g.rect(x - size, y - size, size * 2, size * 2).stroke({
          width: Math.max(1, Math.round(FX_SCALE)),
          color: 0x46240c,
          alpha,
        });
      }
      return;
    }

    if (fx.kind === "puff") {
      const radius = Math.max(1, Math.round(fx.size * (0.45 + progress * 1.1)));
      polygon(g, [
        [x, y - radius],
        [x + radius, y],
        [x, y + radius],
        [x - radius, y],
      ]);
      g.fill({ color: 0x50280c, alpha });
      if (radius > 2) {
        const inner = Math.max(1, Math.round(radius * 0.7));
        polygon(g, [
          [x, y - inner],
          [x + inner, y],
          [x, y + inner],
          [x - inner, y],
        ]);
        g.fill({ color: rgbNumber(color), alpha });
        const core = Math.max(1, Math.round(radius * 0.3));
        g.rect(x - core, y - core, core * 2, core * 2).fill({ color: 0xffbe3c, alpha });
      }
      return;
    }

    if (fx.kind === "burst_star") {
      const radius = fx.size * (0.75 + progress * 0.6);
      const outer: Array<[number, number]> = [];
      const inner: Array<[number, number]> = [];
      for (let index = 0; index < 8; index += 1) {
        const angle = (index * Math.PI) / 4 + progress * 0.3;
        const length = index % 2 === 0 ? radius : radius * 0.32;
        outer.push([x + Math.cos(angle) * length, y + Math.sin(angle) * length]);
        const innerLength = index % 2 === 0 ? radius * 0.72 : radius * 0.22;
        inner.push([x + Math.cos(angle) * innerLength, y + Math.sin(angle) * innerLength]);
      }
      polygon(g, outer);
      g.fill({ color: 0x50280c, alpha });
      polygon(g, inner);
      g.fill({ color: rgbNumber(color), alpha });
      const core = Math.max(1, Math.round(radius * 0.28));
      g.rect(x - core, y - core, core * 2, core * 2).fill({ color: 0xffffeb, alpha });
      return;
    }

    if (fx.kind === "star") {
      const radius = fx.size * (0.65 + progress * 0.35);
      const points: Array<[number, number]> = [];
      for (let index = 0; index < 16; index += 1) {
        const angle = (index * Math.PI) / 8;
        const length = index % 2 === 0 ? radius : radius * 0.4;
        points.push([x + Math.cos(angle) * length, y + Math.sin(angle) * length]);
      }
      polygon(g, points);
      g.fill({ color: rgbNumber(color), alpha });
    }
  }
}
