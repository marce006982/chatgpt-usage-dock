'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'chatgpt-usage-dock.user.js'), 'utf8');

class Element {
  constructor(tag) {
    this.tagName = tag;
    this.children = [];
    this.listeners = {};
    this.style = {};
    this.dataset = {};
    this.hidden = false;
    this.textContent = '';
    this.id = '';
  }
  append(...xs) { this.children.push(...xs); }
  appendChild(x) { this.children.push(x); return x; }
  replaceChildren(...xs) { this.children = xs; }
  addEventListener(name, cb) { this.listeners[name] = cb; }
  setAttribute() {}
  getBoundingClientRect() {
    const panel = this.id === 'cgqd-root' ? this.find(el => el.className === 'cgqd-panel') : null;
    const left = Number.parseFloat(this.style.left);
    const top = Number.parseFloat(this.style.top);
    return {
      left: Number.isFinite(left) ? left : 900,
      top: Number.isFinite(top) ? top : 84,
      width: panel && !panel.hidden ? 292 : 160,
      height: panel && !panel.hidden ? 240 : 36
    };
  }
  setPointerCapture() {}
  querySelectorAll() { return []; }
  closest() { return null; }
  find(predicate) {
    if (predicate(this)) return this;
    for (const child of this.children) {
      const hit = child.find(predicate);
      if (hit) return hit;
    }
    return null;
  }
}

async function runCase(data, httpStatus, stored = new Map()) {
  const document = {
    head: new Element('head'),
    body: new Element('body'),
    documentElement: new Element('html'),
    hidden: false,
    createElement: tag => new Element(tag),
    getElementById: () => null,
    addEventListener: () => {}
  };
  const window = {
    innerWidth: 1280, innerHeight: 720, listeners: {},
    addEventListener(name, cb) { this.listeners[name] = cb; }
  };
  window.top = window;
  const session = { accessToken: 'sample.invalid.token' };
  const requests = [];
  const context = {
    window, document,
    localStorage: {
      getItem: key => stored.get(key) ?? null,
      setItem: (key, value) => stored.set(key, value)
    },
    fetch: async (url, options) => {
      requests.push({ url, options });
      if (url.includes('/api/auth/session')) return { ok: true, json: async () => session };
      if (httpStatus) return { ok: false, status: httpStatus };
      return { ok: true, json: async () => data };
    },
    AbortController, setTimeout, clearTimeout,
    setInterval: () => 1, atob,
    console
  };
  vm.runInNewContext(source, context, { filename: 'chatgpt-usage-dock.user.js' });
  await new Promise(resolve => setTimeout(resolve, 30));
  const root = document.body.find(el => el.id === 'cgqd-root');
  assert.ok(root, 'Dock should render before the network call finishes');
  const pill = root.find(el => el.className === 'cgqd-pill');
  const panel = root.find(el => el.className === 'cgqd-panel');
  const summary = pill.children[1];
  assert.ok(pill && panel);
  return { root, panel, pill, summary, requests, stored, window };
}

(async function main() {
  const now = Math.floor(Date.now() / 1000) + 3600;
  const data = {
    rate_limit: {
      primary_window: { used_percent: 24, limit_window_seconds: 18000, reset_at: now },
      secondary_window: { used_percent: 63, limit_window_seconds: 604800, reset_at: now }
    },
    additional_rate_limits: [{
      limit_name: '专项额度',
      rate_limit: { primary_window: { used_percent: 10, limit_window_seconds: 18000, reset_at: now } }
    }]
  };
  const result = await runCase(data);
  assert.match(result.summary.textContent, /5小时 76%/);
  assert.match(result.summary.textContent, /7天 37%/);
  assert.equal(result.panel.children[1].children.length, 3, 'Should show additional window');
  assert.equal(result.requests.length, 2, 'Should only call ChatGPT session and usage endpoints');
  assert.ok(result.requests.every(r => r.url.startsWith('/')));
  result.pill.listeners.click({ detail: 1, preventDefault() {} });
  assert.equal(result.panel.hidden, false, 'Pill should expand details');

  // The collapsed pill is a drag handle, but a normal click still expands it.
  const pointer = (x, y, pointerId = 1) => ({
    button: 0, pointerId, clientX: x, clientY: y,
    target: { closest: () => null }
  });
  const dragCase = await runCase(data);
  dragCase.pill.listeners.pointerdown(pointer(920, 100));
  dragCase.pill.listeners.pointermove(pointer(960, 130));
  dragCase.pill.listeners.pointerup(pointer(960, 130));
  assert.equal(dragCase.root.style.left, '940px');
  assert.equal(dragCase.root.style.top, '114px');
  assert.deepEqual(JSON.parse(dragCase.stored.get('cgqd-v1-position')), {
    left: '940px', top: '114px'
  }, 'Drag coordinates must be persisted');

  let prevented = false;
  dragCase.pill.listeners.click({ detail: 1, preventDefault() { prevented = true; } });
  assert.equal(prevented, true, 'Drag should consume the synthetic click');
  assert.equal(dragCase.panel.hidden, true, 'Dragging must not expand the details panel');
  dragCase.pill.listeners.click({ detail: 1, preventDefault() {} });
  assert.equal(dragCase.panel.hidden, false, 'The next click should still expand details');

  // Restoring saved coordinates and viewport clamping.
  const restored = await runCase(data, null, dragCase.stored);
  assert.equal(restored.root.style.left, '940px');
  assert.equal(restored.root.style.top, '114px');
  restored.window.innerWidth = 400;
  restored.window.innerHeight = 300;
  restored.window.listeners.resize();
  assert.equal(restored.root.style.left, '108px', 'Expanded panel must remain onscreen');
  assert.equal(restored.root.style.top, '60px');
  assert.equal(JSON.parse(restored.stored.get('cgqd-v1-position')).left, '108px');

  const smallMove = await runCase(data);
  smallMove.pill.listeners.pointerdown(pointer(920, 100));
  smallMove.pill.listeners.pointermove(pointer(923, 101));
  smallMove.pill.listeners.pointerup(pointer(923, 101));
  smallMove.pill.listeners.click({ detail: 1, preventDefault() {} });
  assert.equal(smallMove.panel.hidden, false, 'Tiny motions should remain clicks');
  assert.equal(smallMove.stored.has('cgqd-v1-position'), false, 'A click is not a drag');

  const headerCase = await runCase(data);
  headerCase.pill.listeners.click({ detail: 1, preventDefault() {} });
  const header = headerCase.root.find(el => el.className === 'cgqd-header');
  header.listeners.pointerdown(pointer(920, 100));
  header.listeners.pointermove(pointer(960, 130));
  header.listeners.pointerup(pointer(960, 130));
  assert.equal(headerCase.root.style.left, '940px', 'Expanded header should remain draggable');
  header.listeners.pointerdown({
    ...pointer(920, 100, 2), target: { closest: () => true }
  });
  header.listeners.pointermove(pointer(1000, 300, 2));
  assert.equal(headerCase.root.style.left, '940px', 'Header action buttons must not drag');

  const boundary = await runCase(data);
  boundary.pill.listeners.pointerdown(pointer(920, 100));
  boundary.pill.listeners.pointermove(pointer(9999, 9999));
  boundary.pill.listeners.pointerup(pointer(9999, 9999));
  assert.equal(boundary.root.style.left, '1120px', 'Collapsed pill must stay in viewport');
  assert.equal(boundary.root.style.top, '684px');

  const error = await runCase(null, 403);
  assert.equal(error.summary.textContent, '额度不可用');

  const missing = await runCase({ rate_limit: { primary_window: { limit_window_seconds: 18000 } } });
  assert.equal(missing.summary.textContent, '额度不可用', 'Never fabricate missing percentages');

  console.log('PASS: quota parsing, expand, pill drag, click threshold, persistence, resize, HTTP errors');
})().catch(e => {
  console.error(e);
  process.exitCode = 1;
});
