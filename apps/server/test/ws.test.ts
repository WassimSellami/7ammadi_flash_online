import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import type { ServerMessage } from "@flash/protocol";
import { startNodeServer, type NodeServerHandle } from "../src/node-server";

let handle: NodeServerHandle | null = null;

afterEach(async () => {
  if (handle) {
    await handle.close();
    handle = null;
  }
});

interface Client {
  socket: WebSocket;
  messages: ServerMessage[];
  slot: number | null;
}

function connect(url: string): Promise<Client> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const client: Client = { socket, messages: [], slot: null };
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString()) as ServerMessage;
      client.messages.push(message);
      if (message.t === "welcome") client.slot = message.slot;
    });
    socket.on("open", () => resolve(client));
    socket.on("error", reject);
  });
}

function send(client: Client, message: unknown): void {
  client.socket.send(JSON.stringify(message));
}

async function waitFor(
  client: Client,
  predicate: (message: ServerMessage) => boolean,
  timeoutMs = 10_000,
): Promise<ServerMessage> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const found = client.messages.find(predicate);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for message");
}

describe("node adapter over WebSocket", () => {
  it("runs a short round end to end with two headless clients", async () => {
    handle = await startNodeServer({
      tickMs: 5,
      matchConfig: { roundTicks: 60, countdownTicksPerLabel: 1 },
    });

    const a = await connect(`${handle.url}?room=E2E1`);
    const b = await connect(`${handle.url}?room=E2E1`);

    send(a, { t: "join", v: 1, room: "E2E1", name: "Alpha" });
    send(b, { t: "join", v: 1, room: "E2E1", name: "Bravo" });

    const welcomeA = await waitFor(a, (message) => message.t === "welcome");
    await waitFor(b, (message) => message.t === "welcome");
    expect(welcomeA.t === "welcome" ? welcomeA.v : 0).toBe(1);

    send(a, { t: "ready", palette: 2 });
    send(b, { t: "ready", palette: 0 });

    const roundEnd = await waitFor(
      a,
      (message) => message.t === "roundEnd",
      15_000,
    );
    expect(roundEnd.t === "roundEnd" ? roundEnd.reason : null).toBe("time");
    expect(roundEnd.t === "roundEnd" ? roundEnd.scores.length : 0).toBe(2);

    const states = a.messages.filter((message) => message.t === "state");
    expect(states.some((state) => state.t === "state" && state.phase === "playing")).toBe(true);

    const snapshots = a.messages.filter((message) => message.t === "snapshot");
    expect(snapshots.length).toBeGreaterThan(5);
    let lastTick = -1;
    for (const snapshot of snapshots) {
      if (snapshot.t !== "snapshot") continue;
      expect(snapshot.snap.tick).toBeGreaterThanOrEqual(lastTick);
      lastTick = snapshot.snap.tick;
    }

    a.socket.close();
    b.socket.close();
  });

  it("reports health and creates room codes", async () => {
    handle = await startNodeServer();
    const health = await fetch(`http://127.0.0.1:${handle.port}/health`);
    expect(health.status).toBe(200);
    const body = (await health.json()) as { ok: boolean; protocol: number };
    expect(body.ok).toBe(true);
    expect(body.protocol).toBe(1);

    const created = await fetch(`http://127.0.0.1:${handle.port}/api/rooms`, {
      method: "POST",
    });
    expect(created.status).toBe(201);
    const room = (await created.json()) as { code: string };
    expect(room.code).toMatch(/^[A-Z0-9]{4}$/);
  });

  it("reconnects a dropped player into the same slot", async () => {
    handle = await startNodeServer({
      tickMs: 5,
      matchConfig: { roundTicks: 600, countdownTicksPerLabel: 1 },
      graceTicks: 120,
    });

    const a = await connect(`${handle.url}?room=RCNT`);
    const b = await connect(`${handle.url}?room=RCNT`);
    send(a, { t: "join", v: 1, room: "RCNT", name: "Alpha" });
    send(b, { t: "join", v: 1, room: "RCNT", name: "Bravo" });
    const welcomeA = await waitFor(a, (message) => message.t === "welcome");
    if (welcomeA.t !== "welcome") throw new Error("no welcome");
    await waitFor(b, (message) => message.t === "welcome");

    send(a, { t: "ready", palette: 2 });
    send(b, { t: "ready", palette: 0 });
    await waitFor(a, (message) => message.t === "state" && message.phase === "playing");

    a.socket.close();
    const reconnect = await connect(`${handle.url}?room=RCNT`);
    send(reconnect, {
      t: "join",
      v: 1,
      room: "RCNT",
      name: "Alpha",
      token: welcomeA.token,
    });
    const welcomeAgain = await waitFor(reconnect, (message) => message.t === "welcome");
    expect(welcomeAgain.t === "welcome" ? welcomeAgain.slot : -1).toBe(welcomeA.slot);
    const paint = await waitFor(reconnect, (message) => message.t === "paint");
    expect(paint.t === "paint" ? paint.runs.length : 0).toBeGreaterThan(0);
    expect(paint.t === "paint" ? paint.w : 0).toBe(480);

    reconnect.socket.close();
    b.socket.close();
  });
});
