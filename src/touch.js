// Touch controls (phones and tablets, and the Android app).
//
// In play: a floating stick under one thumb (left / right / up / down, and
// pushed all the way it runs) and JUMP, FIRE and next-weapon buttons under
// the other; a thumb resting between JUMP and FIRE holds both, and slides
// from one to the other. In the menus: tap what you want (the screens say
// where their items are, see Screens.hit), swipe to move through lists, and
// a BACK button; typing a name opens the on-screen keyboard through a text
// bar at the top. The controls feed the same Input the keyboard does, by
// action name, so the game itself doesn't know the difference.
//
// They show on the first touch and step aside for a keyboard or a gamepad.
// A mouse can click the menus too.

import { VIEW_H, VIEW_W } from './config.js';
import { lang, tr } from './lang.js';
import { TOUCH_DEFAULTS } from './save.js';
import { cleanTyped } from './screens.js';

const SVG = (body) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const ICONS = {
  jump: SVG('<path d="M12 19V6"/><path d="M5.5 12L12 5.5 18.5 12"/>'),
  fire: SVG('<circle cx="12" cy="12" r="6.2"/><path d="M12 2.5v4M12 17.5v4M2.5 12h4M17.5 12h4"/><circle cx="12" cy="12" r="1.2" fill="currentColor"/>'),
  weapon: SVG('<path d="M4 9h13"/><path d="M13.5 5.5L17 9l-3.5 3.5"/><path d="M20 15.5H7"/><path d="M10.5 12L7 15.5l3.5 3.5"/>'),
  run: SVG('<path d="M5 6l6 6-6 6"/><path d="M13 6l6 6-6 6"/>'),
  pause: SVG('<path d="M8.5 5.5v13M15.5 5.5v13"/>'),
  back: SVG('<path d="M14.5 5.5L8 12l6.5 6.5"/>'),
  ok: SVG('<path d="M5 12.5l4.5 4.5L19 7.5"/>'),
  cancel: SVG('<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>'),
};

// Stick: how far (of its radius) before a direction counts, and before it runs.
const DEAD = 0.24;
const DEAD_Y = 0.4;
const RUN_AT = 0.8;
const FOLLOW = 1.3;       // the base follows a thumb dragged further than this
const SLOP = 1.28;        // a button is pressed this far beyond its edge

const el = (tag, cls, html = '') => {
  const e = document.createElement(tag);
  e.className = cls;
  if (html) e.innerHTML = html;
  return e;
};

export class Touch {
  constructor({ input, screens }) {
    this.input = input;
    this.screens = screens;
    this.native = !!window.KipAndroid;
    // ?touch=1: a mouse works the touch controls (for trying them at a desk).
    this.mouseToo = /[?&]touch=1\b/.test(location.search);
    const phone = typeof matchMedia === 'function' && matchMedia('(hover: none) and (pointer: coarse)').matches;
    this.active = this.native || phone || this.mouseToo;
    this.opts = { ...TOUCH_DEFAULTS };
    this.play = false;          // the play controls are up
    this.state = {};            // what the screen wants this frame (see frame)
    this.lastTouch = 0;
    this.stick = { id: null, bx: 0, by: 0, home: true };
    this.holds = new Map();     // pointer id -> the hold buttons under it
    this.menuPtr = null;        // the finger on a menu: { id, x, y, t, moved, drag, axis, last }
    this.runLatch = false;      // RUN button: running switched on
    this.held = new Set();      // the actions the controls hold now
    this.typingRef = null;
    this.health = null;
    this.hudInset = 0;
    this.langId = null;
    this.build();
    this.layout();
    this.listen();
    this.show();
  }

  // ---------------------------------------------------------------- the page

  build() {
    const root = this.root = el('div', 't-root');
    root.id = 'touch';
    const button = (name, cls, label = '') => {
      const b = el('div', `t-el t-btn t-${name} ${cls}`, `${ICONS[name]}${label ? '<span></span>' : ''}`);
      b.dataset.label = label;
      root.append(b);
      return b;
    };
    this.base = el('div', 't-el t-play t-stick', '<i class="t-arrow t-l"></i><i class="t-arrow t-r"></i><i class="t-arrow t-u"></i><i class="t-arrow t-d"></i>');
    this.knob = el('div', 't-knob');
    this.base.append(this.knob);
    root.append(this.base);
    this.btn = {
      jump: button('jump', 't-play t-hold', 'JUMP'),
      shoot: button('fire', 't-play t-hold', 'FIRE'),
      weapon: button('weapon', 't-play t-tap'),
      run: button('run', 't-play t-tap t-runbtn', 'RUN'),
      pause: button('pause', 't-tap t-pausebtn'),
      back: button('back', 't-tap t-backbtn'),
    };
    // Typing: a text field the on-screen keyboard can attach to.
    this.form = el('form', 't-type');
    this.form.setAttribute('autocomplete', 'off');
    this.cancelBtn = el('button', 't-type-btn t-type-cancel', ICONS.cancel);
    this.cancelBtn.type = 'button';
    this.cancelBtn.setAttribute('aria-label', 'Cancel');
    this.field = el('input', 't-type-field');
    Object.entries({ type: 'text', autocomplete: 'off', autocorrect: 'off', autocapitalize: 'characters', spellcheck: 'false', enterkeyhint: 'done', 'aria-label': 'Text' })
      .forEach(([k, v]) => this.field.setAttribute(k, v));
    this.okBtn = el('button', 't-type-btn t-type-ok', ICONS.ok);
    this.okBtn.type = 'submit';
    this.okBtn.setAttribute('aria-label', 'Done');
    this.form.append(this.cancelBtn, this.field, this.okBtn);
    root.append(this.form);
    // Phones held upright (in a browser; the app is always sideways).
    this.rotate = el('div', 't-rotate', `${SVG('<rect x="7" y="3" width="10" height="18" rx="2"/><path d="M3 9a9 9 0 013-5M21 15a9 9 0 01-3 5"/>')}<span></span>`);
    root.append(this.rotate);
    // Reads the screen's safe area (notch, rounded corners).
    this.probe = el('div', 't-probe');
    root.append(this.probe);
    document.body.append(root);
    this.labels();
  }

  // The words on the buttons, in the game's language.
  labels() {
    this.langId = lang();
    for (const b of Object.values(this.btn)) {
      const span = b.querySelector('span');
      if (span) span.textContent = tr(b.dataset.label);
    }
    this.rotate.querySelector('span').textContent = tr('Turn your device sideways');
  }

  // The options (OPTIONS > CONTROLS > TOUCH).
  setOptions(opts) {
    this.opts = { ...TOUCH_DEFAULTS, ...opts };
    if (this.opts.run !== 'button') this.runLatch = false;
    this.layout();
    this.show();
  }

  // Where everything sits, in CSS pixels (so presses are tested against
  // exactly what is drawn): the stick under one thumb, the buttons in an arc
  // under the other, pause and back in the top corners.
  layout() {
    const W = window.innerWidth; const H = window.innerHeight;
    const cs = getComputedStyle(this.probe);
    const inset = { l: parseFloat(cs.paddingLeft) || 0, r: parseFloat(cs.paddingRight) || 0, t: parseFloat(cs.paddingTop) || 0, b: parseFloat(cs.paddingBottom) || 0 };
    // One unit: a hundredth of the screen height on a phone, no bigger on a tablet.
    const u = this.u = Math.min(Math.min(H, W * 0.56) / 100, 4.6) * this.opts.size;
    const swap = this.opts.swap;
    const mx = (side) => Math.max(side === 'l' ? inset.l : inset.r, 0) + 3.5 * u;
    const my = inset.b + 4 * u;
    // x measured from the buttons' side of the screen.
    const fromEdge = (d) => (swap ? mx('l') + d : W - mx('r') - d);
    const place = (b, cx, cy, r) => {
      b.cx = cx; b.cy = cy; b.r = r;
      b.style.left = `${cx - r}px`; b.style.top = `${cy - r}px`;
      b.style.width = `${2 * r}px`; b.style.height = `${2 * r}px`;
      b.style.fontSize = `${r}px`;
    };
    place(this.btn.jump, fromEdge(13.5 * u), H - my - 14.5 * u, 11.5 * u);
    place(this.btn.shoot, fromEdge(36.5 * u), H - my - 9.5 * u, 10 * u);
    place(this.btn.weapon, fromEdge(33.5 * u), H - my - 31 * u, 6.6 * u);
    place(this.btn.run, fromEdge(10 * u), H - my - 37.5 * u, 7 * u);
    const cu = Math.min(u, 4.2);      // the corner buttons don't grow with the size option
    place(this.btn.pause, W - Math.max(inset.r, 0) - 8.5 * cu, inset.t + 8.5 * cu, 5.6 * cu);
    place(this.btn.back, Math.max(inset.l, 0) + 9 * cu, inset.t + 9 * cu, 6 * cu);
    this.R = 13 * u;
    this.home = { x: swap ? W - mx('r') - 19 * u : mx('l') + 19 * u, y: H - my - 16.5 * u };
    this.stickSide = swap ? 1 : -1;
    if (this.stick.id === null) this.moveBase(this.home.x, this.home.y, true);
    const k = 5.6 * u;
    this.knob.style.width = `${2 * k}px`; this.knob.style.height = `${2 * k}px`;
    this.knob.style.left = `${this.R - k}px`; this.knob.style.top = `${this.R - k}px`;
    this.W = W; this.H = H;
  }

  moveBase(x, y, home = false) {
    const s = this.stick;
    s.bx = x; s.by = y; s.home = home;
    this.base.style.left = `${x - this.R}px`; this.base.style.top = `${y - this.R}px`;
    this.base.style.width = `${2 * this.R}px`; this.base.style.height = `${2 * this.R}px`;
  }

  // The canvas showing (the 2D one, or the GPU's).
  canvas() {
    const gpu = document.getElementById('gpu');
    return gpu && gpu.style.display !== 'none' ? gpu : document.getElementById('game');
  }

  // A point of the screen in the game's 640x360 view units.
  toView(x, y) {
    const r = this.canvas().getBoundingClientRect();
    return { x: ((x - r.left) / (r.width || 1)) * VIEW_W, y: ((y - r.top) / (r.height || 1)) * VIEW_H, scale: (r.height || VIEW_H) / VIEW_H };
  }

  // ---------------------------------------------------------------- events

  listen() {
    const opt = { passive: false };
    window.addEventListener('pointerdown', (e) => this.down(e), opt);
    window.addEventListener('pointermove', (e) => this.move(e), opt);
    window.addEventListener('pointerup', (e) => this.up(e), opt);
    window.addEventListener('pointercancel', (e) => this.up(e, true), opt);
    window.addEventListener('resize', () => this.layout());
    window.addEventListener('orientationchange', () => this.layout());
    window.addEventListener('blur', () => this.releaseAll());
    // No long-press menus, no pinch or double-tap zoom, no scrolling.
    window.addEventListener('contextmenu', (e) => { if (this.active) e.preventDefault(); });
    for (const type of ['gesturestart', 'gesturechange', 'dblclick']) window.addEventListener(type, (e) => e.preventDefault(), opt);
    document.addEventListener('touchmove', (e) => { if (!e.target.closest || !e.target.closest('.t-type')) e.preventDefault(); }, opt);

    const tapButton = (b, fn) => b.addEventListener('pointerdown', (e) => {
      if (!this.fingers(e)) return;
      e.preventDefault(); e.stopPropagation();
      this.touched(e);
      this.flash(b);
      this.buzz(0);
      fn();
    });
    tapButton(this.btn.weapon, () => this.input.tap('weapon'));
    tapButton(this.btn.pause, () => this.input.tap('pause'));
    tapButton(this.btn.back, () => this.back());
    tapButton(this.btn.run, () => { this.runLatch = !this.runLatch; this.show(); this.sync(); });

    // The text bar.
    this.field.addEventListener('input', () => {
      const T = this.screens.typing;
      if (!T) return;
      const clean = cleanTyped(T, this.field.value);
      T.buf = clean;
      T.fresh = false;
      // Only step in when something had to go (the field shows capitals itself).
      const same = T.kind === 'server' ? this.field.value === clean : this.field.value.toUpperCase() === clean;
      if (!same) this.field.value = clean;
    });
    this.field.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); this.typed(false); } });
    this.form.addEventListener('submit', (e) => { e.preventDefault(); this.typed(true); });
    const press = (b, fn) => b.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); fn(); });
    press(this.cancelBtn, () => this.typed(false));
    press(this.okBtn, () => this.typed(true));
  }

  // Is this pointer one the touch controls take?
  fingers(e) {
    return e.pointerType === 'touch' || e.pointerType === 'pen' || this.mouseToo;
  }

  // A finger is on the screen: bring the controls up (a keyboard or a
  // gamepad put them away).
  touched(e) {
    if (e.pointerType === 'mouse' && !this.mouseToo) return;
    this.lastTouch = performance.now();
    if (!this.active) { this.active = true; this.show(); }
  }

  down(e) {
    if (e.target.closest && e.target.closest('.t-type, .t-tap')) return;     // they see to themselves
    const finger = this.fingers(e);
    if (!finger && e.pointerType !== 'mouse') return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (finger) { e.preventDefault(); this.touched(e); }
    const x = e.clientX; const y = e.clientY;
    if (this.play) {
      if (!finger) return;
      // The stick's half of the screen, or the buttons'.
      const stickHalf = this.stickSide < 0 ? x < this.W * 0.5 : x > this.W * 0.5;
      const nearHold = this.under(x, y).length > 0;
      if (stickHalf && !nearHold && this.stick.id === null) {
        const s = this.stick;
        s.id = e.pointerId;
        // On the stick itself it works at once, like a d-pad; anywhere else
        // it comes to the thumb.
        if (Math.hypot(x - this.home.x, y - this.home.y) <= this.R * 1.15) this.moveBase(this.home.x, this.home.y, true);
        else this.moveBase(Math.max(this.R, Math.min(this.W - this.R, x)), Math.max(this.R, Math.min(this.H - this.R, y)));
        this.base.classList.add('t-live');
        this.steer(x, y);
        return;
      }
      this.holds.set(e.pointerId, []);
      this.press(e.pointerId, x, y);
      return;
    }
    // Menus.
    const T = this.screens.typing;
    if (T) { if (finger) this.focusField(); return; }
    // One finger at a time (one left behind by a lost touch doesn't block the next).
    if (this.menuPtr && performance.now() - this.menuPtr.t < 1500) return;
    const v = this.toView(x, y);
    const h = this.screens.hitAt(v.x, v.y);
    this.menuPtr = { id: e.pointerId, x, y, t: performance.now(), moved: false, axis: null, last: { x, y }, drag: h && h.drag ? h : null, finger };
    if (this.menuPtr.drag) this.key(h.fn(v.x, v.y));
  }

  move(e) {
    if (e.pointerId === this.stick.id) { e.preventDefault(); this.steer(e.clientX, e.clientY); return; }
    if (this.holds.has(e.pointerId)) { e.preventDefault(); this.press(e.pointerId, e.clientX, e.clientY); return; }
    const m = this.menuPtr;
    if (!m || m.id !== e.pointerId) return;
    if (m.finger) e.preventDefault();
    const v = this.toView(e.clientX, e.clientY);
    if (m.drag) { this.key(m.drag.fn(v.x, v.y)); return; }
    if (!m.finger) return;          // a mouse clicks; it doesn't swipe
    const dx = e.clientX - m.x; const dy = e.clientY - m.y;
    const slop = Math.max(10, 12 * v.scale);
    if (!m.axis && Math.hypot(dx, dy) > slop) { m.axis = Math.abs(dy) >= Math.abs(dx) ? 'y' : 'x'; m.moved = true; m.last = { x: e.clientX, y: e.clientY }; }
    if (!m.axis) return;
    // A swipe moves through the list: one row for every row's height of travel.
    const step = (m.axis === 'y' ? 26 : 60) * v.scale;
    const d = m.axis === 'y' ? e.clientY - m.last.y : e.clientX - m.last.x;
    const n = Math.trunc(d / step);
    if (!n) return;
    if (m.axis === 'y') m.last.y += n * step; else m.last.x += n * step;
    // Dragging the list up brings the next row; a swipe to the left, the next page.
    for (let i = 0; i < Math.abs(n); i++) this.input.tap(m.axis === 'y' ? (n < 0 ? 'down' : 'up') : (n < 0 ? 'right' : 'left'));
  }

  up(e, cancelled = false) {
    if (e.pointerId === this.stick.id) {
      this.stick.id = null;
      this.base.classList.remove('t-live');
      this.moveBase(this.home.x, this.home.y, true);
      this.knob.style.transform = '';
      this.steerSet(false, false, false, false, false);
      return;
    }
    if (this.holds.has(e.pointerId)) {
      this.holds.delete(e.pointerId);
      this.syncHolds();
      return;
    }
    const m = this.menuPtr;
    if (!m || m.id !== e.pointerId) return;
    this.menuPtr = null;
    if (cancelled || m.drag || m.moved || this.play || this.screens.typing) return;
    if (performance.now() - m.t > 900) return;        // a rest, not a tap
    const v = this.toView(e.clientX, e.clientY);
    const key = this.screens.tapAt(v.x, v.y);
    if (key && m.finger) this.buzz(0);
    this.key(key);
  }

  key(k) {
    if (k) this.input.tap(k);
  }

  // ---------------------------------------------------------------- stick

  steer(x, y) {
    const s = this.stick;
    let dx = x - s.bx; let dy = y - s.by;
    const d = Math.hypot(dx, dy);
    // The base follows a thumb that wanders off, so it never loses the stick.
    if (d > this.R * FOLLOW) {
      const k = (d - this.R * FOLLOW) / d;
      this.moveBase(Math.max(this.R * 0.6, Math.min(this.W - this.R * 0.6, s.bx + dx * k)), Math.max(this.R * 0.6, Math.min(this.H - this.R * 0.6, s.by + dy * k)));
      dx = x - s.bx; dy = y - s.by;
    }
    const m = Math.hypot(dx, dy) / this.R;
    const c = Math.min(1, m) / (m || 1);
    this.knob.style.transform = `translate(${dx * c}px, ${dy * c}px)`;
    const ax = Math.abs(dx) / this.R; const ay = Math.abs(dy) / this.R;
    // Sideways within about 63 degrees of level; up and down beyond about 35.
    const side = ax > DEAD && ax > ay * 0.5;
    const vert = ay > DEAD_Y && ay > ax * 0.7;
    this.steerSet(side && dx < 0, side && dx > 0, vert && dy < 0, vert && dy > 0, side && m > RUN_AT);
  }

  steerSet(left, right, up, down, far) {
    this.dir = { left, right, up, down, far };
    this.base.classList.toggle('t-far', !!far && this.opts.run === 'stick');
    this.sync();
  }

  // ---------------------------------------------------------------- buttons

  // The hold buttons (JUMP, FIRE) under a point: both, between the two.
  under(x, y) {
    const out = [];
    for (const name of ['jump', 'shoot']) {
      const b = this.btn[name];
      if (Math.hypot(x - b.cx, y - b.cy) <= b.r * SLOP) out.push(name);
    }
    return out;
  }

  press(id, x, y) {
    const now = this.under(x, y);
    const was = this.holds.get(id) || [];
    if (now.some((n) => !was.includes(n))) this.buzz(0);
    this.holds.set(id, now);
    this.syncHolds();
  }

  syncHolds() {
    const on = new Set();
    for (const list of this.holds.values()) for (const n of list) on.add(n);
    this.pressed = on;
    for (const name of ['jump', 'shoot']) this.btn[name].classList.toggle('t-down', on.has(name));
    this.sync();
  }

  flash(b) {
    b.classList.add('t-down');
    setTimeout(() => b.classList.remove('t-down'), 130);
  }

  // Tell the input what is held now.
  sync() {
    const want = new Set();
    if (this.play) {
      const d = this.dir || {};
      for (const a of ['left', 'right', 'up', 'down']) if (d[a]) want.add(a);
      for (const a of this.pressed || []) want.add(a);
      const run = this.opts.run === 'always' || (this.opts.run === 'button' ? this.runLatch : d.far);
      if (run) want.add('run');
    }
    for (const a of this.held) if (!want.has(a)) this.input.hold(a, false);
    for (const a of want) if (!this.held.has(a)) this.input.hold(a, true);
    this.held = want;
  }

  releaseAll() {
    this.stick.id = null;
    this.holds.clear();
    this.menuPtr = null;
    this.dir = {};
    this.pressed = new Set();
    this.knob.style.transform = '';
    this.base.classList.remove('t-live', 't-far');
    if (this.home) this.moveBase(this.home.x, this.home.y, true);
    for (const name of ['jump', 'shoot']) this.btn[name].classList.remove('t-down');
    // Start from nothing held: the input may have let go of everything on
    // its own (the window lost focus, the app went to the background), and
    // what still counts (RUN switched on) has to be told to it again.
    for (const a of this.held) this.input.hold(a, false);
    this.held = new Set();
    this.sync();
  }

  buzz(kind) {
    if (!this.opts.haptic) return;
    try {
      if (this.native) window.KipAndroid.haptic(kind);
      else if (navigator.vibrate) navigator.vibrate(kind ? 35 : 8);
    } catch (e) { /* no buzzer */ }
  }

  // ---------------------------------------------------------------- back, typing

  // The BACK button (and the app's): what Escape does, a step at a time.
  // False when there is nothing left to go back from.
  back() {
    const S = this.screens;
    if (this.input.cancelCapture()) return true;
    if (S.typing) { this.typed(false); return true; }
    if (this.state.root) return false;
    this.input.tap('pause');
    return true;
  }

  // The text bar is done with (OK or the keyboard's own), or cancelled.
  typed(done) {
    const T = this.screens.typing;
    if (!T) return;
    if (done) { T.buf = cleanTyped(T, this.field.value); T.fresh = false; T.done = true; } else T.cancel = true;
    this.field.blur();
  }

  focusField() {
    try { this.field.focus({ preventScroll: true }); } catch (e) { this.field.focus(); }
  }

  // Follow the game's typing (a name, a password, a room code, an address).
  syncTyping() {
    const T = this.active ? this.screens.typing : null;
    if (T === this.typingRef) return;
    this.typingRef = T;
    this.root.classList.toggle('t-typing', !!T);
    this.show();
    if (!T) { this.field.blur(); return; }
    const server = T.kind === 'server';
    this.field.value = T.buf || '';
    this.field.maxLength = server ? 40 : T.kind === 'code' ? 4 : 12;
    this.field.setAttribute('inputmode', server ? 'url' : 'text');
    this.field.setAttribute('autocapitalize', server ? 'off' : 'characters');
    this.field.classList.toggle('t-plain', server);
    this.focusField();
    // A suggested name goes as soon as you type over it.
    if (T.fresh) { try { this.field.select(); } catch (e) { /* not selectable */ } }
  }

  // ---------------------------------------------------------------- every frame

  // What the screen wants now: { play, back, pause, root, health }.
  //   play: the game is being played (stick and buttons)
  //   back: a BACK button (menus);  pause: a pause button on its own
  //   root: nothing to go back to (the title's main menu)
  frame(state) {
    this.state = state;
    // A keyboard or a gamepad in use: the controls step aside.
    if (this.active && !this.screens.typing && !this.native && !this.mouseToo
      && (this.input.lastKey > this.lastTouch || (this.input.padActive() && performance.now() - this.lastTouch > 1500))) { this.active = false; this.show(); }
    if (this.active && this.native && (this.input.lastKey > this.lastTouch + 400 || this.input.padActive()) && performance.now() - this.lastTouch > 4000) { this.active = false; this.show(); }
    const play = this.active && !!state.play;
    if (play !== this.play || state.back !== this.wasBack || state.pause !== this.wasPause) {
      this.play = play; this.wasBack = state.back; this.wasPause = state.pause;
      if (!play) this.releaseAll(); else this.menuPtr = null;
      this.show();
      this.sync();
    }
    if (this.langId !== lang()) this.labels();
    this.screens.touch = this.active;
    this.syncTyping();
    // A buzz when the hero is hurt.
    if (play && typeof state.health === 'number') {
      if (this.health !== null && state.health < this.health) this.buzz(1);
      this.health = state.health;
    } else this.health = null;
    this.hudInset = this.inset();
  }

  show() {
    const c = this.root.classList;
    c.toggle('t-on', this.active);
    c.toggle('t-playing', this.active && this.play);
    c.toggle('t-back', this.active && !this.play && !!this.state.back && !this.screens.typing);
    c.toggle('t-pause', this.active && (this.play || !!this.state.pause));
    c.toggle('t-run', this.opts.run === 'button');
    c.toggle('t-web', !this.native);
    this.btn.run.classList.toggle('t-lit', this.runLatch);
    this.root.style.setProperty('--t-alpha', String(this.opts.alpha));
  }

  // How far (in view units) the pause button reaches into the picture's
  // top right corner: the HUD's hearts move over for it.
  inset() {
    if (!this.active) return 0;
    const r = this.canvas().getBoundingClientRect();
    const b = this.btn.pause;
    const over = r.right - (b.cx - b.r - this.u);
    // Clear of the picture (beside it, or in the band above it on a tablet): nothing to do.
    if (over <= 0 || b.cy + b.r <= r.top || b.cy - b.r > r.top + r.height * 0.12) return 0;
    return Math.min(120, Math.ceil(over / ((r.width || VIEW_W) / VIEW_W)));
  }
}
