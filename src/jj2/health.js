// Is a level fit to play here? The checks that catch a broken map before
// anyone lands in it. scriptNeeds() is sure of itself: the catalog runs it as
// levels load, and a level that fails is left out of the menus.
// frontCover() only raises a doubt (levels often keep their walls' art in a
// front layer): tools/check_maps.mjs reports those for a look, and what is
// really broken goes into Levels/maps.json by hand.

import { VIEW_H, VIEW_W } from '../config.js';
import { tilePixels } from './files.js';

// JJ2+ scripts this game's small interpreter can't stand in for: ones that
// draw the level themselves or rearrange its layers as it runs. Without
// them the level shows layers that were only raw material (textures cut
// into tiles, pieces to be moved into place): a jumble.
const DRAWN = /\b(onDrawLayer\d*|jjTexturedBG|jjLAYER|jjLayers)\b/;

// Why a level with this script can't be shown right, or null.
export function scriptNeeds(text) {
  const code = String(text || '').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
  return DRAWN.test(code) ? 'It needs JJ2+ scripts that draw and move its layers, which this game cannot run' : null;
}

const START_EVENTS = new Set([29, 30, 31, 32]);      // Jazz, Spaz, multiplayer, Lori

// What the layers in front of the play field do to the view where the
// level starts: { share } of the screen they cover with solid tiles (0..1),
// whether the `hero` is under them, and how `dark` those tiles are (true:
// near black). All three together - a black blanket over everything, the
// hero included - is a level with nothing to see (The Zerox Factory).
export function frontCover(file, ts) {
  const none = { share: 0, hero: false, dark: false };
  const sprite = file.layers[3];
  if (!sprite || !sprite.w) return none;
  let start = -1;
  for (let i = 0; i < file.events.length; i++) if (START_EVENTS.has(file.events[i] & 0xff)) { start = i; break; }
  if (start < 0) return none;
  const sx = (start % sprite.w) * 32 + 16; const sy = Math.floor(start / sprite.w) * 32 + 16;
  const cam = {
    x: Math.max(0, Math.min(sprite.w * 32 - VIEW_W, sx - VIEW_W / 2)),
    y: Math.max(0, Math.min(sprite.h * 32 - VIEW_H, sy - VIEW_H / 2)),
  };
  const first = file.maxTiles - file.anims.length;
  const solid = new Map();           // tile id -> its brightness (0-255) if it is solid, else -1
  const px = new Uint8ClampedArray(4096);
  const opaque = (word) => {
    let id = word & (file.maxTiles - 1);
    if (!id) return -1;
    if (id >= first) {
      const a = file.anims[id - first];
      id = a && a.frames.length ? a.frames[0] & (file.maxTiles - 1) : 0;
      if (!id || id >= first) return -1;
    }
    const type = file.tileTypes[id] || 0;
    if (type === 1 || type === 3 || id >= ts.count) return -1;         // translucent, invisible, not there
    if (!solid.has(id)) {
      tilePixels(ts, id, px);
      let n = 0; let sum = 0;
      for (let j = 0; j < 4096; j += 4) if (px[j + 3] > 200) { n++; sum += px[j] + px[j + 1] + px[j + 2]; }
      solid.set(id, n >= 1000 ? sum / n / 3 : -1);
    }
    return solid.get(id);
  };
  const order = file.layerOrder || [0, 1, 2, 3, 4, 5, 6, 7];
  const front = order.slice(0, Math.max(0, order.indexOf(3))).map((i) => file.layers[i]).filter((l) => l && l.used && l.tiles && !l.hidden);
  if (!front.length) return none;
  let cells = 0; let covered = 0; let light = 0; let hero = false;
  const hx = sx - cam.x; const hy = sy - cam.y;
  for (let y = 16; y < VIEW_H; y += 32) {
    for (let x = 16; x < VIEW_W; x += 32) {
      cells++;
      for (const layer of front) {
        // The layer's own place on screen (as src/jj2/view.js draws it).
        const lx = cam.x * layer.speedX + ((VIEW_W - 320) / 2) * (layer.speedX - 1) + layer.offX + x;
        const ly = cam.y * layer.speedY + ((VIEW_H - 200) / 2) * (layer.speedY - 1) + layer.offY + y - (layer.limit ? (VIEW_H - 200) / 2 : 0);
        let tx = Math.floor(lx / 32); let ty = Math.floor(ly / 32);
        if (layer.tileX) tx = ((tx % layer.w) + layer.w) % layer.w;
        if (layer.tileY) ty = ((ty % layer.h) + layer.h) % layer.h;
        if (tx < 0 || ty < 0 || tx >= layer.w || ty >= layer.h) continue;
        const bright = opaque(layer.tiles[ty * layer.w + tx]);
        if (bright < 0) continue;
        covered++; light += bright;
        if (Math.abs(x - hx) <= 16 && Math.abs(y - hy) <= 16) hero = true;
        break;
      }
    }
  }
  return { share: cells ? covered / cells : 0, hero, dark: covered > 0 && light / covered < 24 };
}
