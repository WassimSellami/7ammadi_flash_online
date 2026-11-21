/**
 * Minimal ambient types for the Cloudflare Workers runtime surface used by
 * this project. Kept local so the root TypeScript config can stay DOM-based
 * (the web app and the shared packages share one typecheck).
 */

interface DurableObjectId {
  toString(): string;
}

interface DurableObjectStub {
  fetch(request: Request): Promise<Response>;
}

interface DurableObjectNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): DurableObjectStub;
}

interface DurableObjectStorage {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put<T = unknown>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
  deleteAll(): Promise<void>;
  setAlarm(scheduledTime: number): Promise<void>;
  getAlarm(): Promise<number | null>;
}

interface DurableObjectState {
  storage: DurableObjectStorage;
  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>;
  acceptWebSocket(ws: WebSocket, tags?: string[]): void;
  getWebSockets(tag?: string): WebSocket[];
}

declare const WebSocketPair: {
  new (): { 0: WebSocket; 1: WebSocket };
};

interface CfWebSocket extends WebSocket {
  accept?: () => void;
  serializeAttachment?: (value: unknown) => void;
  deserializeAttachment?: () => unknown;
}

interface Env {
  ROOMS: DurableObjectNamespace;
  ASSETS: { fetch(request: Request): Promise<Response> };
  ALLOWED_ORIGINS?: string;
  ROOM_IDLE_MS?: string;
  MAX_ROOMS_PER_IP?: string;
}

interface ExportedHandler {
  fetch(request: Request, env: Env, ctx?: unknown): Promise<Response> | Response;
}

interface DurableObject {
  fetch(request: Request): Promise<Response>;
}
