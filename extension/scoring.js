// Pure scoring for step 4 — see STEP4.md "Scoring (v1 — simplest defensible)".
// No DOM/WebGL, runs under plain Node (test_scoring.js), same pattern as
// inject.js's decoders.
//
// Candidate tiles: unowned, land, not already a pending pick's own tile.
// Primary score = distance to nearest pending human pick (bigger = less
// crowded). Tiebreak = distance to nearest nation-owned tile (bigger =
// farther from bots). No blended weight — see STEP4.md for why.
//
// `step` samples every Nth tile in both axes instead of every tile — a real
// lobby's full grid (millions of tiles) times nation-tile count made the
// brute-force O(candidates * sources) scan actually too slow live (visible
// main-thread lag), not just a theoretical risk — this is that downsample,
// not a spatial index, per STEP4.md's own stated fallback order. Defaults
// to 1 (every tile) so the small synthetic grids in test_scoring.js are
// unaffected; the real caller in content.js passes a larger step.
function bestSpawnTile(ownerIds, isLand, width, height, playersByID, picks, step = 1) {
  const nationTiles = [];
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const ownerId = ownerIds[y * width + x];
      if (ownerId === 0) continue;
      const player = playersByID.get(ownerId);
      if (player && player.playerType === "NATION") nationTiles.push([x, y]);
    }
  }

  const pickTiles = picks.map((p) => [Math.round(p.x), Math.round(p.y)]);
  const pickSet = new Set(pickTiles.map(([x, y]) => y * width + x));

  // "Maximize distance from picks" with no bound always walks to the map
  // edge/corner — that's the actual math, not a bug (confirmed live). Bound
  // the search to a disk centered on the picks' centroid instead, so
  // there's no far-off edge to race toward, only the edge of a modest local
  // neighborhood. Fixed radius (15% of the map's SHORTER dimension, floored
  // at 20 tiles for tiny maps), NOT scaled by how spread out the picks
  // already are — an earlier version scaled the radius with pick spread
  // (2x distance-from-centroid) and, live, that still produced a radius
  // large enough to reach the real map edge whenever players were even
  // moderately spread out (confirmed: a live 1250x800 map, picks 368 tiles
  // apart, produced a ~368-tile radius — more than half the map's height).
  // 0 picks: nothing to avoid yet, stays unrestricted.
  let centerX = 0, centerY = 0, radiusSq = Infinity;
  if (pickTiles.length >= 1) {
    centerX = pickTiles.reduce((s, [x]) => s + x, 0) / pickTiles.length;
    centerY = pickTiles.reduce((s, [, y]) => s + y, 0) / pickTiles.length;
    const radius = Math.max(Math.min(width, height) * 0.15, 20);
    radiusSq = radius * radius;
  }

  // Maximizing distance from picks always drives toward the single most
  // isolated spot the search allows — an island, a dead-end peninsula —
  // same root cause as the edge-bias bug, just showing up differently now
  // that the search is bounded. Target a MODERATE distance instead of the
  // max: half the search radius from the nearest pick, not as far as
  // physically possible. With 0 picks there's no "nearest pick" to be a
  // moderate distance from, so this stays `null` and scoring falls back to
  // its original maximize-nationDist behavior (still desirable — avoiding
  // bots isn't the "ran away too far" complaint this is fixing).
  const targetDist = pickTiles.length > 0 ? Math.sqrt(radiusSq) * 0.5 : null;

  let best = null;
  let bestScore = Infinity; // |actual dist to nearest pick - targetDist|, or -nationDist when no picks
  let bestNationDist = -Infinity;

  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const i = y * width + x;
      if (ownerIds[i] !== 0 || !isLand[i] || pickSet.has(i)) continue;
      if ((x - centerX) ** 2 + (y - centerY) ** 2 > radiusSq) continue;

      const nationDist = minDistSq(x, y, nationTiles);
      const score =
        targetDist === null
          ? -nationDist // no picks: lower score = farther from nation = better
          : Math.abs(Math.sqrt(minDistSq(x, y, pickTiles)) - targetDist);

      if (score < bestScore || (score === bestScore && nationDist > bestNationDist)) {
        bestScore = score;
        bestNationDist = nationDist;
        best = { x, y };
      }
    }
  }
  return best;
}
// Primary scorer (v2): rank the ofstats.io heatmap's cells (same data as
// the side-panel overlay — win-rate multiplier = wins/expWins per cell) by
// how much they overperform, require a minimum sample count per cell so a
// 2-game fluke doesn't outrank a well-sampled cell, then pick the best
// unowned/land tile within the first qualifying cell (farthest from any
// pending pick, so you don't land on top of someone even in a good cell).
// Falls back to null (caller should fall back to the distance-based
// bestSpawnTile above) when there's no heatmap data yet or nothing meets
// the sample floor — a brand-new/rarely-played map has no history to use.
function bestSpawnTileFromHeatmap(ownerIds, isLand, width, height, picks, heatmap, minSamples = 5) {
  if (!heatmap || !heatmap.cells || !heatmap.cells.length) return null;

  const pickTiles = picks.map((p) => [Math.round(p.x), Math.round(p.y)]);
  const pickSet = new Set(pickTiles.map(([x, y]) => y * width + x));

  const ranked = heatmap.cells
    .filter((c) => c.count >= minSamples && c.expWins > 0)
    .map((c) => ({ ...c, multiplier: c.wins / c.expWins }))
    .sort((a, b) => b.multiplier - a.multiplier || b.count - a.count);

  const cellSize = heatmap.cellSize;

  for (const cell of ranked) {
    const x0 = cell.x * cellSize;
    const y0 = cell.y * cellSize;
    const x1 = Math.min(x0 + cellSize, width);
    const y1 = Math.min(y0 + cellSize, height);

    let best = null;
    let bestHumanDist = -Infinity;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = y * width + x;
        if (ownerIds[i] !== 0 || !isLand[i] || pickSet.has(i)) continue;
        const humanDist = minDistSq(x, y, pickTiles);
        if (humanDist > bestHumanDist) {
          bestHumanDist = humanDist;
          best = { x, y };
        }
      }
    }
    if (best) return best; // first qualifying cell with any valid tile wins
  }
  return null;
}

function minDistSq(x, y, tiles) {
  if (tiles.length === 0) return Infinity;
  let min = Infinity;
  for (const [tx, ty] of tiles) {
    const dx = x - tx;
    const dy = y - ty;
    const d = dx * dx + dy * dy;
    if (d < min) min = d;
  }
  return min;
}

if (typeof module !== "undefined") {
  module.exports = { bestSpawnTile, bestSpawnTileFromHeatmap };
}
