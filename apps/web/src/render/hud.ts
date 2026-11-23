/**
 * In-game HUD, ported from `Screen.draw_round_timeline`: a single bar docked at
 * the bottom with the round timeline, prize checkpoints and the two audio
 * controls. It stays up for the countdown, play and the score scroll so the
 * frame never disappears.
 */

import {
  Container,
  Graphics,
  Sprite,
  type FederatedPointerEvent,
  type Texture,
} from "pixi.js";
import { D_HEIGHT, D_WIDTH, PRIZE_TIME, ROUND_TIME, type PrizeKind } from "@flash/core";

const HUD_HEIGHT = 74;
const TRACK_X = 30;
const TRACK_HEIGHT = 14;
const ICON_SIZE = 36;
const SLIDER_WIDTH = 128;
const SLIDER_HEIGHT = 8;
const CONTROL_GAP = 30;
const RIGHT_MARGIN = 24;
const CHECKPOINT_SIZE = 26;

const TRACK_CENTER_Y = 46;
const ICON_CENTER_Y = 22;
const SLIDER_Y = 54;

const SOUND_CENTER_X = D_WIDTH - RIGHT_MARGIN - SLIDER_WIDTH / 2;
const MUSIC_CENTER_X = SOUND_CENTER_X - SLIDER_WIDTH - CONTROL_GAP;
const TRACK_WIDTH = MUSIC_CENTER_X - SLIDER_WIDTH / 2 - 30 - TRACK_X;

export interface HudState {
  remainingTicks: number;
  totalTicks: number;
  musicOn: boolean;
  sfxOn: boolean;
  musicLevel: number;
  sfxLevel: number;
  /** Prize currently on the field, used to light up its timeline slot. */
  prizeKind: PrizeKind | null;
  phase: "countdown" | "playing" | "result";
}

export class Hud {
  readonly container = new Container();
  private readonly panel = new Graphics();
  private readonly track = new Graphics();
  private readonly glow = new Graphics();
  private readonly fill = new Graphics();
  private readonly markers = new Graphics();
  private readonly knob = new Graphics();
  private readonly music = new Sprite();
  private readonly sound = new Sprite();
  private readonly musicSlider = new Graphics();
  private readonly soundSlider = new Graphics();
  private readonly prizeIcons: Map<PrizeKind, Texture>;
  private readonly prizeSprites: Sprite[] = [];
  private readonly checkpoints: number[] = [];
  private readonly prizeKinds = new Map<number, PrizeKind>();
  private readonly musicOn: Texture;
  private readonly musicOff: Texture;
  private readonly soundOn: Texture;
  private readonly soundOff: Texture;
  private dragging: Graphics | null = null;
  private lastPhase: HudState["phase"] | null = null;
  private elapsed = 0;
  private enabled = true;

  constructor(options: {
    musicOn: Texture;
    musicOff: Texture;
    soundOn: Texture;
    soundOff: Texture;
    prizeIcons: Map<PrizeKind, Texture>;
    onMusic: () => void;
    onSound: () => void;
    onMusicVolume: (level: number) => void;
    onSoundVolume: (level: number) => void;
  }) {
    this.musicOn = options.musicOn;
    this.musicOff = options.musicOff;
    this.soundOn = options.soundOn;
    this.soundOff = options.soundOff;
    this.prizeIcons = options.prizeIcons;

    // Docked at the bottom of the 1920x1080 playfield.
    this.container.position.y = D_HEIGHT - HUD_HEIGHT;
    this.container.addChild(this.panel, this.track, this.glow, this.fill, this.markers);

    // One prize badge per scheduled spawn (28 s, 56 s, 84 s).
    for (let spawn = PRIZE_TIME; spawn < ROUND_TIME; spawn += PRIZE_TIME) {
      const index = this.checkpoints.length;
      this.checkpoints.push(spawn);
      const sprite = new Sprite();
      sprite.anchor.set(0.5);
      sprite.position.set(
        TRACK_X + Math.round((TRACK_WIDTH * spawn) / ROUND_TIME),
        TRACK_CENTER_Y,
      );
      sprite.visible = false;
      this.prizeSprites[index] = sprite;
      this.container.addChild(sprite);
    }

    this.container.addChild(this.knob);

    const icons: Array<[Sprite, number, () => void]> = [
      [this.music, MUSIC_CENTER_X, options.onMusic],
      [this.sound, SOUND_CENTER_X, options.onSound],
    ];
    for (const [sprite, x, handler] of icons) {
      sprite.anchor.set(0.5);
      sprite.position.set(x, ICON_CENTER_Y);
      sprite.width = ICON_SIZE;
      sprite.height = ICON_SIZE;
      sprite.eventMode = "static";
      sprite.cursor = "pointer";
      sprite.on("pointerdown", handler);
      this.container.addChild(sprite);
    }

    this.setupSlider(this.musicSlider, MUSIC_CENTER_X, options.onMusicVolume);
    this.setupSlider(this.soundSlider, SOUND_CENTER_X, options.onSoundVolume);

    this.container.eventMode = "static";
    this.container.visible = false;
  }

  private setupSlider(
    slider: Graphics,
    centerX: number,
    onChange: (level: number) => void,
  ): void {
    slider.position.set(centerX - SLIDER_WIDTH / 2, SLIDER_Y);
    slider.eventMode = "static";
    slider.cursor = "pointer";
    const setFrom = (event: FederatedPointerEvent): void => {
      const local = slider.toLocal(event.global);
      onChange(Math.max(0, Math.min(1, local.x / SLIDER_WIDTH)));
    };
    slider.on("pointerdown", (event: FederatedPointerEvent) => {
      this.dragging = slider;
      setFrom(event);
    });
    slider.on("pointermove", (event: FederatedPointerEvent) => {
      if (this.dragging === slider) setFrom(event);
    });
    const stop = (): void => {
      if (this.dragging === slider) this.dragging = null;
    };
    slider.on("pointerup", stop);
    slider.on("pointerupoutside", stop);
    this.container.addChild(slider);
  }

  /** The HUD stays up for countdown, play and results, like the arcade bar. */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.container.visible = enabled;
  }

  update(state: HudState, dt: number): void {
    this.container.visible = this.enabled;
    if (!this.container.visible) return;

    this.elapsed += dt;
    const total = Math.max(1, state.totalTicks);
    const elapsedTicks = Math.max(0, total - state.remainingTicks);
    const progress = Math.min(1, elapsedTicks / total);
    const remainingSeconds = state.remainingTicks / 60;

    // A fresh round starts with a countdown: forget the previous prize slots.
    if (state.phase === "countdown" && this.lastPhase !== "countdown") {
      this.prizeKinds.clear();
      for (const sprite of this.prizeSprites) sprite.visible = false;
    }
    this.lastPhase = state.phase;

    // Learn which prize belongs to the current checkpoint once it spawns.
    if (state.prizeKind) {
      const slot = Math.floor(elapsedTicks / (PRIZE_TIME * 60)) - 1;
      if (slot >= 0 && slot < this.checkpoints.length) {
        this.prizeKinds.set(slot, state.prizeKind);
      }
    }

    let warning = 0;
    if (state.phase === "playing" && elapsedTicks > 0 && remainingSeconds <= 10) {
      warning = Math.min(1, (10 - remainingSeconds) / 10);
    }
    const pulse = 0.5 + 0.5 * Math.sin(this.elapsed * 6);

    const blend = (
      base: [number, number, number],
      warm: [number, number, number],
      amount: number,
    ): number => {
      const t = Math.max(0, Math.min(1, amount));
      return (
        (Math.round(base[0] + (warm[0] - base[0]) * t) << 16) |
        (Math.round(base[1] + (warm[1] - base[1]) * t) << 8) |
        Math.round(base[2] + (warm[2] - base[2]) * t)
      );
    };

    const panelColor = blend([13, 19, 32], [48, 24, 29], warning * (0.3 + 0.35 * pulse));
    const trackColor = blend([40, 51, 70], [92, 55, 51], warning * 0.5);
    const insetColor = blend([22, 30, 45], [54, 31, 36], warning * 0.45);
    const fillColor = blend([77, 209, 188], [255, 116, 70], warning * (0.55 + 0.35 * pulse));
    const glowColor = blend([77, 209, 188], [255, 116, 70], warning * 0.5);

    // Panel: dark bar with a thin top accent and a soft top edge.
    this.panel.clear();
    this.panel.rect(0, 0, D_WIDTH, HUD_HEIGHT).fill(panelColor);
    this.panel.rect(0, 0, D_WIDTH, 2).fill({ color: glowColor, alpha: 0.55 });
    this.panel.rect(0, HUD_HEIGHT - 1, D_WIDTH, 1).fill({ color: 0x000000, alpha: 0.35 });

    const trackY = TRACK_CENTER_Y - TRACK_HEIGHT / 2;

    // Track: an outer rim plus a recessed inner lane for depth.
    this.track.clear();
    this.track
      .roundRect(TRACK_X, trackY, TRACK_WIDTH, TRACK_HEIGHT, TRACK_HEIGHT / 2)
      .fill(trackColor);
    this.track
      .roundRect(
        TRACK_X + 3,
        trackY + 3,
        TRACK_WIDTH - 6,
        TRACK_HEIGHT - 6,
        (TRACK_HEIGHT - 6) / 2,
      )
      .fill(insetColor);

    const fillWidth = Math.round((TRACK_WIDTH - 6) * progress);
    const fillX = TRACK_X + 3;
    const fillY = trackY + 3;
    const fillH = TRACK_HEIGHT - 6;

    // Soft glow behind the leading edge of the elapsed bar.
    this.glow.clear();
    if (fillWidth > 0) {
      this.glow
        .roundRect(fillX, fillY, fillWidth, fillH, fillH / 2)
        .fill({ color: glowColor, alpha: 0.22 });
    }

    this.fill.clear();
    if (fillWidth > 0) {
      this.fill.roundRect(fillX, fillY, fillWidth, fillH, fillH / 2).fill(fillColor);
      this.fill
        .roundRect(fillX, fillY, fillWidth, Math.max(2, fillH / 2), fillH / 2)
        .fill({ color: 0xffffff, alpha: 0.18 });
    }

    // Prize checkpoints: a badge at each spawn time, lit once it is reached.
    // The actual prize icon is drawn on top as soon as its kind is known.
    this.markers.clear();
    const reachedColor = blend([255, 205, 94], [255, 150, 90], warning * 0.6);
    for (let index = 0; index < this.checkpoints.length; index += 1) {
      const spawn = this.checkpoints[index]!;
      const x = TRACK_X + Math.round((TRACK_WIDTH * spawn) / ROUND_TIME);
      const reached = elapsedTicks >= spawn * 60;
      const rim = reached ? reachedColor : 0x33445e;
      const badge = reached
        ? blend([34, 43, 58], [70, 44, 40], warning * 0.5)
        : 0x1b2435;
      this.markers
        .circle(x, TRACK_CENTER_Y, CHECKPOINT_SIZE / 2)
        .fill(badge)
        .stroke({ width: 2, color: rim });

      const kind = this.prizeKinds.get(index) ?? null;
      const sprite = this.prizeSprites[index]!;
      const texture = kind ? this.prizeIcons.get(kind) ?? null : null;
      if (texture) {
        sprite.texture = texture;
        sprite.scale.set(
          CHECKPOINT_SIZE / texture.width,
          CHECKPOINT_SIZE / texture.height,
        );
        sprite.visible = true;
      } else {
        sprite.visible = false;
        this.markers.circle(x, TRACK_CENTER_Y, 3).fill(reached ? rim : 0x59677f);
      }
    }

    // Leading knob: a bright core with a coloured halo.
    this.knob.clear();
    const knobX = fillX + fillWidth;
    this.knob.circle(knobX, TRACK_CENTER_Y, 10).fill({ color: glowColor, alpha: 0.3 });
    this.knob.circle(knobX, TRACK_CENTER_Y, 6).fill(0xffffff);
    this.knob.circle(knobX, TRACK_CENTER_Y, 3).fill(fillColor);

    this.music.texture = state.musicOn ? this.musicOn : this.musicOff;
    this.sound.texture = state.sfxOn ? this.soundOn : this.soundOff;
    this.paintSlider(this.musicSlider, state.musicLevel, state.musicOn, fillColor);
    this.paintSlider(this.soundSlider, state.sfxLevel, state.sfxOn, fillColor);
  }

  private paintSlider(
    slider: Graphics,
    level: number,
    active: boolean,
    color: number,
  ): void {
    slider.clear();
    slider
      .roundRect(0, 0, SLIDER_WIDTH, SLIDER_HEIGHT, SLIDER_HEIGHT / 2)
      .fill(active ? 0x2a3850 : 0x212a39);
    const width = Math.round(SLIDER_WIDTH * Math.max(0, Math.min(1, level)));
    if (width > 0) {
      slider
        .roundRect(0, 0, width, SLIDER_HEIGHT, SLIDER_HEIGHT / 2)
        .fill(active ? color : 0x59677f);
    }
    const knobX = Math.min(SLIDER_WIDTH, Math.max(0, width));
    slider.circle(knobX, SLIDER_HEIGHT / 2, 6).fill(0xffffff);
    slider.circle(knobX, SLIDER_HEIGHT / 2, 3).fill(active ? color : 0x8b98ad);
  }
}
