import { describe, expect, it } from "vitest";
import { RoomEngine } from "../src";

let tokenCounter = 0;
function token(prefix = "tok"): string {
  tokenCounter += 1;
  return `${prefix}-${tokenCounter}`;
}

function startRoom(options?: {
  roundTicks?: number;
  graceTicks?: number;
  countdownTicks?: number;
}) {
  const engine = new RoomEngine({
    code: "ABCD",
    matchConfig: {
      roundTicks: options?.roundTicks ?? 120,
      countdownTicksPerLabel: options?.countdownTicks ?? 1,
    },
    graceTicks: options?.graceTicks ?? 30,
  });
  const a = engine.join("Alice", token());
  const b = engine.join("Bob", token());
  if (!a.ok || !b.ok) throw new Error("join failed");
  expect(engine.ready(a.playerId, 2).ok).toBe(true);
  expect(engine.ready(b.playerId, 0).ok).toBe(true);
  expect(engine.start(a.playerId).ok).toBe(true);
  return { engine, a, b };
}

describe("RoomEngine lobby", () => {
  it("rejects duplicate palettes and fills all four slots", () => {
    const engine = new RoomEngine({ code: "LMNO" });
    const a = engine.join("Alice", token());
    const b = engine.join("Bob", token());
    if (!a.ok || !b.ok) throw new Error("join failed");
    expect(engine.ready(a.playerId, 2).ok).toBe(true);
    expect(engine.ready(b.playerId, 2)).toEqual({ ok: false, code: "palette_taken" });
    expect(engine.ready(b.playerId, 0).ok).toBe(true);
    const third = engine.join("Carol", token());
    const fourth = engine.join("Dave", token());
    expect(third.ok).toBe(true);
    expect(fourth.ok).toBe(true);
    const fifth = engine.join("Eve", token());
    expect(fifth.ok).toBe(false);
    if (!fifth.ok) expect(fifth.code).toBe("room_full");
  });

  it("lets the host start with two ready players", () => {
    const { engine } = startRoom();
    expect(engine.phase).toBe("countdown");
    expect(engine.metrics.matches).toBe(1);
  });

  it("only lets the host start and requires ready players", () => {
    const engine = new RoomEngine({ code: "HOST" });
    const a = engine.join("Alice", token());
    if (!a.ok) throw new Error("join failed");
    expect(engine.start(a.playerId)).toEqual({ ok: false, code: "not_enough_players" });
    const b = engine.join("Bob", token());
    if (!b.ok) throw new Error("join failed");
    expect(engine.start(a.playerId)).toEqual({ ok: false, code: "not_ready" });
    engine.ready(a.playerId, 2);
    expect(engine.start(a.playerId)).toEqual({ ok: false, code: "not_ready" });
    engine.ready(b.playerId, 0);
    expect(engine.start(b.playerId)).toEqual({ ok: false, code: "not_host" });
    expect(engine.start(a.playerId)).toEqual({ ok: true, started: true });
  });

  it("broadcasts a lobby colour change without readying up", () => {
    const engine = new RoomEngine({ code: "COLR" });
    const a = engine.join("Alice", token());
    const b = engine.join("Bob", token());
    if (!a.ok || !b.ok) throw new Error("join failed");
    expect(engine.color(a.playerId, 1)).toEqual({ ok: true });
    expect(engine.slots[a.slot]?.palette).toBe(1);
    expect(engine.slots[a.slot]?.ready).toBe(false);
    const seenByB = engine
      .stateFor(b.slot)
      .slots.find((slot) => slot.slot === a.slot);
    expect(seenByB?.palette).toBe(1);
    expect(engine.color(b.playerId, 1)).toEqual({
      ok: false,
      code: "palette_taken",
    });
  });

  it("starts a four-player match on the four midpoints", () => {
    const engine = new RoomEngine({
      code: "FOUR",
      matchConfig: { roundTicks: 60, countdownTicksPerLabel: 1 },
    });
    const names = ["Alpha", "Bravo", "Charlie", "Delta"];
    const palettes = [2, 0, 1, 3];
    const joined = names.map((name, index) => {
      const result = engine.join(name, token());
      if (!result.ok) throw new Error("join failed");
      expect(engine.ready(result.playerId, palettes[index]!).ok).toBe(true);
      return result;
    });
    expect(engine.start(joined[0]!.playerId).ok).toBe(true);
    const sim = engine.simState;
    expect(sim).not.toBeNull();
    expect(sim!.activeSlots).toEqual([0, 1, 2, 3]);
    expect(sim!.players[0]!.x).toBe(960);
    expect(sim!.players[0]!.y).toBeLessThan(sim!.players[1]!.y);
    expect(sim!.players[2]!.x).toBeGreaterThan(sim!.players[3]!.x);
    expect(sim!.players[2]!.y).toBe(sim!.players[3]!.y);
  });

  it("reconnects with the stored token into the same slot", () => {
    const { engine, a } = startRoom({ roundTicks: 600 });
    engine.disconnect(a.playerId);
    const rejoined = engine.join("Alice", token(), a.token);
    expect(rejoined.ok).toBe(true);
    if (!rejoined.ok) return;
    expect(rejoined.reconnected).toBe(true);
    expect(rejoined.slot).toBe(a.slot);
    expect(engine.slots[a.slot]?.connected).toBe(true);
    // A reloaded client restarts its sequence at 0; the server must accept it.
    engine.input(a.playerId, { left: false, right: true }, 0, 0);
    expect(engine.slots[a.slot]?.input).toEqual({ left: false, right: true });
  });
});

describe("RoomEngine ticks", () => {
  it("runs a full round at 60 Hz with no drift and a result", () => {
    const { engine } = startRoom({ roundTicks: 120 });
    let ticks = 0;
    let snapshots = 0;
    let endEvents = 0;
    while (engine.phase !== "result" && ticks < 1000) {
      const output = engine.tick();
      ticks += 1;
      snapshots += output.snapshots.length;
      endEvents += output.events.filter((event) => event.type === "end").length;
      if (output.stateChanged) {
        // Adapters resend `state` on transitions.
        expect(engine.stateFor(0).phase).toBe(engine.phase);
      }
    }
    expect(engine.phase).toBe("result");
    expect(ticks).toBe(4 + 120);
    expect(endEvents).toBe(1);
    expect(snapshots).toBeGreaterThan(ticks / 3 - 2);
    expect(engine.engineTick).toBe(ticks);
    expect(engine.simState?.tick).toBe(ticks);
  });

  it("emits snapshots every third tick and on transitions", () => {
    const { engine } = startRoom({ roundTicks: 600 });
    const first = engine.tick();
    expect(first.snapshots).toHaveLength(1);
    const second = engine.tick();
    const sizes = second.snapshots.map((snapshot) => JSON.stringify(snapshot).length);
    expect(sizes.every((size) => size < 400)).toBe(true);

    let seen = 0;
    for (let i = 0; i < 30; i += 1) {
      const output = engine.tick();
      seen += output.snapshots.length;
    }
    expect(seen).toBeGreaterThanOrEqual(9);
    expect(seen).toBeLessThanOrEqual(12);
  });

  it("returns steering to neutral within the input TTL", () => {
    const { engine, a } = startRoom({ roundTicks: 600 });
    while (engine.phase === "countdown") engine.tick();
    expect(engine.phase).toBe("playing");

    const angleStart = engine.simState!.players[0].angle;
    engine.input(a.playerId, { left: false, right: true }, 1, 0);
    engine.tick();
    const angleAfterInput = engine.simState!.players[0].angle;
    expect(angleAfterInput).toBeGreaterThan(angleStart);

    for (let i = 0; i < 15; i += 1) engine.tick();
    const angleAtTtl = engine.simState!.players[0].angle;
    for (let i = 0; i < 10; i += 1) engine.tick();
    const angleAfterTtl = engine.simState!.players[0].angle;
    expect(angleAfterTtl).toBe(angleAtTtl);
  });

  it("ignores stale input sequence numbers", () => {
    const { engine, a } = startRoom({ roundTicks: 600 });
    engine.input(a.playerId, { left: true, right: false }, 5, 0);
    engine.input(a.playerId, { left: false, right: true }, 4, 0);
    expect(engine.slots[0]?.input).toEqual({ left: true, right: false });
  });

  it("runs a four-player round and serializes all four slots", () => {
    const engine = new RoomEngine({
      code: "FOUR",
      matchConfig: { roundTicks: 30, countdownTicksPerLabel: 1 },
    });
    const palettes = [2, 0, 1, 3];
    const joined = ["Alpha", "Bravo", "Charlie", "Delta"].map((name, index) => {
      const result = engine.join(name, token());
      if (!result.ok) throw new Error("join failed");
      engine.ready(result.playerId, palettes[index]!);
      return result;
    });
    engine.start(joined[0]!.playerId);

    let lastSnapshot = null as ReturnType<RoomEngine["snapshotNow"]>;
    let endScores: number[] | null = null;
    for (let i = 0; i < 200 && engine.phase !== "result"; i += 1) {
      const output = engine.tick();
      if (output.snapshots.length > 0) lastSnapshot = output.snapshots.at(-1)!;
      for (const event of output.events) {
        if (event.type === "end") endScores = event.scores;
      }
    }
    expect(engine.phase).toBe("result");
    expect(lastSnapshot?.players).toHaveLength(4);
    expect(lastSnapshot?.players.map((player) => player.slot)).toEqual([0, 1, 2, 3]);
    expect(endScores).toHaveLength(4);
  });
});

describe("RoomEngine disconnect rules", () => {
  it("ends a round by forfeit after the grace window", () => {
    const { engine, a } = startRoom({ roundTicks: 600, graceTicks: 5 });
    while (engine.phase === "countdown") engine.tick();
    engine.disconnect(a.playerId);
    let end: { type: string; winner?: number | null; reason?: string } | null = null;
    for (let i = 0; i < 10; i += 1) {
      const output = engine.tick();
      const found = output.events.find((event) => event.type === "end");
      if (found && found.type === "end") end = found;
    }
    expect(engine.phase).toBe("result");
    expect(end?.reason).toBe("forfeit");
    expect(end?.winner).toBe(1);
  });

  it("abandons when both players are gone", () => {
    const { engine, a, b } = startRoom({ roundTicks: 600, graceTicks: 5 });
    while (engine.phase === "countdown") engine.tick();
    engine.disconnect(a.playerId);
    engine.disconnect(b.playerId);
    let end: { type: string; winner?: number | null; reason?: string } | null = null;
    for (let i = 0; i < 8; i += 1) {
      const output = engine.tick();
      const found = output.events.find((event) => event.type === "end");
      if (found && found.type === "end") {
        end = found;
        break;
      }
    }
    expect(end?.reason).toBe("abandoned");
    expect(end?.winner).toBeNull();
  });

  it("starts a rematch when both players vote", () => {
    const { engine, a, b } = startRoom({ roundTicks: 20 });
    while (engine.phase !== "result") engine.tick();
    expect(engine.rematch(a.playerId).started).toBe(false);
    expect(engine.rematch(b.playerId).started).toBe(true);
    expect(engine.phase).toBe("countdown");
    expect(engine.metrics.matches).toBe(2);
  });

  it("frees a slot when a player leaves from the lobby", () => {
    const engine = new RoomEngine({ code: "WXYZ" });
    const a = engine.join("Alice", token());
    const b = engine.join("Bob", token());
    if (!a.ok || !b.ok) throw new Error("join failed");
    engine.leave(a.playerId);
    expect(engine.phase).toBe("lobby");
    const c = engine.join("Carol", token());
    expect(c.ok).toBe(true);
  });
});
