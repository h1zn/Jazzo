// Checks every classic map in Levels/ and keeps Levels/maps.json, the list
// of maps left out of the menus (desktop and Android alike).
//
//   node tools/check_maps.mjs            check, print the report, update Levels/maps.json
//   node tools/check_maps.mjs --dry      check and print only
//
// It starts serve.py and a headless Chrome (set CHROME to its path if it
// isn't found), loads every level the way the game does, and runs the
// game's own checks (src/jj2/health.js) plus a few of its own:
//   - the level or a tile set it needs can't be loaded
//   - it needs JJ2+ scripts that draw and move its layers (a jumble without)
//   - it draws tiles its tile set doesn't have
// and it points out, for a look (nothing is hidden for it), a level whose
// front layers lay a black blanket over the whole view where it starts.
// In maps.json, `hidden` is yours (edit it by hand: a level key, or a pack as
// "jj2:<pack>:*", with the reason); `found` and `skip` are rewritten here.
// `skip` names the pack files with no playable level left that nothing else
// borrows from: the Android build leaves them out.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DRY = process.argv.includes('--dry');
const PORT = Number(process.env.PORT || 8879);
const DEBUG_PORT = 9463;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findChrome() {
  const tries = [
    process.env.CHROME,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  ];
  return tries.find((p) => p && fs.existsSync(p));
}

const chromePath = findChrome();
if (!chromePath) { console.error('No Chrome or Edge found: set CHROME to its path.'); process.exit(2); }
const server = spawn(process.platform === 'win32' ? 'python' : 'python3', ['serve.py', String(PORT)], { cwd: ROOT, stdio: 'ignore' });
const profile = fs.mkdtempSync(path.join(process.env.TEMP || process.env.TMPDIR || '/tmp', 'check-maps-'));
const chrome = spawn(chromePath, ['--headless=new', `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${profile}`, '--no-first-run', '--mute-audio', 'about:blank'], { stdio: 'ignore' });
const stop = () => { try { chrome.kill(); } catch (e) { /* gone */ } try { server.kill(); } catch (e) { /* gone */ } };
process.on('exit', stop);

let ws = null;
for (let i = 0; i < 60 && !ws; i++) {
  await sleep(250);
  try {
    const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json`)).json();
    const page = list.find((t) => t.type === 'page');
    if (page) ws = new WebSocket(page.webSocketDebuggerUrl);
  } catch (e) { /* not up yet */ }
}
if (!ws) { console.error('Chrome did not start.'); process.exit(2); }
await new Promise((res) => { ws.onopen = res; });
let id = 0; const waiting = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); } };
const send = (method, params = {}) => new Promise((res) => { const n = ++id; waiting.set(n, res); ws.send(JSON.stringify({ id: n, method, params })); });
const evaluate = async (fn) => {
  const r = await send('Runtime.evaluate', { expression: `(${fn})()`, awaitPromise: true, returnByValue: true });
  if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text);
  return r.result.result.value;
};

await send('Page.enable');
await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
for (let i = 0; i < 80; i++) { await sleep(250); if (await evaluate('() => !!window.kip').catch(() => false)) break; }

// In the page: every level of every pack, loaded as the game loads it.
const rows = await evaluate(async () => {
  const cat = await import('/src/jj2/catalog.js');
  const health = await import('/src/jj2/health.js');
  await cat.discoverPacks();
  const out = [];
  for (const def of cat.allJJ2()) {
    const row = { look: null, key: def.key, pack: (def.pack.zip || def.pack.dir || '').replace(/^Levels\//, '').replace(/\/$/, ''), packId: def.pack.id, title: def.title, fault: null, lenders: [] };
    try {
      await def.prepare();
      row.title = def.title;
      // Tiles the tile set doesn't have (a wrong or cut-down set).
      const { file, ts } = def.loaded();
      const first = file.maxTiles - file.anims.length;
      let used = 0; let off = 0;
      for (const w of file.layers[3].tiles || []) {
        const t = w & (file.maxTiles - 1);
        if (!t || t >= first) continue;
        used++;
        if (t >= ts.count) off++;
      }
      if (used && off / used > 0.02) row.fault = `It draws ${Math.round((100 * off) / used)}% of its tiles from beyond its tile set`;
      const cover = health.frontCover(file, ts);
      if (cover.share >= 0.97 && cover.hero && cover.dark && !(def.story && !def.mp)) row.look = 'black front layers cover the whole view where it starts';
    } catch (e) { row.title = def.title; row.fault = String(e.message || e); }
    try { row.lenders = await def.lenders(); } catch (e) { /* no level file to read */ }
    out.push(row);
  }
  return out;
});
stop();
try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* in use */ }

const file = path.join(ROOT, 'Levels', 'maps.json');
let maps = {};
try { maps = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { /* none yet */ }
const hidden = maps.hidden || {};
const byHand = (key) => hidden[key] || hidden[key.replace(/:\d+$/, ':*')];
const found = {};
for (const r of rows) if (r.fault && !byHand(r.key)) found[r.key] = `${r.title}: ${r.fault}`;

// Pack files with nothing left to play, that no playable level borrows from.
const out = (r) => !!r.fault || !!byHand(r.key);
const packs = [...new Set(rows.map((r) => r.pack))];
const lent = new Set(rows.filter((r) => !out(r)).flatMap((r) => r.lenders));
const skip = packs.filter((p) => p && rows.filter((r) => r.pack === p).every(out) && !lent.has(p)).sort();

console.log(`${rows.length} maps checked, ${rows.filter((r) => !out(r)).length} good.`);
for (const r of rows.filter(out)) console.log(`  ${r.key.padEnd(20)} ${String(r.title).slice(0, 30).padEnd(30)} ${byHand(r.key) ? '(hidden by hand) ' : ''}${r.fault || ''}`);
for (const r of rows.filter((q) => q.look && !out(q))) console.log(`  worth a look: ${r.key} ${r.title} - ${r.look}`);
console.log(skip.length ? `Left out of the Android build: ${skip.join(', ')}` : 'Every pack file is still needed.');
if (!DRY) {
  const next = {
    about: maps.about || 'Maps left out of the menus (desktop and Android alike). `hidden` is kept by hand: a level key (jj2:<pack>:<number>) or a whole pack (jj2:<pack>:*), with the reason; delete a line to bring a map back. `found` and `skip` are written by tools/check_maps.mjs.',
    hidden,
    found,
    skip,
  };
  fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`);
  console.log(`Wrote ${path.relative(ROOT, file)}.`);
}
process.exit(0);
