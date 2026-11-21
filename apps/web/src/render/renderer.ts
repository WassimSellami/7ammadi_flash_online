/**
 * Scene renderer. Consumes snapshots (authoritative) and events (transients)
 * and owns every visible Pixi object.
 */

import {
  Application,
  Container,
  Sprite,
  Text,
  TextStyle,
  type Renderer as PixiRenderer,
} from "pixi.js";
import {
  COUNTDOWN_LABELS,
  D_WIDTH,
  FLAG_BANDI,
  FLAG_BEATEN,
  FLAG_BROKEN,
  FLAG_FAT,
  FLAG_JUMPING,
  FLAG_KNOCKBACK,
  FLAG_SPEED,
  FLAG_SQUASH,
  PLAYFIELD_BOTTOM,
  PLAYFIELD_TOP,
  ROUND_TICKS,
  iconMargin,
  type GameEvent,
  type MatchPhase,
  type PlayerSnapshot,
  type Snapshot,
} from "@flash/core";
import { FONT_FAMILY, paletteColor } from "../config";
import type { AudioManager } from "../audio/audio";
import type { GameAssets } from "./assets";
import { EffectsManager, type ObserveState } from "./effects";
import { Hud } from "./hud";
import { PaintLayer } from "./paint";
import { PlayerView } from "./players";
import { PrizeView } from "./prize";

interface DisplayPlayer {
  x: number;
  y: number;
  angle: number;
  targetX: number;
  targetY: number;
  targetAngle: number;
  jumpElapsed: number;
  squashElapsed: number;
  bandiStarted: number | null;
  name: string;
}

const PLAYER_NAMES = ["Player_A", "Player_B"];

export class SceneRenderer {
  private readonly app: Application;
  private readonly audio: AudioManager;
  private readonly world = new Container();
  private readonly background: Sprite;
  private readonly paint: PaintLayer;
  private readonly effects: EffectsManager;
  private readonly prize: PrizeView;
  private readonly players: [PlayerView, PlayerView];
  private readonly hud: Hud;
  private readonly countdown: Text;
  private readonly displays: [DisplayPlayer, DisplayPlayer] = [
    {
      x: 640,
      y: 540,
      angle: 180,
      targetX: 640,
      targetY: 540,
      targetAngle: 180,
      jumpElapsed: 0,
      squashElapsed: 0,
      bandiStarted: null,
      name: PLAYER_NAMES[0]!,
    },
    {
      x: 1280,
      y: 540,
      angle: 0,
      targetX: 1280,
      targetY: 540,
      targetAngle: 0,
      jumpElapsed: 0,
      squashElapsed: 0,
      bandiStarted: null,
      name: PLAYER_NAMES[1]!,
    },
  ];

  private snapshot: Snapshot | null = null;
  private lastPhase: MatchPhase | null = null;
  private hasSnapshot = false;
  private totalTicks = ROUND_TICKS;
  private names: [string, string] = ["Player A", "Player B"];
  private palettes: [number, number] = [2, 0];
  private ownSlot: 0 | 1 | null = null;
  private activeSlots: 1 | 2 = 2;
  private ownInputLeft = false;
  private ownInputRight = false;
  private predictedAngle = 180;
  private countdownAge = 0;
  private countdownLabel = -1;

  constructor(app: Application, assets: GameAssets, audio: AudioManager) {
    this.app = app;
    this.audio = audio;
    this.background = new Sprite(assets.background);
    this.background.width = 1920;
    this.background.height = 1080;

    this.paint = new PaintLayer(app.renderer as PixiRenderer, assets.whiteCircle);
    this.effects = new EffectsManager(assets.whiteCircle);
    this.prize = new PrizeView(assets.prizeIcons);
    this.players = [
      new PlayerView(assets.brushes, 2),
      new PlayerView(assets.brushes, 0),
    ];

    this.countdown = new Text({
      text: "",
      style: new TextStyle({
        fontFamily: FONT_FAMILY,
        fontSize: 150,
        fontWeight: "700",
        fill: 0xffffff,
        stroke: { color: 0x0b1220, width: 12 },
        dropShadow: { color: 0x000000, alpha: 0.55, blur: 12, distance: 0, angle: 0 },
      }),
    });
    this.countdown.anchor.set(0.5);
    this.countdown.position.set(960, 540);
    this.countdown.visible = false;

    this.hud = new Hud({
      musicOn: assets.musicOn,
      musicOff: assets.musicOff,
      soundOn: assets.soundOn,
      soundOff: assets.soundOff,
      onMusic: () => {
        audio.toggleMusic();
        if (audio.musicEnabled) audio.startMusic();
        else audio.stopMusic();
      },
      onSound: () => {
        audio.toggleSfx();
      },
    });

    this.world.addChild(
      this.background,
      this.paint.container,
      this.effects.container,
      ...this.players.map((player) => player.container),
      this.prize.container,
      this.hud.container,
      this.countdown,
    );
    app.stage.addChild(this.world);
    this.resize();
    app.renderer.on("resize", () => this.resize());
  }

  resize(): void {
    const screen = this.app.renderer.screen;
    const scale = Math.min(screen.width / 1920, screen.height / 1080);
    this.world.scale.set(scale);
    this.world.position.set(
      Math.round((screen.width - 1920 * scale) / 2),
      Math.round((screen.height - 1080 * scale) / 2),
    );
  }

  setPlayers(names: [string, string], palettes: [number, number], ownSlot: 0 | 1 | null): void {
    this.names = names;
    this.palettes = palettes;
    this.ownSlot = ownSlot;
  }

  setActiveSlots(count: 1 | 2): void {
    this.activeSlots = count;
    this.players[1].container.visible = count === 2;
  }

  setLocalInput(left: boolean, right: boolean): void {
    this.ownInputLeft = left;
    this.ownInputRight = right;
  }

  get snapshotState(): Snapshot | null {
    return this.snapshot;
  }

  resetRound(): void {
    this.paint.clear();
    this.effects.clear();
    this.prize.update(null, 0, 0);
    this.hasSnapshot = false;
    this.countdown.visible = false;
    this.countdownLabel = -1;
    for (const display of this.displays) display.bandiStarted = null;
  }

  /** Authoritative mask sync after a late join or reconnect. */
  applyMask(width: number, height: number, runs: readonly number[]): void {
    this.paint.applyMask(width, height, runs);
  }

  applySnapshot(snapshot: Snapshot): void {
    const enteringCountdown =
      snapshot.phase === "countdown" && this.lastPhase !== "countdown";
    const resumingRound =
      snapshot.phase === "playing" && (this.lastPhase === null || this.lastPhase === "result");
    const first = !this.hasSnapshot;
    if (first || enteringCountdown || resumingRound) {
      this.resetRound();
      this.hasSnapshot = true;
    }
    this.lastPhase = snapshot.phase;
    this.snapshot = snapshot;
    if (first || snapshot.phase === "countdown") {
      this.totalTicks = Math.max(1, snapshot.total ?? snapshot.ticksLeft);
    }

    const now = performance.now() / 1000;
    const snapshots: [PlayerSnapshot, PlayerSnapshot] = [snapshot.a, snapshot.b];
    for (let slot = 0; slot < this.activeSlots; slot += 1) {
      const source = snapshots[slot]!;
      const display = this.displays[slot]!;
      const distance = Math.hypot(source.x - display.targetX, source.y - display.targetY);
      display.targetX = source.x;
      display.targetY = source.y;
      display.targetAngle = source.ang;
      if (first || distance > 260) {
        display.x = source.x;
        display.y = source.y;
        display.angle = source.ang;
      }
      const jumping = (source.fl & FLAG_JUMPING) !== 0;
      if (!jumping) display.jumpElapsed = 0;
      const squashing = (source.fl & FLAG_SQUASH) !== 0;
      if (!squashing) display.squashElapsed = 0;
      const bandi = (source.fl & FLAG_BANDI) !== 0;
      if (bandi && display.bandiStarted === null) display.bandiStarted = now;
      if (!bandi) display.bandiStarted = null;
    }

    if (first && this.ownSlot !== null) {
      this.predictedAngle = snapshots[this.ownSlot]!.ang;
    }

    if (snapshot.paint) {
      for (let slot = 0; slot < this.activeSlots; slot += 1) {
        const source = snapshots[slot]!;
        this.paint.stampTrail(
          PLAYER_NAMES[slot]!,
          source.x,
          source.y,
          source.r,
          paletteColor(source.c),
        );
      }
    } else {
      for (let slot = 0; slot < this.activeSlots; slot += 1) {
        const source = snapshots[slot]!;
        this.paint.snap(PLAYER_NAMES[slot]!, source.x, source.y, source.r, paletteColor(source.c));
      }
    }

    if (snapshot.phase === "countdown") {
      this.showCountdown(snapshot.cd ?? 0);
    } else {
      this.countdown.visible = false;
    }
  }

  private showCountdown(label: number): void {
    if (this.countdownLabel === label) return;
    this.countdownLabel = label;
    this.countdownAge = 0;
    this.countdown.text = COUNTDOWN_LABELS[label] ?? "Go!";
    this.countdown.visible = true;
    this.countdown.alpha = 1;
    this.countdown.scale.set(1);
  }

  handleEvent(event: GameEvent): void {
    switch (event.type) {
      case "smash":
        this.effects.smash(event.x, event.y);
        this.audio.play("smash");
        break;
      case "punch":
        this.effects.punch(event.x, event.y, this.palettes[event.slot] ?? 0);
        this.audio.play("punch");
        break;
      case "pickup":
        this.effects.pickup(event.x, event.y, event.color);
        this.effects.label(event.x, event.y, event.color, event.label);
        this.audio.play("plop");
        break;
      case "boom":
        this.effects.boom(event.x, event.y, event.color, event.radius);
        this.audio.play("bomb");
        break;
      case "rain":
        this.effects.rain(event.drops, event.color, event.radius);
        this.audio.playRain();
        break;
      case "evil":
        this.audio.play("evil");
        break;
      case "wall":
        this.effects.ripple(event.x, event.y, this.palettes[event.slot] ?? 0);
        break;
      case "spawn":
        this.audio.play("plop");
        break;
      case "count":
        this.playCount(event.label);
        break;
      case "end":
        this.countdown.visible = false;
        break;
    }
  }

  private playCount(label: string): void {
    if (label === "3") this.audio.play("s_3");
    else if (label === "2") this.audio.play("s_2");
    else if (label === "1") this.audio.play("s_1");
    else this.audio.play("s_go");
  }

  update(dt: number): void {
    const snapshot = this.snapshot;
    if (!snapshot) {
      return;
    }
    const now = performance.now() / 1000;
    const sources: [PlayerSnapshot, PlayerSnapshot] = [snapshot.a, snapshot.b];

    for (let slot = 0; slot < this.activeSlots; slot += 1) {
      const source = sources[slot]!;
      const display = this.displays[slot]!;
      const local = this.ownSlot === slot;
      if (
        local &&
        snapshot.phase === "playing" &&
        (source.fl & FLAG_KNOCKBACK) === 0
      ) {
        // Own-player prediction: advance from the predicted angle, then
        // reconcile toward the authoritative snapshot.
        const jumpFactor = (source.fl & FLAG_JUMPING) !== 0 ? 0.8 : 1;
        const step = source.m * ((dt * 1000) / 35) * jumpFactor;
        const rad = (this.predictedAngle * Math.PI) / 180;
        display.x += Math.cos(rad) * step;
        display.y += Math.sin(rad) * step;
        const margin = iconMargin(source.r);
        display.x = Math.max(margin, Math.min(D_WIDTH - margin, display.x));
        display.y = Math.max(
          PLAYFIELD_TOP + margin,
          Math.min(PLAYFIELD_BOTTOM - margin, display.y),
        );
        const driftX = display.targetX - display.x;
        const driftY = display.targetY - display.y;
        if (Math.hypot(driftX, driftY) > 80) {
          display.x = display.targetX;
          display.y = display.targetY;
        } else {
          const correction = Math.min(1, dt * 10);
          display.x += driftX * correction;
          display.y += driftY * correction;
        }
      } else {
        const distance = Math.hypot(display.targetX - display.x, display.targetY - display.y);
        if (distance > 260) {
          display.x = display.targetX;
          display.y = display.targetY;
        } else {
          const blend = Math.min(1, dt * 14);
          display.x += (display.targetX - display.x) * blend;
          display.y += (display.targetY - display.y) * blend;
        }
      }
      let angleDelta = ((display.targetAngle - display.angle + 540) % 360) - 180;
      display.angle += angleDelta * Math.min(1, dt * 16);

      const jumping = (source.fl & FLAG_JUMPING) !== 0;
      if (jumping) display.jumpElapsed += dt;
      else display.jumpElapsed = 0;
      const squashing = (source.fl & FLAG_SQUASH) !== 0;
      if (squashing) display.squashElapsed += dt;
      else display.squashElapsed = 0;
    }

    // Own-player angle prediction (position stays authoritative).
    if (
      this.ownSlot !== null &&
      (snapshot.phase === "playing" || snapshot.phase === "countdown")
    ) {
      const source = sources[this.ownSlot]!;
      const modeAngle = source.m === 0 ? 0 : 6;
      const factor = (dt * 1000) / 35;
      if (this.ownInputRight) this.predictedAngle += modeAngle * factor;
      else if (this.ownInputLeft) this.predictedAngle -= modeAngle * factor;
      let delta = ((source.ang - this.predictedAngle + 540) % 360) - 180;
      if (Math.abs(delta) > 10) this.predictedAngle = source.ang;
      else this.predictedAngle += delta * Math.min(1, dt * 6);
    }

    const observe: ObserveState[] = [];
    for (let slot = 0; slot < this.activeSlots; slot += 1) {
      const source = sources[slot]!;
      const display = this.displays[slot]!;
      const jumpProgress = Math.min(1, display.jumpElapsed / 1.4);
      const lift = (source.fl & FLAG_JUMPING) !== 0 ? Math.sin(Math.PI * jumpProgress) * 110 : 0;
      const squashProgress = Math.min(1, display.squashElapsed / 0.32);
      const squash = (source.fl & FLAG_SQUASH) !== 0 ? Math.sin(Math.PI * squashProgress) : 0;
      const bandiLeft =
        display.bandiStarted === null ? 0 : Math.max(0, 10 - (now - display.bandiStarted));
      const angle = this.ownSlot === slot ? this.predictedAngle : display.angle;
      const modeStep = source.m;
      const view = this.players[slot]!;
      view.update(
        {
          x: display.x,
          y: display.y,
          angle,
          radius: source.r,
          colorIndex: source.c,
          lift,
          squash,
          swing: this.effects.swingAngle(PLAYER_NAMES[slot]!),
          modeStep,
          jumpProgress,
          knockback: (source.fl & FLAG_KNOCKBACK) !== 0,
          bandi: (source.fl & FLAG_BANDI) !== 0,
          bandiLeft,
          broken: (source.fl & FLAG_BROKEN) !== 0,
        },
        dt,
      );
      observe.push({
        name: PLAYER_NAMES[slot]!,
        x: display.x,
        y: display.y,
        radius: source.r,
        colorIndex: source.c,
        jumping: (source.fl & FLAG_JUMPING) !== 0,
        beaten: (source.fl & FLAG_BEATEN) !== 0,
        brokenVisual: (source.fl & FLAG_BROKEN) !== 0,
        knockback: (source.fl & FLAG_KNOCKBACK) !== 0,
        modeStep,
        powerup:
          (source.fl & FLAG_BANDI) !== 0
            ? "bandi"
            : (source.fl & FLAG_FAT) !== 0
              ? "fat"
              : (source.fl & FLAG_SPEED) !== 0
                ? "speed"
                : null,
      });
    }

    this.effects.observe(observe, dt);
    this.effects.update(dt);
    this.prize.update(snapshot.prize, snapshot.tick, dt);
    this.hud.update(
      {
        remainingTicks:
          snapshot.phase === "playing"
            ? snapshot.ticksLeft
            : this.totalTicks,
        totalTicks: this.totalTicks,
        names: this.names,
        scores: snapshot.scores,
        palettes: this.palettes,
        musicOn: this.audio.musicEnabled,
        sfxOn: this.audio.sfxEnabled,
        phase: snapshot.phase,
      },
      dt,
    );

    if (this.countdown.visible) {
      this.countdownAge += dt;
      const progress = Math.min(1, this.countdownAge / 0.9);
      const pop = 1 + 0.18 * Math.sin(progress * Math.PI);
      this.countdown.scale.set(pop * (1.15 - 0.15 * progress));
      this.countdown.alpha = progress > 0.85 ? Math.max(0, 1 - (progress - 0.85) / 0.15) : 1;
      if (this.countdownAge > 0.95) {
        this.countdown.visible = false;
      }
    }

  }
}
