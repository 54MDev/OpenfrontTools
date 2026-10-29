# Build Plan — OpenFront Spawn Heatmap Overlay

Implementation plan, based on the findings in `PLAN.md`. All unknowns are resolved except ofstats.io's ToS stance (non-blocking — ask/check in parallel, doesn't block building).

## Files

Raw MV3 extension, no build step, no framework, no dependencies.

```
extension/
  manifest.json
  content.js
  overlay.css
```

That's it — three files. No bundler, no TypeScript, no React. The whole thing is DOM + fetch + canvas.

## manifest.json

- `manifest_version: 3`
- `content_scripts`: matches `*://openfront.io/*`, runs `content.js` + `overlay.css`
- `host_permissions`: not required (CORS is open on `api.ofstats.io`), but double-check once content.js is actually fetching — add it only if a real run shows a problem
- Icon: reuse/placeholder, doesn't matter for a personal-use extension

## content.js — logic, in order

1. **Map name detection** (poll, since lobby UI mounts after initial page load):
   ```js
   function getCurrentMapName() {
     const hostSel = document.querySelector('#page-host-lobby [role="button"][aria-selected="true"]');
     if (hostSel) return hostSel.getAttribute('aria-label');
     const joinImg = document.querySelector('[data-test-map-preview] img');
     if (joinImg) return joinImg.getAttribute('alt');
     return null;
   }
   ```
   Run this on a `MutationObserver` on `document.body` (lobby UI is injected dynamically) rather than polling with `setInterval` — cheaper and reacts immediately. Debounce it (e.g. 300ms) since lobby re-renders a lot.

2. **Cache the detected name** in a module-level variable once found non-null (per the plan: the in-game URL doesn't carry the map, so once we have it, hold onto it — don't need `sessionStorage`, a page reload starts a new lobby anyway so in-memory is enough).

3. **Fetch heatmap** when the cached name changes:
   ```js
   const url = `https://api.ofstats.io/maps/${encodeURIComponent(mapName)}/heatmap?mode=ffa`;
   fetch(url).then(r => r.json()).then(renderOverlay);
   ```
   Cache the JSON response in a `Map<mapName, data>` in memory — avoids refetching if you requeue the same map.

4. **Render**: a fixed-position `<canvas>` injected into `document.body` (top-right), sized from the response's `gridWidth`/`gridHeight`/`cellSize`. Draw each cell in `cells[]` with opacity/color scaled by `count` (or `wins/expWins` for a win-rate-weighted view — start with raw `count`, it's simpler and is the actual "best spawn" signal).

5. **Toggle**: a small button/corner tab to collapse the overlay. Store collapsed state in `localStorage` (purely cosmetic, fine to lose).

## overlay.css

Fixed-position panel styling only — a bordered box, top:0/right:0, canvas sized to fit, a collapse affordance. Nothing fancy.

## Build order (do in this sequence, verify each step works before moving on)

1. **Map detection only** — content script that just `console.log`s the detected map name as you navigate host/join lobbies. Confirms the selectors hold up in practice (they were checked live/via source, but verify end-to-end once wired into an actual loaded extension).
2. **Fetch + log** — add the heatmap fetch, log the parsed JSON to console. Confirms CORS really is fine from an actual extension content-script context (not just a Playwright page context).
3. **Canvas render** — draw the overlay, static position, no toggle yet. Get the visual right first.
4. **Toggle + polish** — collapse button, maybe a legend/opacity tuning.

## Explicitly skipped (YAGNI — add only if it turns out to matter)

- No options page / settings UI.
- No support for `mode=team`/`mode=all` — `ffa` only to start; add a dropdown later if wanted.
- No persistent cross-session cache (`chrome.storage.local`) — in-memory per-tab-load is enough; heatmap fetches are cheap and infrequent (once per lobby).
- No Firefox/MV2 compat — Chrome MV3 only, since that's what's actually being used.
- No bundler/TS — if this grows past ~300 lines total, reconsider; not expected to.

## Next step

Write `extension/manifest.json` and `extension/content.js` (step 1 of the build order above), load unpacked in Chrome, test against a real lobby.
