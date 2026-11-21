# Protocol v1

JSON over WebSocket. Shared types and validation live in
`packages/protocol/src/index.ts`. `PROTOCOL_VERSION = 1`.

## Endpoints

- `GET /ws?room=CODE` — WebSocket upgrade. `CODE` is 4–8 uppercase letters or
  digits. Server routes to the Durable Object named by the code.
- `POST /api/rooms` — `{code}` (Cloudflare also rate-limits per IP).
- `GET /api/health` — `{ok, protocol}`.

## Client → server

| Message | Fields | Notes |
| --- | --- | --- |
| `join` | `v, room, name, token?` | First message. Name 1–16 printable chars. Token reconnects into the same slot. |
| `ready` | `palette` | Palette 0–3, unique per room. Lobby only. |
| `input` | `seq, tick, left, right` | Sent on change and repeated every 150 ms while steering. TTL 250 ms. |
| `rematch` | — | After a result; both players must vote. |
| `leave` | — | Frees the slot in lobby/result, disconnects during a match. |
| `ping` | `ts` | Every 3 s; server replies `pong`. |

Validation rejects payloads over 2 KB, unknown message types, invalid names,
palettes, room codes, non-integer sequence numbers, and stale `seq` values.
Per-socket rate: 120 messages/second.

## Server → client

| Message | Payload |
| --- | --- |
| `welcome` | `{v, playerId, slot, config, serverTick, token}` |
| `snapshot` | `{v, tick, phase, a, b, prize, scores, ticksLeft, total, paint, cd?, win?}` |
| `paint` | `{w, h, runs}` � compact RLE of the server mask, sent to late joiners/reconnects (`255` = empty) |
| `event` | `{t:"event"} & GameEvent` (`smash`, `punch`, `pickup`, `boom`, `rain`, `evil`, `wall`, `spawn`, `count`, `end`) |
| `state` | `{phase, you, opponent, slots, reason?}` |
| `roundEnd` | `{scores, winner, reason}` |
| `pong` | `{ts}` |
| `error` | `{code, message?}` |

Snapshot player: `{x, y, ang, m, r, fl, c}` where `m` is the mode step
(0 wait, 5 slow, 9 normal, 13 fast), `fl` is a flag bitfield
(1 jumping, 2 bandi, 4 speed, 8 fat, 16 beaten, 32 knockback, 64 broken,
128 squashing) and `c` is the current paint palette index. Prize:
`{kind, x, y, endsAt}` with `endsAt` as an absolute simulation tick.
`paint` is the global stamping flag (`!playerA.jumping`).

## Lifecycle

```
lobby --both ready--> countdown (4 s) --240 ticks--> playing (5040) --> result
result --both rematch--> countdown
```

- Snapshots: every 3rd tick (20 Hz) plus transitions/reconnect.
- Inputs: server holds the last state per player; if no message arrives within
  15 ticks (250 ms), steering becomes neutral.
- Disconnect: `state.opponent.connected = false`, simulation continues with
  neutral input for that slot. Grace 1200 ticks (20 s); then `roundEnd` with
  `reason: "forfeit"` and the present player as winner. Both absent →
  `reason: "abandoned"`, no winner.
- Reconnect: `join` with the stored token returns the same `slot` and token;
  the client immediately receives a snapshot plus a `paint` mask sync so the
  arena can be rebuilt mid-round.

## Safety

- The server never trusts client positions, scores, or prize outcomes.
- The Durable Object checks Origin at the Worker edge (same-origin by default,
  or an explicit `ALLOWED_ORIGINS` allowlist).
- Names are trimmed and validated against printable ASCII; palette values are
  integers 0–3 and must be unique in the room.
