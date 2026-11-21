# Fidelity notes (pygame → TypeScript)

Reference: `../7ammadi_flash_ai` (`data/player.py`, `data/game.py`,
`data/prize.py`, `data/settings.py`, `main.py`).

## Ported exactly

- Tick math: `factor = elapsed_ms / 35`, `angle += mode.angle * factor`,
  `step = mode.step * factor`, with the same float accumulators and `int()`
  truncation each tick. Modes: slow (6,5), normal (6,9), fast (6,13), wait (0,0).
- Playfield clamp with the 80x80 icon margin (`max(radius, 40)`).
- Wall hit: `hitSide` zeroes the axis, sets a 0.5 s cooldown, and restores the
  powerup mode (speed/fat/bandi) without clearing the powerup.
- Jump: quadrant-based `randrange` ranges, server RNG.
- Collision timers: 84 ticks jumping, then slow mode, 300 ticks until normal;
  movement ×0.8 while jumping; jump visual lift 110 px.
- Bandi: 10 s, radius 45, fast mode, punch to the nearest wall in 0.2 s;
  punch cancels bandi on the victim and resets both paint colours.
- Prizes: spawn every 12 s, 12 s lifetime, 80-sample distance placement
  (fallback to the best sample), mode prizes clear the previous powerup,
  rain = 30 drops of radius 36 every 50 ms, boom = radius 200, follow_me sets
  both paint indices to the winner's true palette.
- `set_to_normal` on every normal collision clears `bandi`/`powerup`, resets
  radius and paint colour — this is how speed/fat are consumed.
- Countdown steering: angle changes start during the countdown, and both
  brushes stamp during the countdown (the reference calls `paint_players`).
- **Paint suppression quirk**: both brushes stamp only when Player A is not
  jumping (`Player.paint_both`). A jump by B alone does not suppress painting.
  Preserved verbatim and covered by tests.
- **Knockback/beaten stamping**: following the plan's idle-painting rule (not
  the raw pygame loop), a player being knocked to the wall does not paint a
  streak during that 0.2 s; the other player keeps painting. The global
  A-jump flag still has precedence as above.
- Scores: palette-index counts, `round()` half-to-even, percentage.

## Deliberate changes

- Fixed 60 Hz tick instead of a wall clock (`1000/60 ms` exactly).
- Countdown: 1 s per label (3, 2, 1, Go!) instead of `symbol_time = 0.1`.
- Scoring happens on a 480x252 palette-index mask; the client's paint layer is
  cosmetic. Server scores win.
- Rain is painted into the mask over 1.5 s; boom is stamped instantly. The
  client replays those stamps locally on the same schedule so the visible paint
  matches the score mask.
- Online has no pause; local hotseat pauses.
- `beaten_time` is unused in the reference (nothing sets `beaten = true`); the
  field and flag stay in the snapshot for parity.

## Plan/reference discrepancy

The plan says "7 spawns per 84 s round, ceil(7/6) = 2 per kind". The reference
computes `prizes_per_round = int((84 - 1e-9) // 12) = 6` and the spawn condition
is `spawn_ms < round_time * 1000`, so the 84 s spawn never happens. The port
therefore yields **6 spawns per round, exactly one of each kind** (all six
kinds appear). This matches the reference code and still satisfies the
acceptance criterion "never more than 7 spawns".

## Rendering notes

- The paint layer is a persistent 960x540 `RenderTexture`; it is cleared only
  when a round starts (countdown/playing transition or rematch). A mid-round
  join/reconnect syncs the authoritative 480x252 mask as RLE and redraws it.
- Effects caps: 420 total, 180 trails, 120 bubbles; `_shift_hue` is ported
  exactly. Bandi has no bubbles (ring only), speed/fat spawn bubbles.
- `EffectsManager.scale` used a 1440x900 baseline (1.2 on the reference
  1920x1080 window); the web renderer applies the same `FX_SCALE = 1.2` to
  effect sizes, shadows, rings, stars and the direction marker.
- Comic Sans is replaced by bundled Comic Neue (OFL).
- The brush is recoloured client-side with the same paint-green predicate and
  fitted to 80x80; the swing effect uses two textures split at the cream
  bristle line, rotating around `splitY - 5`. `follow_me` changes the paint
  colour only, never the brush sprite palette.
- Scoreboard/menu visuals are DOM overlays, but the result cards count both
  percentages up and reveal the winner like `Screen.draw_scoreboard`. The
  in-game HUD matches the reference: timeline, prize markers and audio toggles,
  no live scores or numeric timer, hidden during the countdown.
- Netcode: the local brush predicts turn **and** position from the predicted
  angle (jump factor 0.8, playfield clamp) and reconciles to the authoritative
  position when the drift exceeds 40–80 px; the opponent is interpolated and
  both snap on teleports/knockback. The paint layer always uses server
  positions, so client paint is an approximation (server score is final).
