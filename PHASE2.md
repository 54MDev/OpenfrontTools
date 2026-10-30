# Phase 2 — Live Best-Spawn Suggestion

Extends the heatmap overlay (`PLAN.md` / `BUILD_PLAN.md`) with a per-game suggestion:
instead of (or alongside) the historical heatmap, compute the best spawn tile for
*this* lobby from live data — proximity to nations, tribes, waterways, and other
players' pending spawn picks. This fixes the heatmap's self-defeating failure mode:
if everyone using the extension clicks the same historical hot zone, it stops being
a good spot.

**Terminology (confirmed by the user, not guessed):** "nations" and "tribes" are
both AI-controlled, already on the board before spawn picking starts — nations are
the more advanced/dangerous bots, tribes the weaker ones. Neither is a human
"player." Human players are the ones submitting pending spawn picks during the
countdown. Scoring treats these as two different kinds of proximity on purpose: stay
away from nations (dangerous bots), pending-pick proximity is the human-crowding
signal.

## Why this is feasible at all

OpenFront (github.com/openfrontio/OpenFrontIO) renders through WebGL2
(`src/client/render/gl/`) and runs its deterministic sim in a Web Worker. Three
pieces of ground-truth data pass through *standard* browser APIs on their way to
where they're used — not buried in page-closures:

- **Tile ownership** — a packed `R16UI` bitfield per tile (`ownerID` bits 0-11,
  fallout bit 13, defense bonus bit 14 — `TileCodec.ts`), uploaded via
  `texImage2D`/`texSubImage2D`. (Two other `R16UI`/map-sized textures exist —
  `trailTex`, `prevTileTex` — disambiguated by creation order, see checklist.)
- **Pending spawn picks** (the glowing rings) — plain tile-grid-coordinate floats,
  `{x, y, radius, kind, r, g, b}` per instance (`SpawnOverlayPass.ts`), uploaded in
  one batched call per tick via the 5-arg `bufferSubData(target, dstOffset,
  srcData, srcOffset, length)` overload — `length` (in elements) is the real
  signal, not the backing array's byte length.
- **Player registry** (human/nation/tribe, name, flag, `smallID`) — the Worker
  posts `{type: "game_update_batch", gameUpdates: [...]}` to the main thread every
  tick; each tick's `updates` holds `PlayerUpdate` objects
  (`GameUpdateType.Player`) keyed by `smallID`, which is the *same* integer as
  the tile texture's `ownerID` — this is the join key between "who owns this
  tile" and "what kind of player are they."

A script injected into the page's own JS world (MV3 `world: "MAIN"`) can monkey-patch
`WebGL2RenderingContext.prototype.{texImage2D,texSubImage2D,bufferData,bufferSubData}`
and `window.Worker` *before* OpenFront's bundle runs, and read the exact data as it
crosses each API. No pixel sampling, no color decoding, no touching the worker's own
script — numbers straight from the source.

This sidesteps both walls Phase 1 hit: isolated-world separation (fixed by
`world: "MAIN"`) and module-scoped data (fixed by intercepting public browser APIs
instead of reaching into their closures).

## Architecture

```
extension/
  manifest.json       # add a world:"MAIN" content script
  inject.js           # NEW — runs in page world, patches WebGL prototypes +
                       #       window.Worker, posts decoded state via
                       #       window.postMessage
  content.js          # existing isolated-world script — now also listens for
                       #       the posted state, runs scoring, draws suggestion
  overlay.css
```

- `inject.js` (MAIN world): patches the GL methods (tile ownership, pending
  spawn picks) and `window.Worker` (player registry — type/name/flag per
  `smallID`), posts `{type: "oftools-tilestate"}` / `{type: "oftools-spawns"}`
  / `{type: "oftools-players"}` via `window.postMessage` whenever it has a
  fresh decode.
- `content.js` (isolated world, existing file): adds a `message` listener for the
  above, maintains the latest decoded state, joins tile ownerID → player registry
  entry → `{human, nation, tribe}` via `smallID`, and when spawn phase is live,
  runs the scoring function and overlays a marker on the best tile.
- No new permissions needed — `world: "MAIN"` is a content-script property, not a
  host permission.

## Scoring (needs a decision, not just code)

"Best" trades off against itself — closer to water helps navy/trade but also
exposes you; closer to tribes is easy early conquest but risky; closer to other
pending picks avoids... or invites... conflict depending on strategy. Don't hardcode
weights speculatively — start with the simplest defensible version (e.g. maximize
distance from any pending human pick, break ties by distance from tribe/nation
borders) and tune from actually playing with it, not from guessing weights upfront.

## Uncertainty checklist

Go through these against the live game before or during implementation. Check off
what's confirmed; if something's wrong, note what's actually true and adjust the
approach above rather than forcing it.

- [x] **Tile texture identification — format alone is NOT enough, and there's a
      3rd lookalike.** Checked `GpuResources.ts`: `trailTex` is *also* `R16UI`
      at the same `mapW × mapH` size — format+size alone can't tell `tileTex`
      from `trailTex` apart. **Confirmed live**: a real match created exactly
      3 `R16UI`/`mapW×mapH` textures, not 2 — found the 3rd in
      `HeatManager.ts`: `prevTileTex`, a GPU-side snapshot for transition
      detection. Live timing matched source exactly — 2 created at the
      identical timestamp (`tileTex`+`trailTex`, back-to-back in
      `createGPUResources()`), the 3rd slightly later (`prevTileTex`, built
      afterward by `HeatManager`'s own constructor). Importantly,
      `prevTileTex` is updated via a GPU-side blit
      (`blitTileToPrev()`), **not** a CPU `texSubImage2D` call — so it never
      appears in the *ongoing*-upload hook, only at one-time creation. Net
      result: call-order disambiguation (1st = tileTex, 2nd = trailTex) holds
      for live data, 3rd candidate just needs to be ignored/ordered out.
      Resolved via source + live confirmation.
- [x] **Spawn-buffer identification and live capture — confirmed end-to-end.**
      Source: `UnitPass`=4 floats/instance, `StructurePass`=6,
      `StructureLevelPass`=5, nothing else defines a stride at all —
      `SpawnOverlayPass`'s 7-float instance shape is unique. **Correction found
      live**: the real upload isn't a simple 28-byte `bufferSubData` per
      instance — `SpawnOverlayPass.update()` calls the 5-argument overload
      (`target, dstOffset, srcData, srcOffset, length`) once per tick, writing
      *all* active centers in one call against a large preallocated backing
      array; `length` (element count, not bytes) is the real signal, not
      `srcData.byteLength`. Fixed the hook accordingly and got a clean live
      capture from a real 2-human private lobby:
      `x=1076, y=330, radius=10, kind=0 (ENEMY), color=(0.64, 0.90, 0.21)`,
      updating every ~100ms while the opponent's pick was active and before
      the local player spawned — matches `spawn-overlay.vert.glsl`'s own
      layout exactly (`centerX, centerY, quadRadius, kind, r, g, b`). Live
      ownership-tile coordinates, no image analysis. Fully resolved.
- [x] **Nation vs. tribe vs. human lookup — found, and confirmed live.** Not in
      the tile bitfield or in `PlayerPalette.ts`/`Affiliation.ts` as suspected
      — it travels on a **third** channel: the simulation runs inside a Web
      Worker (`GameImpl`, confirmed via stack traces —
      `WorkerClient`/`handleWorkerMessage`), and posts `{type:
      "game_update_batch", gameUpdates: [...]}` messages to the main thread.
      Each tick's `updates` holds `PlayerUpdate` objects (`GameUpdateType.Player
      = 2`) — one per player, confirmed live on tick 1 of a real 2-human match:
      `{playerType: "HUMAN", smallID: 1, name: "AnonLake1", clientID:
      "SHqfsowh", ...}` for the humans, `{playerType: "NATION", smallID: 3,
      name: "United States", nationFlag: "us", clientID: null, ...}` for every
      nation (all ~35 nations present on the World map arrived in this single
      first message). **`smallID` is the exact join key** — it's the same
      integer stored in the tile-ownership bitfield's `ownerID` bits 0-11
      (`TileCodec.ts`), so tile data and this registry link up directly: no
      separate reverse-engineering needed to connect "this tile is owned by
      ID 3" to "ID 3 is the United States, a NATION."
      Caught the same way as the GL data — patch `window.Worker` so every
      worker→main `message` event is inspectable, no need to touch the
      worker's own script. One snag along the way: `gold`/etc. fields are
      `BigInt`, which breaks plain `JSON.stringify` — needs a replacer
      (`(k,v) => typeof v === "bigint" ? v.toString() : v`) when decoding.
      One thing not yet seen in a sample: an explicit `"BOT"` (tribe)
      `playerType` entry — plausible tribes are added via a later message
      (`bots: 400` in game config suggests they may be introduced
      progressively, not all present at tick 1) rather than missing from the
      schema; the enum itself (`PlayerType.Bot`) is confirmed in
      `GameTypes.ts`, so decoding one when it appears is the same code path.
- [x] **Coordinate spaces actually match.** Checked `spawn-overlay.vert.glsl`
      directly — its own comments say it: `aInstance.xy` is documented as
      "Per-instance: centerX, centerY" and the varying that carries it out is
      literally named `vCenter // spawn center (tile coords)`. Same tile-grid
      space as `tileTex`, no camera/world transform needed in between. Resolved
      via source reading.
- [x] **One-shot tile data is enough.** Confirmed directly by the user — nations
      and tribes don't move during the spawn-pick countdown. A single
      tile-texture decode at the start of the spawn phase is sufficient; "no
      further `texSubImage2D` calls" afterward is expected behavior, not a sign
      the hook broke.
- [x] **Injection timing.** Confirmed live with a real Playwright session
      (`page.addInitScript`, the same pre-any-page-script guarantee MV3's
      `world:"MAIN"` + default `document_start` gives a real content script):
      hook installed at ~127ms into page load; the game's first real
      `texImage2D`/`bufferData` calls didn't happen until ~20,900ms (after
      lobby interaction + map load). Hook was active tens of seconds before
      anything it needed to catch — no race.
- [x] **Fair-use line.** User call: okay to proceed. Reasoning — this reads
      state any player can already see on their own screen (territory,
      pending spawn rings), it doesn't modify the game or give actions a
      normal player couldn't take, so it's not treated as hacking/cheating,
      for personal use or if released as an extension.

## Explicitly skipped (YAGNI — add only if it turns out to matter)

- No continuous real-time tracking loop — only decode on upload events, only
  act during the spawn-pick phase.
- No attempt to read unit/structure/trail passes — out of scope, not needed for
  spawn scoring.
- No settings UI for scoring weights until the simple version is proven wrong.

## Status: investigation complete, ready to build

Every checklist item above is resolved and confirmed against a real live session
(private 2-human lobby, World map). Nothing left to investigate — the next session
should go straight to implementation, not more verification. See the verified
reference code below; it's already proven to work against the real game, just
needs restructuring from "dump to `window.__oftools` for manual console
inspection" into "post via `window.postMessage` for `content.js` to consume."

## Appendix: verified reference hooks

These are the exact techniques that worked live, consolidated. `inject.js` should
be built from this shape, not re-derived from scratch.

**1. Tile ownership texture** — identify by creation order (NOT format/size alone —
`trailTex` and `prevTileTex` are both also `R16UI`/`mapW×mapH`; 1st created =
`tileTex`, 2nd = `trailTex`, a 3rd shows up later = `prevTileTex`, ignore it):

```js
const GL = WebGL2RenderingContext.prototype;
const origCreateTexture = GL.createTexture;
const origTexImage2D = GL.texImage2D;
const origTexSubImage2D = GL.texSubImage2D;
const R16UI = 33332;
let mapTexOrder = 0;
let tileTex = null; // the WebGLTexture object for ownerID/fallout/defense data

GL.createTexture = function (...args) {
  const tex = origCreateTexture.apply(this, args);
  tex.__oftoolsCreateOrder = null; // tagged on first matching texImage2D below
  return tex;
};
GL.texImage2D = function (...args) {
  const result = origTexImage2D.apply(this, args);
  try {
    const [, , internalFormat, width, height] = args;
    if (internalFormat === R16UI && width > 1 && height > 1) {
      // `this` isn't the texture object in texImage2D — the bound texture is
      // whatever was last gl.bindTexture()'d. In practice tileTex/trailTex are
      // created back-to-back with data:null (texImage2D called once at
      // creation), so order of *this call* is what matters, not object
      // identity capture here — track via a counter and grab a reference by
      // re-querying the currently bound texture (gl.getParameter(gl.TEXTURE_BINDING_2D)).
      const bound = this.getParameter(this.TEXTURE_BINDING_2D);
      if (mapTexOrder === 0) tileTex = bound; // 1st = tileTex
      mapTexOrder++;
    }
  } catch (e) {}
  return result;
};
GL.texSubImage2D = function (...args) {
  try {
    const bound = this.getParameter(this.TEXTURE_BINDING_2D);
    if (bound === tileTex) {
      // args: (target, level, xoffset, yoffset, width, height, format, type, srcData)
      // srcData (args[8]) is a Uint16Array view of the R16UI tile grid —
      // decode ownerID = value & 0xfff per TileCodec.ts.
    }
  } catch (e) {}
  return origTexSubImage2D.apply(this, args);
};
```

**2. Pending spawn picks** — the real upload is ONE batched 5-arg `bufferSubData`
call per tick, not one call per instance; `length` (element count) is the signal:

```js
const origBufferSubData = GL.bufferSubData;
GL.bufferSubData = function (...args) {
  try {
    if (args.length >= 5) {
      const [, , srcData, srcOffset, length] = args;
      if (length > 0 && length % 7 === 0 && length <= 7 * 50 && srcData && srcData.buffer) {
        const f = new Float32Array(srcData.buffer, srcData.byteOffset + srcOffset * 4, length);
        // f is flat [x,y,radius,kind,r,g,b] × N instances.
        // kind: 0 = enemy, 1 = self, 2 = teammate (spawn-overlay.vert.glsl).
        // x,y are tile-grid coords — same space as tileTex.
      }
    }
  } catch (e) {}
  return origBufferSubData.apply(this, args);
};
```

**3. Player registry (human/nation/tribe + smallID)** — patch `window.Worker` so
every worker→main message is inspectable; look for `gameUpdates[].updates` entries
with `type === 2` (`GameUpdateType.Player`):

```js
const OrigWorker = window.Worker;
function PatchedWorker(...args) {
  const w = new OrigWorker(...args);
  w.addEventListener("message", (ev) => {
    try {
      const d = ev.data;
      if (d && d.gameUpdates) {
        for (const tick of d.gameUpdates) {
          const playerUpdates = tick.updates?.[2]; // GameUpdateType.Player
          if (playerUpdates) {
            for (const p of playerUpdates) {
              // p.smallID, p.playerType ("HUMAN"|"NATION"|"BOT"), p.name,
              // p.nationFlag, p.clientID (null for non-human).
              // smallID is the SAME integer as the tile texture's ownerID.
            }
          }
        }
      }
    } catch (e) {}
  });
  return w;
}
PatchedWorker.prototype = OrigWorker.prototype;
window.Worker = PatchedWorker;
```

Gotcha hit live: `gold`/other numeric fields on `PlayerUpdate` are `BigInt` —
breaks plain `JSON.stringify` anywhere this data gets serialized; not an issue if
`content.js` just reads the fields directly (no stringify needed), but worth
remembering if debugging with `console.log(JSON.stringify(...))` again.

All three hooks install via `page.addInitScript`-equivalent timing
(`world:"MAIN"`, default `document_start`) — confirmed live that the hook is
active ~20 seconds before the game's first relevant GL/Worker activity, no race.

## Suggested build order for the next session

1. Write `inject.js` from the appendix above, cleaned up to actually decode (not
   just log) and `window.postMessage` the three pieces of state to `content.js`.
2. Add a second `content_scripts` entry to `manifest.json` for `inject.js` with
   `"world": "MAIN"` (same `matches` as the existing one).
3. Wire `content.js` to listen for the posted messages, join tile `ownerID` →
   player registry via `smallID`, and `console.log` the joined result first —
   verify against a real lobby before building the scoring/UI on top.
4. Only then: scoring function + overlay marker for the suggested spawn tile.
