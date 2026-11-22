import { describe, expect, it } from "vitest";
import {
  MAX_MESSAGE_BYTES,
  PROTOCOL_VERSION,
  encodeServerMessage,
  isValidName,
  isValidPalette,
  isValidRoomCode,
  parseClientMessage,
} from "../src";

describe("protocol validation", () => {
  it("accepts a well-formed join", () => {
    const result = parseClientMessage(
      JSON.stringify({ t: "join", v: PROTOCOL_VERSION, room: "ABCD", name: "Alice" }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.msg.t).toBe("join");
  });

  it("accepts join with a reconnect token", () => {
    const result = parseClientMessage(
      JSON.stringify({ t: "join", v: 1, room: "ABCD", name: "Alice", token: "tok" }),
    );
    expect(result.ok).toBe(true);
  });

  it("rejects a version mismatch", () => {
    const result = parseClientMessage(
      JSON.stringify({ t: "join", v: 99, room: "ABCD", name: "Alice" }),
    );
    expect(result).toEqual({ ok: false, code: "bad_version" });
  });

  it("rejects invalid rooms, names and palettes", () => {
    expect(parseClientMessage(JSON.stringify({ t: "join", v: 1, room: "ab", name: "A" }))).toEqual({
      ok: false,
      code: "bad_room",
    });
    expect(
      parseClientMessage(JSON.stringify({ t: "join", v: 1, room: "ABCD", name: "bad\nname" })),
    ).toEqual({ ok: false, code: "bad_name" });
    expect(
      parseClientMessage(JSON.stringify({ t: "join", v: 1, room: "ABCD", name: "x".repeat(17) })),
    ).toEqual({ ok: false, code: "bad_name" });
    expect(parseClientMessage(JSON.stringify({ t: "ready", palette: 9 }))).toEqual({
      ok: false,
      code: "bad_palette",
    });
    expect(parseClientMessage(JSON.stringify({ t: "ready", palette: 1.5 }))).toEqual({
      ok: false,
      code: "bad_palette",
    });
  });

  it("rejects malformed JSON, arrays and unknown types", () => {
    expect(parseClientMessage("{")).toEqual({ ok: false, code: "bad_json" });
    expect(parseClientMessage("[]")).toEqual({ ok: false, code: "bad_json" });
    expect(parseClientMessage(JSON.stringify({ t: "nope" }))).toEqual({
      ok: false,
      code: "protocol",
    });
  });

  it("parses lobby colour changes and host starts", () => {
    expect(parseClientMessage(JSON.stringify({ t: "color", palette: 1 }))).toEqual({
      ok: true,
      msg: { t: "color", palette: 1 },
    });
    expect(parseClientMessage(JSON.stringify({ t: "color", palette: 9 }))).toEqual({
      ok: false,
      code: "bad_palette",
    });
    expect(parseClientMessage(JSON.stringify({ t: "start" }))).toEqual({
      ok: true,
      msg: { t: "start" },
    });
  });

  it("rejects oversized payloads", () => {
    const result = parseClientMessage("x".repeat(MAX_MESSAGE_BYTES + 1));
    expect(result).toEqual({ ok: false, code: "too_large" });
  });

  it("validates input booleans and sequence numbers", () => {
    expect(
      parseClientMessage(JSON.stringify({ t: "input", seq: 1, tick: 0, left: true, right: false }))
        .ok,
    ).toBe(true);
    expect(
      parseClientMessage(JSON.stringify({ t: "input", seq: 1, tick: 0, left: 1, right: false })),
    ).toEqual({ ok: false, code: "protocol" });
    expect(
      parseClientMessage(JSON.stringify({ t: "input", seq: -1, tick: 0, left: true, right: false })),
    ).toEqual({ ok: false, code: "protocol" });
  });

  it("validates helpers", () => {
    expect(isValidName("Alice")).toBe(true);
    expect(isValidName(" Alice ")).toBe(false);
    expect(isValidName("")).toBe(false);
    expect(isValidPalette(0)).toBe(true);
    expect(isValidPalette(4)).toBe(false);
    expect(isValidRoomCode("ABCD")).toBe(true);
    expect(isValidRoomCode("abc")).toBe(false);
  });

  it("encodes server messages as JSON", () => {
    const text = encodeServerMessage({ t: "pong", ts: 42 });
    expect(JSON.parse(text)).toEqual({ t: "pong", ts: 42 });
  });
});
