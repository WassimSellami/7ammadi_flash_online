/**
 * Prize icon, rotating halo, spawn burst and expiry pulse.
 */

import { Container, Graphics, Sprite, type Texture } from "pixi.js";
import type { PrizeKind, PrizeSnapshot } from "@flash/core";

const ICON_TINT = 0xffcd5e;
const GLOW = 0x8c4812;
const GLOW_LIGHT = 0xffe3ac;

export class PrizeView {
  readonly container = new Container();
  private readonly burst = new Graphics();
  private readonly halo = new Graphics();
  private readonly icon = new Sprite();
  private readonly textures: Map<PrizeKind, Texture>;
  private kind: PrizeKind | null = null;
  private spawnAge = 0;
  private elapsed = 0;
  private x = 0;
  private y = 0;

  constructor(textures: Map<PrizeKind, Texture>) {
    this.textures = textures;
    this.icon.anchor.set(0.5);
    this.container.addChild(this.burst, this.halo, this.icon);
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
      this.icon.texture = this.textures.get(prize.kind)!;
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
    this.icon.scale.set(scale);
    this.icon.tint = ICON_TINT;

    this.drawHalo(scale, expiring);
    this.drawBurst(progress);
  }

  private drawHalo(scale: number, expiring: boolean): void {
    this.halo.clear();
    const base = 80;
    let radius = Math.round(base * 0.66 * scale);
    if (radius < 6) return;
    const pulse = 0.5 + 0.5 * Math.sin(this.elapsed * 7.5);
    const alpha = (expiring ? 205 : 150) + 55 * pulse;
    const width = Math.max(2, 3.2 * scale);
    const angle = (this.elapsed * 2.4) % (Math.PI * 2);
    const points: Array<[number, number]> = [];
    for (let index = 0; index < 8; index += 1) {
      const pointAngle = angle + (index * Math.PI) / 4;
      const length = index % 2 === 0 ? radius : radius * 0.48;
      points.push([Math.cos(pointAngle) * length, Math.sin(pointAngle) * length]);
    }
    this.halo.moveTo(points[0]![0], points[0]![1]);
    for (let index = 1; index < points.length; index += 1) {
      this.halo.lineTo(points[index]![0], points[index]![1]);
    }
    this.halo.closePath();
    this.halo.stroke({ width: width * 2.2, color: GLOW, alpha: alpha / 255 });
    this.halo.stroke({ width, color: GLOW_LIGHT, alpha: (alpha / 255) * 0.9 });
    for (let index = 0; index < 4; index += 1) {
      const pointAngle = angle + (index * Math.PI) / 2;
      this.halo
        .rect(Math.cos(pointAngle) * radius - 3, Math.sin(pointAngle) * radius - 3, 6, 6)
        .fill({ color: GLOW_LIGHT, alpha: 0.9 });
    }
  }

  private drawBurst(progress: number): void {
    this.burst.clear();
    const age = this.spawnAge;
    if (age >= 1.25) return;
    const burstProgress = Math.min(1, age / 1.25);
    const fade = Math.min(1, (1 - burstProgress) / 0.3);
    const maxRadius = 58;
    const ease = 1 - (1 - burstProgress) ** 3;
    const radius = maxRadius * (0.18 + 0.82 * ease);
    const thickness = Math.max(2, 11 * (1 - 0.45 * burstProgress));
    const alpha = Math.max(0, fade);

    this.burst
      .moveTo(0, -radius)
      .lineTo(radius, 0)
      .lineTo(0, radius)
      .lineTo(-radius, 0)
      .closePath()
      .stroke({ width: thickness + 3, color: GLOW, alpha: alpha * 0.9 });
    this.burst
      .moveTo(0, -radius)
      .lineTo(radius, 0)
      .lineTo(0, radius)
      .lineTo(-radius, 0)
      .closePath()
      .stroke({ width: thickness, color: GLOW_LIGHT, alpha });

    for (let index = 0; index < 8; index += 1) {
      const angle = this.elapsed * 3 + (index * Math.PI) / 4;
      const distance = radius + 10 + 8 * Math.abs(Math.sin(age * 7 + index));
      const x = Math.cos(angle) * distance;
      const y = Math.sin(angle) * distance;
      const size = Math.max(1.5, 5 * (0.55 + 0.45 * fade));
      this.burst.rect(x - size, y - size / 3, size * 2, (size / 3) * 2).fill({ color: GLOW_LIGHT, alpha });
      this.burst.rect(x - size / 3, y - size, (size / 3) * 2, size * 2).fill({ color: GLOW_LIGHT, alpha });
    }

    if (burstProgress < 0.3) {
      const flash = 1 - burstProgress / 0.3;
      const flashSize = 20 * (0.4 + 0.6 * flash);
      this.burst
        .rect(-flashSize, -3, flashSize * 2, 6)
        .fill({ color: GLOW_LIGHT, alpha: 0.85 * flash });
      this.burst
        .rect(-3, -flashSize, 6, flashSize * 2)
        .fill({ color: GLOW_LIGHT, alpha: 0.85 * flash });
    }
  }
}
