# Agent notes

## Commands

Windows + PowerShell. `npm`, `node` and `npx` work through `cmd /c "..."`.

```bash
cmd /c "npm run typecheck"     # tsc -p tsconfig.json --noEmit
cmd /c "npm test"              # vitest run (62 tests)
cmd /c "npm run build"         # apps/web/dist + PWA sw.js
cmd /c "npx tsx apps/server/scripts/load.ts"  # 20-room accelerated load check
cmd /c "npm --workspace @flash/server run dev"   # Node room server :8787
cmd /c "npm --workspace @flash/web run dev"      # Vite :5173
```

Browser checks (Playwright is installed as a root dev dependency):

```bash
cmd /c "node scripts/smoke.mjs http://localhost:4173"          # needs build + preview
cmd /c "node scripts/smoke-online.mjs http://localhost:5173"   # needs node server + vite dev
cmd /c "node scripts/smoke-offline.mjs http://localhost:4173"  # build + preview
cmd /c "node scripts/smoke-cf.mjs http://127.0.0.1:8787"       # wrangler dev
```

## Rules

- `packages/core` is platform-free: no `window`, `document`, `Date.now`,
  `performance.now`, `Math.random`, timers, storage or `node:*` imports.
  `packages/core/test/purity.test.ts` enforces this. The tick is the only clock.
- Do not edit the pygame project at `../7ammadi_flash_ai`.
- The shared core is the only place rules live; the Node and Cloudflare
  adapters must stay transport-only.
- Golden replay hashes and mask parity are the regression net: run `npm test`
  after any change to motion, collisions or prizes.

## Environment gotchas

- `npm.ps1` is blocked by execution policy; invoke npm via `cmd /c`.
- vexp MCP is not registered for this workspace; use read/grep/glob.
- `wrangler dev` serves `apps/web/dist`, so build the web app first.
- The service worker uses `ignoreVary` when matching cached assets (Vite
  preview varies on `Accept-Encoding`); keep it or offline reloads break.
