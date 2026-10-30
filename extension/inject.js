// Runs in the page's own JS world (world: "MAIN"), before OpenFront's bundle
// executes. Patches the exact browser APIs ground-truth game state crosses,
// decodes it, and hands it to content.js (isolated world) via postMessage.
// See PHASE2.md for the reverse-engineering behind each hook.
//
// Decode functions are pulled out as pure functions (no DOM/WebGL) so they
// can run under plain Node in test_inject.js, without a real GL context.

function decodeOwnerIds(raw) {
  // raw: Uint16Array view of the R16UI tile grid. ownerID = low 12 bits
  // (TileCodec.ts) — fallout/defense bits are dropped, unused by scoring.
  const ownerIds = new Uint16Array(raw.length);
  for (let i = 0; i < raw.length; i++) ownerIds[i] = raw[i] & 0xfff;
  return ownerIds;
}

function decodePicks(f) {
  // f: Float32Array, flat [x, y, radius, kind, r, g, b] per instance.
  if (f.length % 7 !== 0) throw new Error("pick buffer not a multiple of 7");
  const picks = [];
  for (let i = 0; i < f.length; i += 7) {
    picks.push({
      x: f[i],
      y: f[i + 1],
      radius: f[i + 2],
      kind: f[i + 3], // 0 = enemy, 1 = self, 2 = teammate
      r: f[i + 4],
      g: f[i + 5],
      b: f[i + 6],
    });
  }
  return picks;
}

function decodePlayers(gameUpdates) {
  const players = [];
  for (const tick of gameUpdates) {
    const playerUpdates = tick.updates?.[2]; // GameUpdateType.Player
    if (!playerUpdates) continue;
    for (const p of playerUpdates) {
      players.push({
        smallID: p.smallID,
        playerType: p.playerType, // "HUMAN" | "NATION" | "BOT"
        name: p.name,
        nationFlag: p.nationFlag,
        clientID: p.clientID,
      });
    }
  }
  return players;
}

if (typeof window !== "undefined") {
  (() => {
    const GL = WebGL2RenderingContext.prototype;
    const R16UI = 33332;

    function post(type, payload) {
      window.postMessage({ source: "oftools-inject", type, ...payload }, "*");
    }

    // --- 1. Tile ownership texture ---------------------------------------
    // tileTex and trailTex are both R16UI/mapW×mapH, created back-to-back;
    // a 3rd lookalike (prevTileTex) shows up later via a GPU blit, never
    // through texSubImage2D, so it never reaches this hook. Call order is
    // the only reliable signal: 1st = tileTex, 2nd = trailTex, ignore later.
    let mapTexOrder = 0;
    let tileTex = null;
    let tileTexSize = null; // {width, height}

    const origTexImage2D = GL.texImage2D;
    GL.texImage2D = function (...args) {
      const result = origTexImage2D.apply(this, args);
      try {
        const [, , internalFormat, width, height] = args;
        if (internalFormat === R16UI && width > 1 && height > 1) {
          if (mapTexOrder === 0) {
            tileTex = this.getParameter(this.TEXTURE_BINDING_2D);
            tileTexSize = { width, height };
          }
          mapTexOrder++;
        }
      } catch (e) {}
      return result;
    };

    const origTexSubImage2D = GL.texSubImage2D;
    GL.texSubImage2D = function (...args) {
      try {
        const bound = this.getParameter(this.TEXTURE_BINDING_2D);
        if (bound === tileTex && tileTexSize) {
          const srcData = args[8];
          if (srcData && srcData.buffer) {
            const raw = new Uint16Array(
              srcData.buffer,
              srcData.byteOffset,
              srcData.length,
            );
            post("oftools-tilestate", {
              width: tileTexSize.width,
              height: tileTexSize.height,
              ownerIds: decodeOwnerIds(raw),
            });
          }
        }
      } catch (e) {}
      return origTexSubImage2D.apply(this, args);
    };

    // --- 2. Pending spawn picks -------------------------------------------
    // One batched 5-arg bufferSubData call per tick holding all active
    // centers; `length` (element count) is the real signal, not byteLength.
    const origBufferSubData = GL.bufferSubData;
    GL.bufferSubData = function (...args) {
      try {
        if (args.length >= 5) {
          const [, , srcData, srcOffset, length] = args;
          if (
            length > 0 &&
            length % 7 === 0 &&
            length <= 7 * 50 &&
            srcData &&
            srcData.buffer
          ) {
            const f = new Float32Array(
              srcData.buffer,
              srcData.byteOffset + srcOffset * 4,
              length,
            );
            post("oftools-spawns", { picks: decodePicks(f) });
          }
        }
      } catch (e) {}
      return origBufferSubData.apply(this, args);
    };

    // --- 3. Player registry (human/nation/tribe + smallID) -----------------
    const OrigWorker = window.Worker;
    function PatchedWorker(...args) {
      const w = new OrigWorker(...args);
      w.addEventListener("message", (ev) => {
        try {
          const d = ev.data;
          if (!d || !d.gameUpdates) return;
          const players = decodePlayers(d.gameUpdates);
          if (players.length) post("oftools-players", { players });
        } catch (e) {}
      });
      return w;
    }
    PatchedWorker.prototype = OrigWorker.prototype;
    window.Worker = PatchedWorker;
  })();
}

if (typeof module !== "undefined") {
  module.exports = { decodeOwnerIds, decodePicks, decodePlayers };
}
