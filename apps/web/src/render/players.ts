/**
 * Brush players: tinted sprite, two-layer swing, jump lift/squash, shadow,
 * direction marker, bandi ring and "broken" stars.
 *
 * The shadow, ring, stars and marker are clipped to the playfield exactly like
 * `EffectsManager` does in the reference; the brush itself is never clipped.
 */

import { Container, Graphics, Sprite } from "pixi.js";
import { D_WIDTH, PAINT_PALETTE, PLAYFIELD_BOTTOM, PLAYFIELD_TOP } from "@flash/core";
import { FX_SCALE } from "../config";
import type { BrushLayers } from "./assets";

const ICON_SIZE = 80;
const JUMP_VISUAL_HEIGHT = 110;
/** Drawn larger than the reference on purpose (requested). Physics/paint stay at 36. */
const BRUSH_VISUAL_SCALE = 1.3;
const VISUAL_SIZE = ICON_SIZE * BRUSH_VISUAL_SCALE;

export interface PlayerViewState {
  x: number;
  y: number;
  angle: number;
  radius: number;
  colorIndex: number;
  /** Current paint colour (`player.color` in the reference), used by the ring. */
  paintIndex: number;
  lift: number;
  squash: number;
  swing: number;
  modeStep: number;
  jumpProgress: number;
  jumping: boolean;
  knockback: boolean;
  bandi: boolean;
  bandiLeft: number;
  broken: boolean;
}

function playfieldMask(): Graphics {
  return new Graphics()
    .rect(0, PLAYFIELD_TOP, D_WIDTH, PLAYFIELD_BOTTOM - PLAYFIELD_TOP)
    .fill(0xffffff);
}

export class PlayerView {
  readonly container = new Container();
  private readonly ground = new Container();
  private readonly over = new Container();
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

    const groundMask = playfieldMask();
    this.ground.addChild(this.shadow, this.ring, groundMask);
    this.ground.mask = groundMask;

    const overMask = playfieldMask();
    this.over.addChild(this.stars, this.marker, overMask);
    this.over.mask = overMask;

    this.container.addChild(this.ground, this.brush, this.over);

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
    this.brush.scale.set(squashX * BRUSH_VISUAL_SCALE, squashY * BRUSH_VISUAL_SCALE);

    const upperAngle = (state.swing * 0.5 * Math.PI) / 180;
    const lowerAngle = (state.swing * Math.PI) / 180;
    this.upper.rotation = upperAngle;
    this.lower.rotation = lowerAngle;

    this.drawShadow(state);
    this.drawRing(state);
    this.drawStars(state);
    this.drawMarker(state, baseY);
  }

  /** `EffectsManager._draw_player_shadow`, based on the fixed 80 px sprite. */
  private drawShadow(state: PlayerViewState): void {
    this.shadow.clear();
    const lift = state.jumping ? Math.min(1, Math.max(0, state.lift / JUMP_VISUAL_HEIGHT)) : 0;
    const widthFactor = state.jumping ? 0.85 - 0.34 * lift : 0.85;
    const alpha = state.jumping ? Math.round(135 - 60 * lift) : 135;
    const width = Math.max(12, Math.round(VISUAL_SIZE * widthFactor));
    const height = Math.max(6, Math.round(width * 0.6));
    const centerX = Math.round(state.x);
    const centerY = Math.round(state.y + VISUAL_SIZE * 0.47);
    const outerWidth = width + 12;
    const outerHeight = height + 6;

    this.shadow
      .ellipse(centerX, centerY, outerWidth / 2, outerHeight / 2)
      .fill({ color: 0x080c14, alpha: Math.max(0, Math.floor(alpha / 3)) / 255 });
    this.shadow
      .ellipse(centerX, centerY, width / 2, height / 2)
      .fill({ color: 0x080c14, alpha: alpha / 255 });
  }

  /** `EffectsManager._draw_bandi`, a pulsing ring in the player's paint colour. */
  private drawRing(state: PlayerViewState): void {
    this.ring.clear();
    if (!state.bandi) return;

    const pulse = (Math.sin(this.elapsed * 9) + 1) * 0.5;
    const remaining = state.bandiLeft;
    const expiring = remaining > 0 && remaining <= 2.5;
    const urgency = expiring ? 1 - remaining / 2.5 : 0;
    const boost = pulse * (4 + 7 * urgency);
    const extent = Math.max(state.radius, VISUAL_SIZE / 2);
    const radius = Math.round(extent + (5 + boost) * FX_SCALE);
    let ringAlpha = Math.round(130 + pulse * 90);
    if (expiring) ringAlpha = Math.min(255, ringAlpha + Math.round(45 * urgency));
    const rgb = PAINT_PALETTE[state.paintIndex]?.rgb ?? PAINT_PALETTE[0]!.rgb;
    const color = (rgb[0] << 16) | (rgb[1] << 8) | rgb[2];

    this.ring
      .circle(state.x, state.y, radius)
      .stroke({
        width: Math.max(1, Math.round((3 + urgency) * FX_SCALE)),
        color,
        alpha: ringAlpha / 255,
      });
  }

  /** `EffectsManager._draw_broken_stars`. */
  private drawStars(state: PlayerViewState): void {
    this.stars.clear();
    if (!state.broken) return;
    const centerX = state.x;
    const centerY = state.y - state.lift;
    const orbit = VISUAL_SIZE / 2 + 10 * FX_SCALE;
    for (let index = 0; index < 5; index += 1) {
      const angle = this.elapsed * 2.6 + (index * Math.PI * 2) / 5;
      const wobble = Math.sin(this.elapsed * 5 + index * 1.7) * 3 * FX_SCALE;
      const starX = centerX + Math.cos(angle) * (orbit + wobble);
      const starY = centerY + Math.sin(angle) * (orbit + wobble * 0.6);
      const radius = (5.5 + 1.5 * Math.sin(this.elapsed * 7 + index * 2.1)) * FX_SCALE;
      const points: Array<[number, number]> = [];
      for (let point = 0; point < 16; point += 1) {
        const pointAngle = (point * Math.PI) / 8;
        const length = point % 2 === 0 ? radius : radius * 0.42;
        points.push([
          starX + Math.cos(pointAngle) * length,
          starY + Math.sin(pointAngle) * length,
        ]);
      }
      this.stars.moveTo(points[0]![0], points[0]![1]);
      for (let index2 = 1; index2 < points.length; index2 += 1) {
        this.stars.lineTo(points[index2]![0], points[index2]![1]);
      }
      this.stars.closePath();
    }
    this.stars.fill(0xc48a1a);
  }

  /** `EffectsManager._draw_direction_marker`. */
  private drawMarker(state: PlayerViewState, baseY: number): void {
    this.marker.clear();
    if (state.modeStep <= 0 || state.knockback) return;

    const direction = (state.angle * Math.PI) / 180;
    const ux = Math.cos(direction);
    const uy = Math.sin(direction);
    const px = -uy;
    const py = ux;
    const extent = Math.max(state.radius, VISUAL_SIZE / 2);
    const originX = state.x + ux * (extent + 0.5 * FX_SCALE);
    const originY = baseY + uy * (extent + 0.5 * FX_SCALE);
    const length = 16 * FX_SCALE;
    const headLength = 7.5 * FX_SCALE;
    const headHalf = 7.5 * FX_SCALE;
    const shaftHalf = 4.5 * FX_SCALE;
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
    this.marker.stroke({
      width: Math.max(2, Math.round(1.8 * FX_SCALE)),
      color: 0x0c0c0e,
      alpha: 0.9,
    });
  }

  get brushY(): number {
    return this.brush.y;
  }
}
