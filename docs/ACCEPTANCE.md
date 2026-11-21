# Acceptance matrix

Evidence for each plan milestone. Commands were run in this repository.

## M0 — hosting/quota spike

| Requirement | Evidence |
| --- | --- |
| Worker + one DO per room, echo/tick loop | `apps/server/src/worker.ts`; `wrangler dev` reached `lobby → countdown → playing` with two clients (`scripts/smoke-cf.mjs`). |
| Two browsers complete a round, requests measured | Two-browser Playwright round against the Node adapter (`scripts/smoke-online.mjs`); message budget measured locally with `npm run measure` (1238 inbound, 1779 outbound, ~504 KB, 88 s). |
| Comfortably inside free tier | `docs/M0-HOSTING.md`: 20 matches/day ≈ 24.8k requests, ~30 min DO wall time. |
| Actual deployed cost documented | **Pending your Cloudflare account** — exact steps are in `docs/M0-HOSTING.md`. |

## M1 — deterministic core

| Requirement | Evidence |
| --- | --- |
| Determinism (ticks + inputs → same state) | `packages/core/test/determinism.test.ts` (700-tick hash replay, different seeds diverge, 1000 ticks no drift). |
| Motion parity, sub-pixel accumulators | `motion.test.ts` asserts `4,4,4,5` normal and `3,3,4` while jumping, wall restore, knockback target. |
| Collision/slow/smash semantics | `paint-collision.test.ts` (jump timer 84 ticks, slow 300 ticks, bandi punch, bandi-vs-bandi). |
| Paint flag quirk | `paint-collision.test.ts` (A jump suppresses both; B jump does not; countdown stamps; idle stamping idempotent). |
| Prizes | `prize.test.ts` (6 spawns/12 s, one per kind, expiry, rain 30 drops/50 ms, boom, follow_me, mode clearing, bandi 10 s). |
| Score parity | `mask.test.ts` compares the mask score with a brute-force 1920x1006 reference painter (≤1 percentage point). |

## M2 — authoritative server

| Requirement | Evidence |
| --- | --- |
| Tick-only clock, no host time/randomness in core | `purity.test.ts` scans core sources for clocks, `Math.random`, host globals, timers. |
| RoomEngine 60 Hz round, no drift | `packages/server-engine/test/room.test.ts` (5280 ticks exact, snapshots every 3rd). |
| Input TTL, reconnect, forfeit, duplicate colours | Same file + `apps/server/test/ws.test.ts` (reconnect receives snapshot + paint; token accepted; seq reset). |
| Protocol validation, oversize rejection | `packages/protocol/test/protocol.test.ts`. |
| Node + Cloudflare adapters share one engine | `apps/server/src/node-server.ts`, `worker.ts`; both smoke-tested. |

## M3 — Pixi web client

| Requirement | Evidence |
| --- | --- |
| Menus, lobby, invite links, colour config | `scripts/smoke.mjs` (invite form), `smoke-online.mjs` (create/join/ready). |
| Paint layer 960x540, GPU only | `apps/web/src/render/paint.ts`; screenshot pixel check after solo and after a mid-round reload. |
| Scene: brush swing, shadows, jump, squash, direction marker, bandi ring, broken stars, prize halo/burst, countdown, HUD, effects caps | Implemented in `apps/web/src/render/*`; browser smoke has no console/page errors. |
| Own-player prediction, opponent interpolation | `SceneRenderer.update` (predicted angle **and** position with 40–80 px reconciliation; opponent smoothed; snap on teleport/knockback). |
| Scoreboard, rematch, forfeit/reconnect states | DOM overlays + game chip; two-browser round reaches results. |
| Audio | Client `AudioManager`, HUD/menu toggles, rain stretched gun sample; autoplay unlock on first gesture. |
| Knockback/beaten paint suppression | `stampPaint` skips the knocked-back victim (plan rule) while preserving the A-jump quirk; regression test in `paint-collision.test.ts`. |

## M4 — offline / PWA

| Requirement | Evidence |
| --- | --- |
| Same core in a Web Worker | `apps/web/src/offline/sim.worker.ts`; solo and hotseat run in `smoke.mjs`. |
| Pause/resume local; no pause online | Pause overlay in `smoke.mjs`; online path never pauses. |
| Versioned assets + service worker | `scripts/build-sw.mjs`; caches 45 files keyed by content hash. |
| Reload after first visit with no network | `scripts/smoke-offline.mjs`: SW active, page controlled, offline reload, solo starts. |
| Install prompt + manifest/icons | `assets/manifest.webmanifest`, generated PNG icons, `beforeinstallprompt` plumbing. |

## M5 — polish

| Requirement | Evidence |
| --- | --- |
| Prediction/interpolation at 150 ms | Implemented; **play-feel on a real 150 ms link not measured here**. |
| Snapshot/event split, reconnect visuals | Snapshots + RLE `paint` sync; events only transients. |
| Custom domain, rollback, CI | `docs/DEPLOY.md`, `.github/workflows/ci.yml`, manual deploy workflow. |
| Deploy drain | Clients reconnect with exponential-backoff attempts and the stored token; lifecycle record restores slots; stale clients get `bad_version` and reload. |
| Ops: 20 concurrent rooms | `apps/server/scripts/load.ts`: 20 full rounds, 542 ms CPU (~195k room-ticks/s), 9.8 MB outbound JSON. |

## Test totals

- `npm test`: **62 passing** across core, protocol, server-engine and the Node WebSocket E2E.
- `npm run typecheck`: clean.
- `npm run build`: succeeds (PWA precache generated).
- Browser: menu/solo/pause/hotseat/invite, two-browser online round with mid-round reload, offline PWA reload, and the Cloudflare adapter.
- Load: 20 rooms × 5280 ticks in 542 ms; reconnect mask sync is ~4.6 KB.

## Not measured in this environment

- **Deployed Cloudflare cost** — needs your account; local budget + exact steps in `docs/M0-HOSTING.md`.
- **150 ms RTT play feel** — prediction/reconciliation is implemented and the
  headless/LAN round passes, but no WAN latency/jitter injection was run.
- **FPS on mid-range hardware** — headless Chromium with SwiftShader only
  verified correctness and paint output, not a 60 FPS budget at 1080p.
- **Two physical machines** — the two-browser round ran on one machine (same
  network path as two tabs).
- **Remote error reporting** — the client surfaces errors as toasts and reloads
  on `bad_version`; no third-party error service is wired.
- **Protocol drain** — stale clients are rejected (`bad_version`) and reload;
  there is no dual-version serving window.
