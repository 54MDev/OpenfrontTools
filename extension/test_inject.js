// Plain-node assert self-check for inject.js's pure decode logic — no
// framework, run with `node extension/test_inject.js`.
const assert = require("assert");
const { decodeOwnerIds, decodePicks, decodeTerrain, decodePlayers } = require("./inject.js");

// ownerID = low 12 bits; fallout (bit 13) / defense (bit 14) must be dropped.
{
  const raw = new Uint16Array([0, 3, (1 << 13) | 7, 0xfff, 0xffff]);
  assert.deepStrictEqual(
    Array.from(decodeOwnerIds(raw)),
    [0, 3, 7, 0xfff, 0xfff],
  );
}

// Pick buffer: flat [x, y, radius, kind, r, g, b] per instance.
{
  const f = new Float32Array([1076, 330, 10, 0, 0.64, 0.9, 0.21, 5, 6, 10, 1, 0.1, 0.2, 0.3]);
  const picks = decodePicks(f);
  assert.strictEqual(picks.length, 2);
  const fr = Math.fround;
  assert.deepStrictEqual(picks[0], {
    x: 1076, y: 330, radius: 10, kind: 0, r: fr(0.64), g: fr(0.9), b: fr(0.21),
  });
  assert.strictEqual(picks[1].kind, 1);
  assert.throws(() => decodePicks(new Float32Array([1, 2, 3])));
}

// Terrain: bit 7 = land, magnitude 31 (bits 0-4) = impassable even if land.
{
  const bytes = new Uint8Array([
    0x00, // water, magnitude 0
    0x80, // land, magnitude 0
    0x9f, // land, magnitude 31 -> impassable, excluded
    0x1f, // water, magnitude 31 -> still water
  ]);
  assert.deepStrictEqual(Array.from(decodeTerrain(bytes)), [0, 1, 0, 0]);
}

// Player registry: only GameUpdateType.Player (key "2") entries, across ticks.
{
  const gameUpdates = [
    { updates: { 2: [{ smallID: 1, playerType: "HUMAN", name: "A" }] } },
    { updates: { 0: [{ foo: "ignored" }] } },
    { updates: { 2: [{ smallID: 3, playerType: "NATION", name: "US", nationFlag: "us" }] } },
  ];
  const players = decodePlayers(gameUpdates);
  assert.strictEqual(players.length, 2);
  assert.strictEqual(players[0].smallID, 1);
  assert.strictEqual(players[1].playerType, "NATION");
}

console.log("inject.js decode self-check: OK");
