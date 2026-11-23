import { COUNTDOWN_TICKS_PER_LABEL } from "@flash/core";
import { startNodeServer } from "./node-server";

const port = Number(process.env.PORT ?? 8787);
const tickMs = process.env.TICK_MS ? Number(process.env.TICK_MS) : undefined;
const roundTicks = process.env.ROUND_TICKS ? Number(process.env.ROUND_TICKS) : undefined;
const countdownTicksPerLabel = process.env.COUNTDOWN_TICKS
  ? Number(process.env.COUNTDOWN_TICKS)
  : undefined;
const graceTicks = process.env.GRACE_TICKS ? Number(process.env.GRACE_TICKS) : undefined;

const handle = await startNodeServer({
  port,
  bots: true,
  ...(Number.isFinite(tickMs) && tickMs ? { tickMs } : {}),
  ...(graceTicks ? { graceTicks } : {}),
  matchConfig: {
    readyTicks: countdownTicksPerLabel ?? COUNTDOWN_TICKS_PER_LABEL,
    ...(roundTicks ? { roundTicks } : {}),
    ...(countdownTicksPerLabel ? { countdownTicksPerLabel } : {}),
  },
});

console.log(`[7ammadi-flash] node room server listening on ${handle.url}`);
console.log(`[7ammadi-flash] health: http://127.0.0.1:${handle.port}/health`);

let closing = false;
async function shutdown(): Promise<void> {
  if (closing) return;
  closing = true;
  await handle.close();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
