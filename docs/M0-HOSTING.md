# M0 — hosting / quota spike

## What is implemented

- Cloudflare Worker `apps/server/src/worker.ts` with one Durable Object per
  room (`idFromName(code)`), Hibernation API sockets, a drift-corrected timer
  only while a match is active, and an idle-room alarm (30 min).
- Lifecycle-only persistence: join, ready, start, result, leave. No per-tick
  storage writes. The record never contains the simulation.
- Safeguards: message size cap (2 KB parsed, 4 KB frame), per-socket rate cap,
  1 Hz presence ping, event-driven inputs, 20 Hz snapshots, room cap per IP
  (best effort, Worker-isolate map), static assets immutable.

## Local measurement (actually run)

`npm run measure` drives one 84 s match through the real `RoomEngine` with the
documented client policy (input repeat every 150 ms while steering, ping every
3 s, snapshots every 3rd tick):

```
engineTicks             5280   (240 countdown + 5040 playing)
inboundMessages         1238
outboundMessages        1779
snapshots               1761
events                    11
state messages             3
bytesOut              ~504 KB
reconnect mask        ~4.6 KB (1430 RLE runs, after a full match)
simulation time          ~58 ms (CPU)
wall duration            88 s
```

Inbound messages are the billable Requests on Cloudflare:

| Daily request allowance | Matches/day |
| --- | ---: |
| 100,000 | 80 |
| 1,000,000 | 807 |

At the plan's target of 20 matches/day the room traffic is **~24.8k
inbound requests/day**, well under a 1M/day allowance. Outbound snapshots are
~504 KB per match (~10 MB/day for 20 matches).

If outbound WS messages are billed in the future, ~1.8k extra per match keeps
20 matches/day at ~60k billable messages.

## Still needs your account

A real deployment can only be measured with Cloudflare credentials, which this
session does not have. To complete the acceptance criterion:

1. `npm run build`
2. `cd apps/server && npx wrangler login && npx wrangler deploy`
3. Open two browsers against the deployed URL, play one full 84 s match.
4. Watch `npx wrangler tail` and the Cloudflare dashboard:
   - Requests (WebSocket messages count as requests),
   - Durable Object duration (should be ~88 s per match, zero while idle),
   - Storage writes (should be ~15 per match, not per tick).
5. Record the numbers in this file and compare against the local budget.

The Worker has no other backend dependency, so if the free plan changes, the
same `RoomEngine` and protocol run on the Node adapter (a single small VM, e.g.
Oracle Always Free) without code changes.

## Local verification already done

- `wrangler dev` binds the DO and static assets; a two-client script reached
  `lobby → countdown → playing` with 20 Hz snapshots (`scripts/smoke-cf.mjs`).
- Node adapter WebSocket E2E and `RoomEngine` unit tests pass (`npm test`).
- Ops load check (`apps/server/scripts/load.ts`): 20 rooms, 20 complete rounds,
  5281 room-ticks, **542 ms** of CPU (~195k room-ticks/s), 35,220 snapshots and
  9.8 MB of outbound snapshot JSON. Comfortably within a single small VM.
