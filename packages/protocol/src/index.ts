/**
 * Protocol v1 — JSON over WebSocket.
 *
 * Both the web client and the two server adapters import these types, so the
 * wire format cannot drift between environments.
 */

import type { GameEvent, RoundEndReason, Snapshot } from "@flash/core";

export const PROTOCOL_VERSION = 1;
export const MAX_MESSAGE_BYTES = 2048;
export const ROOM_CODE_PATTERN = /^[A-Z0-9]{4,8}$/;
export const NAME_MAX = 16;

export type RoomPhase = "lobby" | "countdown" | "playing" | "result";

export interface RoomConfigWire {
  roundSeconds: number;
  tickRate: number;
  snapshotRate: number;
  inputTtlMs: number;
  graceMs: number;
}

export interface SlotWire {
  slot: 0 | 1;
  name: string;
  palette: number;
  ready: boolean;
  connected: boolean;
}

export interface JoinMessage {
  t: "join";
  v: number;
  room: string;
  name: string;
  token?: string;
}

export interface ReadyMessage {
  t: "ready";
  palette: number;
}

export interface InputMessage {
  t: "input";
  seq: number;
  tick: number;
  left: boolean;
  right: boolean;
}

export interface RematchMessage {
  t: "rematch";
}

export interface LeaveMessage {
  t: "leave";
}

export interface PingMessage {
  t: "ping";
  ts: number;
}

export type ClientMessage =
  | JoinMessage
  | ReadyMessage
  | InputMessage
  | RematchMessage
  | LeaveMessage
  | PingMessage;

export interface WelcomeMessage {
  t: "welcome";
  v: number;
  playerId: string;
  slot: 0 | 1;
  config: RoomConfigWire;
  serverTick: number;
  token: string;
}

export interface SnapshotMessage {
  t: "snapshot";
  snap: Snapshot;
}

/**
 * Mask sync for late joiners and reconnects. `runs` is `[value, count, ...]`
 * in the 480x252 playfield mask; 255 means unpainted.
 */
export interface PaintMessage {
  t: "paint";
  w: number;
  h: number;
  runs: number[];
}

export type EventMessage = { t: "event" } & GameEvent;

export interface StateMessage {
  t: "state";
  phase: RoomPhase;
  you: number | null;
  opponent: SlotWire | null;
  slots: SlotWire[];
  reason?: RoundEndReason;
}

export interface RoundEndMessage {
  t: "roundEnd";
  scores: [number, number];
  winner: number | null;
  reason: RoundEndReason;
}

export interface PongMessage {
  t: "pong";
  ts: number;
}

export interface ErrorMessage {
  t: "error";
  code: ErrorCode;
  message?: string;
}

export type ErrorCode =
  | "bad_json"
  | "bad_version"
  | "bad_room"
  | "bad_name"
  | "bad_palette"
  | "palette_taken"
  | "room_full"
  | "too_large"
  | "rate_limited"
  | "not_joined"
  | "protocol";

export type ServerMessage =
  | WelcomeMessage
  | SnapshotMessage
  | PaintMessage
  | EventMessage
  | StateMessage
  | RoundEndMessage
  | PongMessage
  | ErrorMessage;

export interface ParseOk {
  ok: true;
  msg: ClientMessage;
}

export interface ParseError {
  ok: false;
  code: ErrorCode;
  message?: string;
}

export type ParseResult = ParseOk | ParseError;

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

export function isValidName(name: unknown): name is string {
  if (typeof name !== "string") return false;
  const length = name.trim().length;
  if (length < 1 || length > NAME_MAX) return false;
  // Printable, non-control characters only.
  return /^[\x20-\x7E]+$/.test(name) && name.trim() === name;
}

export function isValidPalette(palette: unknown): palette is number {
  return typeof palette === "number" && Number.isInteger(palette) && palette >= 0 && palette <= 3;
}

export function isValidRoomCode(code: unknown): code is string {
  return typeof code === "string" && ROOM_CODE_PATTERN.test(code);
}

function isInt(value: unknown, min: number, max: number): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value >= min &&
    value <= max
  );
}

export function parseClientMessage(raw: string): ParseResult {
  if (byteLength(raw) > MAX_MESSAGE_BYTES) {
    return { ok: false, code: "too_large" };
  }

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { ok: false, code: "bad_json" };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, code: "bad_json" };
  }

  const msg = value as Record<string, unknown>;
  switch (msg.t) {
    case "join": {
      if (msg.v !== PROTOCOL_VERSION) return { ok: false, code: "bad_version" };
      if (!isValidRoomCode(msg.room)) return { ok: false, code: "bad_room" };
      if (!isValidName(msg.name)) return { ok: false, code: "bad_name" };
      if (
        msg.token !== undefined &&
        (typeof msg.token !== "string" || msg.token.length < 1 || msg.token.length > 64)
      ) {
        return { ok: false, code: "protocol" };
      }
      return {
        ok: true,
        msg: {
          t: "join",
          v: PROTOCOL_VERSION,
          room: msg.room,
          name: msg.name.trim(),
          ...(msg.token !== undefined ? { token: msg.token } : {}),
        },
      };
    }
    case "ready": {
      if (!isValidPalette(msg.palette)) return { ok: false, code: "bad_palette" };
      return { ok: true, msg: { t: "ready", palette: msg.palette } };
    }
    case "input": {
      if (!isInt(msg.seq, 0, 2 ** 31) || !isInt(msg.tick, 0, 2 ** 31)) {
        return { ok: false, code: "protocol" };
      }
      if (typeof msg.left !== "boolean" || typeof msg.right !== "boolean") {
        return { ok: false, code: "protocol" };
      }
      return {
        ok: true,
        msg: {
          t: "input",
          seq: msg.seq,
          tick: msg.tick,
          left: msg.left,
          right: msg.right,
        },
      };
    }
    case "rematch":
      return { ok: true, msg: { t: "rematch" } };
    case "leave":
      return { ok: true, msg: { t: "leave" } };
    case "ping": {
      if (typeof msg.ts !== "number" || !Number.isFinite(msg.ts)) {
        return { ok: false, code: "protocol" };
      }
      return { ok: true, msg: { t: "ping", ts: msg.ts } };
    }
    default:
      return { ok: false, code: "protocol" };
  }
}

export function encodeServerMessage(message: ServerMessage): string {
  return JSON.stringify(message);
}

export function defaultRoomConfig(): RoomConfigWire {
  return {
    roundSeconds: 84,
    tickRate: 60,
    snapshotRate: 20,
    inputTtlMs: 250,
    graceMs: 20_000,
  };
}
