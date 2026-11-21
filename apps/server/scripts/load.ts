/**
 * Accelerated ops check: 20 concurrent rooms drive complete 84 s matches on
 * the shared RoomEngine, measuring CPU and snapshot volume.
 *
 *   npx tsx scripts/load.ts
 */

import { RoomEngine } from "@flash/server-engine";
import { encodeServerMessage } from "@flash/protocol";

const ROOMS = 20;
const rooms: RoomEngine[] = [];
let snapshots = 0;
let events = 0;
let bytes = 0;

for (let room = 0; room < ROOMS; room += 1) {
  const engine = new RoomEngine({ code: `LOAD${room}` });
  const a = engine.join("Alpha", `tok-a-${room}`);
  const b = engine.join("Bravo", `tok-b-${room}`);
  if (!a.ok || !b.ok) throw new Error("join failed");
  engine.ready(a.playerId, 2);
  engine.ready(b.playerId, 0);
  rooms.push(engine);
}

let seq = 0;
let totalTicks = 0;
const started = performance.now();
let active = rooms.length;
while (active > 0 && totalTicks < 20_000) {
  active = 0;
  for (const engine of rooms) {
    if (engine.phase === "result") continue;
    active += 1;
    if (totalTicks % 9 === 0) {
      const band = Math.floor(totalTicks / 45) % 3;
      for (const slot of engine.slots) {
        if (!slot) continue;
        engine.input(slot.playerId, { left: band === 1, right: band !== 1 }, seq++, totalTicks);
      }
    }
    const output = engine.tick();
    for (const snapshot of output.snapshots) {
      snapshots += 1;
      bytes += encodeServerMessage({ t: "snapshot", snap: snapshot }).length;
    }
    events += output.events.length;
  }
  totalTicks += 1;
}
const elapsed = performance.now() - started;

console.log({
  rooms: ROOMS,
  ticks: totalTicks,
  wallMs: Number(elapsed.toFixed(1)),
  ticksPerSecond: Math.round((totalTicks * ROOMS) / (elapsed / 1000)),
  simulatedRoomSeconds: Number(((totalTicks * ROOMS) / 60).toFixed(1)),
  snapshots,
  events,
  mbOut: Number((bytes / (1024 * 1024)).toFixed(1)),
});
