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
  SLOT_INDICES,
  iconMargin,
  type GameEvent,
  type MatchPhase,
  type PlayerSnapshot,
  type SlotIndex,
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

const PLAYER_NAMES = ["Player_A", "Player_B", "Player_C", "Player_D"];
const COUNTDOWN_SFX = ["s_3", "s_2", "s_1", "s_go"] as const;

export class SceneRenderer {
  private readonly app: Application;
  private readonly audio: AudioManager;
  private readonly world = new Container();
  private readonly background: Sprite;
  private readonly paint: PaintLayer;
  private readonly effects: EffectsManager;
  private readonly prize: PrizeView;
  private readonly players: PlayerView[];
  private readonly hud: Hud;
  private readonly countdown: Text;
  private readonly displays: DisplayPlayer[] = SLOT_INDICES.map((slot) => ({
    x: 960,
    y: 540,
    angle: 0,
    targetX: 960,
    targetY: 540,
    targetAngle: 0,
    jumpElapsed: 0,
    squashElapsed: 0,
    bandiStarted: null,
    name: PLAYER_NAMES[slot]!,
  }));

  private snapshot: Snapshot | null = null;
  private lastPhase: MatchPhase | null = null;
  private hasSnapshot = false;
  private totalTicks = ROUND_TICKS;
  private names: string[] = ["Player A", "Player B", "Player C", "Player D"];
  private palettes: number[] = [2, 0, 1, 3];
  private ownSlot: number | null = null;
  private activeSlots = new Set<number>([0, 1]);
  private gameVisible = false;
  private ownInputLeft = false;
  private ownInputRight = false;
  private pointer = { x: 0, y: 0, active: false };
  private predictedAngle = 180;
  private countdownAge = 0;
  private countdownLabel = -1;
  private readonly pendingPaint: Array<{
    x: number;
    y: number;
    radius: number;
    color: number;
    delay: number;
  }> = [];

  constructor(app: Application, assets: GameAssets, audio: AudioManager) {
    this.app = app;
    this.audio = audio;
    this.background = new Sprite(assets.background);
    this.background.width = 1920;
    this.background.height = 1080;

    this.paint = new PaintLayer(app.renderer as PixiRenderer, assets.whiteCircle);
    this.effects = new EffectsManager();
    this.prize = new PrizeView(assets.prizeIcons);
    this.players = [
      new PlayerView(assets.brushes, 2),
      new PlayerView(assets.brushes, 0),
      new PlayerView(assets.brushes, 1),
      new PlayerView(assets.brushes, 3),
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
        if (audio.musicEnabled && this.snapshot?.phase === "playing") audio.startMusic();
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
      this.effects.labels,
      this.hud.container,
      this.countdown,
    );
    app.stage.addChild(this.world);
    app.canvas.addEventListener("pointermove", this.onPointerMove);
    app.canvas.addEventListener("pointerleave", this.onPointerLeave);
    this.setGameVisible(false);
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

  setPlayers(names: readonly string[], palettes: readonly number[], ownSlot: number | null): void {
    this.names = SLOT_INDICES.map((slot) => names[slot] ?? `Player ${slot + 1}`);
    this.palettes = SLOT_INDICES.map((slot) => palettes[slot] ?? 0);
    this.ownSlot = ownSlot;
    for (let slot = 0; slot < this.displays.length; slot += 1) {
      this.displays[slot]!.name = PLAYER_NAMES[slot]!;
    }
  }

  setActiveSlots(slots: readonly number[]): void {
    this.activeSlots = new Set(slots);
    for (let slot = 0; slot < this.players.length; slot += 1) {
      this.players[slot]!.container.visible =
        this.gameVisible && this.activeSlots.has(slot);
    }
  }

  /** Hide brushes/prizes/paint while a DOM menu is in front of the arena. */
  setGameVisible(visible: boolean): void {
    this.gameVisible = visible;
    this.paint.container.visible = visible;
    this.effects.container.visible = visible;
    this.effects.labels.visible = visible;
    this.prize.container.visible = visible;
    for (let slot = 0; slot < this.players.length; slot += 1) {
      this.players[slot]!.container.visible = visible && this.activeSlots.has(slot);
    }
    if (!visible) {
      this.audio.stopCountdown();
      this.countdown.visible = false;
    }
  }

  setLocalInput(left: boolean, right: boolean): void {
    this.ownInputLeft = left;
    this.ownInputRight = right;
  }

  private onPointerMove = (event: PointerEvent): void => {
    const rect = this.app.canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const screenX =
      ((event.clientX - rect.left) / rect.width) * this.app.renderer.screen.width;
    const screenY =
      ((event.clientY - rect.top) / rect.height) * this.app.renderer.screen.height;
    const scale = this.world.scale.x || 1;
    this.pointer = {
      x: (screenX - this.world.x) / scale,
      y: (screenY - this.world.y) / scale,
      active: true,
    };
  };

  private onPointerLeave = (): void => {
    this.pointer.active = false;
  };

  /**
   * Mouse steering: turn toward the cursor with the same left/right inputs as
   * the arrow keys, so the brush rotates at the normal simulated speed.
   */
  pointerIntent(): { left: boolean; right: boolean } {
    const neutral = { left: false, right: false };
    if (!this.pointer.active || this.ownSlot === null) return neutral;
    const display = this.displays[this.ownSlot];
    if (!display) return neutral;
    const dx = this.pointer.x - display.x;
    const dy = this.pointer.y - display.y;
    if (Math.hypot(dx, dy) < 8) return neutral;
    const desired = (Math.atan2(dy, dx) * 180) / Math.PI;
    const delta = ((desired - this.predictedAngle + 540) % 360) - 180;
    if (Math.abs(delta) <= 4) return neutral;
    return delta > 0
      ? { left: false, right: true }
      : { left: true, right: false };
  }

  /** Keep the top HUD bar visible on countdown and results too. */
  setHudEnabled(enabled: boolean): void {
    this.hud.setEnabled(enabled);
  }

  get snapshotState(): Snapshot | null {
    return this.snapshot;
  }

  resetRound(): void {
    this.paint.clear();
    this.effects.clear();
    this.pendingPaint.length = 0;
    this.prize.update(null, 0, 0);
    this.hasSnapshot = false;
    this.audio.stopCountdown();
    this.countdown.visible = false;
    this.countdownLabel = -1;
    this.countdownAge = 0;
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
    // A fresh round must not interpolate from the previous death positions:
    // that smear would be painted as a countdown trail.
    const resetView = first || enteringCountdown || resumingRound;
    if (resetView) {
      this.resetRound();
      this.hasSnapshot = true;
    }
    this.lastPhase = snapshot.phase;
    this.snapshot = snapshot;
    if (first || snapshot.phase === "countdown") {
      this.totalTicks = Math.max(1, snapshot.total ?? snapshot.ticksLeft);
    }

    const now = performance.now() / 1000;
    this.setActiveSlots(snapshot.players.map((player) => player.slot));
    for (const source of snapshot.players) {
      const display = this.displays[source.slot]!;
      const distance = Math.hypot(source.x - display.targetX, source.y - display.targetY);
      display.targetX = source.x;
      display.targetY = source.y;
      display.targetAngle = source.ang;
      if (resetView || distance > 260) {
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
      const own = snapshot.players.find((player) => player.slot === this.ownSlot);
      if (own) this.predictedAngle = own.ang;
    }

    if (snapshot.phase === "countdown") {
      this.showCountdown(snapshot.cd ?? 0);
    } else {
      if (this.countdown.visible) this.audio.stopCountdown();
      this.countdown.visible = false;
    }
  }

  private showCountdown(label: number): void {
    if (label < 0) {
      this.showCountdownWait();
      return;
    }
    if (label !== this.countdownLabel) this.setCountdownLabel(label);
  }

  /** Shows "Ready!" for the server's warm-up ticks before the numbers. */
  beginCountdownWait(): void {
    this.showCountdownWait();
  }

  private showCountdownWait(): void {
    if (this.countdownLabel !== -1) {
      this.countdownLabel = -1;
      this.countdownAge = 0;
      this.countdown.alpha = 1;
      this.countdown.scale.set(1);
    }
    this.countdown.text = "Ready!";
    this.countdown.visible = true;
  }

  private setCountdownLabel(label: number): void {
    this.countdownLabel = label;
    this.countdownAge = 0;
    this.countdown.text = COUNTDOWN_LABELS[label] ?? "Go!";
    this.countdown.visible = true;
    this.countdown.alpha = 1;
    this.countdown.scale.set(1);
    const sound = COUNTDOWN_SFX[label];
    if (sound) this.audio.playCountdown(sound);
  }

  handleEvent(event: GameEvent): void {
    switch (event.type) {
      case "smash":
        // The reference only plays the sound; the jump/squash is the visual.
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
        // Paint the circle immediately (the server already stamped it).
        this.paint.stamp(event.x, event.y, event.radius, paletteColor(event.color));
        this.effects.boom(event.x, event.y, event.color, event.radius);
        this.audio.play("bomb");
        break;
      case "rain":
        // The server stamps one drop immediately, then one every 50 ms.
        event.drops.forEach((drop, index) => {
          this.pendingPaint.push({
            x: drop.x,
            y: drop.y,
            radius: event.radius,
            color: paletteColor(event.color),
            delay: index * 0.05,
          });
        });
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
        break;
      case "end":
        this.audio.stopCountdown();
        this.countdown.visible = false;
        this.pendingPaint.length = 0;
        break;
    }
  }


  private flushPendingPaint(dt: number): void {
    for (let index = this.pendingPaint.length - 1; index >= 0; index -= 1) {
      const stamp = this.pendingPaint[index]!;
      stamp.delay -= dt;
      if (stamp.delay > 0) continue;
      this.paint.stamp(stamp.x, stamp.y, stamp.radius, stamp.color);
      this.pendingPaint.splice(index, 1);
    }
  }

  update(dt: number): void {
    const snapshot = this.snapshot;
    if (!snapshot) {
      return;
    }
    this.flushPendingPaint(dt);
    const now = performance.now() / 1000;

    for (const source of snapshot.players) {
      const slot = source.slot;
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
          this.paint.resetPlayer(PLAYER_NAMES[slot]!);
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
          this.paint.resetPlayer(PLAYER_NAMES[slot]!);
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

    // Stamp the cosmetic paint layer every rendered frame from the displayed
    // (predicted/interpolated) positions, not from 20 Hz snapshots. This keeps
    // the stroke growing at 60 fps exactly like the local pygame build.
    const paintPhase =
      snapshot.phase === "countdown" || snapshot.phase === "playing";
    for (const source of snapshot.players) {
      const slot = source.slot;
      const display = this.displays[slot]!;
      const name = PLAYER_NAMES[slot]!;
      const color = paletteColor(source.c);
      if (paintPhase && source.pt && (source.fl & FLAG_KNOCKBACK) === 0) {
        this.paint.stampTrail(name, display.x, display.y, source.r, color);
      } else {
        this.paint.snap(name, display.x, display.y, source.r, color);
      }
    }

    // Own-player angle prediction (position stays authoritative). Locked until
    // the round starts so the countdown cannot be steered locally either.
    if (this.ownSlot !== null && snapshot.phase === "playing") {
      const source = snapshot.players.find((player) => player.slot === this.ownSlot);
      if (source) {
        const modeAngle = source.m === 0 ? 0 : 6;
        const factor = (dt * 1000) / 35;
        if (this.ownInputRight) this.predictedAngle += modeAngle * factor;
        else if (this.ownInputLeft) this.predictedAngle -= modeAngle * factor;
        let delta = ((source.ang - this.predictedAngle + 540) % 360) - 180;
        if (Math.abs(delta) > 10) this.predictedAngle = source.ang;
        else this.predictedAngle += delta * Math.min(1, dt * 6);
      }
    }

    const observe: ObserveState[] = [];
    for (const source of snapshot.players) {
      const slot = source.slot;
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
          name: this.names[slot] ?? "",
          x: display.x,
          y: display.y,
          angle,
          radius: source.r,
          // The brush sprite keeps its lobby palette even while `follow_me`
          // changes the paint colour (reference brush icons are name-based).
          colorIndex: this.palettes[slot] ?? source.c,
          paintIndex: source.c,
          lift,
          squash,
          swing: this.effects.swingAngle(PLAYER_NAMES[slot]!),
          modeStep,
          jumpProgress,
          jumping: (source.fl & FLAG_JUMPING) !== 0,
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
            : snapshot.phase === "result"
              ? 0
              : this.totalTicks,
        totalTicks: this.totalTicks,
        musicOn: this.audio.musicEnabled,
        sfxOn: this.audio.sfxEnabled,
        phase: snapshot.phase,
      },
      dt,
    );

    if (this.countdown.visible && snapshot.phase === "countdown") {
      this.countdownAge += dt;
      const progress = Math.min(1, this.countdownAge / 0.9);
      const pop = 1 + 0.18 * Math.sin(progress * Math.PI);
      this.countdown.scale.set(pop * (1.15 - 0.15 * progress));
      this.countdown.alpha = 1;
    }

  }
}
