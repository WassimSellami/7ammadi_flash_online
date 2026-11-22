/**
 * Cloudflare adapter smoke test against `wrangler dev`.
 *   node scripts/smoke-cf.mjs [base]
 */

import WebSocket from "ws";

const base = process.argv[2] ?? "http://127.0.0.1:8787";
const wsBase = base.replace(/^http/, "ws");

const health = await fetch(`${base}/api/health`);
console.log("health", health.status, await health.text());

const index = await fetch(`${base}/`);
const html = await index.text();
console.log("asset", index.status, html.includes("7ammadi Flash") ? "index ok" : "index mismatch");

const created = await fetch(`${base}/api/rooms`, { method: "POST" });
const room = (await created.json()).code;
console.log("room", room);

const clients = [];
for (const name of ["Alpha", "Bravo"]) {
  const ws = new WebSocket(`${wsBase}/ws?room=${room}`);
  const messages = [];
  ws.on("message", (data) => messages.push(JSON.parse(data.toString())));
  await new Promise((resolve, reject) => {
    ws.on("open", resolve);
    ws.on("error", reject);
  });
  ws.send(JSON.stringify({ t: "join", v: 1, room, name }));
  clients.push({ ws, messages, name });
}

await new Promise((resolve) => setTimeout(resolve, 500));
for (const client of clients) {
  console.log(client.name, "messages:", client.messages.map((m) => m.t).join(","));
}

clients[0].ws.send(JSON.stringify({ t: "ready", palette: 2 }));
clients[1].ws.send(JSON.stringify({ t: "ready", palette: 0 }));

await new Promise((resolve) => setTimeout(resolve, 300));
clients[0].ws.send(JSON.stringify({ t: "start" }));

const startedAt = Date.now();
while (Date.now() - startedAt < 12_000) {
  const states = clients[0].messages.filter((m) => m.t === "state");
  const snapshots = clients[0].messages.filter((m) => m.t === "snapshot");
  if (states.some((s) => s.phase === "playing") && snapshots.length > 5) break;
  await new Promise((resolve) => setTimeout(resolve, 200));
}

const states = clients[0].messages.filter((m) => m.t === "state").map((m) => m.phase);
const snapshots = clients[0].messages.filter((m) => m.t === "snapshot");
console.log("phases", states.join(","));
console.log("snapshots", snapshots.length, snapshots.length ? `last tick ${snapshots.at(-1).snap.tick}` : "");

if (!states.includes("playing") || snapshots.length <= 5) {
  console.error("CF adapter did not reach a running round");
  process.exitCode = 1;
}

for (const client of clients) client.ws.close();
