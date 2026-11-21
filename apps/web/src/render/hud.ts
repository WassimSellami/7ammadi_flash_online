/**
 * In-game HUD: round timeline, prize markers, live score chips, timer and the
 * audio toggles. All coordinates are in the logical 1920x1080 space.
 */

import { Container, Graphics, Sprite, Text, TextStyle, type Texture } from "pixi.js";
import { FONT_FAMILY, paletteColor } from "../config";

const HUD_HEIGHT = 74;
const TRACK_X = 430;
const TRACK_Y = 32;
const TRACK_HEIGHT = 10;
const TRACK_WIDTH = 1120;
const ROUND_TIME = 84;
const PRIZE_TIME = 12;

export interface HudState {
  remainingTicks: number;
  totalTicks: number;
  names: [string, string];
  scores: [number, number];
  palettes: [number, number];
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
  private readonly scoreTexts: [Text, Text];
  private readonly timerText: Text;
  private readonly musicOn: Texture;
  private readonly musicOff: Texture;
  private readonly soundOn: Texture;
  private readonly soundOff: Texture;
  private lastUpdate = 0;

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

    const style = (color: number): TextStyle =>
      new TextStyle({
        fontFamily: FONT_FAMILY,
        fontSize: 24,
        fontWeight: "700",
        fill: color,
        dropShadow: { color: 0x05080f, alpha: 0.6, blur: 3, distance: 1, angle: Math.PI / 2 },
      });

    this.scoreTexts = [new Text({ text: "", style: style(0xffffff) }), new Text({ text: "", style: style(0xffffff) })];
    this.scoreTexts[0].position.set(26, 23);
    this.scoreTexts[1].position.set(196, 23);
    this.container.addChild(...this.scoreTexts);

    this.timerText = new Text({
      text: "1:24",
      style: new TextStyle({
        fontFamily: FONT_FAMILY,
        fontSize: 26,
        fontWeight: "700",
        fill: 0xf1f5fc,
      }),
    });
    this.timerText.anchor.set(0.5);
    this.timerText.position.set(1640, 37);
    this.container.addChild(this.timerText);

    for (const [sprite, x] of [
      [this.music, 1852],
      [this.sound, 1798],
    ] as Array<[Sprite, number]>) {
      sprite.anchor.set(0.5);
      sprite.position.set(x, 37);
      sprite.width = 46;
      sprite.height = 46;
      sprite.eventMode = "static";
      sprite.cursor = "pointer";
      this.container.addChild(sprite);
    }
    this.music.on("pointerdown", options.onMusic);
    this.sound.on("pointerdown", options.onSound);
    this.container.eventMode = "static";
  }

  update(state: HudState, dt: number): void {
    this.lastUpdate += dt;
    const total = Math.max(1, state.totalTicks);
    const elapsed = Math.max(0, total - state.remainingTicks);
    const progress = Math.min(1, elapsed / total);
    const remainingSeconds = state.remainingTicks / 60;
    const warning = remainingSeconds <= 10 && state.phase === "playing"
      ? Math.min(1, (10 - remainingSeconds) / 10)
      : 0;
    const pulse = 0.5 + 0.5 * Math.sin(this.lastUpdate * 6);

    const blend = (base: [number, number, number], warm: [number, number, number], amount: number): number => {
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

    this.track.clear();
    this.track.roundRect(TRACK_X, TRACK_Y, TRACK_WIDTH, TRACK_HEIGHT, 5).fill(trackColor);

    this.fill.clear();
    const fillWidth = Math.round(TRACK_WIDTH * progress);
    if (fillWidth > 0) {
      this.fill.roundRect(TRACK_X, TRACK_Y, fillWidth, TRACK_HEIGHT, 5).fill(fillColor);
    }

    this.markers.clear();
    for (let spawn = PRIZE_TIME; spawn < ROUND_TIME; spawn += PRIZE_TIME) {
      const x = TRACK_X + Math.round((TRACK_WIDTH * spawn) / ROUND_TIME);
      const reached = elapsed >= spawn * 60;
      const midY = TRACK_Y + TRACK_HEIGHT / 2;
      this.markers.moveTo(x, midY - 10);
      this.markers.lineTo(x + 10, midY);
      this.markers.lineTo(x, midY + 10);
      this.markers.lineTo(x - 10, midY);
      this.markers.closePath();
      this.markers.fill(reached ? 0xffcd5e : 0x1c273a);
      this.markers.stroke({ width: 2, color: 0xffcd5e });
    }

    this.scoreTexts[0].text = `${truncate(state.names[0])} ${state.scores[0]}%`;
    this.scoreTexts[0].style.fill = paletteColor(state.palettes[0]);
    this.scoreTexts[1].text = `${truncate(state.names[1])} ${state.scores[1]}%`;
    this.scoreTexts[1].style.fill = paletteColor(state.palettes[1]);

    const seconds = Math.ceil(state.remainingTicks / 60);
    this.timerText.text = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
    this.timerText.style.fill = warning > 0.35 ? 0xff8a6e : 0xf1f5fc;

    this.music.texture = state.musicOn ? this.musicOn : this.musicOff;
    this.sound.texture = state.sfxOn ? this.soundOn : this.soundOff;
  }
}

function truncate(name: string): string {
  const cleaned = name.replace(/_/g, " ");
  return cleaned.length > 10 ? `${cleaned.slice(0, 9)}…` : cleaned;
}
