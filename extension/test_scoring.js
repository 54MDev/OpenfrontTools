// Plain-node assert self-check for scoring.js's pure bestSpawnTile — no
// framework, run with `node extension/test_scoring.js`.
const assert = require("assert");
const { bestSpawnTile, bestSpawnTileFromHeatmap } = require("./scoring.js");

// Scenario A: 5x5 grid, nation at (0,0), water at (4,4), one human pick at
// (4,0). The radius bound is 15% of min(width,height), floored at 20 tiles
// — on a grid this tiny the 20-tile floor always wins (0.15*5 = 0.75), so
// this case is effectively unrestricted, same as having 0 picks. That's
// intentional, not a gap: real OpenFront maps are always far larger than
// 20 tiles per side, so the floor only exists to keep the math sane on a
// degenerate grid like this test one, never to meaningfully bound a real
// map. A human avoiding both the nation and the pick would spawn as far
// from the pick as possible, on land, unowned — the opposite corner (0,4).
{
  const width = 5, height = 5;
  const ownerIds = new Uint16Array(width * height); // all 0 (unowned) by default
  ownerIds[0] = 1; // (0,0) owned by nation smallID 1
  const isLand = new Uint8Array(width * height).fill(1);
  isLand[4 * width + 4] = 0; // (4,4) water
  const playersByID = new Map([[1, { playerType: "NATION" }]]);
  const picks = [{ x: 4, y: 0, radius: 1, kind: 1, r: 0, g: 0, b: 0 }];

  const result = bestSpawnTile(ownerIds, isLand, width, height, playersByID, picks);
  assert.deepStrictEqual(result, { x: 0, y: 4 });
}

// Scenario B: 3x3 grid, no pending picks at all — humanDist ties (Infinity)
// across every candidate, so the nation-distance tiebreak alone decides.
// Nation at (0,0); farthest tile is the opposite corner (2,2).
{
  const width = 3, height = 3;
  const ownerIds = new Uint16Array(width * height);
  ownerIds[0] = 1; // (0,0) owned by nation
  const isLand = new Uint8Array(width * height).fill(1);
  const playersByID = new Map([[1, { playerType: "NATION" }]]);
  const picks = [];

  const result = bestSpawnTile(ownerIds, isLand, width, height, playersByID, picks);
  assert.deepStrictEqual(result, { x: 2, y: 2 });
}

// Exclusion of a pick's own tile only ever changes the result in the
// degenerate case where it's the sole candidate — distance-to-self is
// always the worst possible score, so it can never "win" otherwise. 1x1
// grid, the only land/unowned tile is exactly where the pick sits:
// no safe candidate exists, so the result must be null, not that tile.
{
  const width = 1, height = 1;
  const ownerIds = new Uint16Array(width * height);
  const isLand = new Uint8Array(width * height).fill(1);
  const playersByID = new Map();
  const picks = [{ x: 0, y: 0, radius: 1, kind: 0, r: 0, g: 0, b: 0 }];
  const result = bestSpawnTile(ownerIds, isLand, width, height, playersByID, picks);
  assert.strictEqual(result, null);
}

// Scenario D: 200x200 grid (large enough that the 20-tile floor doesn't
// dominate — min(200,200)*0.15 = 30), no nations, two picks 40 tiles apart
// at (80,100) and (120,100) — centroid (100,100), radius 30, target distance
// 15 (half the radius). The result should sit near 15 tiles from its
// nearest pick, not run all the way to the far edge of the search disk —
// that was the live complaint ("trying to run to islands" instead of
// playing a moderate, contested spot). The exact-distance-15 point closest
// to the top of the scan order is (80,85): 15 tiles from pick (80,100)
// (dx=0,dy=-15), also 25 from the centroid (within the radius-30 bound).
{
  const width = 200, height = 200;
  const ownerIds = new Uint16Array(width * height);
  const isLand = new Uint8Array(width * height).fill(1);
  const playersByID = new Map();
  const picks = [
    { x: 80, y: 100, radius: 1, kind: 1, r: 0, g: 0, b: 0 },
    { x: 120, y: 100, radius: 1, kind: 0, r: 0, g: 0, b: 0 },
  ];

  const result = bestSpawnTile(ownerIds, isLand, width, height, playersByID, picks);
  const distFromCenter = Math.hypot(result.x - 100, result.y - 100);
  const distFromNearestPick = Math.min(
    Math.hypot(result.x - 80, result.y - 100),
    Math.hypot(result.x - 120, result.y - 100),
  );
  assert.ok(distFromCenter <= 30 + 1e-9, `expected within radius 30, got ${distFromCenter}`);
  assert.ok(
    Math.abs(distFromNearestPick - 15) < 1e-9,
    `expected ~15 tiles from nearest pick (moderate, not max), got ${distFromNearestPick}`,
  );
  assert.deepStrictEqual(result, { x: 80, y: 85 });
}

// Scenario E (bestSpawnTileFromHeatmap): 10x10 grid, cellSize 5 -> four 5x5
// cells. Cell (1,0) overperforms most (multiplier 1.6) among cells with
// enough samples; cell (0,1) has a higher raw multiplier (5x) but only 2
// samples, below the minSamples floor (5) — must be skipped as noise, not
// trusted just because the ratio looks good. No pending picks, so within
// the winning cell the first scanned valid tile (5,0) is the answer.
{
  const width = 10, height = 10;
  const ownerIds = new Uint16Array(width * height);
  const isLand = new Uint8Array(width * height).fill(1);
  const heatmap = {
    cellSize: 5,
    cells: [
      { x: 0, y: 0, count: 10, wins: 4, expWins: 5 }, // multiplier 0.8
      { x: 1, y: 0, count: 10, wins: 8, expWins: 5 }, // multiplier 1.6 — winner
      { x: 0, y: 1, count: 2, wins: 5, expWins: 1 }, // multiplier 5, but count < minSamples
      { x: 1, y: 1, count: 10, wins: 5, expWins: 5 }, // multiplier 1.0
    ],
  };

  const result = bestSpawnTileFromHeatmap(ownerIds, isLand, width, height, [], heatmap);
  assert.deepStrictEqual(result, { x: 5, y: 0 });
}

// Within the winning cell, still avoid landing on a pending pick — prefers
// the farthest unowned/land tile in the cell from any pick, not just the
// first one scanned.
{
  const width = 10, height = 10;
  const ownerIds = new Uint16Array(width * height);
  const isLand = new Uint8Array(width * height).fill(1);
  const heatmap = {
    cellSize: 5,
    cells: [{ x: 1, y: 0, count: 10, wins: 8, expWins: 5 }],
  };
  const picks = [{ x: 5, y: 0, radius: 1, kind: 1, r: 0, g: 0, b: 0 }];

  const result = bestSpawnTileFromHeatmap(ownerIds, isLand, width, height, picks, heatmap);
  assert.deepStrictEqual(result, { x: 9, y: 4 });
}

// No heatmap data (or nothing meets the sample floor) -> null, so the
// caller knows to fall back to the distance-based bestSpawnTile.
{
  const width = 10, height = 10;
  const ownerIds = new Uint16Array(width * height);
  const isLand = new Uint8Array(width * height).fill(1);
  assert.strictEqual(
    bestSpawnTileFromHeatmap(ownerIds, isLand, width, height, [], null),
    null,
  );
  assert.strictEqual(
    bestSpawnTileFromHeatmap(ownerIds, isLand, width, height, [], {
      cellSize: 5,
      cells: [{ x: 0, y: 0, count: 1, wins: 1, expWins: 0.5 }],
    }),
    null,
  );
}

console.log("scoring.js self-check: OK");
