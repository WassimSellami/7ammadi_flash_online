/**
 * Node development / CI adapter.
 *
 * Same `RoomEngine` as the Cloudflare Durable Object, with `ws` and an
 * in-process drift-corrected 60 Hz loop. Used by the headless E2E test, load
 * tests and local `npm run dev:server`.
 */

import { randomUUID, getRandomValues } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import type { SimConfig } from "@flash/core";
import { RoomEngine, type TickOutput } from "@flash/server-engine";
import {
  PROTOCOL_VERSION,
  encodeServerMessage,
  isValidRoomCode,
  parseClientMessage,
  type ClientMessage,
  type ErrorCode,
  type ServerMessage,
} from "@flash/protocol";

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export interface RoomHubMetrics {
  roomsCreated: number;
  roomsActive: number;
  ticks: number;
  messagesIn: number;
  messagesOut: number;
  snapshotsOut: number;
  eventsOut: number;
  bytesOut: number;
}

export interface NodeServerOptions {
  port?: number;
  host?: string;
  tickMs?: number;
  matchConfig?: Omit<SimConfig, "palettes" | "seed" | "activeSlots" | "spawn">;
  inputTtlTicks?: number;
  graceTicks?: number;
  idleTtlMs?: number;
  /** Fill open room slots with AI brushes (the game client enables this). */
  bots?: boolean;
}

export interface NodeServerHandle {
  server: Server;
  hub: RoomHub;
  port: number;
  url: string;
  close: () => Promise<void>;
}

interface ClientContext {
  room: RoomRuntime;
  playerId: string | null;
  slot: 0 | 1 | 2 | 3 | null;
  messages: number;
  joinedAt: number;
}

type ClientSocket = WebSocket & { ctx?: ClientContext };

interface RoomRuntime {
  code: string;
  engine: RoomEngine;
  sockets: Map<0 | 1 | 2 | 3, ClientSocket>;
  timeout: NodeJS.Timeout | null;
  nextTickAt: number;
  lastSeen: number;
}

function newRoomCode(): string {
  const bytes = getRandomValues(new Uint8Array(4));
  let code = "";
  for (const byte of bytes) code += CODE_ALPHABET[byte % CODE_ALPHABET.length];
  return code;
}

export class RoomHub {
  readonly rooms = new Map<string, RoomRuntime>();
  readonly metrics: RoomHubMetrics = {
    roomsCreated: 0,
    roomsActive: 0,
    ticks: 0,
    messagesIn: 0,
    messagesOut: 0,
    snapshotsOut: 0,
    eventsOut: 0,
    bytesOut: 0,
  };

  private readonly options: NodeServerOptions;
  private readonly tickMs: number;
  private readonly idleTtlMs: number;
  private sweepTimer: NodeJS.Timeout | null = null;

  constructor(options: NodeServerOptions = {}) {
    this.options = options;
    this.tickMs = options.tickMs ?? 1000 / 60;
    this.idleTtlMs = options.idleTtlMs ?? 30 * 60 * 1000;
  }

  createRoom(code?: string): RoomRuntime {
    const resolved = code && isValidRoomCode(code) ? code : this.generateUniqueCode();
    const engine = new RoomEngine({
      code: resolved,
      ...(this.options.matchConfig ? { matchConfig: this.options.matchConfig } : {}),
      ...(this.options.inputTtlTicks !== undefined
        ? { inputTtlTicks: this.options.inputTtlTicks }
        : {}),
      ...(this.options.graceTicks !== undefined
        ? { graceTicks: this.options.graceTicks }
        : {}),
      ...(this.options.bots ? { bots: true } : {}),
    });
    const room: RoomRuntime = {
      code: resolved,
      engine,
      sockets: new Map(),
      timeout: null,
      nextTickAt: 0,
      lastSeen: Date.now(),
    };
    this.rooms.set(resolved, room);
    this.metrics.roomsCreated += 1;
    this.metrics.roomsActive = this.rooms.size;
    return room;
  }

  private generateUniqueCode(): string {
    for (let attempt = 0; attempt < 64; attempt += 1) {
      const code = newRoomCode();
      if (!this.rooms.has(code)) return code;
    }
    return newRoomCode();
  }

  getOrCreate(code: string): RoomRuntime {
    return this.rooms.get(code) ?? this.createRoom(code);
  }

  attach(room: RoomRuntime, slot: 0 | 1 | 2 | 3, socket: ClientSocket): void {
    const existing = room.sockets.get(slot);
    if (existing && existing !== socket) {
      // The replaced socket must not disconnect the freshly reconnected player.
      existing.ctx = undefined;
      existing.close(4001, "replaced");
    }
    room.sockets.set(slot, socket);
    room.lastSeen = Date.now();
    this.ensureLoop(room);
  }

  detach(room: RoomRuntime, slot: 0 | 1 | 2 | 3, socket: ClientSocket): void {
    if (room.sockets.get(slot) === socket) room.sockets.delete(slot);
    room.lastSeen = Date.now();
    if (room.sockets.size === 0 && (room.engine.phase === "lobby" || room.engine.phase === "result")) {
      this.stopLoop(room);
    }
  }

  ensureLoop(room: RoomRuntime): void {
    if (room.timeout) return;
    room.nextTickAt = performance.now();
    const runner = (): void => {
      room.timeout = null;
      const now = performance.now();
      let catchUp = 0;
      while (room.nextTickAt <= now && catchUp < 8) {
        const output = room.engine.tick();
        this.metrics.ticks += 1;
        this.dispatch(room, output);
        room.nextTickAt += this.tickMs;
        catchUp += 1;
      }
      // Catch up after a short stall; only drop time after a long pause.
      if (room.nextTickAt < now && now - room.nextTickAt > 1000) {
        room.nextTickAt = now - 1000;
      }
      if (room.sockets.size === 0 && (room.engine.phase === "lobby" || room.engine.phase === "result")) {
        this.stopLoop(room);
        return;
      }
      const delay = Math.max(0, room.nextTickAt - performance.now());
      room.timeout = setTimeout(runner, delay);
    };
    room.timeout = setTimeout(runner, 0);
  }

  stopLoop(room: RoomRuntime): void {
    if (room.timeout) {
      clearTimeout(room.timeout);
      room.timeout = null;
    }
  }

  private dispatch(room: RoomRuntime, output: TickOutput): void {
    for (const event of output.events) {
      this.broadcast(room, { t: "event", ...event });
      this.metrics.eventsOut += 1;
      if (event.type === "end") {
        this.broadcast(room, {
          t: "roundEnd",
          scores: event.scores,
          winner: event.winner,
          reason: event.reason,
        });
      }
    }
    for (const snapshot of output.snapshots) {
      this.broadcast(room, { t: "snapshot", snap: snapshot });
      this.metrics.snapshotsOut += 1;
    }
    if (output.stateChanged) this.broadcastState(room);
  }

  broadcast(room: RoomRuntime, message: ServerMessage): void {
    const payload = encodeServerMessage(message);
    for (const socket of room.sockets.values()) {
      this.sendRaw(socket, payload);
    }
  }

  private sendRaw(socket: ClientSocket, payload: string): void {
    if (socket.readyState !== WebSocket.OPEN) return;
    if (socket.bufferedAmount > 512 * 1024) return;
    socket.send(payload);
    this.metrics.messagesOut += 1;
    this.metrics.bytesOut += payload.length;
  }

  broadcastState(room: RoomRuntime): void {
    for (const [slot, socket] of room.sockets) {
      this.sendRaw(socket, encodeServerMessage(room.engine.stateFor(slot)));
    }
  }

  send(socket: ClientSocket, message: ServerMessage): void {
    this.sendRaw(socket, encodeServerMessage(message));
  }

  sendError(socket: ClientSocket, code: ErrorCode, message?: string): void {
    this.send(socket, { t: "error", code, ...(message ? { message } : {}) });
  }

  sweep(): void {
    const now = Date.now();
    for (const [code, room] of this.rooms) {
      const idleFor = now - room.lastSeen;
      const empty = room.sockets.size === 0;
      if (empty && idleFor > this.idleTtlMs) {
        this.stopLoop(room);
        for (const socket of room.sockets.values()) socket.close(1001, "room expired");
        this.rooms.delete(code);
      }
    }
    this.metrics.roomsActive = this.rooms.size;
  }

  startSweeper(): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => this.sweep(), 60_000);
    this.sweepTimer.unref();
  }

  stop(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    for (const room of this.rooms.values()) {
      this.stopLoop(room);
      for (const socket of room.sockets.values()) socket.close(1001, "server closing");
    }
    this.rooms.clear();
    this.metrics.roomsActive = 0;
  }
}

function writeJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type",
    "access-control-allow-methods": "GET,POST,OPTIONS",
  });
  response.end(payload);
}

export async function startNodeServer(options: NodeServerOptions = {}): Promise<NodeServerHandle> {
  const hub = new RoomHub(options);
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  hub.startSweeper();

  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    if (request.method === "OPTIONS") {
      writeJson(response, 204, {});
      return;
    }
    if (url.pathname === "/health" || url.pathname === "/api/health") {
      writeJson(response, 200, {
        ok: true,
        protocol: PROTOCOL_VERSION,
        rooms: hub.rooms.size,
        metrics: hub.metrics,
      });
      return;
    }
    if (url.pathname === "/api/rooms" && request.method === "POST") {
      const room = hub.createRoom();
      writeJson(response, 201, { code: room.code });
      return;
    }
    if (url.pathname.startsWith("/api/rooms/") && request.method === "GET") {
      const code = url.pathname.slice("/api/rooms/".length).toUpperCase();
      writeJson(response, 200, { code, exists: isValidRoomCode(code) && hub.rooms.has(code) });
      return;
    }
    writeJson(response, 404, { error: "not_found" });
  });

  server.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    if (url.pathname !== "/ws") {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }
    const code = (url.searchParams.get("room") ?? "").toUpperCase();
    if (!isValidRoomCode(code)) {
      socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      const room = hub.getOrCreate(code);
      const client = ws as ClientSocket;
      client.ctx = {
        room,
        playerId: null,
        slot: null,
        messages: 0,
        joinedAt: Date.now(),
      };
      wss.emit("connection", client, request);
    });
  });

  wss.on("connection", (socket: ClientSocket) => {
    socket.on("message", (data: RawData) => handleMessage(hub, socket, data));
    socket.on("close", () => handleClose(hub, socket));
    socket.on("error", () => handleClose(hub, socket));
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, options.host ?? "127.0.0.1", () => resolve());
  });

  const address = server.address();
  const port = typeof address === "object" && address ? address.port : (options.port ?? 0);

  return {
    server,
    hub,
    port,
    url: `ws://127.0.0.1:${port}/ws`,
    close: async () => {
      hub.stop();
      for (const client of wss.clients) client.terminate();
      wss.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function handleMessage(hub: RoomHub, socket: ClientSocket, data: RawData): void {
  const ctx = socket.ctx;
  if (!ctx) return;
  hub.metrics.messagesIn += 1;
  ctx.messages += 1;
  ctx.room.lastSeen = Date.now();

  const raw = typeof data === "string" ? data : data.toString();
  const parsed = parseClientMessage(raw);
  if (!parsed.ok) {
    hub.sendError(socket, parsed.code, parsed.message);
    if (parsed.code === "too_large") socket.close(4002, "too large");
    return;
  }

  const message = parsed.msg;
  const { engine } = ctx.room;

  if (message.t === "join") {
    if (ctx.playerId) {
      hub.sendError(socket, "protocol", "already joined");
      return;
    }
    if (message.room !== ctx.room.code) {
      hub.sendError(socket, "bad_room", "room mismatch");
      return;
    }
    const joined = engine.join(message.name, randomUUID(), message.token);
    if (!joined.ok) {
      hub.sendError(socket, joined.code, "room is full");
      return;
    }
    ctx.playerId = joined.playerId;
    ctx.slot = joined.slot;
    hub.attach(ctx.room, joined.slot, socket);
    hub.send(socket, {
      t: "welcome",
      v: PROTOCOL_VERSION,
      playerId: joined.playerId,
      slot: joined.slot,
      host: engine.hostSlot === joined.slot,
      config: engine.configWire(),
      serverTick: engine.engineTick,
      token: joined.token,
    });
    hub.broadcastState(ctx.room);
    const snapshot = engine.snapshotNow();
    if (snapshot) hub.send(socket, { t: "snapshot", snap: snapshot });
    const paint = engine.maskRle();
    if (paint) hub.send(socket, { t: "paint", ...paint });
    return;
  }

  if (!ctx.playerId) {
    hub.sendError(socket, "not_joined");
    return;
  }

  switch (message.t) {
    case "ready": {
      const result = engine.ready(ctx.playerId, message.palette);
      if (!result.ok) hub.sendError(socket, result.code);
      hub.broadcastState(ctx.room);
      break;
    }
    case "color": {
      const result = engine.color(ctx.playerId, message.palette);
      if (!result.ok) hub.sendError(socket, result.code);
      hub.broadcastState(ctx.room);
      break;
    }
    case "start": {
      const result = engine.start(ctx.playerId);
      if (!result.ok) hub.sendError(socket, result.code);
      hub.broadcastState(ctx.room);
      hub.ensureLoop(ctx.room);
      break;
    }
    case "bot": {
      const result = engine.setBot(ctx.playerId, message.slot, message.enabled);
      if (!result.ok) hub.sendError(socket, result.code);
      hub.broadcastState(ctx.room);
      break;
    }
    case "input":
      engine.input(ctx.playerId, { left: message.left, right: message.right }, message.seq, message.tick);
      break;
    case "rematch": {
      engine.rematch(ctx.playerId);
      hub.broadcastState(ctx.room);
      break;
    }
    case "leave": {
      const slot = ctx.slot;
      engine.leave(ctx.playerId);
      if (slot !== null) hub.detach(ctx.room, slot, socket);
      ctx.playerId = null;
      ctx.slot = null;
      hub.broadcastState(ctx.room);
      break;
    }
    case "ping":
      hub.send(socket, { t: "pong", ts: message.ts });
      break;
  }
}

function handleClose(hub: RoomHub, socket: ClientSocket): void {
  const ctx = socket.ctx;
  if (!ctx) return;
  if (ctx.playerId) ctx.room.engine.disconnect(ctx.playerId);
  if (ctx.slot !== null) hub.detach(ctx.room, ctx.slot, socket);
  if (ctx.playerId) hub.broadcastState(ctx.room);
  socket.ctx = undefined;
}

export type { ClientMessage };
