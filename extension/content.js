(() => {
  const API_BASE = "https://api.ofstats.io/maps";
  const COLLAPSE_KEY = "oftools-heatmap-collapsed";
  const POS_KEY = "oftools-heatmap-pos"; // {left, top, width}
  const DEFAULT_WIDTH = 260;

  let currentMapName = null;
  const heatmapCache = new Map(); // mapName -> parsed response
  let latestHeatmapData = null; // the active map's heatmap, for step4 scoring below

  // offsetParent is null when the element (or an ancestor) is display:none —
  // OpenFront keeps every "page" mounted in the DOM at all times and just
  // toggles visibility, so a plain querySelector match isn't enough: it'll
  // happily match the default-selected map card on a hidden page.
  function isVisible(el) {
    return !!el && el.offsetParent !== null;
  }

  function getCurrentMapName() {
    const hostSel = document.querySelector(
      '#page-host-lobby [role="button"][aria-selected="true"]',
    );
    if (isVisible(hostSel)) return hostSel.getAttribute("aria-label");

    const joinImg = document.querySelector(
      "#page-join-lobby [data-test-map-preview] img",
    );
    if (isVisible(joinImg)) return joinImg.getAttribute("alt");

    return null;
  }

  function buildOverlay() {
    const saved = JSON.parse(localStorage.getItem(POS_KEY) || "null");

    const root = document.createElement("div");
    root.id = "oftools-heatmap-overlay";
    if (saved?.left != null) {
      root.style.left = `${saved.left}px`;
      root.style.top = `${saved.top}px`;
      root.style.right = "auto";
    }
    if (saved?.width) root.style.width = `${saved.width}px`;

    const header = document.createElement("div");
    header.id = "oftools-heatmap-header";
    const title = document.createElement("span");
    title.id = "oftools-heatmap-title";
    title.textContent = "Spawn heatmap";
    const toggle = document.createElement("button");
    toggle.id = "oftools-heatmap-toggle";
    toggle.type = "button";
    toggle.textContent = "–";
    header.append(title, toggle);

    const canvas = document.createElement("canvas");
    canvas.id = "oftools-heatmap-canvas";

    const legend = document.createElement("div");
    legend.id = "oftools-heatmap-legend";
    legend.innerHTML = `
      <div id="oftools-heatmap-gradient"></div>
      <div id="oftools-heatmap-legend-labels">
        <span>worse than expected</span><span>better than expected</span>
      </div>
    `;

    const status = document.createElement("div");
    status.id = "oftools-heatmap-status";

    root.append(header, canvas, legend, status);
    document.body.appendChild(root);

    const collapsed = localStorage.getItem(COLLAPSE_KEY) === "1";
    if (collapsed) root.classList.add("oftools-collapsed");
    toggle.textContent = collapsed ? "+" : "–";

    toggle.addEventListener("click", () => {
      const isCollapsed = root.classList.toggle("oftools-collapsed");
      toggle.textContent = isCollapsed ? "+" : "–";
      localStorage.setItem(COLLAPSE_KEY, isCollapsed ? "1" : "0");
    });

    makeDraggable(root, header);
    makeResizable(root, canvas);

    return { root, canvas, title, status };
  }

  function savePos(root) {
    const rect = root.getBoundingClientRect();
    localStorage.setItem(
      POS_KEY,
      JSON.stringify({ left: rect.left, top: rect.top, width: rect.width }),
    );
  }

  function makeDraggable(root, handle) {
    handle.addEventListener("pointerdown", (e) => {
      if (e.target.id === "oftools-heatmap-toggle") return;
      const rect = root.getBoundingClientRect();
      const offsetX = e.clientX - rect.left;
      const offsetY = e.clientY - rect.top;
      root.style.right = "auto";
      handle.setPointerCapture(e.pointerId);

      function onMove(ev) {
        root.style.left = `${ev.clientX - offsetX}px`;
        root.style.top = `${ev.clientY - offsetY}px`;
      }
      function onUp() {
        handle.removeEventListener("pointermove", onMove);
        handle.removeEventListener("pointerup", onUp);
        savePos(root);
      }
      handle.addEventListener("pointermove", onMove);
      handle.addEventListener("pointerup", onUp);
    });
  }

  // Native CSS `resize: horizontal` handles the drag handle for free; we
  // just need to redraw the canvas (and keep map aspect ratio) when the
  // container's box actually changes size, and persist the chosen width.
  function makeResizable(root, canvas) {
    let lastData = null;
    const observer = new ResizeObserver(() => {
      if (lastDataFor(root) ) drawHeatmap(canvas, lastDataFor(root));
      savePos(root);
    });
    observer.observe(root);
    root._getLastData = () => lastData;
    root._setLastData = (d) => (lastData = d);
  }

  function lastDataFor(root) {
    return root._getLastData ? root._getLastData() : null;
  }

  let overlayEls = null;
  function getOverlay() {
    if (!overlayEls) overlayEls = buildOverlay();
    return overlayEls;
  }

  // Color encodes win-rate multiplier (wins / expected wins): blue = spawns
  // that underperform their expected win share, red = spawns that
  // overperform. A three-stop scale (blue -> near-white -> red) keeps the
  // 1x midpoint legible instead of blending into a muddy purple. Opacity
  // encodes sample size, with a floor so thin-data cells don't wash out to
  // near-black against the canvas background and a sqrt curve so they're
  // still distinguishable from high-confidence cells.
  const COLD = [30, 90, 255]; // blue, underperforms
  const MID = [240, 240, 240]; // near-white, as expected
  const HOT = [255, 30, 30]; // red, overperforms

  function lerp(a, b, t) {
    return Math.round(a + (b - a) * t);
  }

  function colorForCell(cell, maxCount) {
    const multiplier = cell.expWins > 0 ? cell.wins / cell.expWins : 1;
    const t = Math.max(0, Math.min(1, multiplier / 2)); // 0 = 0x, 0.5 = 1x, 1 = 2x+
    const [from, to, localT] =
      t < 0.5 ? [COLD, MID, t / 0.5] : [MID, HOT, (t - 0.5) / 0.5];
    const r = lerp(from[0], to[0], localT);
    const g = lerp(from[1], to[1], localT);
    const b = lerp(from[2], to[2], localT);
    const alpha = Math.max(0.4, Math.min(0.95, Math.sqrt(cell.count / maxCount)));
    return `rgba(${r}, ${g}, ${b}, ${alpha.toFixed(2)})`;
  }

  function drawHeatmap(canvas, data) {
    const width = canvas.parentElement.clientWidth || DEFAULT_WIDTH;
    const scale = width / data.mapWidth;
    canvas.width = width;
    canvas.height = Math.round(data.mapHeight * scale);

    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (!data.cells.length) return;

    const maxCount = Math.max(...data.cells.map((c) => c.count));
    const cellPx = data.cellSize * scale;

    for (const cell of data.cells) {
      ctx.fillStyle = colorForCell(cell, maxCount);
      ctx.fillRect(cell.x * cellPx, cell.y * cellPx, cellPx, cellPx);
    }
  }

  async function fetchHeatmap(mapName) {
    if (heatmapCache.has(mapName)) return heatmapCache.get(mapName);
    const url = `${API_BASE}/${encodeURIComponent(mapName)}/heatmap?mode=ffa`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`heatmap fetch failed: ${res.status}`);
    const data = await res.json();
    heatmapCache.set(mapName, data);
    return data;
  }

  async function showHeatmapFor(mapName) {
    const { root, canvas, title, status } = getOverlay();
    title.textContent = `Spawn heatmap — ${mapName}`;
    status.textContent = "Loading…";
    try {
      const data = await fetchHeatmap(mapName);
      root._setLastData(data);
      latestHeatmapData = data;
      drawHeatmap(canvas, data);
      status.textContent = data.cells.length
        ? `${data.totalGames} games, ${data.totalSpawns} spawns`
        : "No data for this map yet.";
    } catch (err) {
      status.textContent = "Couldn't load heatmap.";
      console.warn("[oftools-heatmap]", err);
    }
  }

  function checkMap() {
    const mapName = getCurrentMapName();
    if (mapName && mapName !== currentMapName) {
      currentMapName = mapName;
      showHeatmapFor(mapName);
    }
  }

  let debounceTimer = null;
  const observer = new MutationObserver(() => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(checkMap, 300);
  });
  observer.observe(document.body, { childList: true, subtree: true });

  checkMap();

  // --- Phase 2: live best-spawn suggestion (verification step) -----------
  // Listens for the state inject.js (MAIN world) posts, joins tile ownerID
  // -> player registry via smallID, and logs the result. Scoring/overlay
  // comes after this is confirmed against a real lobby — see PHASE2.md.
  let latestTileState = null; // {width, height, ownerIds: Uint16Array}
  let latestTerrain = null; // {width, height, isLand: Uint8Array}
  let terrainCandidates = []; // [Uint8Array] — map.bin fetches not yet matched to tile dims
  let latestPicks = null; // [{x, y, radius, kind, r, g, b}]
  let latestCamera = null; // {sx, sy, tx, ty}
  let lastBestTile = null; // {x, y} | null — drawn by the marker loop below
  const playersByID = new Map(); // smallID -> {playerType, name, nationFlag, clientID}

  function playerFor(ownerId) {
    if (ownerId === 0) return null; // 0 = unowned
    return playersByID.get(ownerId) || null;
  }

  // inject.js can't tell which .bin fetch is the real terrain (it loads
  // before game textures exist, so tileTexSize isn't known yet there) — so
  // it posts every match and we pick one here. The lobby's map-select
  // carousel fetches a .bin per map shown as a thumbnail, not just the one
  // picked, and many maps share the same tile-grid dimensions — so byte
  // length alone can match the wrong map. Always take the MOST RECENT
  // matching candidate, not the first: the real in-game fetch happens last,
  // after the lobby's own prefetching is done, so newest-match-wins self-
  // corrects once the real one arrives, even if an earlier mismatch already
  // resolved something.
  function resolveTerrain() {
    if (!latestTileState) return;
    const expected = latestTileState.width * latestTileState.height;
    for (let i = terrainCandidates.length - 1; i >= 0; i--) {
      if (terrainCandidates[i].length === expected) {
        latestTerrain = {
          width: latestTileState.width,
          height: latestTileState.height,
          isLand: terrainCandidates[i],
        };
        return;
      }
    }
  }

  function logJoinedState() {
    if (!latestTileState) return;
    const counts = { HUMAN: 0, NATION: 0, BOT: 0, unowned: 0, unknown: 0 };
    for (const ownerId of latestTileState.ownerIds) {
      if (ownerId === 0) {
        counts.unowned++;
        continue;
      }
      const player = playerFor(ownerId);
      if (!player) counts.unknown++;
      else counts[player.playerType] = (counts[player.playerType] || 0) + 1;
    }
    console.log("[oftools-phase2] tile ownership by player type", counts);
    console.log(
      "[oftools-phase2] players",
      Array.from(playersByID.values()),
    );
    if (latestPicks) {
      // picks carry kind (0=enemy/1=self/2=teammate) + color, not a smallID
      // — no player join possible here, per PHASE2.md.
      console.log("[oftools-phase2] pending spawn picks", latestPicks);
    }
    if (latestTerrain) {
      let land = 0;
      for (const v of latestTerrain.isLand) if (v) land++;
      console.log("[oftools-phase2] terrain", {
        land,
        water: latestTerrain.isLand.length - land,
      });

      // Prefer the ofstats.io heatmap (real historical win-rate per cell) —
      // naturally avoids edges/corners since good spawns cluster in played
      // areas, not an assumption we have to encode ourselves. Falls back to
      // the live distance-based scan (below) only when there's no heatmap
      // yet, or nothing meets its own sample-size floor.
      const fromHeatmap = bestSpawnTileFromHeatmap(
        latestTileState.ownerIds,
        latestTerrain.isLand,
        latestTileState.width,
        latestTileState.height,
        latestPicks || [],
        latestHeatmapData,
      );

      // Cap the scan at roughly 10k candidate tiles regardless of map size
      // — brute force over every tile was measured too slow live (visible
      // main-thread lag during real play), see scoring.js's own note.
      const step = Math.max(
        1,
        Math.round(Math.sqrt((latestTileState.width * latestTileState.height) / 10000)),
      );
      const best =
        fromHeatmap ||
        bestSpawnTile(
          latestTileState.ownerIds,
          latestTerrain.isLand,
          latestTileState.width,
          latestTileState.height,
          playersByID,
          latestPicks || [],
          step,
        );
      console.log(
        "[oftools-step4] best spawn tile",
        JSON.stringify(best),
        fromHeatmap ? "(from heatmap)" : "(distance fallback)",
        "map:",
        latestTileState.width,
        "x",
        latestTileState.height,
        "picks:",
        JSON.stringify((latestPicks || []).map((p) => [Math.round(p.x), Math.round(p.y)])),
      );
      lastBestTile = best;
    }
  }

  // --- Step 4 marker (quick visual check, ahead of 4.8's real version) ---
  // ponytail: no phase-stop yet (runs the whole page lifetime, not just
  // during spawn pick) — fine for eyeballing the suggestion live; add the
  // stop-on-game-start condition in 4.8 proper.
  function getGameCanvas() {
    for (const c of document.querySelectorAll("canvas")) {
      if (!c.id.startsWith("oftools-")) return c;
    }
    return null;
  }

  let markerCanvas = null;
  function getMarkerCanvas() {
    if (markerCanvas) return markerCanvas;
    markerCanvas = document.createElement("canvas");
    markerCanvas.id = "oftools-marker-canvas";
    markerCanvas.style.position = "fixed";
    markerCanvas.style.pointerEvents = "none";
    markerCanvas.style.zIndex = "9999";
    document.body.appendChild(markerCanvas);
    return markerCanvas;
  }

  // Formula confirmed live in STEP4.md's 4.2 against a real lobby.
  function worldToScreen(worldX, worldY, cam, canvasW, canvasH, dpr) {
    const zoom = (cam.sx * canvasW) / 2;
    const offsetX = -cam.tx / cam.sx;
    const offsetY = -cam.ty / cam.sy;
    return {
      x: (zoom * (worldX - offsetX)) / dpr + canvasW / (2 * dpr),
      y: (zoom * (worldY - offsetY)) / dpr + canvasH / (2 * dpr),
    };
  }

  function drawMarkerLoop() {
    requestAnimationFrame(drawMarkerLoop);
    const gameCanvas = getGameCanvas();
    if (!gameCanvas || !latestCamera || !lastBestTile) return;

    const rect = gameCanvas.getBoundingClientRect();
    const canvas = getMarkerCanvas();
    canvas.style.left = `${rect.left}px`;
    canvas.style.top = `${rect.top}px`;
    canvas.width = rect.width;
    canvas.height = rect.height;

    const dpr = window.devicePixelRatio || 1;
    const pos = worldToScreen(
      lastBestTile.x,
      lastBestTile.y,
      latestCamera,
      gameCanvas.width,
      gameCanvas.height,
      dpr,
    );

    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "red";
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, 6, 0, Math.PI * 2);
    ctx.fill();
  }
  requestAnimationFrame(drawMarkerLoop);

  window.addEventListener("message", (ev) => {
    const d = ev.data;
    if (ev.source !== window || !d || d.source !== "oftools-inject") return;

    if (d.type === "oftools-players") {
      for (const p of d.players) playersByID.set(p.smallID, p);
      logJoinedState();
    } else if (d.type === "oftools-tilestate") {
      latestTileState = { width: d.width, height: d.height, ownerIds: d.ownerIds };
      resolveTerrain();
      logJoinedState();
    } else if (d.type === "oftools-spawns") {
      latestPicks = d.picks;
      logJoinedState();
    } else if (d.type === "oftools-terrain") {
      terrainCandidates.push(d.isLand);
      if (terrainCandidates.length > 10) terrainCandidates.shift();
      resolveTerrain();
      logJoinedState();
    } else if (d.type === "oftools-camera") {
      latestCamera = { sx: d.sx, sy: d.sy, tx: d.tx, ty: d.ty };
    }
  });
})();
