/**
 * Brush players: tinted sprite, two-layer swing, jump lift/squash, shadow,
 * direction marker, bandi ring and "broken" stars.
 */

import { Container, Graphics, Sprite } from "pixi.js";
import type { BrushLayers } from "./assets";

const ICON_SIZE = 80;

export interface PlayerViewState {
  x: number;
  y: number;
  angle: number;
  radius: number;
  colorIndex: number;
  lift: number;
  squash: number;
  swing: number;
  modeStep: number;
  jumpProgress: number;
  knockback: boolean;
  bandi: boolean;
  bandiLeft: number;
  broken: boolean;
}

export class PlayerView {
  readonly container = new Container();
  private readonly shadow = new Graphics();
  private readonly ring = new Graphics();
  private readonly stars = new Graphics();
  private readonly marker = new Graphics();
  private readonly brush = new Container();
  private readonly upper: Sprite;
  private readonly lower: Sprite;
  private readonly layers: Map<number, BrushLayers>;
  private colorIndex = -1;
  private splitY = 50;
  private elapsed = 0;

  constructor(layers: Map<number, BrushLayers>, colorIndex: number) {
    this.layers = layers;
    this.container.addChild(this.shadow, this.ring, this.brush, this.stars, this.marker);
    const initial = this.layers.get(colorIndex) ?? this.layers.values().next().value!;
    this.upper = new Sprite(initial.upper);
    this.lower = new Sprite(initial.lower);
    this.upper.anchor.set(0);
    this.lower.anchor.set(0);
    this.brush.addChild(this.upper, this.lower);
    this.setColor(colorIndex);
  }

  setColor(colorIndex: number): void {
    if (colorIndex === this.colorIndex) return;
    const layers = this.layers.get(colorIndex) ?? this.layers.values().next().value!;
    this.colorIndex = colorIndex;
    this.splitY = layers.splitY;
    this.upper.texture = layers.upper;
    this.lower.texture = layers.lower;
    const pivotY = Math.max(0, layers.splitY - 5);
    for (const sprite of [this.upper, this.lower]) {
      sprite.pivot.set(ICON_SIZE / 2, pivotY);
      sprite.position.set(0, -ICON_SIZE / 2 + pivotY);
    }
  }

  update(state: PlayerViewState, dt: number): void {
    this.elapsed += dt;
    this.setColor(state.colorIndex);

    const baseY = state.y - state.lift;
    this.brush.position.set(state.x, baseY);
    const squashX = state.squash > 0.001 ? 1 + 0.24 * state.squash : 1;
    const squashY = state.squash > 0.001 ? 1 - 0.2 * state.squash : 1;
    this.brush.scale.set(squashX, squashY);

    const upperAngle = (state.swing * 0.5 * Math.PI) / 180;
    const lowerAngle = (state.swing * Math.PI) / 180;
    this.upper.rotation = upperAngle;
    this.lower.rotation = lowerAngle;

    this.drawShadow(state);
    this.drawRing(state);
    this.drawStars(state);
    this.drawMarker(state, baseY);
  }

  private drawShadow(state: PlayerViewState): void {
    this.shadow.clear();
    const liftFactor = Math.min(1, state.lift / 110);
    const width = (state.radius * 1.5) * (1 - liftFactor * 0.35);
    const height = Math.max(7, state.radius * 0.42 * (1 - liftFactor * 0.4));
    this.shadow
      .ellipse(state.x, state.y + state.radius * 0.78, width, height)
      .fill({ color: 0x05080f, alpha: 0.34 - liftFactor * 0.12 });
  }

  private drawRing(state: PlayerViewState): void {
    this.ring.clear();
    if (!state.bandi) return;
    const urgency = state.bandiLeft <= 2.5;
    const pulse = 0.5 + 0.5 * Math.sin(this.elapsed * (urgency ? 13 : 6.5));
    const radius = state.radius + 12 + pulse * 5;
    const color = urgency ? 0xff6f5c : 0xffcd5e;
    this.ring
      .circle(state.x, state.y - state.lift, radius)
      .stroke({ width: 5, color, alpha: 0.35 + pulse * 0.45 });
    this.ring
      .circle(state.x, state.y - state.lift, radius + 8)
      .stroke({ width: 2, color: 0xff3d2e, alpha: 0.15 + pulse * 0.25 });
  }

  private drawStars(state: PlayerViewState): void {
    this.stars.clear();
    if (!state.broken) return;
    const centerY = state.y - state.lift;
    const orbit = state.radius + 14;
    for (let index = 0; index < 5; index += 1) {
      const angle = this.elapsed * 2.6 + (index * Math.PI * 2) / 5;
      const wobble = Math.sin(this.elapsed * 5 + index * 1.7) * 3;
      const starX = state.x + Math.cos(angle) * (orbit + wobble);
      const starY = centerY + Math.sin(angle) * (orbit + wobble * 0.6);
      const radius = 5.5 + 1.5 * Math.sin(this.elapsed * 7 + index * 2.1);
      this.stars.moveTo(starX, starY - radius);
      for (let point = 1; point < 16; point += 1) {
        const pointAngle = (point * Math.PI) / 8;
        const length = point % 2 === 0 ? radius : radius * 0.42;
        this.stars.lineTo(
          starX + Math.cos(pointAngle) * length,
          starY + Math.sin(pointAngle) * length,
        );
      }
      this.stars.closePath();
    }
    this.stars.fill(0xc48a1a);
  }

  private drawMarker(state: PlayerViewState, baseY: number): void {
    this.marker.clear();
    if (state.modeStep <= 0 || state.knockback) return;

    const direction = (state.angle * Math.PI) / 180;
    const ux = Math.cos(direction);
    const uy = Math.sin(direction);
    const px = -uy;
    const py = ux;
    const extent = Math.max(state.radius, ICON_SIZE / 2);
    const originX = state.x + ux * (extent + 0.5);
    const originY = baseY + uy * (extent + 0.5);
    const length = 16;
    const headLength = 7.5;
    const headHalf = 7.5;
    const shaftHalf = 4.5;
    const shaftEnd = length - headLength;

    const toWorld = (lx: number, ly: number): [number, number] => [
      originX + ux * lx + px * ly,
      originY + uy * lx + py * ly,
    ];
    const points = [
      toWorld(0, -shaftHalf),
      toWorld(shaftEnd, -shaftHalf),
      toWorld(shaftEnd, -headHalf),
      toWorld(length, 0),
      toWorld(shaftEnd, headHalf),
      toWorld(shaftEnd, shaftHalf),
      toWorld(0, shaftHalf),
    ] as Array<[number, number]>;

    const pulse = 0.5 + 0.5 * Math.sin(this.elapsed * 6.5);
    const light = 0.2 + 0.8 * pulse;
    const gold = [176 + (255 - 176) * light, 122 + (224 - 122) * light, 26 + (118 - 26) * light];
    const color = (Math.round(gold[0]) << 16) | (Math.round(gold[1]) << 8) | Math.round(gold[2]);

    this.marker.moveTo(points[0]![0], points[0]![1]);
    for (let index = 1; index < points.length; index += 1) {
      this.marker.lineTo(points[index]![0], points[index]![1]);
    }
    this.marker.closePath();
    this.marker.fill(color);
    this.marker.stroke({ width: 2, color: 0x0c0c0e, alpha: 0.9 });
  }

  setJumpProgress(progress: number): void {
    this.marker.alpha = 1;
    void progress;
  }

  get brushY(): number {
    return this.brush.y;
  }
}
