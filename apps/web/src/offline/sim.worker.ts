/// <reference lib="webworker" />

/**
 * Offline simulation worker (local hotseat).
 *
 * Runs the exact same core as the authoritative server at 60 Hz, posting
 * snapshots at 20 Hz and events immediately. Pausing stops ticks; the
 * renderer keeps drawing the last snapshot.
 */

import {
  COUNTDOWN_TICKS_PER_LABEL,
  NEUTRAL_INPUT,
  serializeSnapshot,
  stepSim,
  createSim,
  type GameEvent,
  type InputState,
  type SimState,
  type Snapshot,
} from "@flash/core";

type InitMessage = {
  type: "init";
  palettes: [number, number];
  activeSlots: 1 | 2;
  seed: string;
};

type Incoming =
  | InitMessage
  | { type: "input"; slot: 0 | 1; left: boolean; right: boolean }
  | { type: "pause"; paused: boolean }
  | { type: "rematch" };

const scope = self as unknown as {
  postMessage(data: unknown): void;
  onmessage: ((event: MessageEvent) => void) | null;
};

let sim: SimState | null = null;
let initMessage: InitMessage | null = null;
let inputs: [InputState, InputState] = [NEUTRAL_INPUT, NEUTRAL_INPUT];
let paused = false;
let timer: ReturnType<typeof setTimeout> | null = null;
let nextTickAt = 0;
let matchCounter = 0;
let lastPhase = "lobby";

function postState(): void {
  if (!sim) return;
  scope.postMessage({
    type: "state",
    phase: sim.phase,
    countdown: sim.phase === "countdown" ? sim.countdownLabel : undefined,
  });
  if (sim.phase !== lastPhase) {
    lastPhase = sim.phase;
  }
}

function startLoop(): void {
  if (timer !== null) return;
  nextTickAt = performance.now();
  const run = (): void => {
    timer = null;
    if (!sim) return;
    const now = performance.now();
    let catchUp = 0;
    while (nextTickAt <= now && catchUp < 8) {
      if (!paused && sim.phase !== "result") {
        const events = stepSim(sim, inputs);
        for (const event of events) {
          scope.postMessage({ type: "event", event });
          if (event.type === "end") {
            scope.postMessage({
              type: "roundEnd",
              scores: event.scores,
              winner: event.winner,
              reason: event.reason,
            });
          }
        }
        if (sim.phase !== lastPhase) postState();
        if (sim.tick % 3 === 0) {
          scope.postMessage({ type: "snapshot", snapshot: serializeSnapshot(sim) });
        }
      }
      nextTickAt += 1000 / 60;
      catchUp += 1;
    }
    // Catch up after a short stall; only drop time after a long background pause.
    if (nextTickAt < now && now - nextTickAt > 1000) nextTickAt = now - 1000;
    if (!sim) return;
    if (sim.phase === "result") {
      // Keep a short idle loop so a rematch can restart cleanly.
      timer = setTimeout(run, 100);
      return;
    }
    timer = setTimeout(run, Math.max(0, nextTickAt - performance.now()));
  };
  timer = setTimeout(run, 0);
}

function stopLoop(): void {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
}

function beginMatch(): void {
  if (!initMessage) return;
  matchCounter += 1;
  sim = createSim({
    palettes: initMessage.palettes,
    activeSlots: initMessage.activeSlots,
    readyTicks: COUNTDOWN_TICKS_PER_LABEL,
    seed: `${initMessage.seed}|m${matchCounter}`,
  });
  inputs = [NEUTRAL_INPUT, NEUTRAL_INPUT];
  paused = false;
  lastPhase = "lobby";
  postState();
  scope.postMessage({ type: "snapshot", snapshot: serializeSnapshot(sim) });
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
  startLoop();
}

scope.onmessage = (event: MessageEvent) => {
  const message = event.data as Incoming;
  switch (message.type) {
    case "init":
      initMessage = message;
      matchCounter = 0;
      beginMatch();
      break;
    case "input":
      inputs[message.slot] = { left: message.left, right: message.right };
      break;
    case "pause":
      paused = message.paused;
      if (!paused) nextTickAt = performance.now();
      scope.postMessage({ type: "paused", paused });
      break;
    case "rematch":
      beginMatch();
      break;
  }
};

export type { Snapshot, GameEvent };
