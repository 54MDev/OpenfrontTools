# Step 4 — Scoring + Overlay for Best-Spawn Suggestion

Builds on `PHASE2.md` (investigation + steps 1-3, all live-verified). Inputs now
available in `content.js`, already joined and confirmed correct against a real
lobby:

- `latestTileState.ownerIds` — flat `Uint16Array`, one `smallID` per tile
  (`0` = unowned), `width`/`height` give the grid shape.
- `playersByID` — `smallID -> {playerType, name, nationFlag, clientID}`.
- `latestPicks` — pending human spawn picks, `{x, y, radius, kind, r, g, b}`
  (tile-grid coords, same space as `ownerIds`).

## Goal

When the spawn-pick phase is live, compute one tile-grid coordinate — "spawn
here" — and show a marker on it. Simplest defensible version only (per
`PHASE2.md`'s own scoring note): maximize distance from other humans' pending
picks (avoid crowding), tie-break by distance from nation-owned tiles (avoid
the dangerous bots). No weight-tuning UI, no multi-factor model, until this is
played with and found wrong.

## Two things step 1-3 didn't need that step 4 does

**1. Land vs. water.** `ownerIds` only carries `ownerID` (bits 0-11) —
fallout/defense bits were dropped as unneeded in `inject.js`'s decode (see
`PHASE2.md`). An unowned tile (`ownerId === 0`) could be unclaimed land *or*
water — nations/tribes already own all the land they start on, so in practice
most/all remaining unowned tiles are water, but this is an assumption, not
confirmed. **Needs verifying against a real map before scoring, not guessed.**
If it holds, no new hook is needed — candidates are just "not nation-owned,
not tribe-owned, not already a pending human pick's tile." If it doesn't
hold, the `tileTex`'s fallout/defense bits (already flowing through the same
`texSubImage2D` hook, just currently discarded) are the fallback — reuse,
don't add a new hook.

**2. Tile-grid coord -> screen pixel.** The marker has to be drawn where the
player can see it, and the game's camera pans/zooms. None of the three hooks
from step 1-3 expose the camera transform. **Needs investigating against the
live game, not assumed**, in this order (cheapest first):
- Check if OpenFront's own canvas/WebGL context exposes a reusable
  projection (uniform values, `gl.viewport`, or a transform matrix passed to
  a shader) that can be read the same way the other hooks read state —
  avoids rebuilding camera math from scratch.
- If not exposed anywhere interceptable, the fallback is tracking pan/zoom
  via the same DOM events the game itself listens to (wheel/drag) and
  reimplementing the tile->screen math from `GameRenderer`'s source (public
  on GitHub) — more code, last resort.

Everything else below assumes these two are resolved; don't write scoring/
rendering code against guesses for either.

## Scoring (v1 — simplest defensible)

```
for each candidate tile (unowned, land, not a pending-pick's own tile):
  humanDist   = min distance to any pending human pick (bigger is better)
  nationDist  = min distance to any nation-owned tile (bigger is better)
  score = humanDist                      # primary
  tiebreak = nationDist                  # only compares when humanDist ties
best = argmax(score, tiebreak)
```

No weighting between the two factors — tribes/nations proximity is a
tiebreak, not blended into one number, because blending requires picking a
relative weight with no data to justify it yet (exactly what `PHASE2.md`
warned against: "don't hardcode weights speculatively"). Revisit only after
playing with this and seeing it pick bad tiles.

**Rerun on every pick update, not once per spawn phase.** Pending picks are
the fast-changing input here — humans move their spawn choice multiple times
during the countdown (confirmed live: `latestPicks` growing/changing across
the captured session in `PHASE2.md`'s verification) — so a one-shot calc at
phase start would suggest a tile that's already crowded a few seconds later.
Split the two factors by how often their input actually changes:

- `nationDist` per candidate tile — static for the whole spawn phase (nations/
  tribes don't move, per `PHASE2.md`'s checklist). Compute once when the
  spawn phase starts, cache it.
- `humanDist` per candidate tile — recompute every time `oftools-spawns`
  fires. The live capture in `PHASE2.md` saw picks update every ~100ms
  (~10Hz); reconfirm the real rate against a fresh capture rather than
  assuming it, since it's the thing driving how often this whole
  calculation reruns.

This keeps each update cheap — "distance from each candidate to the current
~N pending picks" (N = humans in the lobby, small) — instead of a full
two-factor rescan every update.

Scan is full-grid per spawn-phase tick — `ownerIds` is at most a few hundred
thousand entries (`mapW × mapH`, e.g. a 2048×1024 map ≈ 2M, in practice
smaller since the join step already proved ~5.5M array length is fine to
iterate once for the ownership-count log). If a per-tick full scan turns out
to be slow in practice, downsample the grid (e.g. every 4th tile) before
reaching for anything fancier — not before.

## Overlay rendering

Reuse the existing heatmap overlay's canvas approach (`content.js`'s
`drawHeatmap`) as the pattern, but this marker draws **on the game itself**,
not in the fixed side panel — so it needs its own `<canvas>` positioned over
the WebGL canvas (`position: absolute`, matched size, pointer-events: none),
redrawn on a `requestAnimationFrame` loop only while the spawn phase is
active (not every frame all game — stop the loop once spawned/game starts).

## Build order

1. Confirm land/water assumption and the camera-transform approach against a
   real live lobby (both are investigation, not coding — see above).
2. Write the scoring function as a pure function (`bestSpawnTile(ownerIds,
   width, height, playersByID, picks) -> {x, y}`) — pure so it gets the same
   kind of Node `assert` self-check as `inject.js`'s decoders
   (`test_scoring.js`), no browser needed to catch an off-by-one in the
   distance math.
3. Wire it into `content.js`: call it whenever tile/player/pick state
   updates during the spawn phase, `console.log` the chosen tile first —
   verify it against a real lobby before drawing anything.
4. Only then: the overlay canvas + marker.

## Explicitly skipped (YAGNI — add only if it turns out to matter)

- No configurable scoring weights/settings UI.
- No "exposure" scoring (coastline/navy access) — not in the v1 formula above.
- No continuous suggestion through the whole game — spawn phase only, per
  `PHASE2.md`.
- No downsampling/spatial index for the tile scan until a real slowdown is
  observed.

## Status: planning only — nothing in this file is built yet

This is the approach, written down before touching code, because step 4 is
bigger than steps 1-3 and has two unresolved investigation items (land/water,
camera transform) that should be nailed down before scoring/rendering code is
written against a guess.
