# Deployment

## Cloudflare (production)

One Worker serving the built web app and one Durable Object class (`Room`).

```bash
npm install
npm run build
cd apps/server
npx wrangler login
npx wrangler deploy
```

`apps/server/wrangler.jsonc`:

- `main: src/worker.ts`
- static assets: `../web/dist` with `ASSETS` binding and SPA fallback
- Durable Object binding `ROOMS` → class `Room`, migration tag `v1`
- vars: `ALLOWED_ORIGINS` (comma-separated; empty = same-origin),
  `ROOM_IDLE_MS` (default 30 min), `MAX_ROOMS_PER_IP` (best-effort cap)

### Custom domain

Add the custom domain in the Cloudflare dashboard (Workers → your Worker →
Settings → Domains & Routes). If the web app is served from a different origin
than the Worker, set `ALLOWED_ORIGINS` to the exact web origin and build the
web app with:

```bash
VITE_SERVER_URL=https://your-worker.example.workers.dev npm run build
```

`VITE_SERVER_URL` accepts `https://…` or `wss://…`; the client derives the
other scheme.

### Rollback

`npx wrangler deployments list` then `npx wrangler rollback <id>`, or redeploy
the previous commit. Durable Objects are namespaced by room code; a rollback
does not delete stored lobby records. Bump `PROTOCOL_VERSION` for wire-breaking
changes; clients on an old version are rejected with `bad_version`.

## Node adapter (local dev, CI, fallback host)

```bash
npm --workspace @flash/server run dev        # :8787
PORT=9000 TICK_MS=16.6667 node ...           # optional overrides
```

The Node adapter is transport-only: same `RoomEngine`, same protocol. It can
serve as a fallback on a single free VM if Cloudflare quotas stop fitting, but
it does not serve the static build by itself (put the `apps/web/dist` folder
behind a static file server or add a small static handler).

## Local Cloudflare check

```bash
npm run build
cd apps/server
npx wrangler dev --port 8787
# then, from the repo root:
node scripts/smoke-cf.mjs http://127.0.0.1:8787
```

This was run in this repository: health, static index, room creation, two
clients, countdown → playing, 20 Hz snapshots.

## Free-tier checklist

- Verify the current Durable Objects request/duration/storage allowances before
  launch; they are the only cost driver.
- Idle rooms hibernate and expire after `ROOM_IDLE_MS`; no timer runs between
  matches.
- Snapshot payload is ~300 bytes; static assets are immutable and cached by the
  service worker. Runtime assets are ~4 MB (MP3 audio + re-encoded background);
  the initial JS bundle is ~350 KB (~110 KB gzip) plus Pixi renderer chunks.
- `play_music` provenance must be verified or replaced before a public
  launch (see `assets/PROVENANCE.md`).

## Known operational limit

Cloudflare timers do not survive hibernation. While a match is active the DO
keeps a timer loop and stays awake; lifecycle data is persisted at transitions.
If the platform evicts a DO mid-match anyway, the room restores from its lobby
record and clients reconnect into their slots (both ready again starts a fresh
round). This is the documented trade-off from the plan: timers are never
persisted, and the simulation is never written per tick.
