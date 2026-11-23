/**
 * Platform-free authoritative room.
 *
 * Owns lobby state, per-player input buffering with a TTL, snapshot cadence,
 * reconnect grace and forfeit rules. It never touches sockets, storage, timers
 * or wall clocks: adapters call `tick()` on their own schedule and forward the
 * returned messages.
 */

import {
  DEFAULT_PALETTE_A,
  DEFAULT_PALETTE_B,
  MAX_PLAYERS,
  NEUTRAL_INPUT,
  PALETTE_COUNT,
  ROUND_TICKS,
  SLOT_INDICES,
  TICK_MS,
  createSim,
  encodeMaskRle,
  botInput,
  reflectBotHeading,
  finishRound,
  serializeSnapshot,
  stepSim,
  type GameEvent,
  type InputState,
  type RoundEndReason,
  type SimConfig,
  type SimState,
  type SlotIndex,
  type Snapshot,
} from "@flash/core";
import {
  defaultRoomConfig,
  type RoomConfigWire,
  type RoomPhase,
  type SlotWire,
  type StateMessage,
} from "@flash/protocol";

export const SNAPSHOT_EVERY_TICKS = 3;
export const DEFAULT_INPUT_TTL_TICKS = 15; // 250 ms
export const DEFAULT_GRACE_TICKS = 1200; // 20 s

export interface RoomSlot {
  slot: SlotIndex;
  playerId: string;
  token: string;
  name: string;
  palette: number;
  ready: boolean;
  connected: boolean;
  /** True for an AI-filled slot; a joining human replaces it in place. */
  bot: boolean;
  disconnectTick: number | null;
  lastInputTick: number;
  lastInputSeq: number;
  input: InputState;
  messagesThisTick: number;
}

export interface JoinResultOk {
  ok: true;
  playerId: string;
  slot: SlotIndex;
  token: string;
  reconnected: boolean;
}

export interface JoinResultError {
  ok: false;
  code: "room_full";
}

export type JoinResult = JoinResultOk | JoinResultError;

export interface StartResultOk {
  ok: true;
  started: boolean;
}

export interface StartResultError {
  ok: false;
  code: "not_joined" | "not_host" | "not_enough_players" | "not_ready";
}

export type StartResult = StartResultOk | StartResultError;

export interface RoomOptions {
  code: string;
  /** Test seam: shorten rounds/countdown without touching rule constants. */
  matchConfig?: Omit<SimConfig, "palettes" | "seed" | "activeSlots" | "spawn">;
  inputTtlTicks?: number;
  graceTicks?: number;
  seedPrefix?: string;
  /** Fill every open slot with a ready bot (production rooms enable this). */
  bots?: boolean;
}

export type TickReason =
  | "none"
  | "started"
  | "phase"
  | "ready"
  | "disconnect"
  | "reconnect"
  | "left"
  | "rematch";

export interface TickOutput {
  snapshots: Snapshot[];
  events: GameEvent[];
  stateChanged: boolean;
  reason: TickReason;
  phase: RoomPhase;
}

export interface RoomMetrics {
  ticks: number;
  snapshots: number;
  events: number;
  matches: number;
}

export interface SlotRecord {
  slot: SlotIndex;
  name: string;
  token: string;
  palette: number;
  ready: boolean;
}

/** Lifecycle-only persistence record. Never contains per-tick simulation. */
export interface RoomRecord {
  code: string;
  matchNumber: number;
  slots: (SlotRecord | null)[];
}

const DEFAULT_SLOT_PALETTES: readonly number[] = [
  DEFAULT_PALETTE_A,
  DEFAULT_PALETTE_B,
  1,
  3,
];

export class RoomEngine {
  readonly code: string;
  readonly slots: (RoomSlot | null)[] = SLOT_INDICES.map(() => null);
  phase: RoomPhase = "lobby";
  engineTick = 0;
  lastActivityTick = 0;
  metrics: RoomMetrics = { ticks: 0, snapshots: 0, events: 0, matches: 0 };

  private sim: SimState | null = null;
  private matchNumber = 0;
  private readonly ttlTicks: number;
  private readonly graceTicks: number;
  private readonly options: RoomOptions;
  private stateChanged = false;
  private forceSnapshot = false;
  private pendingReason: TickReason = "none";
  private readonly rematchVotes = new Set<number>();
  private readonly botsEnabled: boolean;
  private readonly botBaseAngles: number[] = SLOT_INDICES.map(() => 0);
  /** Slots the host explicitly left empty in the lobby. */
  private readonly disabledBots = new Set<SlotIndex>();

  constructor(options: RoomOptions) {
    this.code = options.code;
    this.options = options;
    this.ttlTicks = options.inputTtlTicks ?? DEFAULT_INPUT_TTL_TICKS;
    this.graceTicks = options.graceTicks ?? DEFAULT_GRACE_TICKS;
    this.botsEnabled = options.bots ?? false;
    if (this.botsEnabled) this.fillBots();
  }

  get simState(): SimState | null {
    return this.sim;
  }

  get playerCount(): number {
    return this.slots.filter((slot) => slot !== null).length;
  }

  get connectedCount(): number {
    return this.slots.filter((slot) => slot?.connected).length;
  }

  /** Lowest connected human slot; bots never become host. */
  get hostSlot(): SlotIndex | null {
    for (const slot of this.slots) {
      if (slot?.connected && !slot.bot) return slot.slot;
    }
    return null;
  }

  /** Host can start once two or more connected players are ready. */
  get canStart(): boolean {
    if (this.phase !== "lobby") return false;
    const present = this.connectedSlots();
    return (
      present.length >= 2 && present.every((slot) => this.readyForStart(slot))
    );
  }

  /** The host is implicitly ready; bots are always ready. */
  private readyForStart(slot: RoomSlot): boolean {
    return slot.bot || slot.slot === this.hostSlot || slot.ready;
  }

  private connectedSlots(): RoomSlot[] {
    return this.slots.filter(
      (slot): slot is RoomSlot => slot !== null && slot.connected,
    );
  }

  configWire(): RoomConfigWire {
    const base = defaultRoomConfig();
    return {
      ...base,
      roundSeconds: base.roundSeconds,
      inputTtlMs: Math.round(this.ttlTicks * TICK_MS),
      graceMs: Math.round(this.graceTicks * TICK_MS),
    };
  }

  join(name: string, newToken: string, token?: string): JoinResult {
    this.touch();

    if (token) {
      const existing = this.findByToken(token);
      if (existing && !existing.bot) {
        existing.connected = true;
        existing.disconnectTick = null;
        existing.messagesThisTick = 0;
        // A reloaded client starts its sequence at 0 again.
        existing.lastInputSeq = -1;
        existing.input = { ...NEUTRAL_INPUT };
        existing.lastInputTick = this.sim?.tick ?? 0;
        this.stateChanged = true;
        this.forceSnapshot = true;
        this.pendingReason = "reconnect";
        return {
          ok: true,
          playerId: existing.playerId,
          slot: existing.slot,
          token: existing.token,
          reconnected: true,
        };
      }
    }

    // Humans fill open slots first, then take over the lowest bot until
    // everyone who joins has a brush.
    const empty = SLOT_INDICES.find((index) => this.slots[index] === null);
    const bot = SLOT_INDICES.find((index) => this.slots[index]?.bot);
    const slot = empty ?? bot;
    if (slot === undefined) return { ok: false, code: "room_full" };

    const palette = this.slots[slot]?.palette ?? this.defaultPalette(slot);
    const player: RoomSlot = {
      slot,
      playerId: `${this.code}-${slot}`,
      token: newToken,
      name,
      palette,
      ready: false,
      connected: true,
      bot: false,
      disconnectTick: null,
      lastInputTick: 0,
      lastInputSeq: -1,
      input: { ...NEUTRAL_INPUT },
      messagesThisTick: 0,
    };
    this.slots[slot] = player;
    this.disabledBots.delete(slot);
    this.stateChanged = true;
    this.forceSnapshot = true;
    this.pendingReason = "reconnect";
    return {
      ok: true,
      playerId: player.playerId,
      slot,
      token: player.token,
      reconnected: false,
    };
  }

  private defaultPalette(slot: SlotIndex): number {
    const preferred = DEFAULT_SLOT_PALETTES[slot] ?? slot % PALETTE_COUNT;
    const used = new Set(
      this.slots
        .filter((candidate): candidate is RoomSlot => candidate !== null && candidate.slot !== slot)
        .map((candidate) => candidate.palette),
    );
    if (!used.has(preferred)) return preferred;
    for (let palette = 0; palette < PALETTE_COUNT; palette += 1) {
      if (!used.has(palette)) return palette;
    }
    return preferred;
  }

  findByPlayerId(playerId: string): RoomSlot | null {
    return (
      this.slots.find((slot) => slot?.playerId === playerId) ?? null
    );
  }

  /** Keeps every open slot playable while the room waits for humans. */
  private fillBots(): void {
    if (!this.botsEnabled) return;
    for (const slot of SLOT_INDICES) {
      if (this.slots[slot] || this.disabledBots.has(slot)) continue;
      this.slots[slot] = this.createBot(slot);
      this.stateChanged = true;
    }
  }

  private createBot(slot: SlotIndex): RoomSlot {
    return {
      slot,
      playerId: `${this.code}-bot-${slot}`,
      token: `bot-${this.code}-${slot}`,
      name: `Bot ${slot + 1}`,
      palette: this.defaultPalette(slot),
      ready: true,
      connected: true,
      bot: true,
      disconnectTick: null,
      lastInputTick: 0,
      lastInputSeq: -1,
      input: { ...NEUTRAL_INPUT },
      messagesThisTick: 0,
    };
  }

  /**
   * Host-only lobby control: toggle the AI in a slot. `enabled: false` leaves
   * the slot empty for the round; `true` puts a ready bot back. Human slots are
   * never touched.
   */
  setBot(
    playerId: string,
    target: SlotIndex,
    enabled: boolean,
  ): { ok: true } | { ok: false; code: "not_joined" | "not_host" | "not_ready" } {
    const caller = this.findByPlayerId(playerId);
    if (!caller) return { ok: false, code: "not_joined" };
    if (this.phase !== "lobby") return { ok: false, code: "not_ready" };
    if (this.hostSlot !== caller.slot) return { ok: false, code: "not_host" };
    const existing = this.slots[target] ?? null;
    if (existing && !existing.bot) return { ok: false, code: "not_ready" };

    this.touch();
    if (enabled) {
      this.disabledBots.delete(target);
      if (!existing) this.slots[target] = this.createBot(target);
    } else {
      this.disabledBots.add(target);
      if (existing?.bot) this.slots[target] = null;
    }
    this.reassignBotPalettes();
    this.stateChanged = true;
    this.pendingReason = "ready";
    return { ok: true };
  }

  findByToken(token: string): RoomSlot | null {
    return this.slots.find((slot) => slot?.token === token) ?? null;
  }

  ready(playerId: string, palette: number): { ok: true } | { ok: false; code: "palette_taken" | "not_joined" } {
    const slot = this.findByPlayerId(playerId);
    if (!slot) return { ok: false, code: "not_joined" };
    if (this.phase !== "lobby") return { ok: true };
    const taken = this.slots.some(
      (other) =>
        other !== null &&
        !other.bot &&
        other.slot !== slot.slot &&
        other.palette === palette,
    );
    if (taken) {
      return { ok: false, code: "palette_taken" };
    }
    this.touch();
    slot.palette = palette;
    slot.ready = true;
    this.reassignBotPalettes();
    this.stateChanged = true;
    this.pendingReason = "ready";
    return { ok: true };
  }

  /** Lobby colour change that is broadcast immediately without readying up. */
  color(playerId: string, palette: number): { ok: true } | { ok: false; code: "palette_taken" | "not_joined" } {
    const slot = this.findByPlayerId(playerId);
    if (!slot) return { ok: false, code: "not_joined" };
    if (this.phase !== "lobby") return { ok: true };
    const taken = this.slots.some(
      (other) =>
        other !== null &&
        !other.bot &&
        other.slot !== slot.slot &&
        other.palette === palette,
    );
    if (taken) return { ok: false, code: "palette_taken" };
    if (slot.palette === palette) return { ok: true };
    this.touch();
    slot.palette = palette;
    this.reassignBotPalettes();
    this.stateChanged = true;
    this.pendingReason = "ready";
    return { ok: true };
  }

  /** Bots yield any colour a human picks, keeping all four brushes distinct. */
  private reassignBotPalettes(): void {
    const used = new Set<number>();
    for (const slot of this.slots) {
      if (slot && !slot.bot) used.add(slot.palette);
    }
    for (const index of SLOT_INDICES) {
      const bot = this.slots[index];
      if (!bot?.bot) continue;
      let palette = bot.palette;
      if (used.has(palette)) {
        palette = -1;
        for (let candidate = 0; candidate < PALETTE_COUNT; candidate += 1) {
          if (!used.has(candidate)) {
            palette = candidate;
            break;
          }
        }
        bot.palette = palette >= 0 ? palette : bot.palette;
        palette = bot.palette;
      }
      used.add(palette);
    }
  }

  /** Host-only start, allowed with any player count from 2 to 4. */
  start(playerId: string): StartResult {
    const slot = this.findByPlayerId(playerId);
    if (!slot) return { ok: false, code: "not_joined" };
    if (this.phase !== "lobby") return { ok: false, code: "not_ready" };
    if (this.hostSlot !== slot.slot) return { ok: false, code: "not_host" };
    const present = this.connectedSlots();
    if (present.length < 2) return { ok: false, code: "not_enough_players" };
    if (present.some((candidate) => !this.readyForStart(candidate))) {
      return { ok: false, code: "not_ready" };
    }
    this.touch();
    this.startMatch();
    return { ok: true, started: true };
  }

  input(
    playerId: string,
    input: InputState,
    seq: number,
    clientTick: number,
  ): { ok: boolean; code?: "rate_limited" | "not_joined" } {
    const slot = this.findByPlayerId(playerId);
    if (!slot) return { ok: false, code: "not_joined" };
    slot.messagesThisTick += 1;
    if (slot.messagesThisTick > 60) return { ok: false, code: "rate_limited" };

    if (seq <= slot.lastInputSeq) return { ok: true };
    slot.lastInputSeq = seq;
    slot.input = { left: input.left, right: input.right };
    slot.lastInputTick = this.sim?.tick ?? 0;
    void clientTick;
    this.touch();
    return { ok: true };
  }

  rematch(playerId: string): { started: boolean } {
    if (this.phase !== "result") return { started: false };
    const slot = this.findByPlayerId(playerId);
    if (!slot) return { started: false };
    this.rematchVotes.add(slot.slot);
    this.touch();

    const started = this.maybeStartRematch();
    if (!started) {
      this.stateChanged = true;
      this.pendingReason = "rematch";
    }
    return { started };
  }

  /** Rematch only waits for players who are still connected. */
  private maybeStartRematch(): boolean {
    if (this.phase !== "result") return false;
    const required = this.connectedSlots()
      .filter((candidate) => !candidate.bot)
      .map((candidate) => candidate.slot);
    const started =
      required.length >= 1 &&
      required.every((vote) => this.rematchVotes.has(vote));
    if (started) this.startMatch();
    return started;
  }

  leave(playerId: string): void {
    const slot = this.findByPlayerId(playerId);
    if (!slot) return;
    this.touch();
    if (this.phase === "lobby") {
      this.slots[slot.slot] = null;
      this.rematchVotes.clear();
      this.sim = null;
      this.phase = "lobby";
      this.fillBots();
      this.stateChanged = true;
      this.pendingReason = "left";
      return;
    }
    if (this.phase === "result") {
      this.slots[slot.slot] = null;
      this.rematchVotes.delete(slot.slot);
      if (this.connectedSlots().filter((candidate) => !candidate.bot).length === 0) {
        this.rematchVotes.clear();
        this.sim = null;
        this.phase = "lobby";
        this.fillBots();
        this.pendingReason = "left";
      } else if (!this.maybeStartRematch()) {
        this.pendingReason = "left";
      }
      this.stateChanged = true;
      return;
    }
    this.markDisconnected(slot);
  }

  disconnect(playerId: string): void {
    const slot = this.findByPlayerId(playerId);
    if (!slot || !slot.connected) return;
    this.markDisconnected(slot);
    if (this.phase === "result") {
      this.rematchVotes.delete(slot.slot);
      this.maybeStartRematch();
    }
  }

  private markDisconnected(slot: RoomSlot): void {
    slot.connected = false;
    slot.disconnectTick = this.engineTick;
    slot.input = { ...NEUTRAL_INPUT };
    this.stateChanged = true;
    this.pendingReason = "disconnect";
  }

  /** Called once per 60 Hz tick by the adapter. */
  tick(): TickOutput {
    this.engineTick += 1;
    this.metrics.ticks += 1;
    this.lastActivityTick = this.engineTick;

    let events: GameEvent[] = [];
    let reason: TickReason = this.pendingReason;
    this.pendingReason = "none";
    let forceSnapshot = this.forceSnapshot;
    this.forceSnapshot = false;
    const phaseBefore = this.phase;

    if (this.sim && (this.phase === "countdown" || this.phase === "playing")) {
      const forfeit = this.checkForfeit();
      if (forfeit) {
        this.sim.events.length = 0;
        finishRound(this.sim, forfeit.reason, forfeit.winner);
        events.push(...this.sim.events);
        this.phase = "result";
        reason = "phase";
        forceSnapshot = true;
      } else {
        const inputs: InputState[] = SLOT_INDICES.map((slot) => {
          const roomSlot = this.slots[slot];
          if (roomSlot?.bot && this.sim) {
            const player = this.sim.players[slot]!;
            if (this.sim.phase === "playing") {
              this.botBaseAngles[slot] = reflectBotHeading(
                player,
                this.botBaseAngles[slot] ?? 0,
              );
            }
            return botInput(this.sim, slot, this.botBaseAngles[slot]!);
          }
          return this.effectiveInput(slot);
        });
        events = stepSim(this.sim, inputs);
        this.phase = this.sim.phase;
        if (this.sim.phase === "result") {
          forceSnapshot = true;
          reason = "phase";
        }
      }
    }

    const stateChanged = this.stateChanged || reason !== "none" || this.phase !== phaseBefore;
    if (this.phase !== phaseBefore) {
      reason = "phase";
      forceSnapshot = true;
    }
    this.stateChanged = false;

    for (const slot of this.slots) {
      if (slot) slot.messagesThisTick = 0;
    }

    const snapshots: Snapshot[] = [];
    const active =
      this.phase === "countdown" || this.phase === "playing";
    const due =
      this.sim !== null &&
      (forceSnapshot || (active && this.sim.tick % SNAPSHOT_EVERY_TICKS === 0));
    if (due && this.sim) {
      snapshots.push(serializeSnapshot(this.sim));
      this.metrics.snapshots += 1;
    }

    this.metrics.events += events.length;
    return {
      snapshots,
      events,
      stateChanged,
      reason,
      phase: this.phase,
    };
  }

  private effectiveInput(slotIndex: number): InputState {
    const slot = this.slots[slotIndex];
    if (!slot || !slot.connected || !this.sim) return { ...NEUTRAL_INPUT };
    if (this.sim.tick - slot.lastInputTick > this.ttlTicks) return { ...NEUTRAL_INPUT };
    return slot.input;
  }

  private checkForfeit(): { reason: RoundEndReason; winner: number | null } | null {
    // Bots are always present; forfeit rules only judge connected humans so a
    // bot never turns a disconnect into a ghost player or a stalled round.
    const humans = this.slots.filter(
      (slot): slot is RoomSlot => slot !== null && !slot.bot,
    );
    const present = humans.filter((slot) => slot.connected);
    const absent = humans.filter((slot) => !slot.connected);
    if (absent.length === 0) return null;
    for (const slot of absent) {
      if (slot.disconnectTick === null) return null;
      if (this.engineTick - slot.disconnectTick < this.graceTicks) return null;
    }
    if (present.length === 0) return { reason: "abandoned", winner: null };
    // Three or more players can keep playing after one disconnect.
    if (present.length > 1) return null;
    return { reason: "forfeit", winner: present[0]!.slot };
  }

  private startMatch(): void {
    const active = this.connectedSlots();
    this.matchNumber += 1;
    this.metrics.matches += 1;
    for (const slot of this.slots) {
      if (!slot) continue;
      slot.input = { ...NEUTRAL_INPUT };
      slot.lastInputTick = 0;
      slot.lastInputSeq = -1;
    }
    const palettes = this.slots.map(
      (slot, index) => slot?.palette ?? DEFAULT_SLOT_PALETTES[index] ?? 0,
    );
    this.sim = createSim({
      palettes,
      activeSlots: active.map((slot) => slot.slot),
      spawn: "cross",
      seed: `${this.options.seedPrefix ?? this.code}|m${this.matchNumber}|${palettes.join(",")}`,
      ...(this.options.matchConfig ?? {}),
    });
    for (const slot of active) {
      if (slot.bot) {
        // Keep the cross spawn's outward heading: bots point outside at the
        // start and let the border reflection turn the patrol around.
        this.botBaseAngles[slot.slot] = this.sim.players[slot.slot]!.angle;
      }
    }
    this.phase = "countdown";
    this.rematchVotes.clear();
    this.forceSnapshot = true;
    this.stateChanged = true;
    this.pendingReason = "started";
  }

  snapshotNow(): Snapshot | null {
    return this.sim ? serializeSnapshot(this.sim) : null;
  }

  /** Reconnect paint sync: compact RLE of the authoritative mask. */
  maskRle(): { w: number; h: number; runs: number[] } | null {
    if (!this.sim) return null;
    return {
      w: this.sim.mask.cols,
      h: this.sim.mask.rows,
      runs: encodeMaskRle(this.sim.mask),
    };
  }

  stateFor(slotIndex: number): StateMessage {
    const self = this.slots[slotIndex] ?? null;
    const other = this.slots.find(
      (candidate): candidate is RoomSlot =>
        candidate !== null && candidate.slot !== slotIndex,
    ) ?? null;
    const wire = (slot: RoomSlot | null): SlotWire | null =>
      slot
        ? {
            slot: slot.slot,
            name: slot.name,
            palette: slot.palette,
            ready: slot.ready,
            connected: slot.connected,
            ...(slot.bot ? { bot: true } : {}),
          }
        : null;
    const reason = this.sim?.endReason ?? undefined;
    return {
      t: "state",
      phase: this.phase,
      you: self ? self.slot : null,
      host: this.hostSlot,
      opponent: other ? wire(other) : null,
      slots: SLOT_INDICES.map((index) => wire(this.slots[index]!)).filter(
        (value): value is SlotWire => value !== null,
      ),
      ...(reason ? { reason } : {}),
    };
  }

  /** Marks user activity; used by adapters for room TTL. */
  touch(): void {
    this.lastActivityTick = this.engineTick;
  }

  /** Round length in ticks, used by tests and adapters for budgets. */
  get roundTicks(): number {
    return this.sim?.roundTicks ?? this.options.matchConfig?.roundTicks ?? ROUND_TICKS;
  }

  /** True when the room can be hibernated/evicted; bots do not keep it alive. */
  isIdle(): boolean {
    const humansConnected = this.slots.some(
      (slot) => slot !== null && !slot.bot && slot.connected,
    );
    return (this.phase === "lobby" || this.phase === "result") && !humansConnected;
  }

  /** Snapshot of lobby data for durability across adapter restarts. */
  serializeRecord(): RoomRecord {
    // Bots are rebuilt on restore; only human identities need persisting.
    const toRecord = (slot: RoomSlot | null): SlotRecord | null =>
      slot && !slot.bot
        ? {
            slot: slot.slot,
            name: slot.name,
            token: slot.token,
            palette: slot.palette,
            ready: slot.ready,
          }
        : null;
    return {
      code: this.code,
      matchNumber: this.matchNumber,
      slots: this.slots.map((slot) => toRecord(slot)),
    };
  }

  /**
   * Rebuilds a room from `serializeRecord`. Active matches do not survive a
   * restart (the plan persists lifecycle transitions only), so the room comes
   * back in the lobby with every player disconnected and ready to reconnect.
   */
  static restore(record: RoomRecord, options: Omit<RoomOptions, "code"> = {}): RoomEngine {
    const engine = new RoomEngine({ ...options, code: record.code });
    engine.matchNumber = record.matchNumber;
    for (const saved of record.slots) {
      if (!saved) continue;
      const slot: RoomSlot = {
        slot: saved.slot,
        playerId: `${record.code}-${saved.slot}`,
        token: saved.token,
        name: saved.name,
        palette: saved.palette,
        ready: saved.ready,
        connected: false,
        bot: false,
        disconnectTick: null,
        lastInputTick: 0,
        lastInputSeq: -1,
        input: { ...NEUTRAL_INPUT },
        messagesThisTick: 0,
      };
      engine.slots[saved.slot] = slot;
    }
    // Re-seed bots after humans so their palettes avoid the restored ones.
    for (const index of SLOT_INDICES) {
      if (engine.slots[index]?.bot) engine.slots[index] = null;
    }
    engine.fillBots();
    engine.phase = "lobby";
    return engine;
  }
}
