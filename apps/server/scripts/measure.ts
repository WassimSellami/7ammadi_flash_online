/**
 * Message-budget measurement for one full 84 s match.
 *
 * Drives the same RoomEngine the Durable Object uses and counts the traffic a
 * pair of clients would generate under the documented client policy:
 *   - inputs repeat every 150 ms while steering (server TTL 250 ms),
 *   - pings every 3 s,
 *   - snapshots at 20 Hz.
 */

import { RoomEngine } from "@flash/server-engine";
import { encodeServerMessage } from "@flash/protocol";

const engine = new RoomEngine({ code: "MEAS" });
const a = engine.join("Alpha", "tok-a");
const b = engine.join("Bravo", "tok-b");
if (!a.ok || !b.ok) throw new Error("join failed");
engine.ready(a.playerId, 2);
engine.ready(b.playerId, 0);

let inbound = 2 + 2; // joins + ready
let outbound = 0;
let bytesOut = 0;
let snapshots = 0;
let events = 0;
let stateMessages = 0;
let seq = 0;
let tick = 0;
const started = performance.now();

const send = (slot: 0 | 1, left: boolean, right: boolean): void => {
  const playerId = slot === 0 ? a.playerId : b.playerId;
  engine.input(playerId, { left, right }, seq++, tick);
  inbound += 1;
};

while (engine.phase !== "result" && tick < 10_000) {
  // 150 ms input repeat (9 ticks), alternating steering every ~0.75 s.
  if (tick % 9 === 0) {
    const phase = Math.floor(tick / 45) % 3;
    send(0, phase === 1, phase !== 1);
    send(1, phase === 2, phase !== 2);
  }
  // 1 Hz presence ping every 60 ticks (60 pings/s is unnecessary).
  if (tick % 180 === 0) {
    inbound += 2;
  }

  const output = engine.tick();
  for (const snapshot of output.snapshots) {
    snapshots += 1;
    outbound += 1;
    bytesOut += encodeServerMessage({ t: "snapshot", snap: snapshot }).length;
  }
  for (const event of output.events) {
    events += 1;
    outbound += 1;
    bytesOut += encodeServerMessage({ t: "event", ...event }).length;
    if (event.type === "end") {
      outbound += 1;
      bytesOut += 120;
    }
  }
  if (output.stateChanged) {
    stateMessages += 1;
    outbound += 2;
    bytesOut += 2 * 220;
  }
  tick += 1;
}

const elapsed = performance.now() - started;
const paint = engine.maskRle();
const paintBytes = paint ? JSON.stringify({ t: "paint", ...paint }).length : 0;
const perMatch = {
  engineTicks: tick,
  simulationsMs: Number(elapsed.toFixed(1)),
  inboundMessages: inbound,
  outboundMessages: outbound,
  snapshots,
  events,
  stateMessages,
  bytesOut,
  kbOut: Math.round((bytesOut / 1024) * 10) / 10,
  durationSeconds: Number((tick / 60).toFixed(1)),
  reconnectMaskRuns: paint?.runs.length ?? 0,
  reconnectMaskKb: Math.round((paintBytes / 1024) * 10) / 10,
};

console.log(JSON.stringify(perMatch, null, 2));
console.log(
  [
    "",
    "Per-match DO request budget (inbound WS messages count as requests):",
    `  ${perMatch.inboundMessages} requests per match.`,
    `At 1,000,000 free requests/day: ~${Math.floor(1_000_000 / perMatch.inboundMessages)} matches/day.`,
    `At the plan target of 20 matches/day: ~${20 * perMatch.inboundMessages} requests/day.`,
    "",
    "If your plan bills outbound messages too:",
    `  ${perMatch.outboundMessages} outbound messages (~${perMatch.kbOut} KB).`,
    "",
    "Duration while a room is active: ~88 s per match; 20 matches/day ~= 30 minutes of DO wall time.",
  ].join("\n"),
);
