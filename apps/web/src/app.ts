import { Application } from "pixi.js";
import type { Snapshot } from "@flash/core";
import type { RoundEndMessage, StateMessage, WelcomeMessage } from "@flash/protocol";
import { AudioManager } from "./audio/audio";
import {
  ASSET_BASE,
  STORAGE,
  httpBase,
  inviteUrl,
  paletteCss,
  roomFromUrl,
} from "./config";
import { KeyboardInput } from "./input/keyboard";
import { OnlineClient, type ConnectionStatus } from "./net/client";
import { OfflineClient, type OfflineRoundEnd } from "./offline/client";
import { loadAssets, type GameAssets } from "./render/assets";
import { SceneRenderer } from "./render/renderer";
import { button, clear, el, swatches, toast } from "./ui/dom";
import { canInstall, promptInstall, registerServiceWorker, setupInstallPrompt } from "./pwa";

type Screen = "boot" | "menu" | "online" | "lobby" | "game" | "result" | "paused";
type Mode = "online" | "hotseat";

const DEFAULT_NAME = "Player";
const ROOM_RE = /^[A-Z0-9]{4,8}$/;

export class FlashApp {
  private app = new Application();
  private audio = new AudioManager();
  private input = new KeyboardInput();
  private renderer!: SceneRenderer;
  private assets!: GameAssets;
  private ui!: HTMLElement;
  private screen: Screen = "boot";
  private mode: Mode | null = null;
  private online: OnlineClient | null = null;
  private offline: OfflineClient | null = null;

  private playerName = DEFAULT_NAME;
  private palette = 2;
  private ownPalette = 2;
  private room: string | null = null;
  private ownSlot: 0 | 1 | null = null;
  private onlineState: StateMessage | null = null;
  private latestSnapshot: Snapshot | null = null;
  private result: RoundEndMessage | OfflineRoundEnd | null = null;
  private latency: number | null = null;
  private connection: ConnectionStatus = "closed";
  private paused = false;
  private inputBlocked = true;
  private lastErrorAt = 0;
  private installing = false;
  private resultToken = 0;
  private pauseButtons: HTMLButtonElement[] = [];
  private pauseIndex = 0;

  async start(): Promise<void> {
    registerServiceWorker();
    setupInstallPrompt();
    this.ui = document.getElementById("ui")!;
    this.readPreferences();

    await this.app.init({
      background: "#060b14",
      resizeTo: window,
      antialias: true,
      autoDensity: true,
      resolution: Math.min(2, window.devicePixelRatio || 1),
      preference: "webgl",
    });
    document.getElementById("stage")!.appendChild(this.app.canvas);

    const loading = this.showLoading();
    const assets = await loadAssets((fraction) => {
      loading.textContent = `Loading brushes… ${Math.round(fraction * 100)}%`;
    });
    await document.fonts.load('700 24px "Comic Neue"').catch(() => undefined);
    this.assets = assets;
    document.documentElement.style.setProperty(
      "--scroll-board",
      `url("${assets.scoreBoard}")`,
    );
    this.renderer = new SceneRenderer(this.app, assets, this.audio);
    loading.remove();

    this.app.ticker.add((ticker) => {
      const dt = Math.min(0.05, ticker.deltaMS / 1000);
      this.renderer.update(dt);
      this.pollInput();
    });

    window.addEventListener("keydown", this.onGlobalKeyDown);
    window.addEventListener("pointerdown", this.onFirstGesture, { once: true });
    window.addEventListener("keydown", this.onFirstGesture, { once: true });
    window.addEventListener("blur", () => {
      this.input.clear();
      if (this.mode === "online") this.online?.sendNeutral();
    });
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState !== "hidden") return;
      if (this.mode === "online") this.online?.sendNeutral();
      if (this.mode === "hotseat" && this.screen === "game") {
        this.setPaused(true);
      }
    });

    const room = roomFromUrl();
    if (room && readSessionToken(room)) this.enterRoom(room);
    else if (room) this.showOnline(room);
    else this.showMenu();
  }

  private onFirstGesture = (): void => {
    this.audio.unlock();
  };

  private readPreferences(): void {
    try {
      const storedName = localStorage.getItem(STORAGE.name);
      if (storedName) this.playerName = storedName.slice(0, 16);
      const storedPaletteRaw = localStorage.getItem(STORAGE.palette);
      const storedPalette = storedPaletteRaw === null ? NaN : Number(storedPaletteRaw);
      if (Number.isInteger(storedPalette) && storedPalette >= 0 && storedPalette <= 3) {
        this.palette = storedPalette;
      }
    } catch {
      // Private-mode storage failures are non-fatal.
    }
  }

  private savePreferences(): void {
    try {
      localStorage.setItem(STORAGE.name, this.playerName);
      localStorage.setItem(STORAGE.palette, String(this.palette));
    } catch {
      // Ignore.
    }
  }

  private showLoading(): HTMLElement {
    clear(this.ui);
    const screen = el("div", "screen compact classic-page");
    const title = el("h1", undefined, "7ammadi Flash");
    title.style.margin = "0 0 8px";
    const line = el("p", "subtitle", "Warming up the brushes…");
    screen.append(title, line);
    this.ui.append(screen);
    return line;
  }

  private setScreen(screen: Screen): void {
    this.screen = screen;
    this.inputBlocked = screen !== "game";
    if (screen !== "game") this.renderer.setLocalInput(false, false);
    // The arcade HUD bar stays up during countdown, play and the score scroll.
    const inArena = screen === "game" || screen === "result";
    this.renderer.setHudEnabled(inArena);
    this.renderer.setGameVisible(inArena);
  }

  // ---------------------------------------------------------------- menus

  private showMenu(): void {
    this.setScreen("menu");
    this.audio.stopMusic();
    clear(this.ui);
    const screen = el("div", "screen classic-page menu-page");
    const brand = el("div", "brand");
    brand.append(el("h1", undefined, "7ammadi Flash"));

    const brushes = el("div", "menu-brushes");
    this.assets.brushIcons.forEach((src, index) => {
      const icon = el("img", "menu-brush");
      icon.src = src;
      icon.alt = "";
      icon.draggable = false;
      icon.style.setProperty("--tilt", `${index % 2 === 0 ? -6 : 6}deg`);
      brushes.append(icon);
    });

    const list = el("div", "menu-list classic");
    list.append(
      button("Play online", () => this.showOnline(), {
        className: "wide menu-play",
        hint: "Create a room or join with a code — free, no account.",
      }),
      button("Play offline", () => this.startLocal("hotseat"), {
        className: "wide menu-local",
        hint: "Two players, one keyboard. A/D and arrow keys.",
      }),
    );

    const installSlot = el("div", "menu-footer");
    installSlot.id = "install-slot";
    installSlot.hidden = !canInstall();
    installSlot.append(
      button("Install app", () => {
        if (this.installing) return;
        this.installing = true;
        void promptInstall().finally(() => {
          this.installing = false;
        });
      }, { className: "ghost install-button" }),
    );

    screen.append(brand, brushes, list, installSlot);
    this.ui.append(screen);
  }

  private showOnline(prefill?: string): void {
    this.setScreen("online");
    this.audio.stopMusic();
    clear(this.ui);
    const screen = el("div", "screen classic-page");
    screen.append(el("h2", undefined, "Play online"));

    const form = el("div", "grid two");
    const left = el("div", "panel grid");
    left.append(el("h3", undefined, "Your setup"));

    const nameLabel = el("label", undefined, "Display name");
    const nameInput = el("input");
    nameInput.type = "text";
    nameInput.name = "name";
    nameInput.maxLength = 16;
    nameInput.value = this.playerName;
    nameLabel.append(nameInput);

    const paletteLabel = el("label", undefined, "Your palette");
    let chosen = this.palette;
    const paletteRow = swatches(null, chosen, (index) => {
      chosen = index;
      this.palette = index;
      this.savePreferences();
      updateSwatchRow(paletteRow, index);
    });
    paletteLabel.append(paletteRow);
    left.append(nameLabel, paletteLabel);

    const right = el("div", "grid");
    const hostPanel = el("div", "panel grid");
    hostPanel.append(
      el("h3", undefined, "Create a room"),
      el("p", "tiny", "You get a code and a link. Your friend joins with it."),
      button("Create room", () => {
        this.playerName = nameInput.value.trim() || DEFAULT_NAME;
        this.palette = chosen;
        this.savePreferences();
        void this.createRoom();
      }, { className: "primary" }),
    );

    const joinPanel = el("div", "panel grid");
    joinPanel.append(el("h3", undefined, "Join with a code"));
    const codeInput = el("input");
    codeInput.type = "text";
    codeInput.maxLength = 8;
    codeInput.placeholder = "ABCD";
    codeInput.value = (prefill ?? roomFromUrl() ?? "").toUpperCase();
    joinPanel.append(
      codeInput,
      button("Join", () => {
        this.playerName = nameInput.value.trim() || DEFAULT_NAME;
        this.palette = chosen;
        this.savePreferences();
        const code = codeInput.value.trim().toUpperCase();
        if (!ROOM_RE.test(code)) {
          toast("Room codes are 4–8 letters or digits.");
          return;
        }
        this.enterRoom(code);
      }, { className: "primary" }),
    );
    right.append(hostPanel, joinPanel);
    form.append(left, right);
    screen.append(form);

    const footer = el("div", "row");
    footer.style.marginTop = "18px";
    footer.append(button("Back", () => this.showMenu(), { className: "ghost" }));
    screen.append(footer);
    this.ui.append(screen);
    if (!prefill) nameInput.focus();
  }

  private async createRoom(): Promise<void> {
    try {
      const response = await fetch(`${httpBase()}/api/rooms`, { method: "POST" });
      if (!response.ok) throw new Error(String(response.status));
      const body = (await response.json()) as { code?: string };
      if (!body.code) throw new Error("missing code");
      this.enterRoom(body.code);
    } catch {
      toast("Could not create a room. Is the room server running?");
    }
  }

  // -------------------------------------------------------------- online

  private enterRoom(code: string): void {
    this.online?.close();
    this.mode = "online";
    this.room = code;
    this.onlineState = null;
    this.result = null;
    this.connection = "connecting";
    history.replaceState(null, "", inviteUrl(code));

    const token = readSessionToken(code) ?? undefined;
    const client = new OnlineClient({
      room: code,
      name: this.playerName,
      ...(token ? { token } : {}),
      onWelcome: (message) => this.onWelcome(message),
      onState: (state) => this.onOnlineState(state),
      onSnapshot: (snapshot) => {
        this.latestSnapshot = snapshot;
        this.renderer.applySnapshot(snapshot);
      },
      onPaint: (paint) => this.renderer.applyMask(paint.w, paint.h, paint.runs),
      onEvent: (event) => this.renderer.handleEvent(event),
      onRoundEnd: (message) => {
        this.result = message;
        this.showResult();
      },
      onError: (errorCode, message) => {
        this.showOnlineError(errorCode, message);
      },
      onStatus: (status) => {
        this.connection = status;
        this.updateChip();
      },
      onLatency: (ms) => {
        this.latency = ms;
        this.updateChip();
      },
    });
    this.online = client;
    client.connect();
    this.showConnecting(code);
  }

  private onWelcome(message: WelcomeMessage): void {
    this.ownSlot = message.slot;
    this.ownPalette = this.palette;
    if (this.room) writeSessionToken(message.token, this.room);
    this.updateChip();
  }

  private onlineOrder(): {
    self: StateMessage["slots"][number] | null;
    opponent: StateMessage["opponent"];
    names: [string, string];
    palettes: [number, number];
  } {
    const state = this.onlineState;
    const self = state?.slots.find((slot) => slot.slot === state.you) ?? null;
    const opponent = state?.opponent ?? null;
    const selfName = self?.name ?? this.playerName;
    const oppName = opponent?.name ?? "Waiting…";
    const selfPalette = self?.palette ?? this.palette;
    const oppPalette = opponent?.palette ?? (selfPalette === 0 ? 1 : 0);
    const you = state?.you ?? this.ownSlot ?? 0;
    return {
      self,
      opponent,
      names: you === 0 ? [selfName, oppName] : [oppName, selfName],
      palettes: you === 0 ? [selfPalette, oppPalette] : [oppPalette, selfPalette],
    };
  }

  private onOnlineState(state: StateMessage): void {
    this.onlineState = state;
    const order = this.onlineOrder();
    this.renderer.setPlayers(order.names, order.palettes, this.ownSlot);
    this.renderer.setActiveSlots(2);
    this.updateChip();
    if (
      state.opponent &&
      !state.opponent.connected &&
      (state.phase === "countdown" || state.phase === "playing")
    ) {
      toast("Opponent disconnected — 20 s to reconnect.", 3200);
    }

    if (state.phase === "lobby") {
      this.showLobby(state);
      return;
    }
    if (state.phase === "countdown" || state.phase === "playing") {
      if (this.screen !== "game") this.showGameChrome();
      if (state.phase === "playing") {
        if (this.audio.musicEnabled) this.audio.startMusic();
      } else {
        this.audio.stopMusic();
      }
      return;
    }
    if (state.phase === "result") {
      if (!this.result && this.latestSnapshot) {
        this.result = {
          t: "roundEnd",
          scores: this.latestSnapshot.scores,
          winner: this.latestSnapshot.win ?? null,
          reason: state.reason ?? "time",
        };
      }
      if (this.screen !== "result") this.showResult();
    }
  }

  private showConnecting(code: string): void {
    this.setScreen("lobby");
    this.audio.stopMusic();
    clear(this.ui);
    const screen = el("div", "screen compact classic-page");
    screen.append(
      el("h2", undefined, "Connecting…"),
      el("p", "subtitle", `Joining room ${code}`),
    );
    const row = el("div", "row");
    row.style.marginTop = "18px";
    row.append(
      button("Cancel", () => {
        this.leaveOnline();
        this.showMenu();
      }, { className: "ghost" }),
    );
    screen.append(row);
    this.ui.append(screen);
  }

  private showLobby(state: StateMessage): void {
    this.setScreen("lobby");
    this.audio.stopMusic();
    clear(this.ui);
    const room = this.room ?? "";
    const screen = el("div", "screen classic-page");
    const header = el("div", "row between");
    header.append(el("h2", undefined, "Room"), el("span", "badge", "waiting"));
    screen.append(header, el("div", "code", room));

    const actions = el("div", "row");
    actions.style.margin = "14px 0 20px";
    actions.append(
      button("Copy invite link", () => {
        const link = inviteUrl(room);
        void navigator.clipboard
          .writeText(link)
          .then(() => toast("Invite link copied."))
          .catch(() => toast(link));
      }, { className: "primary" }),
      button("Copy code", () => {
        void navigator.clipboard
          .writeText(room)
          .then(() => toast("Room code copied."))
          .catch(() => toast(room));
      }, { className: "ghost" }),
    );
    screen.append(actions);

    const self = state.slots.find((slot) => slot.slot === state.you) ?? null;
    const opponent = state.opponent;
    const slots = el("div", "slot-list");
    slots.append(
      this.slotRow(
        self?.name ?? this.playerName,
        self?.palette ?? this.palette,
        "you",
        self?.ready ?? false,
        self?.connected ?? true,
      ),
      opponent
        ? this.slotRow(
            opponent.name,
            opponent.palette,
            opponent.ready ? "ready" : "not ready",
            opponent.ready,
            opponent.connected,
          )
        : this.slotRow("Waiting for a challenger…", 1, "empty", false, true),
    );
    screen.append(el("h3", undefined, "Players"), slots);

    const paletteBlock = el("div", "panel grid");
    paletteBlock.style.marginTop = "16px";
    paletteBlock.append(el("h3", undefined, "Your palette"));
    const taken = opponent?.palette ?? null;
    let chosen = self?.palette ?? this.palette;
    const row = swatches(taken, chosen, (index) => {
      chosen = index;
      this.palette = index;
      this.savePreferences();
      updateSwatchRow(row, index);
    });
    paletteBlock.append(row);
    screen.append(paletteBlock);

    const footer = el("div", "row between");
    footer.style.marginTop = "18px";
    footer.append(
      button(self?.ready ? "Ready!" : "I'm ready", () => {
        this.online?.ready(chosen);
      }, { className: "primary", disabled: self?.ready ?? false }),
      button("Leave room", () => {
        this.leaveOnline();
        this.showMenu();
      }, { className: "ghost" }),
    );
    screen.append(footer);
    screen.append(
      el(
        "p",
        "tiny",
        opponent?.ready && self?.ready
          ? "Both ready — starting…"
          : "The match starts automatically when both players are ready.",
      ),
    );
    this.ui.append(screen);
  }

  private slotRow(
    name: string,
    palette: number,
    status: string,
    ready: boolean,
    connected: boolean,
  ): HTMLElement {
    const row = el("div", "slot");
    const dot = el("span", "dot");
    dot.style.background = paletteCss(palette);
    const label = el("span", "name", name);
    const state = el(
      "span",
      "state",
      !connected ? "reconnecting" : ready ? "ready" : status,
    );
    row.append(dot, label, state);
    return row;
  }

  private showGameChrome(): void {
    this.setScreen("game");
    clear(this.ui);
    if (this.mode === "online") {
      const chip = el("div", "hud-chip");
      chip.id = "game-chip";
      chip.append(el("span", "pill", this.room ? `room ${this.room}` : "online"));
      const latency = el("span", "pill", "—");
      latency.id = "latency-pill";
      chip.append(latency);
      this.ui.append(chip);
    }
    this.updateChip();
  }

  private updateChip(): void {
    const pill = document.getElementById("latency-pill");
    if (!pill) return;
    if (this.connection === "reconnecting") pill.textContent = "reconnecting…";
    else if (this.connection === "connecting") pill.textContent = "connecting…";
    else if (this.connection === "closed") pill.textContent = "offline";
    else pill.textContent = this.latency === null ? "—" : `${Math.round(this.latency)} ms`;
  }

  private confirmLeave(): void {
    if (this.mode === "online") this.online?.sendNeutral();
    this.inputBlocked = true;
    clear(this.ui);
    const veil = el("div", "pause-veil");
    const card = el("div", "overlay-card");
    card.append(
      el("h2", undefined, "Leave the match?"),
      el("p", "subtitle", "The round keeps running without you. Your opponent can win by forfeit."),
    );
    const row = el("div", "row");
    row.style.justifyContent = "center";
    row.append(
      button("Keep playing", () => {
        this.inputBlocked = false;
        this.showGameChrome();
      }, { className: "primary" }),
      button("Leave", () => {
        this.leaveOnline();
        this.showMenu();
      }, { className: "danger" }),
    );
    card.append(row);
    veil.append(card);
    this.ui.append(veil);
  }

  private showResult(): void {
    this.setScreen("result");
    this.audio.stopMusic();
    this.resultToken += 1;
    clear(this.ui);
    const order = this.mode === "online" ? this.onlineOrder() : null;
    const scores = this.result?.scores ?? this.latestSnapshot?.scores ?? [0, 0];
    const winner = this.result?.winner ?? this.latestSnapshot?.win ?? null;
    const reason = this.result?.reason;
    const palettes: [number, number] = order ? order.palettes : [2, 0];

    const veil = el("div", "pause-veil results-veil");
    const scroll = el("div", "scroll-panel result-scroll");
    const content = el("div", "result-content");
    content.append(el("h2", "result-title", "Battle Results"));

    const rows = el("div", "result-rows");
    const values: HTMLElement[] = [];
    const trophies: HTMLImageElement[] = [];
    for (const index of [0, 1] as const) {
      const row = el("div", "result-row");
      const brush = el("img", "result-brush");
      brush.src = this.brushIcon(palettes[index]!);
      brush.alt = "";
      brush.draggable = false;
      const line = el("div", "result-line");
      const label = el("span", "result-name", `Player ${index + 1} :`);
      label.style.color = paletteCss(palettes[index]!);
      const percent = el("span", "result-percent", "0%");
      values.push(percent);
      line.append(label, percent);
      const trophy = el("img", "result-trophy");
      trophy.src = `${ASSET_BASE}/icons/trophy.png`;
      trophy.alt = winner === index ? "Winner" : "";
      trophy.decoding = "async";
      trophies.push(trophy);
      row.append(brush, line, trophy);
      rows.append(row);
    }
    content.append(rows);

    const actions = el("div", "result-actions");
    const online = this.mode === "online";
    const rematch = button("Rematch", () => {
      rematch.disabled = true;
      rematch.textContent = "Waiting for opponent…";
      if (online) this.online?.rematch();
      else this.offline?.rematch();
    }, { className: "primary" });
    actions.append(
      rematch,
      button(online ? "Leave room" : "Main menu", () => {
        if (online) this.leaveOnline();
        else this.closeOffline();
        this.showMenu();
      }, { className: "ghost" }),
    );
    content.append(actions);
    if (online && reason === "forfeit") {
      content.append(el("p", "result-note", "A rematch needs both players present."));
    }
    scroll.append(content);
    veil.append(scroll);
    this.ui.append(veil);
    this.playResultSequence(scores, rows, values, trophies, winner, actions);
  }

  private brushIcon(palette: number): string {
    return this.assets.brushIcons[palette] ?? this.assets.brushIcons[0] ?? "";
  }

  /**
   * Scoreboard reveal: the scroll drops in, then each line counts up with a
   * cue, and finally the winner's trophy pops.
   */
  private playResultSequence(
    scores: readonly [number, number],
    rows: HTMLElement,
    values: readonly HTMLElement[],
    trophies: readonly HTMLImageElement[],
    winner: number | null,
    actions: HTMLElement,
  ): void {
    const token = this.resultToken;
    const alive = (): boolean => this.screen === "result" && this.resultToken === token;
    const at = (delay: number, fn: () => void): void => {
      window.setTimeout(() => {
        if (alive()) fn();
      }, delay);
    };

    // The panel itself slides down from above the screen via CSS.
    this.audio.play("scoreTick");

    const reveal = (index: 0 | 1, delay: number): void => {
      at(delay, () => {
        rows.children.item(index)?.classList.add("shown");
        this.audio.play("scoreTick");
        this.countPercent(values[index]!, scores[index] ?? 0, 900, token);
      });
    };
    reveal(0, 1700);
    reveal(1, 3000);

    at(4400, () => {
      this.audio.play("scoreTick");
      if (winner !== null) trophies[winner]?.classList.add("pop");
    });

    at(5600, () => actions.classList.add("shown"));
  }

  private countPercent(
    node: HTMLElement,
    score: number,
    duration: number,
    token: number,
  ): void {
    const start = performance.now();
    const step = (): void => {
      if (this.screen !== "result" || this.resultToken !== token) return;
      const progress = Math.min(1, (performance.now() - start) / duration);
      const eased = 1 - (1 - progress) ** 3;
      node.textContent = `${Math.round(score * eased)}%`;
      if (progress < 1) requestAnimationFrame(step);
      else node.textContent = `${score}%`;
    };
    requestAnimationFrame(step);
  }

  private showOnlineError(code: string, message?: string): void {
    const now = Date.now();
    if (now - this.lastErrorAt < 800) return;
    this.lastErrorAt = now;
    if (code === "room_full") {
      toast("That room is already full.");
      this.leaveOnline();
      this.showMenu();
    } else if (code === "bad_room") {
      toast("That room code is not valid.");
      this.leaveOnline();
      this.showMenu();
    } else if (code === "bad_version") {
      toast("Updating to the latest version…");
      window.setTimeout(() => location.reload(), 700);
    } else if (code === "palette_taken") {
      toast("That palette is taken. Pick another.");
    } else if (code === "bad_name") {
      toast("Choose a display name (1–16 printable characters).");
    } else if (code === "too_large") {
      toast("Message too large.");
    } else if (code === "rate_limited") {
      toast("Slow down a moment.");
    } else {
      toast(message ?? `Connection error (${code}).`);
    }
  }

  private leaveOnline(): void {
    this.online?.leave();
    this.online = null;
    this.mode = null;
    this.onlineState = null;
    this.result = null;
    this.latestSnapshot = null;
    this.ownSlot = null;
    this.connection = "closed";
    this.room = null;
    history.replaceState(null, "", location.pathname);
    this.inputBlocked = true;
  }

  // -------------------------------------------------------------- offline

  private startLocal(mode: "hotseat"): void {
    this.closeOffline();
    this.mode = mode;
    this.result = null;
    this.latestSnapshot = null;
    this.paused = false;
    const palettes: [number, number] = [2, 0];
    this.ownPalette = palettes[0];
    this.renderer.resetRound();
    this.renderer.setActiveSlots(2);
    this.renderer.setPlayers(["Player A", "Player B"], palettes, null);
    this.offline = new OfflineClient({ mode, palettes });
    this.offline.onSnapshot = (snapshot) => {
      this.latestSnapshot = snapshot;
      this.renderer.applySnapshot(snapshot);
    };
    this.offline.onEvent = (event) => this.renderer.handleEvent(event);
    this.offline.onState = (message) => {
      if (message.phase === "countdown" || message.phase === "playing") {
        if (this.screen !== "game") this.showGameChrome();
        this.inputBlocked = false;
        if (message.phase === "playing") {
          if (this.audio.musicEnabled) this.audio.startMusic();
        } else {
          this.audio.stopMusic();
        }
      }
    };
    this.offline.onRoundEnd = (message) => {
      this.result = message;
      this.showResult();
    };
    this.showGameChrome();
    this.inputBlocked = false;
  }

  private closeOffline(): void {
    this.offline?.close();
    this.offline = null;
    if (this.mode !== "online") this.mode = null;
    this.paused = false;
    this.pauseButtons = [];
    this.pauseIndex = 0;
  }

  private setPaused(paused: boolean): void {
    if (this.mode === "online" || !this.offline) return;
    this.paused = paused;
    this.offline.setPaused(paused);
    this.input.clear();
    if (!paused) {
      this.pauseButtons = [];
      this.pauseIndex = 0;
      this.showGameChrome();
      this.inputBlocked = false;
      if (this.audio.musicEnabled && this.latestSnapshot?.phase === "playing") {
        this.audio.startMusic();
      }
      return;
    }
    this.inputBlocked = true;
    this.audio.pauseMusic();
    clear(this.ui);
    const veil = el("div", "pause-veil");
    const card = el("div", "overlay-card");
    card.append(el("h2", undefined, "Paused"));
    const menu = el("div", "overlay-menu");
    const resume = button("Resume", () => this.setPaused(false), {
      className: "primary wide",
    });
    const restart = button("Restart", () => {
      this.closeOffline();
      this.startLocal("hotseat");
    }, { className: "ghost wide" });
    const mainMenu = button("Main menu", () => {
      this.closeOffline();
      this.showMenu();
    }, { className: "ghost wide" });
    this.pauseButtons = [resume, restart, mainMenu];
    this.pauseIndex = 0;
    for (const item of this.pauseButtons) item.tabIndex = -1;
    menu.append(...this.pauseButtons);
    card.append(menu);
    veil.append(card);
    this.ui.append(veil);
    this.updatePauseSelection();
  }

  private movePauseSelection(delta: number): void {
    if (this.pauseButtons.length === 0) return;
    this.pauseIndex =
      (this.pauseIndex + delta + this.pauseButtons.length) % this.pauseButtons.length;
    this.updatePauseSelection();
    this.audio.play("scoreTick");
  }

  private updatePauseSelection(): void {
    this.pauseButtons.forEach((item, index) => {
      item.classList.toggle("selected", index === this.pauseIndex);
    });
  }

  private selectPauseButton(): void {
    const item = this.pauseButtons[this.pauseIndex];
    if (!item) return;
    this.audio.play("scoreTick");
    item.click();
  }

  // --------------------------------------------------------------- input

  private pollInput(): void {
    if (this.screen !== "game" || this.inputBlocked) {
      if (this.mode === "online") this.online?.sendNeutral();
      return;
    }
    if (this.mode === "online" && this.online) {
      const intent = this.input.own();
      this.renderer.setLocalInput(intent.left, intent.right);
      const active =
        this.onlineState?.phase === "playing" || this.onlineState?.phase === "countdown";
      if (active) this.online.updateInput(intent.left, intent.right);
      else this.online.sendNeutral();
      return;
    }
    if (this.mode === "hotseat" && this.offline) {
      const { a, b } = this.input.hotseat();
      this.offline.setInputs(a, b);
    }
  }

  private onGlobalKeyDown = (event: KeyboardEvent): void => {
    if (this.mode === "hotseat" && this.paused) {
      if (event.key === "ArrowUp") {
        event.preventDefault();
        this.movePauseSelection(-1);
        return;
      }
      if (event.key === "ArrowDown") {
        event.preventDefault();
        this.movePauseSelection(1);
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        this.selectPauseButton();
        return;
      }
    }
    if (event.key !== "Escape") return;
    if (this.mode === "online" && this.screen === "game") {
      event.preventDefault();
      this.confirmLeave();
      return;
    }
    if (
      this.mode === "hotseat" &&
      (this.screen === "game" || this.screen === "paused")
    ) {
      event.preventDefault();
      this.setPaused(!this.paused);
    }
  };
}

function updateSwatchRow(row: HTMLElement, selected: number): void {
  const children = row.querySelectorAll(".swatch");
  children.forEach((child, index) => {
    child.setAttribute("aria-pressed", String(index === selected));
  });
}

function readSessionToken(room: string): string | null {
  try {
    return sessionStorage.getItem(STORAGE.token(room));
  } catch {
    return null;
  }
}

function writeSessionToken(token: string, room: string): void {
  try {
    sessionStorage.setItem(STORAGE.token(room), token);
  } catch {
    // Ignore.
  }
}
