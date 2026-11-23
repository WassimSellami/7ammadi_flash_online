/**
 * WebSocket client for the online room.
 *
 * Inputs are sent on change plus a 150 ms repeat while steering (the server
 * TTL is 250 ms). Presence heartbeat is a 1 Hz ping, snapshots arrive at 20 Hz.
 */

import type { GameEvent, SlotIndex, Snapshot } from "@flash/core";
import {
  PROTOCOL_VERSION,
  type ClientMessage,
  type ErrorCode,
  type PaintMessage,
  type RoundEndMessage,
  type ServerMessage,
  type StateMessage,
  type WelcomeMessage,
} from "@flash/protocol";
import { wsUrl } from "../config";

export type ConnectionStatus = "connecting" | "open" | "reconnecting" | "closed";

export interface OnlineClientOptions {
  room: string;
  name: string;
  token?: string;
  onWelcome?: (message: WelcomeMessage) => void;
  onState?: (message: StateMessage) => void;
  onSnapshot?: (snapshot: Snapshot) => void;
  onPaint?: (message: PaintMessage) => void;
  onEvent?: (event: GameEvent) => void;
  onRoundEnd?: (message: RoundEndMessage) => void;
  onError?: (code: ErrorCode, message?: string) => void;
  onStatus?: (status: ConnectionStatus) => void;
  onLatency?: (ms: number) => void;
}

export class OnlineClient {
  private readonly options: OnlineClientOptions;
  private socket: WebSocket | null = null;
  private status: ConnectionStatus = "closed";
  private token: string | null;
  private slot: SlotIndex | null = null;
  private intentionalClose = false;
  private attempts = 0;
  private seq = 0;
  private input = { left: false, right: false };
  private lastSent = { left: false, right: false };
  private lastSnapshotTick = 0;
  private repeatTimer: number | null = null;
  private pingTimer: number | null = null;
  private reconnectTimer: number | null = null;
  private lastPingAt = 0;

  constructor(options: OnlineClientOptions) {
    this.options = options;
    this.token = options.token ?? null;
  }

  get playerSlot(): SlotIndex | null {
    return this.slot;
  }

  get connectionStatus(): ConnectionStatus {
    return this.status;
  }

  connect(): void {
    this.intentionalClose = false;
    this.setStatus(this.attempts === 0 ? "connecting" : "reconnecting");
    const url = wsUrl(this.options.room);
    let socket: WebSocket;
    try {
      socket = new WebSocket(url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;

    socket.addEventListener("open", () => {
      this.attempts = 0;
      this.setStatus("open");
      this.send({
        t: "join",
        v: PROTOCOL_VERSION,
        room: this.options.room,
        name: this.options.name,
        ...(this.token ? { token: this.token } : {}),
      });
      this.startPresence();
    });

    socket.addEventListener("message", (event) => {
      this.handleMessage(String(event.data));
    });

    socket.addEventListener("error", () => {
      // `close` follows; avoid double scheduling.
    });

    socket.addEventListener("close", () => {
      this.stopPresence();
      this.socket = null;
      if (this.intentionalClose) {
        this.setStatus("closed");
        return;
      }
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (this.intentionalClose) return;
    this.setStatus("reconnecting");
    this.attempts += 1;
    const delay = Math.min(5000, 400 * this.attempts);
    if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private setStatus(status: ConnectionStatus): void {
    this.status = status;
    this.options.onStatus?.(status);
  }

  private handleMessage(raw: string): void {
    let message: ServerMessage;
    try {
      message = JSON.parse(raw) as ServerMessage;
    } catch {
      return;
    }
    switch (message.t) {
      case "welcome":
        this.slot = message.slot;
        this.token = message.token;
        this.options.onWelcome?.(message);
        break;
      case "state":
        this.options.onState?.(message);
        break;
      case "snapshot":
        this.lastSnapshotTick = message.snap.tick;
        this.options.onSnapshot?.(message.snap);
        break;
      case "paint":
        this.options.onPaint?.(message);
        break;
      case "event":
        this.options.onEvent?.(message);
        break;
      case "roundEnd":
        this.options.onRoundEnd?.(message);
        break;
      case "pong":
        if (this.lastPingAt > 0) {
          this.options.onLatency?.(Math.max(0, Date.now() - this.lastPingAt));
        }
        break;
      case "error":
        this.options.onError?.(message.code, message.message);
        break;
    }
  }

  private send(message: ClientMessage): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify(message));
  }

  ready(palette: number): void {
    this.send({ t: "ready", palette });
  }

  color(palette: number): void {
    this.send({ t: "color", palette });
  }

  start(): void {
    this.send({ t: "start" });
  }

  /** Host-only: turn the AI for a slot on or off. */
  setBot(slot: SlotIndex, enabled: boolean): void {
    this.send({ t: "bot", slot, enabled });
  }

  rematch(): void {
    this.send({ t: "rematch" });
  }

  leave(): void {
    this.intentionalClose = true;
    this.send({ t: "leave" });
    this.stopPresence();
    this.socket?.close(1000, "left");
    this.setStatus("closed");
  }

  /** Called whenever the keyboard intent changes. */
  updateInput(left: boolean, right: boolean): void {
    if (this.input.left === left && this.input.right === right) return;
    this.input = { left, right };
    this.flushInput();
  }

  private flushInput(): void {
    if (this.input.left === this.lastSent.left && this.input.right === this.lastSent.right) {
      return;
    }
    this.lastSent = { ...this.input };
    this.seq += 1;
    this.send({
      t: "input",
      seq: this.seq,
      tick: this.lastSnapshotTick,
      left: this.input.left,
      right: this.input.right,
    });
  }

  private startPresence(): void {
    this.stopPresence();
    this.repeatTimer = window.setInterval(() => {
      if (this.input.left || this.input.right) {
        this.lastSent = { left: !this.input.left, right: !this.input.right };
        this.flushInput();
      }
    }, 150);
    this.pingTimer = window.setInterval(() => {
      this.lastPingAt = Date.now();
      this.send({ t: "ping", ts: this.lastPingAt });
    }, 3000);
    this.lastPingAt = Date.now();
    this.send({ t: "ping", ts: this.lastPingAt });
  }

  private stopPresence(): void {
    if (this.repeatTimer !== null) {
      window.clearInterval(this.repeatTimer);
      this.repeatTimer = null;
    }
    if (this.pingTimer !== null) {
      window.clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  sendNeutral(): void {
    this.updateInput(false, false);
  }

  close(): void {
    this.intentionalClose = true;
    this.stopPresence();
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.socket?.close(1000, "closed");
    this.socket = null;
    this.setStatus("closed");
  }
}
