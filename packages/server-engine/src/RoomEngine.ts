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

  constructor(options: RoomOptions) {
    this.code = options.code;
    this.options = options;
    this.ttlTicks = options.inputTtlTicks ?? DEFAULT_INPUT_TTL_TICKS;
    this.graceTicks = options.graceTicks ?? DEFAULT_GRACE_TICKS;
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

  /** Lowest connected slot; the host starts the match. */
  get hostSlot(): SlotIndex | null {
    for (const slot of this.slots) {
      if (slot?.connected) return slot.slot;
    }
    return null;
  }

  /** Host can start once two or more connected players are ready. */
  get canStart(): boolean {
    if (this.phase !== "lobby") return false;
    const present = this.connectedSlots();
    return (
      present.length >= 2 && present.every((slot) => slot.ready)
    );
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
      if (existing) {
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

    const slot = SLOT_INDICES.find((index) => this.slots[index] === null);
    if (slot === undefined) return { ok: false, code: "room_full" };

    const palette = this.defaultPalette(slot);
    const player: RoomSlot = {
      slot,
      playerId: `${this.code}-${slot}`,
      token: newToken,
      name,
      palette,
      ready: false,
      connected: true,
      disconnectTick: null,
      lastInputTick: 0,
      lastInputSeq: -1,
      input: { ...NEUTRAL_INPUT },
      messagesThisTick: 0,
    };
    this.slots[slot] = player;
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

  findByToken(token: string): RoomSlot | null {
    return this.slots.find((slot) => slot?.token === token) ?? null;
  }

  ready(playerId: string, palette: number): { ok: true } | { ok: false; code: "palette_taken" | "not_joined" } {
    const slot = this.findByPlayerId(playerId);
    if (!slot) return { ok: false, code: "not_joined" };
    if (this.phase !== "lobby") return { ok: true };
    const taken = this.slots.some(
      (other) => other !== null && other.slot !== slot.slot && other.palette === palette,
    );
    if (taken) {
      return { ok: false, code: "palette_taken" };
    }
    this.touch();
    slot.palette = palette;
    slot.ready = true;
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
      (other) => other !== null && other.slot !== slot.slot && other.palette === palette,
    );
    if (taken) return { ok: false, code: "palette_taken" };
    if (slot.palette === palette) return { ok: true };
    this.touch();
    slot.palette = palette;
    this.stateChanged = true;
    this.pendingReason = "ready";
    return { ok: true };
  }

  /** Host-only start, allowed with any player count from 2 to 4. */
  start(playerId: string): StartResult {
    const slot = this.findByPlayerId(playerId);
    if (!slot) return { ok: false, code: "not_joined" };
    if (this.phase !== "lobby") return { ok: false, code: "not_ready" };
    if (this.hostSlot !== slot.slot) return { ok: false, code: "not_host" };
    const present = this.connectedSlots();
    if (present.length < 2) return { ok: false, code: "not_enough_players" };
    if (present.some((candidate) => !candidate.ready)) {
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

    const required = this.connectedSlots().map((candidate) => candidate.slot);
    const started =
      required.length >= 2 &&
      required.every((vote) => this.rematchVotes.has(vote));
    if (started) {
      this.startMatch();
    } else {
      this.stateChanged = true;
      this.pendingReason = "rematch";
    }
    return { started };
  }

  leave(playerId: string): void {
    const slot = this.findByPlayerId(playerId);
    if (!slot) return;
    this.touch();
    if (this.phase === "lobby" || this.phase === "result") {
      this.slots[slot.slot] = null;
      this.rematchVotes.clear();
      this.sim = null;
      this.phase = "lobby";
      this.stateChanged = true;
      this.pendingReason = "left";
      return;
    }
    this.markDisconnected(slot);
  }

  disconnect(playerId: string): void {
    const slot = this.findByPlayerId(playerId);
    if (!slot || !slot.connected) return;
    this.markDisconnected(slot);
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
        const inputs: InputState[] = SLOT_INDICES.map((slot) =>
          this.effectiveInput(slot),
        );
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
    const present = this.slots.filter(
      (slot): slot is RoomSlot => slot !== null && slot.connected,
    );
    const absent = this.slots.filter(
      (slot): slot is RoomSlot => slot !== null && !slot.connected,
    );
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

  /** True when the room can be hibernated/evicted. */
  isIdle(): boolean {
    return (
      (this.phase === "lobby" || this.phase === "result") &&
      this.connectedCount === 0
    );
  }

  /** Snapshot of lobby data for durability across adapter restarts. */
  serializeRecord(): RoomRecord {
    const toRecord = (slot: RoomSlot | null): SlotRecord | null =>
      slot
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
        disconnectTick: null,
        lastInputTick: 0,
        lastInputSeq: -1,
        input: { ...NEUTRAL_INPUT },
        messagesThisTick: 0,
      };
      engine.slots[saved.slot] = slot;
    }
    engine.phase = "lobby";
    return engine;
  }
}
