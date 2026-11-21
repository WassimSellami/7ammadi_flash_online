# 7ammadi Flash — online browser edition

Paint the arena against a friend in the browser, or play locally. This is the
web rewrite of the pygame project in the sibling folder `7ammadi_flash_ai`
(which is left untouched and remains runnable).

- **Online 1v1** via room code / invite link, hosted on Cloudflare Workers +
  one Durable Object per room.
- **Local hotseat**, offline, installable as a PWA.
- **One rule engine**: the deterministic TypeScript core in `packages/core`
  runs on the server (Cloudflare or Node) and in the browser Web Worker.

## Quick start

```bash
npm install
npm run dev:server     # room server on :8787 (Node adapter, tsx)
npm run dev:web        # Vite on :5173, proxies /api and /ws
```

Open <http://localhost:5173>. Create a room, open the invite link in a second
browser (or a private window) and ready up.

Production build:

```bash
npm run build          # apps/web/dist, PWA service worker generated
npm --workspace @flash/server run dev:cf   # wrangler dev, serves dist + DO
npm run deploy         # build + wrangler deploy (needs Cloudflare credentials)
```

## Layout

```
packages/core           constants, RNG, motion, collisions, prizes, mask/score, sim
packages/protocol       message types, validation, PROTOCOL_VERSION
packages/server-engine  RoomEngine: lobby, inputs, snapshots, reconnect, forfeit
apps/web                Vite + PixiJS renderer, menus, audio, input, offline worker
apps/server             Cloudflare Worker + Durable Object, Node dev adapter
assets/v1               art, sounds, Comic Neue (OFL); served at /v1
docs                    deployment, protocol, hosting costs, fidelity notes
```

## Scripts

| Command | What it does |
| --- | --- |
| `npm run typecheck` | strict `tsc` over every workspace |
| `npm test` | Vitest: determinism, rules, protocol, mask parity, RoomEngine, WebSocket E2E (62 tests) |
| `npm run build` | Vite build + generated `sw.js` precache |
| `npm run dev:server` / `dev:web` | local room server / Vite dev server |
| `npm run smoke` | Playwright menu → hotseat → pause → invite-form smoke |
| `npm run smoke:online` | two browsers complete an online round (short dev round) |
| `npm run smoke:offline` | installs the PWA, goes offline, reloads, plays hotseat |
| `npm run smoke:cf` | Cloudflare adapter against `wrangler dev` |
| `npm run measure` | message budget for one 84 s match |

Smoke tests expect the preview/dev servers to be running; see
`docs/M0-HOSTING.md` and the script headers.

## Design summary

- 60 Hz authoritative tick (`1000/60 ms` per tick), snapshots every 3rd tick
  (20 Hz). Inputs are event-driven with a 250 ms TTL and a 150 ms repeat while
  steering. Pings every 3 s.
- Snapshot + event channels: snapshots are enough to rebuild the scene;
  events only add transients (punch, boom, rain, labels, countdown).
- Scoring is server-authoritative from a 480x252 palette-index mask with O(1)
  per-index counters. Clients paint a 960x540 GPU RenderTexture for looks.
- Reconnect token in `sessionStorage`; 20 s grace, then forfeit (or abandoned
  if both are gone). Reconnects receive a compact RLE mask sync so the arena
  is rebuilt mid-round. No pause online, including tab blur.
- Local mode pauses on `Esc` and when the tab is hidden.
- Room persistence is lifecycle-only (join/ready/start/result); no per-tick
  storage writes. Timers run only during an active match.

## Behaviour fidelity

See `docs/FIDELITY.md` for the exact port notes. The important deliberate
changes are the 1 s countdown labels (the reference used 0.1 s) and the
server-side paint mask. One plan/reference discrepancy is documented there:
the reference yields **6 spawns, 1 per kind** (the plan text says 7/2), and the
port follows the reference code.

## Not verified here

- Actual deployed Cloudflare cost (needs your account; local budget + method in
  `docs/M0-HOSTING.md`).
- 150 ms RTT play feel on real networks (prediction/interpolation are implemented;
  the netcode tests are headless and local).

## Deployment

See `docs/DEPLOY.md`. The Cloudflare adapter has been verified locally with
`wrangler dev`; an actual deployed cost measurement is the only M0 item that
needs your Cloudflare account (`docs/M0-HOSTING.md`).

## Assets

The pygame project's art and audio were copied into `assets/v1` with a
provenance note. Audio is converted to MP3 and the background re-encoded
(~29 MB → ~4 MB of runtime assets). `play_music` needs its license verified
(or replaced) before a public launch, as called out in the plan. Comic Neue is
bundled under the SIL Open Font License (`assets/v1/fonts/OFL.txt`).
