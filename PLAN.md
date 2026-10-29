# OpenFront Spawn Heatmap Overlay — Plan

Browser extension that overlays ofstats.io's spawn heatmaps directly on openfront.io, in a small top-right panel, matched to the map you're currently in.

## Idea

- Content script runs on `openfront.io`.
- Detects the current map.
- Fetches the matching heatmap from `ofstats.io`.
- Renders it in a small fixed overlay (top-right corner), toggleable/collapsible.

## Pieces

1. **Map detection** — read current map name from the page (URL param, lobby DOM text, or a global game-state object OpenFront exposes). *Needs verifying by inspecting the live page.*
2. **Heatmap fetch** — determine how ofstats.io serves heatmaps:
   - Static image per map (e.g. `/heatmaps/<slug>.png`) → easy, just `<img>` it.
   - JSON/data-driven, rendered client-side → fetch the JSON, draw with `<canvas>`.
   *Needs verifying via their network requests.*
3. **Overlay UI** — plain `div`, `position: fixed; top:0; right:0`, image or canvas, collapse toggle. No framework.
4. **Manifest (MV3)** — `content_scripts` matched to `openfront.io`, `host_permissions` for `ofstats.io` (avoids CORS issues that page-context fetch would hit).
5. **Caching** — heatmaps are static per map, so cache in `chrome.storage.local` or just rely on HTTP cache. Nothing fancier needed.

## Investigation findings (2026-10-29)

**OpenFront (openfront.io)** — open source: github.com/openfrontio/OpenFrontIO.

- Map identity is `GameMapType`, a plain enum (`GameConfig.gameMap`), e.g. `"blacksea"`, `"gatewaytotheatlantic"`, `"world"` — slugs confirmed lowercase, no separators, straight from OpenFront's own CDN asset manifest (`maps/<slug>/thumbnail.webp`, `manifest.json`, etc. on `cdn.ofedge.io`).
- **No URL-based map name.** Once a game starts, the URL is just `openfront.io/game/<gameID>` — the map isn't in the URL, hash, or page title.
- **No debug global.** `ClientGameRunner.ts` keeps `lobbyConfig`/`gameConfig` as closures — nothing is attached to `window`, so a content script can't just read it off the page's JS state in the isolated world. (A `"world": "MAIN"` content script still wouldn't help — the data's module-scoped, not exposed.)
- **DOM scrape confirmed, two selectors needed — host flow and join flow render the map name differently:**
  - **Hosting** (tested live with Playwright on the Create Lobby screen): `#page-host-lobby [role="button"][aria-selected="true"]` → `aria-label` attribute, e.g. `aria-label="World"`.
  - **Joining someone else's lobby** (confirmed by reading `JoinLobbyModal.ts`'s `renderGameConfig()` directly — the live public-lobby list never actually loaded in the automated browser session, so source was the faster and more authoritative check anyway): `[data-test-map-preview] img` → `alt` attribute. Both ultimately come from the same internal `getMapName(gameConfig.gameMap)` call, so the string format matches between the two (and matches what ofstats.io's API wants).
  - Both are semantic attributes (`aria-label`, `alt`, a `data-test-*` hook) rather than Tailwind utility classes, so they're reasonably stable against styling changes.
  - Plan: content script tries the host selector, falls back to the join selector, and if neither matches just skips showing the overlay (no hard failure) — then caches whichever name it found (in-memory/`sessionStorage`) and drives the overlay off that cached value through gameplay, since the in-game URL/state doesn't carry the map name (per above).

**ofstats.io** — sits behind Cloudflare's JS bot-challenge; plain `curl`/non-browser fetches get a challenge page, not content. It's also a client-rendered SPA (the HTML body is essentially empty until its JS runs and fetches data). Confirmed with Playwright (real headful Chromium — Cloudflare blocks headless/non-browser requests, so this step needed an actual browser):

- **Real heatmap API, confirmed working:**
  `GET https://api.ofstats.io/maps/{mapName}/heatmap?mode=ffa`
  - `mode` ∈ `ffa` | `team` | `all`.
  - `{mapName}` is the **human display name**, not OpenFront's internal slug — e.g. `World`, `Black Sea`, `Europe Classic`. Must be `encodeURIComponent`-ed in the URL (`Europe Classic` → `Europe%20Classic`), not passed as a literal space.
  - Response: JSON grid, not an image — `{ mapWidth, mapHeight, gridWidth, gridHeight, cellSize, totalSpawns, totalGames, cells: [{x, y, count, wins, expWins}, ...] }`. Render with `<canvas>`, not `<img>`.
  - **Mapping needed:** OpenFront's `GameMapType` enum uses lowercase-no-space slugs (`blacksea`, `europeclassic`); ofstats.io uses spaced display names (`Black Sea`, `Europe Classic`). Extension needs a small slug → display-name lookup table (not a derivable 1:1 transform — can pull the full list from `GET https://api.ofstats.io/maps`, which also conveniently returns display names + play-count stats).
    *(Superseded below — the DOM scrape findings came after this and fixed it: `aria-label`/`alt` hand back the display name directly, so no lookup table is actually needed. See `BUILD_PLAN.md`, which is the current source of truth.)*
  - `GET https://api.ofstats.io/maps/{mapName}` (no `/heatmap`) returns general map stats + recent games — not needed for the overlay, but there if useful later.
- **Thumbnails** (not heatmaps, but confirms slug-vs-name split): `https://ofstats.io/maps/thumbs/{lowercaseSlug}.webp?v=<hash>` — these *do* use OpenFront's own lowercase slug.
- **CORS: confirmed wide open.** `api.ofstats.io` sends `Access-Control-Allow-Origin: *` (verified via Playwright at the raw network level). A content script on `openfront.io` can `fetch()` it directly — no `host_permissions`/background-script workaround needed, no manifest complexity for this.

## Remaining unknowns before building

- [ ] ofstats.io ToS/robots.txt stance on hitting their API directly from an extension — if restrictive, ask them first.

Map-detection and heatmap-fetch are both now fully resolved (selectors + API confirmed). This is the only open item left.

## Non-goals (for now)

- No build system/bundler/framework — raw manifest + content script + CSS is enough for this size.
- No settings UI beyond a simple toggle, unless it turns out to be needed.
- No bundling multiple heatmap types/filters until the basic overlay works.

## Next step

Inspect openfront.io (map-name source) and ofstats.io (heatmap asset shape) before writing any extension code.
