/**
 * Cloudflare Worker entry + Durable Object adapter.
 *
 * One DO per room (`idFromName(code)`). Sockets use the Hibernation API; a
 * drift-corrected setTimeout loop only runs while a match is active. Lifecycle
 * transitions (join, ready, start, result, leave) persist a compact record; no
 * per-tick writes.
 */

import { finishRound } from "@flash/core";
import { RoomEngine, type RoomRecord } from "@flash/server-engine";import {
  PROTOCOL_VERSION,
  encodeServerMessage,
  isValidRoomCode,
  parseClientMessage,
  type ErrorCode,
  type ServerMessage,
} from "@flash/protocol";

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const TICK_MS = 1000 / 60;
const DEFAULT_IDLE_MS = 30 * 60 * 1000;

interface SocketAttachment {
  playerId: string;
  slot: 0 | 1 | 2 | 3;
}

interface RateBucket {
  count: number;
  resetAt: number;
}

interface CreateBucket {
  count: number;
  resetAt: number;
}

const createBuckets = new Map<string, CreateBucket>();

function newRoomCode(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  let code = "";
  for (const byte of bytes) code += CODE_ALPHABET[byte % CODE_ALPHABET.length];
  return code;
}

function originAllowed(request: Request, url: URL, env: Env): boolean {
  const origin = request.headers.get("Origin");
  if (!origin) return true;
  const configured = env.ALLOWED_ORIGINS ?? "";
  const allowed = configured
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  try {
    const originUrl = new URL(origin);
    if (allowed.length === 0) return originUrl.host === url.host;
    return allowed.includes(origin);
  } catch {
    return false;
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function clientIp(request: Request): string {
  return request.headers.get("CF-Connecting-IP") ?? "unknown";
}

const worker: ExportedHandler = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/api/health") {
      return json({ ok: true, protocol: PROTOCOL_VERSION });
    }

    if (url.pathname === "/api/rooms" && request.method === "POST") {
      const now = Date.now();
      const ip = clientIp(request);
      if (createBuckets.size > 5000) {
        for (const [key, bucket] of createBuckets) {
          if (bucket.resetAt <= now) createBuckets.delete(key);
        }
      }
      const bucket = createBuckets.get(ip);
      const limit = Number(env.MAX_ROOMS_PER_IP ?? 10);
      if (!bucket || bucket.resetAt <= now) {
        createBuckets.set(ip, { count: 1, resetAt: now + 60 * 60 * 1000 });
      } else if (bucket.count >= limit) {
        return json({ error: "room_creation_limited" }, 429);
      } else {
        bucket.count += 1;
      }
      const code = newRoomCode();
      return json({ code }, 201);
    }

    if (url.pathname === "/ws") {
      if (request.headers.get("Upgrade") !== "websocket") {
        return json({ error: "expected_websocket" }, 426);
      }
      if (!originAllowed(request, url, env)) {
        return json({ error: "origin_not_allowed" }, 403);
      }
      const code = (url.searchParams.get("room") ?? "").toUpperCase();
      if (!isValidRoomCode(code)) return json({ error: "bad_room" }, 400);
      const id = env.ROOMS.idFromName(code);
      const stub = env.ROOMS.get(id);
      const forwarded = new URL(request.url);
      forwarded.searchParams.set("room", code);
      return stub.fetch(new Request(forwarded.toString(), request));
    }

    return env.ASSETS.fetch(request);
  },
};

export default worker;

export class Room implements DurableObject {
  private readonly state: DurableObjectState;
  private readonly env: Env;
  private engine: RoomEngine | null = null;
  private code = "";
  private loop: ReturnType<typeof setTimeout> | null = null;
  private loopNext = 0;
  private record: RoomRecord | null = null;
  private lastPhase = "lobby";
  private idleMs: number;
  private readonly rate = new Map<WebSocket, RateBucket>();

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    this.idleMs = Number(env.ROOM_IDLE_MS ?? DEFAULT_IDLE_MS);
    void this.state.blockConcurrencyWhile(async () => {
      const stored = await this.state.storage.get<RoomRecord>("record");
      if (stored) {
        this.record = stored;
        this.code = stored.code;
      }
    });
  }

  private async ensureEngine(code: string): Promise<RoomEngine> {
    if (this.engine) return this.engine;
    this.code = code || this.code;
    this.engine = this.record
      ? RoomEngine.restore(this.record)
      : new RoomEngine({ code: this.code });
    this.lastPhase = this.engine.phase;
    return this.engine;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/ws") return json({ error: "not_found" }, 404);
    if (request.headers.get("Upgrade") !== "websocket") {
      return json({ error: "expected_websocket" }, 426);
    }

    const code = (url.searchParams.get("room") ?? this.code).toUpperCase();
    await this.ensureEngine(code);
    const pair = new WebSocketPair();
    const server = pair[1] as CfWebSocket;
    this.state.acceptWebSocket(server);
    server.serializeAttachment?.(null);

    return new Response(null, {
      status: 101,
      webSocket: pair[0],
    } as unknown as ResponseInit);
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (!this.engine) await this.ensureEngine(this.code);
    if (!this.engine) return;
    const size = typeof message === "string" ? message.length : message.byteLength;
    if (size > 4096) {
      this.sendError(ws, "too_large");
      ws.close(4002, "too large");
      return;
    }

    const bucket = this.rate.get(ws) ?? { count: 0, resetAt: Date.now() + 1000 };
    if (bucket.resetAt <= Date.now()) {
      bucket.count = 0;
      bucket.resetAt = Date.now() + 1000;
    }
    bucket.count += 1;
    this.rate.set(ws, bucket);
    if (bucket.count > 120) {
      this.sendError(ws, "rate_limited");
      return;
    }

    const raw = typeof message === "string" ? message : new TextDecoder().decode(message);
    const parsed = parseClientMessage(raw);
    if (!parsed.ok) {
      this.sendError(ws, parsed.code, parsed.message);
      return;
    }
    const msg = parsed.msg;
    const engine = this.engine;

    if (msg.t === "join") {
      if (this.attachment(ws)) {
        this.sendError(ws, "protocol", "already joined");
        return;
      }
      if (msg.room !== this.code) {
        this.sendError(ws, "bad_room", "room mismatch");
        return;
      }
      const joined = engine.join(msg.name, crypto.randomUUID(), msg.token);
      if (!joined.ok) {
        this.sendError(ws, joined.code, "room is full");
        return;
      }
      this.setAttachment(ws, { playerId: joined.playerId, slot: joined.slot });
      this.evictOtherSockets(ws, joined.playerId);
      this.send(ws, {
        t: "welcome",
        v: PROTOCOL_VERSION,
        playerId: joined.playerId,
        slot: joined.slot,
        host: engine.hostSlot === joined.slot,
        config: engine.configWire(),
        serverTick: engine.engineTick,
        token: joined.token,
      });
      await this.persist();
      this.broadcastState();
      const snapshot = engine.snapshotNow();
      if (snapshot) this.send(ws, { t: "snapshot", snap: snapshot });
      const paint = engine.maskRle();
      if (paint) this.send(ws, { t: "paint", ...paint });
      this.ensureLoop();
      return;
    }

    const attachment = this.attachment(ws);
    if (!attachment) {
      this.sendError(ws, "not_joined");
      return;
    }

    switch (msg.t) {
      case "ready": {
        const result = engine.ready(attachment.playerId, msg.palette);
        if (!result.ok) this.sendError(ws, result.code);
        await this.persist();
        this.broadcastState();
        this.ensureLoop();
        break;
      }
      case "color": {
        const result = engine.color(attachment.playerId, msg.palette);
        if (!result.ok) this.sendError(ws, result.code);
        await this.persist();
        this.broadcastState();
        break;
      }
      case "start": {
        const result = engine.start(attachment.playerId);
        if (!result.ok) this.sendError(ws, result.code);
        await this.persist();
        this.broadcastState();
        this.ensureLoop();
        break;
      }
      case "input":
        engine.input(
          attachment.playerId,
          { left: msg.left, right: msg.right },
          msg.seq,
          msg.tick,
        );
        break;
      case "rematch":
        engine.rematch(attachment.playerId);
        await this.persist();
        this.broadcastState();
        this.ensureLoop();
        break;
      case "leave":
        engine.leave(attachment.playerId);
        this.setAttachment(ws, null);
        await this.persist();
        this.broadcastState();
        break;
      case "ping":
        this.send(ws, { t: "pong", ts: msg.ts });
        break;
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    if (!this.engine) await this.ensureEngine(this.code);
    const attachment = this.attachment(ws);
    this.rate.delete(ws);
    if (!attachment || !this.engine) return;
    this.engine.disconnect(attachment.playerId);
    await this.persist();
    this.broadcastState();
    if (this.engine.phase === "lobby" || this.engine.phase === "result") this.stopLoop();
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.webSocketClose(ws);
  }

  async alarm(): Promise<void> {
    const sockets = this.state.getWebSockets();
    if (sockets.length === 0) {
      const record = await this.state.storage.get<RoomRecord>("record");
      const lastActive = await this.state.storage.get<number>("lastActive");
      if (!record || !lastActive || Date.now() - lastActive >= this.idleMs) {
        await this.state.storage.deleteAll();
        this.engine = null;
        this.record = null;
        return;
      }
    }
    await this.state.storage.setAlarm(Date.now() + this.idleMs);
  }

  private ensureLoop(): void {
    if (this.loop) return;
    if (!this.engine) return;
    this.loopNext = performance.now();
    const run = (): void => {
      this.loop = null;
      if (!this.engine) return;
      const now = performance.now();
      let catchUp = 0;
      while (this.loopNext <= now && catchUp < 8) {
        this.step();
        this.loopNext += TICK_MS;
        catchUp += 1;
      }
      // Catch up after a short stall; only drop time after a long pause.
      if (this.loopNext < now && now - this.loopNext > 1000) {
        this.loopNext = now - 1000;
      }
      const engine = this.engine;
      if (!engine) return;
      if (engine.phase === "countdown" || engine.phase === "playing") {
        this.loop = setTimeout(run, Math.max(0, this.loopNext - performance.now()));
      }
    };
    this.loop = setTimeout(run, 0);
  }

  private stopLoop(): void {
    if (this.loop) {
      clearTimeout(this.loop);
      this.loop = null;
    }
  }

  private step(): void {
    const engine = this.engine;
    if (!engine) return;
    const output = engine.tick();
    for (const event of output.events) {
      this.broadcast({ t: "event", ...event });
      if (event.type === "end") {
        this.broadcast({
          t: "roundEnd",
          scores: event.scores,
          winner: event.winner,
          reason: event.reason,
        });
      }
    }
    for (const snapshot of output.snapshots) {
      this.broadcast({ t: "snapshot", snap: snapshot });
    }
    if (output.stateChanged) this.broadcastState();

    if (engine.phase !== this.lastPhase) {
      this.lastPhase = engine.phase;
      void this.persist();
      if (engine.phase === "result") this.stopLoop();
    }

    // Nobody is connected: stop burning DO wall time and abandon the round.
    if (
      (engine.phase === "countdown" || engine.phase === "playing") &&
      this.state.getWebSockets().length === 0
    ) {
      const sim = engine.simState;
      if (sim) finishRound(sim, "abandoned");
      this.lastPhase = "result";
      void this.persist();
      this.stopLoop();
    }
  }

  private evictOtherSockets(current: WebSocket, playerId: string): void {
    for (const ws of this.state.getWebSockets()) {
      if (ws === current) continue;
      const attachment = this.attachment(ws);
      if (attachment?.playerId !== playerId) continue;
      this.setAttachment(ws, null);
      try {
        ws.close(4001, "replaced");
      } catch {
        // The socket is already gone.
      }
    }
  }

  private sockets(): Array<{ ws: WebSocket; attachment: SocketAttachment | null }> {
    return this.state.getWebSockets().map((ws) => ({
      ws,
      attachment: this.attachment(ws),
    }));
  }

  private attachment(ws: WebSocket): SocketAttachment | null {
    const socket = ws as CfWebSocket;
    const value = socket.deserializeAttachment?.();
    if (!value || typeof value !== "object") return null;
    const candidate = value as Partial<SocketAttachment>;
    if (
      typeof candidate.playerId !== "string" ||
      (candidate.slot !== 0 &&
        candidate.slot !== 1 &&
        candidate.slot !== 2 &&
        candidate.slot !== 3)
    ) {
      return null;
    }
    return candidate as SocketAttachment;
  }

  private setAttachment(ws: WebSocket, value: SocketAttachment | null): void {
    (ws as CfWebSocket).serializeAttachment?.(value);
    if (value === null) this.rate.delete(ws);
  }

  private broadcast(message: ServerMessage): void {
    const payload = encodeServerMessage(message);
    for (const { ws } of this.sockets()) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      try {
        ws.send(payload);
      } catch {
        // A dead socket is cleaned up by webSocketClose.
      }
    }
  }

  private broadcastState(): void {
    if (!this.engine) return;
    for (const { ws, attachment } of this.sockets()) {
      if (!attachment) continue;
      this.send(ws, this.engine.stateFor(attachment.slot));
    }
  }

  private send(ws: WebSocket, message: ServerMessage): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(encodeServerMessage(message));
    } catch {
      // Ignore write failures; close will be delivered separately.
    }
  }

  private sendError(ws: WebSocket, code: string, message?: string): void {
    this.send(ws, { t: "error", code: code as ErrorCode, ...(message ? { message } : {}) });
  }

  private async persist(): Promise<void> {
    if (!this.engine) return;
    const record = this.engine.serializeRecord();
    this.record = record;
    this.lastPhase = this.engine.phase;
    await this.state.storage.put("record", record);
    await this.state.storage.put("phase", this.engine.phase);
    await this.state.storage.put("lastActive", Date.now());
    await this.state.storage.setAlarm(Date.now() + this.idleMs);
  }
}

export const __testing = { newRoomCode, originAllowed };
