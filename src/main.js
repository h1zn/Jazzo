// Entry point: fixed-step loop (14 ms ticks, resync after 35 behind, as
// measured) with interpolated rendering, and the screen flow:
// splash (press a key: JJ2's intro film, or the intro track) -> menu ->
// level card -> play
// (pause / clear tally / game over / win) -> high score name -> table,
// the party lobby -> party play, and split screen (two players, one computer).
// Touch screens (and the Android app, android/) play through src/touch.js.

import { buildArt } from './art.js';
import { Audio } from './audio.js';
import { parseJ2V } from './cinematic.js';
import { MAX_CATCHUP_TICKS, TICK_MS, VIEW_H, VIEW_W } from './config.js';
import { Game } from './game.js';
import { PostFX } from './gpu.js';
import { bindKey, connectedPads, defaultKeys, Input } from './input.js';
import { cinematicFile, nextPlayable, songKey } from './jj2/catalog.js';
import { setLang, tr } from './lang.js';
import { LEVELS, levelDef } from './levels.js';
import { localPair, Net, Party } from './party.js';
import { Renderer } from './render.js';
import { addScore, loadSave, recordLevel, saveSlot, scoreRank, touchOptions, writeSave } from './save.js';
import { Screens } from './screens.js';
import { loading } from './sheets.js';
import { Touch } from './touch.js';

const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
// The loading screen (index.html) is up already; its bar fills as the
// game's pictures arrive (about ART_PICTURES of them), and it comes down
// with the first frame drawn (see loop).
const ART_PICTURES = 45;
const report = (part) => { if (window.kipLoading) window.kipLoading(part); };
report(0.12);
loading.listener = (n) => report(Math.min(0.97, 0.12 + (n / ART_PICTURES) * 0.85));
const art = await buildArt();
loading.listener = null;
const audio = new Audio();
let save = loadSave();
const input = new Input(window, save.options.keys);
const game = new Game(audio, art);
const renderer = new Renderer(ctx, art);
const screens = new Screens(ctx, art, audio);
// The touch controls; `touch.native`: running inside the Android app.
const touch = new Touch({ input, screens });
touch.setOptions(touchOptions(save));
screens.native = touch.native;
screens.touch = touch.active;
audio.setVolumes(save.options.music, save.options.sfx);
setLang(save.options.lang);
game.video = save.options.video;
game.quickChange = !!save.options.quickChange;
// Split screen: player 2's game, input and view (made when first needed).
let splitKit = null;        // { game, input, renderer }, made once
let split = null;           // splitKit while two play on one computer

// ---------------------------------------------------------------- video options

// The GPU's canvas (src/gpu.js): shown instead of the 2D one while its
// effects are on, the 2D picture going through its shaders each frame.
const gpuCanvas = document.createElement('canvas');
gpuCanvas.id = 'gpu';
gpuCanvas.setAttribute('aria-label', "Jazzo game screen");
canvas.after(gpuCanvas);
let post = null;              // PostFX once made; false: no WebGL2 here
gpuCanvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); post = false; layout(); });
function gpuOn() {
  if (!save.options.video.gpu) return false;
  if (post === null) post = PostFX.create(gpuCanvas) || false;
  return !!post;
}
// How much glow each setting gives.
const GLOW = { off: 0, low: 0.4, high: 0.8 };
screens.gpuState = () => (gpuOn() ? 'on' : post === false ? 'none' : 'off');

// The render resolution: the game is drawn at 640x360 times this (its
// drawing code works in 640x360 units, scaled up), so lighting, glows and
// text are sharp at 720p, 1080p, 1440p or 4K. AUTO: as many times as the
// screen's own pixels allow: at most 3 (1080p) on a computer; on a phone or
// tablet the screen's full resolution, up to 4K, stepping down a notch if
// the device can't keep the game smooth at it (`autoCap`). The HD smoothing
// upscaler works on the original pixels, so it draws at 1x.
let renderScale = 1;
let autoCap = 6;
// What the video screen reports: the screen's pixels, the picture's, and the picture's place on the screen.
let shown = null;
// `fit`: screen pixels per game pixel, as the picture is shown.
function pickScale(fit) {
  const v = save.options.video;
  if (gpuOn() && v.upscale === 'hd') return 1;
  if (typeof v.res === 'number') return v.res;
  // Whole steps, and never past the screen's own pixels: a picture drawn
  // bigger than the screen comes back down unevenly (a tablet's 2000x1200
  // screen is 3.1 times 640x360; drawn 4 times, every ninth row would go).
  // What's left over, the GPU's sharp upscaler spreads evenly.
  return Math.max(1, Math.min(touch.native || touch.active ? autoCap : 3, Math.floor(fit + 0.02)));
}

// Size the canvas: fill the window at 16:9, or (pixel perfect) the largest
// whole multiple of 640x360 that fits; sharp or smooth scaling.
function layout() {
  const v = save.options.video;
  const dpr = window.devicePixelRatio || 1;
  // The window, in CSS pixels. visualViewport has the exact size: innerHeight
  // is rounded, and a phone's 411.4 rounded up to 412 would make the picture
  // a screen pixel and a half too tall (and scaled, blurring it a little).
  const vv = window.visualViewport;
  const winW = vv && vv.width > 0 ? vv.width : window.innerWidth;
  const winH = vv && vv.height > 0 ? vv.height : window.innerHeight;
  // F3 / F4 shrink and grow the game inside the window.
  const k = Math.min(winW / VIEW_W, winH / VIEW_H) * (v.size || 1);
  // The picture's place on the screen, in the screen's own pixels: a whole
  // number of them, at 16:9, so a 1080p picture takes 1920x1080 of a phone's
  // 2400x1080 and nothing is scaled a second time on its way to the screen.
  // Pixel perfect: a whole number of screen pixels per game pixel (not of
  // CSS pixels, which are 2 or 3 screen pixels on a phone).
  let devH = Math.max(1, Math.floor(VIEW_H * k * dpr + 0.05));
  // The window's size comes in whole CSS pixels (a phone's 411.4 as 411 or
  // 412), so a 1080-pixel screen can come out as 1078 or 1082: within one
  // CSS pixel of a whole number of 360-row steps, it is that.
  const near = Math.round(devH / VIEW_H) * VIEW_H;
  if (near > 0 && Math.abs(devH - near) <= dpr) devH = near;
  if (v.scale === 'pixel' && devH >= VIEW_H) devH = Math.floor(devH / VIEW_H) * VIEW_H;
  const devW = Math.round((devH * VIEW_W) / VIEW_H);
  const cssW = devW / dpr; const cssH = devH / dpr;
  renderScale = pickScale(devH / VIEW_H);
  if (canvas.width !== VIEW_W * renderScale) { canvas.width = VIEW_W * renderScale; canvas.height = VIEW_H * renderScale; }
  const gpu = gpuOn();
  for (const c of [canvas, gpuCanvas]) { c.style.width = `${cssW}px`; c.style.height = `${cssH}px`; }
  canvas.style.display = gpu ? 'none' : 'block';
  gpuCanvas.style.display = gpu ? 'block' : 'none';
  if (gpu) {
    // The screen's own pixels: the final picture is made at full resolution.
    gpuCanvas.width = devW; gpuCanvas.height = devH;
  }
  // Without the GPU the browser scales the canvas itself: crisp pixels as
  // asked, unless the picture is bigger than its place on the screen (crisp
  // scaling would then drop rows here and there; blended keeps them all).
  const shrunk = devW < canvas.width;
  canvas.style.imageRendering = v.filter === 'smooth' || shrunk ? 'auto' : 'pixelated';
  shown = { screen: `${Math.round(winW * dpr)}X${Math.round(winH * dpr)}`, drawn: `${canvas.width}X${canvas.height}`, at: `${devW}X${devH}` };
}
screens.videoInfo = () => shown;
window.addEventListener('resize', layout);
document.addEventListener('fullscreenchange', layout);
layout();

function toggleFullscreen() {
  // The app is always full screen.
  if (touch.native) { audio.play('denied'); screens.say('THE APP ALWAYS FILLS THE SCREEN'); return; }
  const req = document.documentElement.requestFullscreen;
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  else if (req) document.documentElement.requestFullscreen().catch(() => audio.play('denied'));
}
input.onAltEnter = toggleFullscreen;

// F3 / F4: the screen size, in tenths of the window (half to all of it).
function resize(d) {
  const v = save.options.video;
  const size = Math.round(Math.max(0.5, Math.min(1, (v.size || 1) + d * 0.1)) * 10) / 10;
  if (size === v.size) { audio.play('denied'); return; }
  v.size = size;
  layout();
  writeSave(save);
  screens.say(tr('SCREEN SIZE {0}%', Math.round(size * 100)));
}

window.addEventListener('gamepadconnected', () => screens.say('GAMEPAD CONNECTED'));
window.addEventListener('gamepaddisconnected', () => screens.say('GAMEPAD DISCONNECTED'));

game.unlocked = save.unlocked;
game.character = save.character || 'jazz';
game.difficulty = save.difficulty;

let scene = 'splash';
let sceneTime = 0;
let irisTime = 0;
let pendingLevel = null;
let gated = true;          // the splash waits for a key so audio may start
let net = null;            // party connection while in the lobby or a hunt
let cinema = null;         // the films playing: { reels, i, film, next, then }

// Debug handle for playtesting from the browser console.
window.kip = {
  game, input, audio, screens, save,
  go: (s) => go(s),
  scene: () => scene,
  cinema: () => cinema,
  split: () => split,
  touch,
  startSplit: () => startSplit(),
  play: async (index = 0) => {
    const def = levelDef(index);
    if (def.prepare) await def.prepare();
    game.party = null; game.newGame(index); irisTime = 99; go('play');
  },
};

function go(next) {
  if (next !== 'cinema' && cinema) { cinema = null; audio.stopCues(); }
  scene = next;
  sceneTime = 0;
}

function toMenu() {
  leaving = false;
  if (net) { net.close(); net = null; }
  if (split) endSplit();
  game.party = null;
  audio.board(false);
  game.character = save.character || 'jazz';
  screens.sub = null;
  screens.menu = 0;
  go('title');
  audio.startMusic('title');
}

// A game ended (game over, the last level, or quitting): a score good
// enough for the table asks for a name, then shows the table.
let finished = null;        // the game waiting for its high-score name
function endGame() {
  const score = game.score;
  const rank = scoreRank(save, score);
  const def = levelDef(game.levelIndex);
  finished = { score, level: def ? def.title : '', difficulty: game.difficulty, character: game.character };
  toMenu();
  if (rank < 0) { finished = null; return; }
  screens.askName(score, rank, save.lastName || game.character.toUpperCase());
  audio.play('rank');
}

// Open a pause-menu screen from play (F1 help, F5 load, F6 save).
function pauseWith(sub) {
  screens.pauseIndex = 0;
  screens.sub = null;
  screens.levelTitle = levelDef(game.levelIndex).title;
  if (sub) screens.pauseOpen(sub);
  audio.hover(false);
  audio.board(false);
  audio.play('pause');
  go('paused');
}

// Browsers only allow audio after a gesture: the first key or click starts
// it, and JJ2's own intro with it (the Epic logo, then the film, from
// JJ2-Cinematics.zip); without the films, the intro track plays over the
// splash. The menu follows.
const INTRO = [{ name: 'Logo.j2v' }, { name: 'Intro.j2v', song: 'Intro.j2b' }];
const ENDING = [{ name: 'Ending.j2v', song: 'Ending.j2b' }];
function unlock() {
  audio.unlock();
  if (!gated) return;
  gated = false;
  sceneTime = 0;
  playFilms(INTRO, toMenu, () => {
    go('splash');
    audio.startMusic('intro', { restart: true, onEnd: () => { if (scene === 'splash') toMenu(); } });
  });
}

// ---------------------------------------------------------------- cinematics

// The films' sound cues, from Data.j2d (tools/j2a.py cine): per film, a
// list of [frame, sound file, volume 0-64, pan 0-64].
let cueLists = null;
const cueUrl = (file) => `assets/sfx/cine/${file}.wav`;

// A film, its song and its sounds, loaded: { film, song, cues } (film null
// if it isn't there).
async function loadReel(reel) {
  if (!cueLists) cueLists = fetch('assets/cinematics.json').then((r) => r.json()).catch(() => ({}));
  const [bytes, song, lists] = await Promise.all([cinematicFile(reel.name), reel.song ? songKey(reel.song) : null, cueLists]);
  const film = bytes && await parseJ2V(bytes).catch(() => null);
  const cues = (film && lists[reel.name.replace(/\.j2v$/i, '')]) || [];
  await Promise.all(cues.map(([, file]) => audio.load(cueUrl(file))));
  return { film, song, cues };
}

// The film's sounds up to the frame it shows.
function playCues(c) {
  while (c.cue < c.cues.length && c.cues[c.cue][0] <= c.film.shown) {
    const [, file, vol, pan] = c.cues[c.cue++];
    audio.cue(cueUrl(file), vol / 64, (pan - 32) / 32);
  }
}

// Play films one after another, then `then`; any key skips them all.
// `missing` runs instead if the first film isn't there.
function playFilms(reels, then, missing = then) {
  const c = { reels, i: 0, film: null, next: loadReel(reels[0]), then };
  cinema = c;
  audio.stopMusic();
  go('cinema');
  startReel(c, missing);
}

async function startReel(c, missing) {
  const { film, song, cues } = await c.next;
  if (cinema !== c) return;            // skipped while it loaded
  if (!film) { cinema = null; if (c.i === 0) missing(); else c.then(); return; }
  Object.assign(c, { film, cues, cue: 0 });
  c.next = c.i + 1 < c.reels.length ? loadReel(c.reels[c.i + 1]) : null;
  if (song) audio.startMusic(song, { restart: true });
  else audio.stopMusic();
}

function endFilms() {
  const { then } = cinema;
  cinema = null;
  audio.stopMusic();
  audio.stopCues();
  then();
}
window.addEventListener('keydown', unlock);
// Anywhere on the page: on a phone the picture has margins beside it.
window.addEventListener('pointerdown', unlock);

// ---------------------------------------------------------------- back, background

// The app's BACK button (android/): a step back, as Escape; on the main
// menu a second BACK leaves the app (false tells it to).
let exitArmed = -1e9;
window.kipBack = () => {
  if (touch.back()) return true;
  if (performance.now() - exitArmed < 2500) return false;
  exitArmed = performance.now();
  screens.say('PRESS BACK AGAIN TO EXIT');
  return true;
};

// The app went to the background, or the tab was hidden: a game being
// played pauses, held keys and buttons let go, and the sound stops.
let asleep = false;
function background(hidden) {
  if (hidden === asleep) return;
  asleep = hidden;
  if (hidden) {
    input.releaseAll();
    touch.releaseAll();
    if (scene === 'play' && !game.party && game.state === 'play') pauseWith(null);
    audio.sleep(true);
    hostOn(true);
  } else {
    hostOn(false);
    audio.sleep(false);
    last = performance.now();
    acc = 0;
    // The page was asleep, not the connection: give it a moment to speak.
    if (net) net.heard();
  }
}
document.addEventListener('visibilitychange', () => background(document.hidden));
window.kipAppPaused = (paused) => background(!!paused || document.hidden);

// ---------------------------------------------------------------- hosting

// Whether this game is the host of a party (in the lobby, or in play).
function hostingParty() {
  if (!net || net.status !== 'open') return false;
  if (scene === 'play') return !!(game.party && game.party.host);
  return scene === 'title' && screens.sub === 'host' && !!screens.lobby.code;
}

// The host's phone put away (home, the screen off, a call) with a party
// on: hidden, a page stops drawing and its timers slow to a crawl, but the
// others' game needs the host (it grants the pickups, and brings them back
// on its clock). A worker's clock isn't slowed: from there the game is
// ticked on, blind, until the app is back. In the app a hum below hearing
// keeps the page from being frozen outright after five minutes (audio.hum),
// the app itself keeps the phone awake meanwhile (HostService), and the
// others see the host stepped away.
const HIDDEN_TICKER = 'let t=null;onmessage=(e)=>{clearInterval(t);t=null;if(e.data>0)t=setInterval(()=>postMessage(0),e.data);};';
let ticker = null;
function hostOn(away) {
  if (ticker) { ticker.terminate(); ticker = null; }
  const party = scene === 'play' && game.party && game.party.host ? game.party : null;
  if (away && hostingParty()) {
    try {
      ticker = new Worker(URL.createObjectURL(new Blob([HIDDEN_TICKER], { type: 'text/javascript' })));
      ticker.onmessage = () => {
        if (asleep && hostingParty()) advance(performance.now());
        else hostOn(false);
      };
      ticker.postMessage(TICK_MS);
    } catch (e) { ticker = null; }
  }
  if (touch.native) audio.hum(!!ticker);
  if (party && party.idle !== away && (!away || !party.result)) party.stepAway(game, away);
}

// The app shows a notice while this phone hosts (and keeps the phone
// awake for it): told how many are in the game, 0 when hosting ends.
let toldHosting = 0;
function tellHosting() {
  if (!touch.native || !window.KipAndroid.hosting) return;
  let n = 0;
  if (hostingParty()) n = scene === 'play' ? game.party.rivals.size + 1 : (screens.lobby.players || []).length || 1;
  if (n === toldHosting) return;
  toldHosting = n;
  try { window.KipAndroid.hosting(n); } catch (e) { /* an older app */ }
}

// The level card shows while an original JJ2 level's files load.
function showCard(index, fresh) {
  const def = levelDef(index);
  pendingLevel = { index, fresh, ready: !def.prepare };
  game.cardIndex = index;
  const meta = { title: def.title, tip: def.tip, label: def.pack && def.pack.title.toUpperCase(), loading: !!def.prepare };
  game.cardMeta = meta;
  if (def.prepare) {
    // A load that finishes after another card opened only updates its own card.
    const pending = pendingLevel;
    def.prepare().then(() => {
      pending.ready = true;
      meta.loading = false;
      meta.title = def.title;
    }).catch((e) => { meta.error = e.message; meta.loading = false; meta.next = nextPlayable(def.next); meta.title = def.title; });
  }
  audio.stopMusic();
  audio.play('card');
  go('card');
}

// Index from a menu action: built-in levels are numbers, JJ2 levels keys.
const levelKey = (k) => (/^\d+$/.test(k) ? Number(k) : k);

function startPendingLevel() {
  const { index, fresh, saved, continues } = pendingLevel;
  game.party = null;
  game.result = null;
  if (saved) game.loadSaved(saved);
  else if (fresh) game.newGame(index, continues);
  else game.loadLevel(index);
  irisTime = 0;
  go('play');
}

// Load a saved game (from the menu or the pause menu).
function loadSlot(i) {
  const slot = save.slots[i];
  if (!slot) return;
  // A classic level whose files have gone since it was saved.
  if (!levelDef(slot.level)) { audio.play('denied'); screens.say('THAT LEVEL CAN NOT LOAD'); return; }
  game.character = slot.character || game.character;
  showCard(slot.level, false);
  pendingLevel.saved = slot;
}

// ---------------------------------------------------------------- split screen

// Two players on one computer: two games joined like a party hunt, one in
// each half of the screen. Player 1 plays on Keyboard 1 (less any keys of
// Keyboard 2), player 2 on Keyboard 2; gamepads go one each.
async function startSplit() {
  // Two players need two sets of controls: the touch screen is only one.
  if (touch.active && !connectedPads().length && !input.lastKey) { audio.play('denied'); screens.say('SPLIT SCREEN NEEDS A GAMEPAD OR A KEYBOARD'); return; }
  const st = screens.partySettings();
  const index = st.level;
  const def = levelDef(index);
  if (screens.lobby.status === 'loading') return;   // already on its way
  if (def.prepare) {
    screens.lobby.status = 'loading';
    try { await def.prepare(); } catch (e) { screens.lobby.status = 'idle'; screens.say('THAT LEVEL CAN NOT LOAD'); return; }
    screens.lobby.status = 'idle';
    if (scene !== 'title' || screens.sub !== 'local') return;
  }
  if (!splitKit) splitKit = { game: new Game(audio, art), input: new Input(window, save.options.keys2, { second: true }), renderer: new Renderer(ctx, art) };
  splitKit.game.quickChange = game.quickChange;
  split = splitKit;
  const g2 = split.game;
  g2.video = save.options.video;
  g2.quiet = true;
  game.viewW = VIEW_W / 2; g2.viewW = VIEW_W / 2;
  renderer.w = VIEW_W / 2; split.renderer.w = VIEW_W / 2;
  const [a, b] = localPair();
  // Each player's nickname (the party menu's NAME is player 1's).
  const players = [{ id: 1, name: save.options.playerName || tr('PLAYER 1') }, { id: 2, name: save.options.playerName2 || tr('PLAYER 2') }];
  const rules = { players, mode: st.mode, goal: st.goal, truce: st.truce, local: true };
  game.newParty(index, new Party(a, { ...rules, id: 1 }));
  g2.newParty(index, new Party(b, { ...rules, id: 2 }));
  split.input.setKeys(save.options.keys2);
  input.setKeys(save.options.keys, new Set(Object.values(split.input.bindings).flat().filter((c) => c !== 'Escape' && c !== 'Enter')));
  input.padRole = 'p1'; split.input.padRole = 'p2';
  irisTime = 0;
  go('split');
}

function endSplit() {
  game.viewW = VIEW_W; renderer.w = VIEW_W;
  game.quiet = false;
  input.setKeys(save.options.keys);
  input.padRole = 'any';
  split.input.padRole = 'none';
  split.game.party = null;
  split.renderer.w = VIEW_W;
  split = null;
}

// ---------------------------------------------------------------- party lobby

const playerName = () => save.options.playerName || '';

// Where the party relay is. On a computer it is the game's own server
// (serve.py), so there is nothing to say. In the app this device runs it
// when it hosts (android/.../PartyServer.java); to join, it is the host's
// address as typed (192.168.1.20:8870, the port optional).
function relayUrl(hosting) {
  if (!touch.native) return null;
  if (hosting) {
    let info = null;
    try { info = JSON.parse(window.KipAndroid.startServer()); } catch (e) { /* no answer */ }
    if (!info || !info.port) throw new Error(tr('The party server could not start on this device.'));
    return `ws://127.0.0.1:${info.port}/ws`;
  }
  let address = String(save.options.server || '').trim().replace(/^(https?|wss?):\/*/i, '').replace(/\/.*$/, '');
  if (!address) throw new Error(tr("Type the host's address first."));
  if (!/:\d+$/.test(address) || /^\[[^\]]*$/.test(address)) address += ':8870';
  return `ws://${address}/ws`;
}

// Connect to the relay (once); false if it can't be reached.
async function connect(hosting = false) {
  if (net && net.status === 'open') return true;
  let url = null;
  try { url = relayUrl(hosting); } catch (e) { screens.lobby = { status: 'error', error: e.message }; return false; }
  if (net) net.close();                      // one still on its way (a second tap): this one takes over
  const conn = net = new Net(url);
  const ok = await conn.connect();
  if (conn !== net) return false;            // left while connecting
  if (!ok) {
    const error = !touch.native ? conn.error : hosting ? tr('The party server could not start on this device.')
      : tr('Could not reach {0}. Check the address, and that both devices are on the same Wi-Fi.', save.options.server);
    screens.lobby = { status: 'error', error };
    return false;
  }
  return true;
}

async function hostParty() {
  if (!(await connect(true))) return;
  const st = screens.partySettings();
  net.send({ t: 'host', name: playerName(), mode: st.mode });
}

async function listRooms() {
  // The app finds the hosts on the network itself (unless an address was typed).
  if (touch.native && !screens.lobby.manual) { discover(); return; }
  if (await connect()) net.send({ t: 'rooms' });
}

// The app: ask the network who is hosting (android/.../HostFinder.java
// broadcasts; phones and computers hosting answer with their open games)
// and list every game found. Nothing to type.
let joinAt = -1e9;            // when a join was last asked for (the search leaves it alone)
async function discover() {
  const L = screens.lobby;
  if (L.searching || L.joined || (net && net.status === 'connecting') || performance.now() - joinAt < 4000) return;
  if (net) { net.close(); net = null; }
  L.searching = true;
  try { window.KipAndroid.findHosts(); } catch (e) { /* an older app: nothing found */ }
  for (let i = 0; i < 14; i++) {
    await new Promise((r) => setTimeout(r, 200));
    if (screens.lobby !== L || screens.sub !== 'join' || L.joined || L.manual) break;
    let found = null;
    try { found = JSON.parse(window.KipAndroid.foundHosts()); } catch (e) { /* no answer */ }
    if (!found) break;
    // Always in the same order (answers come back in any), and while a
    // search runs the list only grows: games already listed stay until it
    // is over, so the list doesn't blink empty every time it looks again.
    const rooms = found.hosts.flatMap((h) => (h.rooms || []).map((r) => ({ ...r, server: h.address })))
      .sort((a, b) => String(a.code).localeCompare(String(b.code)) || String(a.server).localeCompare(String(b.server)));
    if (found.done || !L.rooms || rooms.length >= L.rooms.length) showRooms(L, rooms, found.hosts.map((h) => h.address));
    if (found.done) break;
  }
  L.searching = false;
  if (!L.rooms) L.rooms = [];
}

// The games found, with the cursor kept on what it was on (the same game,
// or the same row under the list) as the list changes around it.
const LISTED = 6;
function showRooms(L, rooms, hosts) {
  const old = (L.rooms || []).slice(0, LISTED);
  const on = screens.sub === 'join' && screens.lobby === L && !screens.typing;
  const picked = on ? old[screens.menu] : null;
  const under = on && !picked ? screens.menu - old.length : -1;
  L.hosts = hosts;
  L.rooms = rooms;
  if (!on) return;
  const shown = rooms.slice(0, LISTED);
  const i = picked ? shown.findIndex((r) => r.code === picked.code && r.server === picked.server) : -1;
  if (i >= 0) screens.menu = i;
  else if (under >= 0) screens.menu = shown.length + under;
  else if (picked) screens.menu = shown.length;      // its game is gone: on to REFRESH, not on to another game
}

async function joinParty(code, password) {
  joinAt = performance.now();
  if (touch.native && !screens.lobby.manual) {
    // The game picked (or the code typed) says which host to join.
    const L = screens.lobby;
    const room = (L.rooms || []).find((r) => r.code === code);
    const server = room ? room.server : (L.hosts || [])[0];
    if (!server) { L.error = tr('No game with that code was found on this Wi-Fi.'); audio.play('denied'); return; }
    if (net && save.options.server !== server) { net.close(); net = null; }
    save.options.server = server;
    writeSave(save);
  }
  if (!(await connect())) return;
  net.send({ t: 'join', code, name: playerName(), password });
}

// The host tells everyone what game is set up (and the server lists it).
function sendSettings() {
  if (!net || !screens.lobby.code || screens.sub !== 'host') return;
  const st = screens.partySettings();
  net.send({ t: 'settings', mode: st.mode, level: st.level, goal: st.goal, truce: st.truce });
}

// While a party level loads, the lobby stops reading messages so the
// others' first moves wait in the inbox for the game.
let partyLoading = null;        // the connection whose party level is loading

// Load a party level; false if it failed or the player left meanwhile.
async function preparePartyLevel(index) {
  const def = levelDef(index);
  if (!def || !def.prepare) return !!def;
  const conn = net;
  partyLoading = conn;
  screens.lobby.status = 'loading';
  try {
    await def.prepare();
  } catch (e) {
    if (net === conn) screens.lobby = { status: 'error', error: e.message };
    return false;
  } finally {
    if (partyLoading === conn) partyLoading = null;
  }
  if (screens.lobby.status === 'loading') screens.lobby.status = 'open';
  return !!net && net === conn && net.status === 'open' && scene === 'title' && screens.lobby.status !== 'error';
}

function startParty(rules) {
  game.newParty(rules.level, new Party(net, rules));
  irisTime = 0;
  go('play');
}

// The host loads the level first, then tells everyone to start.
// Levels with nothing to load start at once, inside the same tick.
async function hostStart() {
  if (!net || partyLoading === net) return;
  const st = screens.partySettings();
  if (!(await preparePartyLevel(st.level))) return;
  const L = screens.lobby;
  const rules = { level: st.level, mode: st.mode, goal: st.goal, truce: st.truce, players: L.players };
  net.send({ t: 'start', ...rules });
  startParty({ ...rules, id: L.id });
}

async function guestStart(m) {
  const rules = { level: m.level, mode: m.mode, goal: m.goal, truce: m.truce, players: m.players, id: screens.lobby.id };
  if (await preparePartyLevel(m.level)) startParty(rules);
}

function lobbyTick() {
  if (!net || partyLoading === net) return;
  const msgs = net.take();
  for (let k = 0; k < msgs.length; k++) {
    const m = msgs[k];
    const L = screens.lobby;
    if (m.t === 'hosted') { Object.assign(L, { status: 'open', code: m.code, urls: m.urls, id: m.id, players: m.players }); sendSettings(); }
    else if (m.t === 'joined') Object.assign(L, { status: 'open', joined: true, code: m.code, id: m.id, players: m.players, error: null });
    else if (m.t === 'peer') { L.players = m.players; audio.play('select'); sendSettings(); }
    else if (m.t === 'rooms') L.rooms = m.list;
    else if (m.t === 'settings') L.settings = m;
    else if (m.t === 'error') L.error = m.why;
    else if (m.t === 'start') {
      net.inbox.unshift(...msgs.slice(k + 1));   // keep the rest for the game
      guestStart(m);
      return;
    } else if (m.t === 'left') {
      if (m.closed && L.joined) { screens.lobby = { status: 'error', error: 'The host left.' }; return; }
      L.players = (L.players || []).filter((pl) => pl.id !== m.id);
    }
  }
}

// The options screens' actions (from the title or the pause menu). True
// when `action` was one of them.
function optionsAction(action) {
  if (action === 'options') {
    audio.setVolumes(save.options.music, save.options.sfx);
    game.quickChange = !!save.options.quickChange;
    if (splitKit) splitKit.game.quickChange = game.quickChange;
    writeSave(save);
  } else if (action === 'keys') { input.setKeys(save.options.keys); writeSave(save); } else if (action === 'capture') {
    // The next key press rebinds the chosen slot (Escape cancels).
    input.capture((code) => {
      const c = screens.capturing;
      screens.capturing = null;
      if (!c || code === 'Escape') return;
      const field = c.field || 'keys';
      if (!save.options[field]) save.options[field] = defaultKeys(field === 'keys2');
      if (bindKey(save.options[field], c.action, c.col, code)) { audio.play('select'); input.setKeys(save.options.keys); writeSave(save); } else audio.play('denied');
    });
  } else if (action === 'video') { game.video = save.options.video; layout(); writeSave(save); } else if (action === 'fullscreen') toggleFullscreen();
  else if (action === 'bigger' || action === 'smaller') resize(action === 'bigger' ? 1 : -1);
  else if (action === 'touch') { touch.setOptions(touchOptions(save)); writeSave(save); }
  else if (action === 'lang') { setLang(save.options.lang); writeSave(save); } else if (action === 'slots') writeSave(save);
  else if (action === 'reset') { save = { ...save, unlocked: 1, levels: {} }; writeSave(save); game.unlocked = 1; } else if (action === 'options-closed') { /* back to the pause menu */ } else return false;
  return true;
}

// The F keys, from any screen: F1 help, F3 / F4 screen size, F5 load and
// F6 save. True when one was handled.
function specialKeys() {
  if (screens.typing || screens.capturing) return false;
  // Screen size changes anywhere, without holding up the game.
  if (input.pressed('smaller')) resize(-1);
  if (input.pressed('bigger')) resize(1);
  const key = ['help', 'load', 'save'].find((k) => input.pressed(k));
  if (!key) return false;
  if (scene === 'title') {
    if (net) return false;    // not while a party is being set up
    if (key === 'save') { audio.play('denied'); return true; }
    audio.play('select');
    screens.open(key);
    return true;
  }
  if (scene === 'play' && !game.party && game.state === 'play') { pauseWith(key); return true; }
  if (scene === 'paused') { screens.pauseOpen(key); audio.play('select'); return true; }
  return false;
}

// ---------------------------------------------------------------- tick

function tick() {
  // Gamepad buttons work the menus everywhere but in play.
  input.menu = scene !== 'split' && !(scene === 'play' && game.state === 'play');
  input.sample();
  if (split) { split.input.menu = false; split.input.sample(); }
  if (input.pressed('mute') && !(scene === 'title' && screens.sub === 'join') && !screens.typing) audio.toggleMute();
  sceneTime++;
  if (scene !== 'splash' && specialKeys()) return;
  switch (scene) {
    case 'splash':
      if (!gated && sceneTime > 40 && (input.pressed('start') || input.pressed('jump') || input.pressed('pause'))) toMenu();
      break;
    case 'cinema': {
      const c = cinema;
      if (sceneTime > 20 && ['start', 'jump', 'pause', 'fire'].some((k) => input.pressed(k))) { endFilms(); break; }
      // The film's frames go by its own clock; the next film loads meanwhile.
      if (c.film) {
        const done = c.film.advance(TICK_MS);
        playCues(c);
        if (done) {
          c.last = c.film;
          c.film = null;
          if (++c.i < c.reels.length) startReel(c);
          else endFilms();
        }
      }
      break;
    }
    case 'title': {
      game.time++;
      lobbyTick();
      if (scene !== 'title') break;
      // The app looks again for games every few seconds while the list is up.
      if (touch.native && screens.sub === 'join' && !screens.typing && !screens.lobby.joined && !screens.lobby.manual
        && screens.lobby.status !== 'error' && sceneTime % 350 === 349) discover();
      const action = screens.titleInput(input, save) || '';
      if (optionsAction(action)) break;
      if (action.startsWith('level:')) showCard(levelKey(action.slice(6)), true);
      else if (action === 'save') { writeSave(save); game.character = save.character; game.difficulty = save.difficulty; }
      else if (action.startsWith('load-slot:')) loadSlot(Number(action.slice(10)));
      else if (action === 'score-name') {
        const name = screens.typedName || save.lastName || 'JAZZ';
        save.lastName = name;
        const rank = finished ? addScore(save, { ...finished, name }) : -1;
        finished = null;
        writeSave(save);
        screens.open('scores');
        screens.highlight = rank;
      } else if (action === 'local-start') startSplit();
      else if (action === 'host') hostParty();
      else if (action === 'rooms') listRooms();
      else if (action.startsWith('join:')) { const [code, password] = action.slice(5).split(':'); joinParty(code, password); }
      else if (action === 'leave') { if (net) net.close(); net = null; }
      else if (action === 'settings') sendSettings();
      else if (action === 'host-password') { if (net) net.send({ t: 'password', password: screens.lobby.password || '' }); }
      else if (action === 'pname' || action.startsWith('pname+')) {
        save.options.playerName = screens.typedName;
        writeSave(save);
        if (action === 'pname+host') hostParty();
        else if (action === 'pname+rooms') listRooms();
      } else if (action === 'pname2') { save.options.playerName2 = screens.typedName; writeSave(save); }
      else if (action.startsWith('server+')) {
        // The app: the host's address, remembered for the next time.
        save.options.server = screens.typedName;
        writeSave(save);
        listRooms();
      }
      else if (action === 'pname1+local' || action === 'pname2+local') {
        save.options[action === 'pname1+local' ? 'playerName' : 'playerName2'] = screens.typedName;
        writeSave(save);
        // Both named: off they go; else the other name is asked for next.
        if (save.options.playerName && save.options.playerName2) startSplit();
        else screens.askLocalName(save.options.playerName ? 2 : 1, save);
      }
      else if (action === 'party-start') hostStart();
      break;
    }
    case 'card':
      if (game.cardMeta.error) {
        // A level that can't load: ENTER moves on along its episode's chain.
        if (sceneTime > 30 && input.pressed('start') && game.cardMeta.next) showCard(game.cardMeta.next, false);
        else if (sceneTime > 30 && (input.pressed('start') || input.pressed('pause'))) toMenu();
        break;
      }
      if (!pendingLevel.ready && sceneTime > 30 && input.pressed('pause')) { toMenu(); break; }   // give up on a slow load
      if (pendingLevel.ready && (sceneTime > 170 || (sceneTime > 50 && input.pressed('start')))) startPendingLevel();
      break;
    case 'play':
      irisTime++;
      if (game.party) {
        // Esc asks before leaving (the game goes on meanwhile; the others
        // are told if you go); Enter after the result.
        if (game.party.result && (input.pressed('start') || input.pressed('pause'))) { toMenu(); break; }
        if (leaveAsk(input.pressed('pause'), input.pressed('start'))) break;
        // (With the connection lost, or the host's app put away, the hero stands still.)
        game.update(leaving || game.party.offline || asleep ? IDLE : input);
        break;
      }
      if (game.state === 'play' && input.pressed('pause')) {
        pauseWith(null);
        break;
      }
      game.update(input);
      if (game.state === 'clear' && !game.result) {
        game.result = recordLevel(save, game.levelIndex, game.stats, game.score);
        save.unlocked = Math.max(save.unlocked, game.unlocked);
        writeSave(save);
      }
      if (game.state === 'clear' && game.clearTime > 280 && input.pressed('start')) {
        game.result = null;
        const def = levelDef(game.levelIndex);
        if (def.jj2) {
          const next = nextPlayable(def.next);
          // Past the last level of the game: the ending film first.
          if (next) showCard(next, false); else if (def.ending) playFilms(ENDING, endGame); else endGame();
        } else if (game.levelIndex + 1 < LEVELS.length) showCard(game.levelIndex + 1, false);
        else game.nextLevel();
      } else if (game.state === 'gameover') {
        // "Continue?": YES starts the level again with fresh lives, but
        // without the score and weapons, three times a game (the manual).
        game.overTime = (game.overTime || 0) + 1;
        if (game.overTime === 1) screens.continueYes = true;
        if (game.continues <= 0) {
          if (game.overTime > 60 && (input.pressed('start') || input.pressed('jump') || input.pressed('pause'))) endGame();
          break;
        }
        const answer = game.overTime > 40 ? screens.continueInput(input) : null;
        if (answer === 'yes') { const left = game.continues - 1; showCard(game.levelIndex, true); pendingLevel.continues = left; }
        else if (answer === 'no') endGame();
      } else if (game.state === 'win') {
        game.overTime = (game.overTime || 0) + 1;
        if (game.overTime > 90 && input.pressed('start')) endGame();
      }
      break;
    case 'split': {
      // Esc leaves; ENTER after the result.
      irisTime++;
      const done = game.party && game.party.result;
      if (done && (input.pressed('start') || split.input.pressed('start') || input.pressed('pause') || split.input.pressed('pause'))) { toMenu(); break; }
      if (leaveAsk(input.pressed('pause') || split.input.pressed('pause'), input.pressed('start') || split.input.pressed('start'))) break;
      game.update(leaving ? IDLE : input);
      split.game.update(leaving ? IDLE : split.input);
      break;
    }
    case 'paused': {
      const action = screens.pauseInput(input, save) || '';
      if (optionsAction(action)) break;
      if (action === 'resume') go('play');
      else if (action === 'restart') { game.restoreStart(); showCard(game.levelIndex, false); }
      else if (action === 'quit') endGame();
      else if (action.startsWith('save-slot:')) {
        saveSlot(save, Number(action.slice(10)), { ...game.snapshot(), name: screens.typedName, title: levelDef(game.levelIndex).title });
        screens.say('GAME SAVED');
      } else if (action.startsWith('load-slot:')) loadSlot(Number(action.slice(10)));
      break;
    }
    default:
      break;
  }
}

// Leaving a party game: Esc asks, ENTER leaves, Esc again plays on.
// True once it has left.
let leaving = false;
const IDLE = { held: () => false, pressed: () => false, released: () => false, padPressed: () => false };
function leaveAsk(esc, enter) {
  if (!leaving) {
    if (esc) { leaving = true; audio.play('pause'); }
    return false;
  }
  if (enter) { leaving = false; toMenu(); return true; }
  if (esc) { leaving = false; audio.play('select'); }
  return false;
}

// Split screen: each player's view in their half, with their own HUD.
function renderSplit(alpha) {
  const W = VIEW_W / 2;
  [[game, renderer], [split.game, split.renderer]].forEach(([g, r], i) => {
    ctx.save();
    ctx.beginPath();
    ctx.rect(i * W, 0, W, VIEW_H);
    ctx.clip();
    ctx.translate(i * W, 0);
    r.world(g, alpha);
    r.hud(g);
    if (irisTime < 45) screens.iris(g.player.cx - g.cam.x, g.player.cy - g.cam.y, (irisTime / 45) ** 2 * Math.hypot(W, VIEW_H));
    ctx.restore();
  });
  ctx.fillStyle = '#05020c';
  ctx.fillRect(W - 1, 0, 2, VIEW_H);
}

// The film, or the last one's last frame while the next loads (black before any).
function drawCinema() {
  const film = cinema && (cinema.film || cinema.last);
  if (film) film.draw(ctx, VIEW_W, VIEW_H);
  else { ctx.fillStyle = '#000'; ctx.fillRect(0, 0, VIEW_W, VIEW_H); }
}

function render(alpha) {
  if (scene === 'splash') return screens.splash(sceneTime, gated);
  if (scene === 'cinema') return drawCinema();
  if (scene === 'split') { renderSplit(alpha); if (leaving) screens.leaveAsk(); return null; }
  if (scene === 'title') return screens.title(game.time, save);
  if (scene === 'card') return screens.card(game, sceneTime, save);
  if (game.state === 'win') return screens.win(game, game.overTime || 0);
  renderer.world(game, alpha);
  if (game.state !== 'clear' || game.clearTime < 70) renderer.hud(game);
  if (game.state === 'clear') screens.tally(game);
  if (game.state === 'gameover') screens.gameOver(game, game.overTime || 0);
  if (scene === 'paused') screens.pause(sceneTime, save);
  if (leaving && game.party) screens.leaveAsk();
  if (irisTime < 45) {
    const p = game.player;
    const cx = p.cx - game.cam.x;
    const cy = p.cy - game.cam.y;
    screens.iris(cx, cy, (irisTime / 45) ** 2 * Math.hypot(VIEW_W, VIEW_H));
  }
  return null;
}

let last = performance.now();
let acc = 0;

// AUTO resolution on a phone: the screen's own, unless the game can't hold a
// smooth frame rate there. Two slow stretches (2 s each, under 42 frames a
// second) in play take it down a notch, no lower than 720p; it stays there
// for this run of the app.
const pace = { t: 0, frames: 0, slow: 0 };
function watchPace(now, dt) {
  const auto = (touch.native || touch.active) && typeof save.options.video.res !== 'number';
  if (!auto || scene !== 'play' || dt > 400 || renderScale <= 2) { pace.t = now; pace.frames = 0; pace.slow = 0; return; }
  pace.frames++;
  if (now - pace.t < 2000) return;
  const fps = (pace.frames * 1000) / (now - pace.t);
  pace.t = now; pace.frames = 0;
  pace.slow = fps < 42 ? pace.slow + 1 : 0;
  if (pace.slow >= 2) { pace.slow = 0; autoCap = renderScale - 1; layout(); }
}

// The ticks due by `now` (from the frame loop, or blind while the app is
// put away and this phone hosts a party).
function advance(now) {
  acc += Math.min(now - last, 1000);
  last = now;
  let steps = 0;
  while (acc >= TICK_MS) {
    // A failing tick is reported once and the game keeps running.
    try { tick(); } catch (e) { if (!loop.reportedTick) { console.error(e); loop.reportedTick = true; } }
    acc -= TICK_MS;
    if (++steps > MAX_CATCHUP_TICKS) { acc = 0; break; }
  }
  if (touch.native && ++advance.n % 20 === 0) tellHosting();
}
advance.n = 0;

let fps = 0;
const frameRate = { t: 0, frames: 0 };
screens.frameRate = () => fps;

function loop(now) {
  watchPace(now, now - last);
  advance(now);
  // The touch controls follow the screen: the stick and buttons in play, a
  // BACK button in the menus (which say each frame where their items are).
  const playing = scene === 'play' && game.state === 'play' && !leaving && !(game.party && game.party.result);
  touch.frame({
    play: playing,
    pause: scene === 'split' && !leaving,
    back: (scene === 'title' && screens.sub !== null) || scene === 'paused' || (scene === 'card' && !!pendingLevel && (!pendingLevel.ready || !!game.cardMeta.error)),
    root: scene === 'splash' || (scene === 'title' && screens.sub === null && !screens.typing),
    health: game.player ? game.player.health : null,
  });
  // The HUD keeps its touch layout behind the pause menu too.
  renderer.touchHud = touch.active && (scene === 'play' || scene === 'paused') ? { inset: touch.hudInset } : null;
  screens.hits.length = 0;
  // Never let one bad frame freeze the game: report it and keep going.
  // Everything draws in 640x360 units, scaled to the render resolution.
  ctx.setTransform(renderScale, 0, 0, renderScale, 0, 0);
  ctx.imageSmoothingEnabled = false;
  renderer.scale = renderScale;
  if (splitKit) splitKit.renderer.scale = renderScale;
  try {
    render(acc / TICK_MS);
    screens.drawToast();
    // The frames drawn per second, measured over the last half second (the
    // video screen shows it; FPS COUNTER shows it in play, top left of centre).
    frameRate.frames++;
    if (now - frameRate.t >= 500) { fps = Math.round((frameRate.frames * 1000) / (now - frameRate.t)); frameRate.t = now; frameRate.frames = 0; }
    if (save.options.video.fps && (scene === 'play' || scene === 'split' || scene === 'paused')) screens.med(`${fps} FPS`, VIEW_W / 2 - 110, 1, { scale: 0.4, color: '#ffd54a', raw: true });
  } catch (e) {
    if (!loop.reported) { console.error(e); loop.reported = true; }
    ctx.fillStyle = 'rgba(0,0,0,0.75)';
    ctx.fillRect(0, VIEW_H - 40, VIEW_W, 40);
    ctx.fillStyle = '#ff8a8a';
    ctx.font = '11px sans-serif';
    ctx.fillText(`Error: ${e.message} (see the browser console)`, 8, VIEW_H - 16);
  }
  // Through the GPU's shaders to the screen (or the 2D canvas as it is).
  if (post && save.options.video.gpu) {
    const v = save.options.video;
    try { post.draw(canvas, { upscale: v.upscale, bloom: GLOW[v.bloom] ?? 0, lines: VIEW_H }); } catch (e) { console.warn('GPU effects off:', e.message); post = false; layout(); }
  }
  // The game is up: the loading screen comes down.
  if (!loop.up) {
    loop.up = true;
    window.kip.loadMs = Math.round(performance.now());
    if (window.kipLoaded) window.kipLoaded();
    // (The app has a loading picture of its own over the page until it draws.)
    try { if (window.KipAndroid && window.KipAndroid.ready) window.KipAndroid.ready(); } catch (e) { /* an older app */ }
  }
  requestAnimationFrame(loop);
}

requestAnimationFrame(loop);
