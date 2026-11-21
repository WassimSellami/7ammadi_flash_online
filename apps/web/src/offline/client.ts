/**
 * Main-thread wrapper around the offline simulation worker.
 */

import type { GameEvent, RoundEndReason, Snapshot } from "@flash/core";
import type { Intent } from "../input/keyboard";

export type OfflineMode = "hotseat" | "solo";

export interface OfflineRoundEnd {
  scores: [number, number];
  winner: number | null;
  reason: RoundEndReason;
}

export class OfflineClient {
  readonly mode: OfflineMode;
  private readonly worker: Worker;
  private lastA: Intent = { left: false, right: false };
  private lastB: Intent = { left: false, right: false };
  private paused = false;

  onSnapshot?: (snapshot: Snapshot) => void;
  onEvent?: (event: GameEvent) => void;
  onState?: (message: { phase: string; countdown?: number }) => void;
  onRoundEnd?: (message: OfflineRoundEnd) => void;

  constructor(options: { mode: OfflineMode; palettes: [number, number] }) {
    this.mode = options.mode;
    this.worker = new Worker(new URL("./sim.worker.ts", import.meta.url), {
      type: "module",
    });
    this.worker.addEventListener("message", (event) => {
      const data = event.data as
        | { type: "snapshot"; snapshot: Snapshot }
        | { type: "event"; event: GameEvent }
        | { type: "state"; phase: string; countdown?: number }
        | { type: "roundEnd"; scores: [number, number]; winner: number | null; reason: RoundEndReason }
        | { type: "paused"; paused: boolean };
      switch (data.type) {
        case "snapshot":
          this.onSnapshot?.(data.snapshot);
          break;
        case "event":
          this.onEvent?.(data.event);
          break;
        case "state":
          this.onState?.({ phase: data.phase, ...(data.countdown !== undefined ? { countdown: data.countdown } : {}) });
          break;
        case "roundEnd":
          this.onRoundEnd?.({
            scores: data.scores,
            winner: data.winner,
            reason: data.reason,
          });
          break;
        case "paused":
          this.paused = data.paused;
          break;
      }
    });
    this.worker.postMessage({
      type: "init",
      palettes: options.palettes,
      activeSlots: options.mode === "solo" ? 1 : 2,
      seed: `offline-${Date.now().toString(36)}`,
    });
  }

  get isPaused(): boolean {
    return this.paused;
  }

  setInputs(a: Intent, b: Intent): void {
    if (a.left !== this.lastA.left || a.right !== this.lastA.right) {
      this.lastA = { ...a };
      this.worker.postMessage({ type: "input", slot: 0, left: a.left, right: a.right });
    }
    if (this.mode === "hotseat" && (b.left !== this.lastB.left || b.right !== this.lastB.right)) {
      this.lastB = { ...b };
      this.worker.postMessage({ type: "input", slot: 1, left: b.left, right: b.right });
    }
  }

  setPaused(paused: boolean): void {
    this.worker.postMessage({ type: "pause", paused });
  }

  rematch(): void {
    this.lastA = { left: false, right: false };
    this.lastB = { left: false, right: false };
    this.worker.postMessage({ type: "rematch" });
  }

  close(): void {
    this.worker.terminate();
  }
}
