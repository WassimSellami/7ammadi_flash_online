/**
 * In-game HUD, ported from `Screen.draw_round_timeline`: a single panel with
 * the round timeline, prize markers and the two audio toggles. Like the
 * reference, it only shows while the round is actually being played.
 */

import { Container, Graphics, Sprite, type Texture } from "pixi.js";

const HUD_HEIGHT = 74;
const PANEL_CENTER_Y = HUD_HEIGHT / 2;
const TRACK_X = 28;
const TRACK_HEIGHT = 10;
const ICON_SIZE = 46;
const ROUND_TIME = 84;
const PRIZE_TIME = 12;

export interface HudState {
  remainingTicks: number;
  totalTicks: number;
  musicOn: boolean;
  sfxOn: boolean;
  phase: "countdown" | "playing" | "result";
}

export class Hud {
  readonly container = new Container();
  private readonly panel = new Graphics();
  private readonly track = new Graphics();
  private readonly fill = new Graphics();
  private readonly markers = new Graphics();
  private readonly music = new Sprite();
  private readonly sound = new Sprite();
  private readonly musicOn: Texture;
  private readonly musicOff: Texture;
  private readonly soundOn: Texture;
  private readonly soundOff: Texture;
  private elapsed = 0;

  constructor(options: {
    musicOn: Texture;
    musicOff: Texture;
    soundOn: Texture;
    soundOff: Texture;
    onMusic: () => void;
    onSound: () => void;
  }) {
    this.musicOn = options.musicOn;
    this.musicOff = options.musicOff;
    this.soundOn = options.soundOn;
    this.soundOff = options.soundOff;

    this.container.addChild(this.panel, this.track, this.fill, this.markers);

    const musicX = 1920 - 22 - ICON_SIZE;
    const soundX = musicX - 10 - ICON_SIZE;
    for (const [sprite, x] of [
      [this.music, musicX],
      [this.sound, soundX],
    ] as Array<[Sprite, number]>) {
      sprite.anchor.set(0.5);
      sprite.position.set(x, PANEL_CENTER_Y);
      sprite.width = ICON_SIZE;
      sprite.height = ICON_SIZE;
      sprite.eventMode = "static";
      sprite.cursor = "pointer";
      this.container.addChild(sprite);
    }
    this.music.on("pointerdown", options.onMusic);
    this.sound.on("pointerdown", options.onSound);
    this.container.eventMode = "static";
    this.container.visible = false;
  }

  update(state: HudState, dt: number): void {
    this.container.visible = state.phase === "playing";
    if (!this.container.visible) return;

    this.elapsed += dt;
    const total = Math.max(1, state.totalTicks);
    const elapsedTicks = Math.max(0, total - state.remainingTicks);
    const progress = Math.min(1, elapsedTicks / total);
    const remainingSeconds = state.remainingTicks / 60;

    let warning = 0;
    if (elapsedTicks > 0 && remainingSeconds <= 10) {
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

    const panelColor = blend([16, 23, 38], [58, 29, 34], warning * (0.3 + 0.35 * pulse));
    const trackColor = blend([55, 68, 90], [116, 70, 62], warning * 0.55);
    const fillColor = blend([77, 209, 188], [255, 116, 70], warning * (0.55 + 0.35 * pulse));

    this.panel.clear();
    this.panel.rect(0, 0, 1920, HUD_HEIGHT).fill(panelColor);

    const trackWidth = Math.max(40, 1796 - 50);
    this.track.clear();
    this.track
      .roundRect(TRACK_X, PANEL_CENTER_Y - TRACK_HEIGHT / 2, trackWidth, TRACK_HEIGHT, 5)
      .fill(trackColor);

    this.fill.clear();
    const fillWidth = Math.round(trackWidth * progress);
    if (fillWidth > 0) {
      this.fill
        .roundRect(TRACK_X, PANEL_CENTER_Y - TRACK_HEIGHT / 2, fillWidth, TRACK_HEIGHT, 5)
        .fill(fillColor);
    }

    this.markers.clear();
    const reachedColor = blend([255, 205, 94], [255, 150, 90], warning * 0.6);
    for (let spawn = PRIZE_TIME; spawn < ROUND_TIME; spawn += PRIZE_TIME) {
      const x = TRACK_X + Math.round((trackWidth * spawn) / ROUND_TIME);
      const reached = elapsedTicks >= spawn * 60;
      this.markers.moveTo(x, PANEL_CENTER_Y - 10);
      this.markers.lineTo(x + 10, PANEL_CENTER_Y);
      this.markers.lineTo(x, PANEL_CENTER_Y + 10);
      this.markers.lineTo(x - 10, PANEL_CENTER_Y);
      this.markers.closePath();
      this.markers.fill(reached ? reachedColor : 0x1c273a);
      this.markers.stroke({ width: 2, color: reachedColor });
    }

    this.music.texture = state.musicOn ? this.musicOn : this.musicOff;
    this.sound.texture = state.sfxOn ? this.soundOn : this.soundOff;
  }
}
