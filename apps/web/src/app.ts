import { Application } from "pixi.js";
import type { SlotIndex, Snapshot } from "@flash/core";
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
  private ownSlot: SlotIndex | null = null;
  private onlineState: StateMessage | null = null;
  private latestSnapshot: Snapshot | null = null;
  private result: RoundEndMessage | OfflineRoundEnd | null = null;
  private latency: number | null = null;
  private connection: ConnectionStatus = "closed";
  private paused = false;
  private mouseControl = true;
  private inputBlocked = true;
  private lastErrorAt = 0;
  private installing = false;
  private resultToken = 0;
  private pauseButtons: HTMLButtonElement[] = [];
  private pauseIndex = 0;
  private lobbyKey: string | null = null;
  private lobbyRows: Array<{
    root: HTMLElement;
    dot: HTMLElement;
    name: HTMLElement;
    state: HTMLElement;
    control: HTMLButtonElement;
  }> = [];
  private lobbySwatches: HTMLElement | null = null;
  private lobbyChosen = 2;
  private lobbyReady: HTMLButtonElement | null = null;
  private lobbyStart: HTMLButtonElement | null = null;
  private lobbyWait: HTMLElement | null = null;
  private lobbyHint: HTMLElement | null = null;
  private lobbyModeButtons: { single: HTMLButtonElement; teams: HTMLButtonElement } | null =
    null;

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
    this.renderer.setActorsVisible(screen !== "result");
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
    left.append(nameLabel, el("p", "tiny", "Pick your color inside the room."));

    const right = el("div", "grid");
    const hostPanel = el("div", "panel grid");
    hostPanel.append(
      el("h3", undefined, "Create a room"),
      el("p", "tiny", "You get a code and a link. Your friend joins with it."),
      button("Create room", () => {
        this.playerName = nameInput.value.trim() || DEFAULT_NAME;
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
    names: string[];
    palettes: number[];
    slots: number[];
  } {
    const state = this.onlineState;
    const names: string[] = [];
    const palettes: number[] = [];
    const slots: number[] = [];
    for (const index of [0, 1, 2, 3] as const) {
      const wire = state?.slots.find((slot) => slot.slot === index) ?? null;
      names[index] = wire?.name ?? `Player ${index + 1}`;
      palettes[index] = wire?.palette ?? [2, 0, 1, 3][index]!;
      if (wire) slots.push(index);
    }
    return { names, palettes, slots };
  }

  private onOnlineState(state: StateMessage): void {
    this.onlineState = state;
    const order = this.onlineOrder();
    this.renderer.setPlayers(order.names, order.palettes, this.ownSlot);
    this.renderer.setActiveSlots(order.slots);
    this.updateChip();

    const disconnected = state.slots.find(
      (slot) =>
        !slot.connected &&
        (state.phase === "countdown" || state.phase === "playing"),
    );
    if (disconnected) {
      toast(`${disconnected.name} disconnected — 20 s to reconnect.`, 3200);
    }

    if (state.phase === "lobby") {
      this.showLobby(state);
      return;
    }
    if (state.phase === "countdown" || state.phase === "playing") {
      if (this.screen !== "game") {
        this.showGameChrome();
        if (state.phase === "countdown") this.renderer.beginCountdownWait();
      }
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
    const room = this.room ?? "";
    const canSync =
      this.lobbyKey === room &&
      this.lobbyRows.length === 4 &&
      this.lobbyRows.every((row) => this.ui.contains(row.root));
    if (!canSync) this.buildLobby(room);
    this.syncLobby(state);
  }

  private buildLobby(room: string): void {
    clear(this.ui);
    this.lobbyKey = room;
    const screen = el("div", "screen classic-page");
    const header = el("div", "row between");
    header.append(el("h2", undefined, "Room"), el("span", "badge", "waiting"));
    screen.append(header, el("div", "code", room));

    const actions = el("div", "row lobby-actions");
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

    const paletteBlock = el("div", "panel lobby-palette");
    paletteBlock.style.marginTop = "16px";
    paletteBlock.append(el("h3", undefined, "Your color"));
    this.lobbyChosen = this.palette;
    this.lobbySwatches = swatches(null, this.lobbyChosen, (index) => {
      this.lobbyChosen = index;
      this.palette = index;
      this.savePreferences();
      if (this.lobbySwatches) updateSwatchRow(this.lobbySwatches, index);
      this.online?.color(index);
    });
    paletteBlock.append(this.lobbySwatches);
    screen.append(paletteBlock);

    const modePanel = el("div", "panel lobby-palette lobby-mode");
    modePanel.style.marginTop = "12px";
    modePanel.append(el("h3", undefined, "Battle mode"));
    const modeRow = el("div", "row");
    const singleButton = button("Single", () => this.online?.setMode("single"), {
      className: "ghost mode-button",
    });
    const teamsButton = button("Teams", () => this.online?.setMode("teams"), {
      className: "ghost mode-button",
    });
    this.lobbyModeButtons = { single: singleButton, teams: teamsButton };
    modeRow.append(singleButton, teamsButton);
    modePanel.append(modeRow);
    screen.append(modePanel);

    const slots = el("div", "slot-list");
    this.lobbyRows = [];
    for (let index = 0; index < 4; index += 1) {
      const row = this.createSlotRow();
      this.lobbyRows.push(row);
      slots.append(row.root);
    }
    const playersTitle = el("h3", undefined, "Players (2–4)");
    playersTitle.style.margin = "18px 0 8px";
    screen.append(playersTitle, slots);

    const footer = el("div", "row");
    footer.style.marginTop = "18px";
    footer.style.justifyContent = "center";
    this.lobbyReady = button("I'm ready", () => {
      this.online?.ready(this.lobbyChosen);
    }, { className: "primary" });
    this.lobbyStart = button("Start game", () => this.online?.start(), {
      className: "primary",
    });
    this.lobbyWait = el("p", "tiny", "Waiting for the host to start…");
    footer.append(
      this.lobbyReady,
      this.lobbyStart,
      this.lobbyWait,
      button("Leave room", () => {
        this.leaveOnline();
        this.showMenu();
      }, { className: "ghost" }),
    );
    screen.append(footer);
    this.lobbyHint = el("p", "tiny", "");
    screen.append(this.lobbyHint);
    this.ui.append(screen);
  }

  private syncLobby(state: StateMessage): void {
    const self = state.slots.find((slot) => slot.slot === state.you) ?? null;
    if (self) this.lobbyChosen = self.palette;
    const isHost = state.host !== null && state.you === state.host;
    const teams = state.mode === "teams";

    if (this.lobbyModeButtons) {
      for (const [mode, item] of [
        ["single", this.lobbyModeButtons.single],
        ["teams", this.lobbyModeButtons.teams],
      ] as const) {
        item.disabled = !isHost;
        item.classList.toggle("primary", state.mode === mode);
        item.classList.toggle("ghost", state.mode !== mode);
      }
    }
    for (let index = 0; index < this.lobbyRows.length; index += 1) {
      const row = this.lobbyRows[index]!;
      const wire = state.slots.find((slot) => slot.slot === index) ?? null;
      if (!wire) {
        row.dot.style.background = "transparent";
        row.dot.style.border = "2px dashed rgba(74, 39, 11, 0.45)";
        row.dot.style.boxShadow = "none";
        row.name.textContent = "Open slot";
        row.state.textContent = "none";
      } else {
        row.dot.style.background = paletteCss(wire.palette);
        row.dot.style.border = "none";
        row.dot.style.boxShadow = "";
        row.name.textContent = wire.name;
        const baseState = wire.bot
          ? "bot"
          : wire.slot === state.host
            ? "host"
            : !wire.connected
              ? "reconnecting"
              : wire.ready
                ? "ready"
                : wire.slot === state.you
                  ? "you"
                  : "not ready";
        row.state.textContent =
          teams && wire.team !== undefined
            ? `${baseState} · team ${wire.team + 1}`
            : baseState;
      }

      if (teams) {
        // Team battle: the host picks which slot joins his team.
        const canPick =
          isHost &&
          wire !== null &&
          index !== state.you &&
          state.host !== null &&
          state.partner !== index;
        row.control.hidden = !canPick;
        if (canPick) {
          row.control.textContent = "Partner";
          row.control.title = "Put this player on your team";
          row.control.onclick = () =>
            this.online?.setTeamPartner(index as SlotIndex);
        }
        continue;
      }

      // Single battle: hosts can toggle the AI for every slot but their own.
      const canToggle = isHost && index !== state.you && (!wire || wire.bot);
      row.control.hidden = !canToggle;
      if (canToggle) {
        row.control.textContent = wire ? "None" : "Bot";
        row.control.title = wire ? "Leave this slot empty" : "Add a bot here";
        row.control.onclick = () =>
          this.online?.setBot(index as SlotIndex, !wire);
      }
    }

    const taken = state.slots
      .filter((slot) => slot.slot !== state.you && !slot.bot)
      .map((slot) => slot.palette);
    if (this.lobbySwatches) {
      syncSwatchRow(this.lobbySwatches, taken, this.lobbyChosen);
    }

    const connected = state.slots.filter((slot) => slot.connected);
    // The host never readies up; only every other human and the bots matter.
    const required = connected.filter((slot) => slot.slot !== state.host);
    const allReady = connected.length >= 2 && required.every((slot) => slot.ready);

    if (this.lobbyReady) {
      const label = this.lobbyReady.firstElementChild;
      if (label) label.textContent = self?.ready ? "Ready!" : "I'm ready";
      this.lobbyReady.disabled = self?.ready ?? false;
      this.lobbyReady.hidden = isHost;
    }
    if (this.lobbyStart) {
      this.lobbyStart.hidden = !isHost;
      this.lobbyStart.disabled = !allReady;
    }
    this.lobbyWait?.toggleAttribute("hidden", isHost);
    if (this.lobbyHint) {
      this.lobbyHint.textContent =
        connected.length < 2
          ? isHost
            ? "Add a bot or wait for another player before starting."
            : "Waiting for another player…"
          : !allReady
            ? "Everyone in the room must be ready before the host can start."
            : "";
    }
  }

  private createSlotRow(): {
    root: HTMLElement;
    dot: HTMLElement;
    name: HTMLElement;
    state: HTMLElement;
    control: HTMLButtonElement;
  } {
    const root = el("div", "slot");
    const dot = el("span", "dot");
    const name = el("span", "name");
    const state = el("span", "state");
    const control = el("button", "ghost");
    control.type = "button";
    control.hidden = true;
    root.append(dot, name, state, control);
    return { root, dot, name, state, control };
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
      el("p", "subtitle", "The round keeps running without you. The remaining players can win by forfeit."),
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

  private resultPlayers(): Array<{
    slot: number;
    name: string;
    palette: number;
    score: number;
  }> {
    const snapshot = this.latestSnapshot;
    const scores = this.result?.scores ?? snapshot?.scores ?? [];
    if (snapshot && snapshot.players.length > 0) {
      return snapshot.players.map((player, index) => {
        const wire =
          this.onlineState?.slots.find((slot) => slot.slot === player.slot) ??
          null;
        const fallbackPalette =
          this.mode === "online"
            ? ([2, 0, 1, 3][player.slot] ?? 0)
            : (player.slot === 0 ? 2 : 0);
        const fallbackName =
          this.mode === "online"
            ? `Player ${player.slot + 1}`
            : `Player ${String.fromCharCode(65 + player.slot)}`;
        return {
          slot: player.slot,
          name: wire?.name ?? fallbackName,
          palette: wire?.palette ?? fallbackPalette,
          score: scores[index] ?? 0,
        };
      });
    }
    return scores.map((score, index) => ({
      slot: index,
      name:
        this.mode === "online"
          ? `Player ${index + 1}`
          : `Player ${String.fromCharCode(65 + index)}`,
      palette: this.mode === "online" ? ([2, 0, 1, 3][index] ?? 0) : index === 0 ? 2 : 0,
      score,
    }));
  }

  /** Slots that share the trophy with `slot` (both teammates in team battle). */
  private teamMembers(slot: number): number[] {
    const state = this.onlineState;
    if (state?.mode !== "teams") return [slot];
    const wire = state.slots.find((candidate) => candidate.slot === slot) ?? null;
    if (!wire || wire.team === undefined) return [slot];
    return state.slots
      .filter((candidate) => candidate.team === wire.team)
      .map((candidate) => candidate.slot);
  }

  private showResult(): void {
    this.setScreen("result");
    this.audio.stopMusic();
    this.resultToken += 1;
    clear(this.ui);
    const players = this.resultPlayers();
    const scores = players.map((player) => player.score);
    const winner = this.result?.winner ?? this.latestSnapshot?.win ?? null;
    const reason = this.result?.reason;
    const teams = this.onlineState?.mode === "teams";
    const winnerSlots = winner === null ? [] : this.teamMembers(winner);

    const veil = el("div", "pause-veil results-veil");
    const scroll = el("div", "scroll-panel result-scroll");
    const content = el("div", "result-content");
    if (players.length > 2) content.classList.add("many");

    const rows = el("div", "result-rows");
    const values: HTMLElement[] = [];
    const trophies: HTMLImageElement[] = [];
    content.append(
      el("h2", "result-title", teams ? "TEAM BATTLE RESULTS" : "SINGLE BATTLE RESULTS"),
    );
    for (const player of players) {
      const row = el("div", "result-row");
      const brush = el("img", "result-brush");
      brush.src = this.brushIcon(player.palette);
      brush.alt = "";
      brush.draggable = false;
      const line = el("div", "result-line");
      const label = el("span", "result-name", player.name);
      label.style.color = paletteCss(player.palette);
      const percent = el("span", "result-percent", "0%");
      values.push(percent);
      line.append(label, percent);
      const trophy = el("img", "result-trophy");
      trophy.src = `${ASSET_BASE}/icons/trophy.png`;
      trophy.alt = winnerSlots.includes(player.slot) ? "Winner" : "";
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
      rematch.textContent = "Waiting for players…";
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
      content.append(el("p", "result-note", "A rematch needs every player present."));
    }
    scroll.append(content);
    veil.append(scroll);
    this.ui.append(veil);
    const winnerRows = winnerSlots
      .map((slot) => players.findIndex((player) => player.slot === slot))
      .filter((index) => index >= 0);
    this.playResultSequence(
      players.length,
      scores,
      rows,
      values,
      trophies,
      winnerRows,
      actions,
    );
  }

  private brushIcon(palette: number): string {
    return this.assets.brushIcons[palette] ?? this.assets.brushIcons[0] ?? "";
  }

  /**
   * Scoreboard reveal: the scroll drops in, then each line counts up with a
   * cue, and finally the winner's trophy pops.
   */
  private playResultSequence(
    count: number,
    scores: readonly number[],
    rows: HTMLElement,
    values: readonly HTMLElement[],
    trophies: readonly HTMLImageElement[],
    winners: readonly number[],
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

    const reveal = (index: number, delay: number): void => {
      at(delay, () => {
        rows.children.item(index)?.classList.add("shown");
        this.audio.play("scoreTick");
        this.countPercent(values[index]!, scores[index] ?? 0, 900, token);
      });
    };
    for (let index = 0; index < count; index += 1) {
      reveal(index, 1700 + index * 1300);
    }

    const trophyAt = 1700 + count * 1300 + 100;
    at(trophyAt, () => {
      this.audio.play("scoreTick");
      for (const index of winners) trophies[index]?.classList.add("pop");
    });

    at(trophyAt + 1200, () => actions.classList.add("shown"));
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
      toast("That color is taken. Pick another.");
    } else if (code === "not_host") {
      toast("Only the host can start the game.");
    } else if (code === "not_enough_players") {
      toast("At least two players are needed to start.");
    } else if (code === "not_ready") {
      toast("Everyone must be ready before the host starts.");
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
    this.renderer.setActiveSlots([0, 1]);
    this.renderer.setPlayers(
      ["Player A", "Player B", "Player C", "Player D"],
      [palettes[0], palettes[1], 1, 3],
      null,
    );
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
      const keyboard = this.input.own();
      const mouse = this.mouseControl
        ? this.renderer.pointerIntent()
        : { left: false, right: false };
      const left = keyboard.left || mouse.left;
      const right = keyboard.right || mouse.right;
      this.renderer.setLocalInput(left, right);
      const phase = this.latestSnapshot?.phase ?? this.onlineState?.phase;
      const active = phase === "playing";
      if (active) this.online.updateInput(left, right);
      else this.online.sendNeutral();
      return;
    }
    if (this.mode === "hotseat" && this.offline) {
      const { a, b } = this.input.hotseat();
      this.offline.setInputs(a, b);
    }
  }

  private onGlobalKeyDown = (event: KeyboardEvent): void => {
    if (
      !event.repeat &&
      (event.key === "p" || event.key === "P") &&
      this.mode === "online" &&
      this.screen === "game"
    ) {
      event.preventDefault();
      this.mouseControl = !this.mouseControl;
      toast(this.mouseControl ? "Mouse control on." : "Mouse control off.");
      return;
    }
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

function syncSwatchRow(
  row: HTMLElement,
  taken: readonly number[],
  selected: number,
): void {
  const takenSet = new Set(taken);
  row.querySelectorAll<HTMLButtonElement>(".swatch").forEach((child, index) => {
    const isTaken = takenSet.has(index);
    child.setAttribute("aria-pressed", String(index === selected));
    child.dataset.taken = String(isTaken);
    child.disabled = isTaken;
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
