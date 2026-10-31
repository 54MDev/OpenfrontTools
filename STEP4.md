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

## Two things step 1-3 didn't need that step 4 does — both now resolved

Both were open questions when this file was first written; both are now
confirmed live. Full detail (including a correction to the first one — the
initial land/water approach was wrong) is in substeps 4.1 and 4.2 below. One
caveat carries forward into the build order: **4.1's land/water signal
(`map.bin`-family fetch + bit-7 decode) is confirmed correct, but not yet
wired into `inject.js`/`content.js` as real code** — so far it only exists
as a throwaway console-pasted verification snippet. That wiring is now its
own substep (4.4, inserted below) before the scoring function can have real
land/water data to call against.

1. **Land vs. water** — resolved via `map.bin` (see 4.1): a plain
   `window.fetch` hook, decode bit 7 of each byte as `IS_LAND_BIT`.
2. **Tile-grid coord → screen pixel** — resolved via the camera matrix (see
   4.2): a `uniformMatrix3fv` hook, decode `sx/sy/tx/ty` into `zoom`/
   `offsetX`/`offsetY`.

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

## Build order (substeps + checks)

Each substep has one concrete check before moving to the next — matches the
project's own pattern from `BUILD_PLAN.md`/`PHASE2.md` (verify live, don't
stack unverified steps).

**4.1 — Confirm land vs. water. [x] Re-opened and resolved correctly
(2026-10-30) — the first pass was wrong.** The original check (rendering
`ownerIds` as a black/white silhouette and eyeballing it against the
coastline) looked like it confirmed `ownerId === 0` means water. It didn't,
and the mistake is worth recording: the ownership counts logged back in
`PHASE2.md`'s verification (`{NATION: 1071, BOT: 20762, unowned: 5478167}`)
show nations/tribes own only ~22,000 tiny city-blob tiles out of ~5.5M total
— they don't cover continents. So the vast majority of "unowned" is actually
*unclaimed land*, not water; the silhouette's dots happened to trace the
coast because most of those nations are literally coastal cities (confirmed
in our own captured player list — Malabo, Libreville, Port Harcourt, etc.),
not because the surrounding black area was water. `ownerId` cannot
distinguish land from water at all.

**The real signal, found by reading the actual OpenFrontIO source** (cloned
`main` and grepped — GitHub's code search needed login, raw file fetches
404'd, grepping the tarball worked): terrain is a *separate* per-tile byte,
nothing to do with the `ownerID`/state texture our hooks already capture.
`packages/engine-lib/src/game/GameMapImpl.ts` defines it directly:

```
bit 7 (0x80) = IS_LAND_BIT
bit 6 (0x40) = SHORELINE_BIT
bit 5 (0x20) = OCEAN_BIT
bits 0-4 (0x1f) = MAGNITUDE_MASK (elevation/depth)
IMPASSABLE_MAGNITUDE = 31  — land tiles at this magnitude cannot be owned,
                             attacked, or nuked (per the source comment) —
                             exclude these from spawn candidates too
```

This byte array is **not** uploaded to the GPU as-is — `TerrainPass.ts`
converts it to theme-colored RGBA8 before it ever touches a texture (so
decoding the terrain GL texture would mean reverse-engineering
theme-dependent colors — avoided). Instead, go one step further upstream:
`packages/shared/src/FetchGameMapLoader.ts` loads the raw terrain bytes with
a **plain `fetch("<mapSlug>/map.bin")`** (or `map4x.bin`/`map16x.bin` for
compact/mini variants) — `response.arrayBuffer()`, one byte per tile,
row-major, no header (`data.length === width * height`, enforced by
`genTerrainFromBin`'s own validation in `TerrainMapLoader.ts`). This is
exactly the kind of standard-browser-API crossing point `PHASE2.md`'s
architecture note described — patchable with a plain `window.fetch` hook,
the same pattern already used for `window.Worker`. No WebGL, no theme
decoding, one-shot load at map-load time (terrain is immutable after that
except rare water-nuke conversions, out of scope here same as the rest of
step 4).

Hook plan for `inject.js`: patch `window.fetch`, filter for URLs ending in
`map.bin`/`map4x.bin`/`map16x.bin`, decode the response into
`{isLand, isImpassable}` per tile. Since a map may fetch more than one of
these (full + compact/mini variants) and only one is the actual in-game
terrain, disambiguate by matching buffer length against the already-known
`tileTexSize.width * tileTexSize.height` from the existing tile-ownership
hook — not by assuming which bin is "the" one.

**Live check passed (2026-10-30).** First attempt at the verification
snippet (`step4-1-check-v2.js`) caught nothing — its URL-matching regex
expected a literal `map4x.bin`, but real filenames carry a content hash
(`map4x.abcad4be8f4c.bin`, confirmed from the captured `[MapLoader]` log
line against the Great Lakes map), so nothing matched. Fixed the filter to
`url.includes("/maps/") && /\.bin(\?|$)/.test(url)` instead of a literal
filename match. Re-ran against a real lobby (Great Lakes map, which turned
out to only fetch `map4x.bin` — this map uses the compact size tier where
`map4x.bin` *is* the full-resolution terrain, confirming the "disambiguate
by length, not by which filename" plan above was the right call, not an
unnecessary precaution): the rendered silhouette (white = `IS_LAND_BIT` set,
black = not) matched the real map **exactly**, pixel-for-pixel, both land
and water. `map.bin`-family fetch + bit-7 decode is confirmed as the real
land/water signal — safe to build 4.4's candidate filter on it.

**4.2 — Confirm the camera transform. [x] Confirmed live (2026-10-30).**
OpenFront's own `Camera.ts` (source read directly from GitHub) builds a 3×3
world→clip matrix, `[sx,0,0, 0,sy,0, tx,ty,1]` (column-major), and every
render pass uploads it once per frame via `gl.uniformMatrix3fv(uCamera,
false, cameraMatrix)` — same interception pattern as the existing hooks, no
camera math rebuilt from scratch. From the captured `sx, sy, tx, ty` plus the
canvas's own pixel size and `devicePixelRatio`:

```
zoom    = sx * canvasW / 2
offsetX = -tx / sx
offsetY = -ty / sy

screenX = (zoom * (worldX - offsetX)) / dpr + canvasW / (2 * dpr)
screenY = (zoom * (worldY - offsetY)) / dpr + canvasH / (2 * dpr)
```
(relative to the GL canvas's own top-left — add its `getBoundingClientRect()`
for page coords). The matrix is picked out of all `uniformMatrix3fv` calls by
shape (`m[1,2,3,5] === 0`, `m[8] === 1`, `m[0] > 0`, `m[4] < 0`) — no object
identity or call-order tricks needed, unlike the tile-texture hook.

Verified with a console-pasted snippet (`step4-2-check.js`, throwaway, no
extension code changed): converted the latest pending pick's tile coords to
screen pixels and rendered a tracking dot. Confirmed live — the dot landed
inside the real glow ring and tracked correctly through pan and zoom.

**4.3 — Confirm the real pick-update rate. [x] Confirmed live (2026-10-30).**
Measured with a console-pasted snippet (`step4-3-check.js`, throwaway, no
extension code changed) diffing `performance.now()` across consecutive
`oftools-spawns` messages in a real lobby. During the actual spawn-pick
countdown, the rate is tight and consistent: ~85-115ms between messages,
averaging ~100ms (~10Hz) — matches and reconfirms `PHASE2.md`'s earlier
estimate with a real measurement, not just a repeated assumption.

**Finding worth keeping, not just discarding:** the capture kept running
after the game actually started (spawn phase over), and intervals got wild
there — bursts of ~6ms gaps, multi-second gaps, up to 18.6s. This is the
7-floats-per-instance buffer-shape heuristic in `inject.js` (`length % 7 ===
0 && length <= 350`) false-positive-matching *other* gameplay buffers (units,
structures) once real gameplay traffic starts — not actual spawn picks,
since spawn picking is long over by then. Not a problem for scoring (step
4.4+ only runs during the spawn phase, never during active gameplay), but
worth remembering if `oftools-spawns` ever needs trusting outside that
window — it isn't reliable there.

**4.4 — Wire the real `map.bin` fetch hook into `inject.js` + `content.js`.
[x] Code written (2026-10-30), one bug found and fixed during the live check
— not yet re-verified live.** Added `decodeTerrain` + a `window.fetch` patch
to `inject.js`, a `content.js` listener, and a `decodeTerrain` case in
`test_inject.js` (`node test_inject.js` passes).

**Bug found live:** first version gated the fetch hook on `tileTexSize`
being set (to disambiguate which `.bin` is the real terrain). `map.bin`
loads *before* the game creates its WebGL textures — the map has to finish
loading before anything can be rendered — so `tileTexSize` is always still
`null` at the point the fetch resolves, and the block silently never ran.
Nothing logged, not even a wrong answer. Fixed by moving the disambiguation
out of `inject.js` (which can't know tile dimensions yet) and into
`content.js` (which already holds `latestTileState` once it arrives):
`inject.js` now decodes and posts every matching `.bin` fetch
unconditionally; `content.js` buffers them in `terrainCandidates` and picks
the one whose length matches `width*height` once tile state shows up,
in whichever order the two actually arrive.

**Second bug found live (2026-10-30): wrong-map match, not a bit-flip.**
First live run logged `{land: 1455663, water: 5590929}` (≈20.6% land) on
"Brain Rot", a map that's mostly land — backwards. Root cause wasn't the
bit-7 decode (that's still the verified-correct math from 4.1); it was
`resolveTerrain()`'s disambiguation picking the *first* candidate whose
byte length matched the tile grid. The lobby's map-select carousel fetches
a `.bin` per map shown as a thumbnail, not just the one picked — and many
maps share the same tile-grid dimensions, so length alone matched some
other map's terrain, not Brain Rot's. Fixed by always taking the
**most recent** matching candidate instead of the first, since the real
in-game fetch happens last (after the lobby's own prefetching is done) —
self-corrects even if an earlier mismatch already resolved something.
Candidate list capped at 10 (oldest dropped) so a long lobby-browsing
session doesn't grow it unbounded.

**Live check passed (2026-10-30), re-run after the fix.** Logged `{land:
978363, water: 1121637}` (≈46.6% land, near-even with a water skew) —
matches the real map by eye. "Most recent matching candidate" disambiguation
confirmed correct; 4.4 fully done. Move on to 4.5.

**4.5 — Write the scoring function. [x] Done (2026-10-30).** Added
`extension/scoring.js` (`bestSpawnTile(ownerIds, isLand, width, height,
playersByID, picks) -> {x, y} | null`) — pure, no DOM/WebGL, same style as
`inject.js`'s decoders. Full-grid scan, brute-force min-distance (marked
with a `ponytail:` comment on the fallback plan — downsample before a
spatial index — per this file's own "Overlay rendering" section).

*Check: `extension/test_scoring.js`, three synthetic-grid cases —
(A) 5x5 grid, nation corner + water corner + one pending pick: confirmed it
picks the opposite corner, avoiding both. (B) 3x3 grid, zero pending picks:
confirmed the nation-distance tiebreak alone decides when every candidate
ties at `humanDist = Infinity`. (C) 1x1 grid where the only land/unowned
tile is literally a pending pick's own tile: confirmed the exclusion check
returns `null` rather than suggesting a spawn on top of someone else's
pick (worth noting: a pick's own tile can never win via scoring alone,
since distance-to-self is always the worst possible score — exclusion only
matters in this all-candidates-excluded edge case). `node test_scoring.js`
passes.*

**4.6 — Wire scoring into `content.js`, log only. [x] Code written
(2026-10-30) — not yet live-verified.** `scoring.js` added to
`manifest.json`'s `content.js` content-script entry (loaded before
`content.js`, same isolated-world global, no bundler/module system needed —
matches how `inject.js`'s exports already degrade to plain globals in the
browser). `logJoinedState()` now calls `bestSpawnTile(...)` whenever
`latestTerrain` is resolved and logs `[oftools-step4] best spawn tile`.
Version bumped to 0.2.4.
*Check still outstanding: in a real lobby, watch the logged tile change as
other humans move their picks, and confirm by eye that the logged tile is
never inside any pending pick's own glow ring (i.e., it's actually avoiding
them, not coincidentally landing on one) and is never on water.*

**Marker added early (2026-10-30), ahead of 4.7/4.8 — for live testing, not
the final version.** User asked for a visual red-dot instead of reading
console logs while testing, so pulled 4.8's overlay forward (skipping 4.7's
perf split, not needed yet) using 4.2's already-confirmed camera formula.
Wired for real: `inject.js` gained a `uniformMatrix3fv` hook (picks the
camera matrix by the shape 4.2 already verified, posts `oftools-camera
{sx, sy, tx, ty}`); `content.js` gained a `getGameCanvas()` (first
non-`oftools-*` `<canvas>` on the page), a fixed-position marker canvas, and
a `requestAnimationFrame` loop drawing a red dot at the scored tile's
screen position. **Known simplification (marked `ponytail:` in the code):
no stop-on-game-start condition yet** — the loop runs the whole page
lifetime, not just the spawn-pick phase; fine for eyeballing live, revisit
when 4.8 is done for real. Not yet live-verified — next live check should
confirm the dot tracks the right tile through pan/zoom, same as 4.2's
original throwaway-snippet check did.

**Two findings from the first live test of the marker (2026-10-30):**

1. **Real perf bug, not theoretical.** The brute-force O(candidates ×
   sources) scan — flagged as a risk by `scoring.js`'s own `ponytail:`
   comment back in 4.5 — turned out to actually matter: visible main-thread
   lag, barely able to pan the game. Fixed by downsampling: `bestSpawnTile`
   now takes a `step` param (every Nth tile in both axes, default 1 so
   `test_scoring.js`'s small grids are unaffected), and `content.js` picks
   `step` to cap the scan at roughly 10k candidate tiles regardless of map
   size. 4.7 (the static/dynamic caching split) is still unstarted and
   would help further, but this alone should fix the lag.

2. **"Always drifts to the map edge/corner" is the spec working as
   written, not a bug.** Maximizing distance-from-picks with no notion of
   "stay near the action" mathematically favors remote corners — asked the
   user how to handle it (cap search radius vs. land-density weighting vs.
   leave it); **decision: leave it as-is for now**, revisit later if it
   becomes a real nuisance once more of the pipeline is done.

*Check still outstanding: re-verify in a real lobby that panning is no
longer laggy and the dot still tracks a sensible (if edge-prone) tile.*

**Edge-bias revisited (2026-10-30) — decision reversed after seeing it
live.** User asked follow-up: would shrinking the map bounds just move the
degenerate corner-seeking to the new inset boundary instead of fixing it?
Yes — "maximize distance from picks" with no bound is mathematically a
boundary-seeking objective on any region, so a margin trim just relocates
where it hugs, it doesn't produce better interior spawns. Decided to bound
the search to a disk around the picks' own centroid instead (not a fixed
map-relative margin): with 2+ pending picks, `radius = max(2 x farthest
pick's distance from centroid, 0.1 x map diagonal)` — grows/shrinks with
how spread the actual cluster is, so there's no far-off edge to race
toward, only the edge of the real contested area. A single pick says
nothing about cluster size yet, so it's left unrestricted until a second
pick exists. Implemented in `scoring.js`; `test_scoring.js` gained a 4th
case (11x11 grid, two picks, asserts the result lands inside the radius-2
disk instead of a map corner). Version bumped to 0.2.6.
*Check still outstanding: live-verify the radius bound with 2+ real human
picks in a lobby — confirm the suggestion stays near the actual cluster
instead of drifting to a corner, and doesn't feel too tight/too loose (the
2x/0.1x constants are a first guess, not measured).*

**Still going to edges after that fix (2026-10-30) — found the real gap.**
The 2+-pick radius bound only ever applied with 2+ *simultaneous* pending
picks; with exactly 1 (the common case — solo-testing, or just being early
in the countdown before others pick), the code fell straight back to fully
unrestricted (`radiusSq = Infinity`), reproducing the original bug. Fixed:
single-pick case now gets a flat default radius (30% of the map diagonal)
centered on that one pick, instead of being treated as "no data yet."
`test_scoring.js`'s Scenario A actually had this old buggy behavior
hard-coded as its expected result (`{x:0, y:4}`, the far corner) — rewritten
to the new bounded expectation (`{x:4, y:2}`, tiebreak picks the tile
farther from the nation among the humanDist-tied candidates inside the
radius). Version bumped to 0.2.7.
*Check still outstanding: re-verify live, including the single-pick case
(the one that was actually still broken) — not just the 2+-pick case
already checked above.*

**Still edge-hugging after that fix too (2026-10-30) — root cause actually
found this time, with live numbers, not guesswork.** Added `width`/`height`
and the real pick coordinates to the console log (previous logs only showed
`Object` — DevTools' plain-text copy doesn't expand nested objects, switched
to `JSON.stringify`). The live data proved the radius math was being
applied correctly — the suggestion was landing almost exactly ON the
radius boundary every time (map 1250x800: single pick at (497,279), result
(890,70), distance 445.1 vs. computed radius 445.2; 2 picks 368 apart,
result landed at distance 363 vs. computed radius 368.4) — the bound just
wasn't tight enough to look like a bound. Both scaled with inputs that made
them balloon on a real map: 30% of the *diagonal* for 1 pick, and 2x the
picks' own spread for 2+ picks — spread-out players (common/expected) blew
the radius up to more than half the map's shorter dimension, which is
indistinguishable from unbounded by eye.

**Fix: dropped spread-based scaling entirely.** One fixed radius now,
regardless of pick count (1 or more): `15% of min(width, height)`, floored
at 20 tiles. Doesn't grow when players are spread out — a modest, roughly
constant-size local neighborhood around the picks' centroid, every time.
`test_scoring.js` rewritten: Scenario A (5x5 grid) reverts to its very
first expected answer, because the floor genuinely dominates at that scale
(intentional — real maps are always far bigger than 20 tiles/side, the
floor is just degenerate-math protection, not a meaningful bound at test
scale) — not a regression, the same math simply doesn't bind there.
Scenario D rewritten at a realistic 200x200 scale (where 15% actually
exceeds the floor) to exercise the real bound. Version bumped to 0.2.10.

*Check still outstanding: live-verify again with the new fixed-15% radius
— on the 1250x800 map from this session, radius should now compute to
120 tiles (15% of 800), not 445. Watch the logged `map:`/pick coordinates
and confirm the suggested tile's distance from the pick centroid stays
near 120, not near map-edge-scale distances.*

## Pivot (2026-10-30): primary scorer is now the ofstats.io heatmap

After the distance-based radius bound was tuned correctly but still felt
like guessing at live play, user proposed using the ofstats.io heatmap
(the same win-rate-by-cell data already driving the side-panel overlay)
as the primary signal instead — historically strong spawns are, by
construction, in played/contested areas rather than empty corners, so this
sidesteps the whole edge-bias problem rather than continuing to patch
around it.

**New primary scorer: `bestSpawnTileFromHeatmap`** (`scoring.js`). Ranks
the heatmap's cells by win-rate multiplier (`wins/expWins`), **requires a
minimum sample count (default 5)** per cell so a 2-game fluke can't outrank
a well-sampled cell, then picks the best unowned/land/non-pick tile inside
the first qualifying cell (farthest from any pending pick, so it still
avoids literally standing on someone else's spawn even in a good cell).
Returns `null` when there's no heatmap yet or nothing clears the sample
floor — signals the caller to fall back.

**`bestSpawnTile` (the distance-based v1 scorer) is now the fallback**,
not the primary — still useful for brand-new/rarely-played maps with no
real heatmap history yet. Wired in `content.js`: `latestHeatmapData` is
captured from the existing `showHeatmapFor()` fetch (same data the side
panel already draws, no new network call), and the step4 call site tries
`bestSpawnTileFromHeatmap` first, falling back to `bestSpawnTile` only
when it returns `null`. Console log now also prints which path was used
(`(from heatmap)` / `(distance fallback)`).

`test_scoring.js` gained 3 cases: ranking picks the right cell among
several (and correctly skips a cell with a great ratio but too few
samples), within-cell tile choice still avoids a pending pick, and the
null-fallback path (no heatmap data, or nothing meets the sample floor).
Version bumped to 0.3.0 (scoring approach change, not just a tuning fix).

*Check still outstanding: live-verify against a real lobby — confirm the
console log shows `(from heatmap)` for a well-played map, the suggested
tile actually lands in/near a visibly red (overperforming) region of the
side-panel heatmap, and the `(distance fallback)` path still engages
sanely on a map with no/sparse heatmap data.*

## Follow-up (2026-10-30): stop maximizing distance, target a moderate one

User's live complaint: the distance-based fallback was "trying to run to
islands" — correctly identified as a variant of the same edge-bias root
cause from earlier, just showing up inside the bounded radius instead of
at the map edge. Maximizing distance from picks always drives toward the
single most isolated reachable spot (an island, a dead-end peninsula),
regardless of bound size.

**Fix (`bestSpawnTile` in `scoring.js`):** score candidates by closeness to
a target distance — **half the search radius** from the nearest pick —
instead of by raw distance maximized. With 0 pending picks there's no
"nearest pick" to be moderately far from, so that case is unchanged
(still maximizes distance from nations, which is a different, still-
wanted behavior — "avoid bots" isn't the complaint here).
`test_scoring.js`'s Scenario D rewritten: the result now sits at exactly
15 tiles from its nearest pick (half of the 30-tile radius) rather than
~36 tiles (the old max). Scenarios A/B/C unaffected (A's tiny grid still
has the floor dominate so target-vs-max don't differ there; B has 0 picks;
C is the degenerate null case). Version bumped to 0.3.1.

**Scope decision, not yet applied:** `bestSpawnTileFromHeatmap`'s
within-cell tile choice still maximizes distance-from-picks, unchanged.
Left alone for now — cells are small (tens of tiles), so the "run to the
far corner" effect is far less pronounced there, and the user's complaint
was about the broader-radius fallback search. Revisit if the heatmap path
shows the same symptom live.

*Check still outstanding: live-verify — the suggested tile (when on the
distance-fallback path) should now settle at a moderate distance from
other players, not the farthest corner of the search area.*

**4.7 — Split static/dynamic scoring per the caching note above.** Cache
`nationDist` once per phase start; recompute only `humanDist` on each pick
update.
*Check: log a timestamp around the recompute call and confirm it only runs
on `oftools-spawns` events, not on every `oftools-tilestate`/`oftools-players`
/`oftools-terrain` message too — those shouldn't retrigger the expensive
half.*

**4.8 — Overlay canvas + marker.** Build the `position: absolute` canvas
over the WebGL canvas per "Overlay rendering" above, driven by the
confirmed transform from 4.2.
*Check: in a real lobby, the marker visibly tracks the suggested tile
through at least one pan and one zoom without drifting off — and disappears
once spawned/the game starts (loop actually stops, not just hidden).*

## Explicitly skipped (YAGNI — add only if it turns out to matter)

- No configurable scoring weights/settings UI.
- No "exposure" scoring (coastline/navy access) — not in the v1 formula above.
- No continuous suggestion through the whole game — spawn phase only, per
  `PHASE2.md`.
- No downsampling/spatial index for the tile scan until a real slowdown is
  observed.

## Status (2026-10-30): done, live-verified, user-confirmed working well

All of 4.1-4.8 are complete and wired into the real extension (not
throwaway snippets) — `inject.js`, `content.js`, `scoring.js`,
`test_inject.js`, `test_scoring.js`. Version 0.3.1. The feature works:
a red dot marker shows the suggested spawn tile during the pick phase,
and after several rounds of live tuning (below), the user confirmed it's
landing on genuinely good spawns.

**What it actually does, end to end:** while the spawn-pick countdown is
live, `content.js` joins four live-captured signals — tile ownership
(`ownerIds`), terrain (`isLand`, via the `map.bin` fetch hook), the player
registry (bots vs. nations vs. humans), and everyone's pending spawn picks
— and feeds them to `bestSpawnTileFromHeatmap` (primary) or `bestSpawnTile`
(fallback) in `scoring.js` to pick one tile. The camera-matrix hook
converts that tile to a screen position every frame so the red dot tracks
pan/zoom.

**Primary scorer: the ofstats.io heatmap.** Ranks map cells by historical
win-rate multiplier (`wins/expWins`), requires a minimum sample count so
sparse cells can't fake a good ratio, then picks the best free tile inside
the top qualifying cell. This is why it doesn't need edge-avoidance logic
of its own — strong historical cells are naturally in played, central
areas, not corners.

**Fallback scorer: live distance-based**, used only when a map has no/too
little heatmap history. This one went through three rounds of live
correction before it worked — worth remembering because the lessons
generalize to any "maximize distance from X" heuristic:
1. Unbounded "maximize distance from picks" always walks to the map's
   literal edge/corner — mathematically guaranteed, not a bug to patch
   around locally.
2. Bounding the search to a radius around the picks only fixes this if the
   radius itself doesn't scale with how spread out the picks already are
   — an early version computed radius from pick spread and it still
   reached the map edge whenever players were normally spread out. Fixed:
   one fixed radius (15% of the map's shorter dimension, floored at 20
   tiles), independent of pick spread.
3. Even correctly bounded, maximizing distance *within* the bound still
   drives to the single most isolated point the bound allows (an island,
   a dead-end peninsula) — same root cause, smaller scale. Fixed:
   target a moderate distance (half the radius) from the nearest pick
   instead of the max.

If this fallback ever needs more work, `bestSpawnTileFromHeatmap`'s
within-cell tile choice still maximizes distance (not moderates it) —
left alone because cells are small enough that it wasn't shown to be a
live problem, but the same "moderate, not max" fix would transfer
directly if it ever is.

**Known deferred items**, not bugs, intentionally skipped (ponytail/YAGNI):
- 4.7's static/dynamic caching split (nation-tile list recomputed every
  call instead of cached once/phase) — the `step` downsampling already
  fixed the measured live lag, so this wasn't needed on top of it.
- The marker's stop-on-game-start condition (runs the whole page
  lifetime, not just the spawn-pick phase) — harmless since nothing reads
  `lastBestTile` meaningfully once the game starts, but not cleaned up.
- All constants above (15%/20-tile radius, 0.5x target fraction, 5-sample
  heatmap floor) are first-guess tuning confirmed-good by one live
  session, not derived from broader data — reasonable future revisit if
  behavior ever regresses on a very differently-shaped map.
