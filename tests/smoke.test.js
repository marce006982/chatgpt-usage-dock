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
  getBoundingClientRect() { return { left: 900, top: 84 }; }
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

async function runCase(data, httpStatus) {
  const document = {
    head: new Element('head'),
    body: new Element('body'),
    documentElement: new Element('html'),
    hidden: false,
    createElement: tag => new Element(tag),
    getElementById: () => null,
    addEventListener: () => {}
  };
  const window = { innerWidth: 1280, innerHeight: 720 };
  window.top = window;
  const session = { accessToken: 'sample.invalid.token' };
  const requests = [];
  const context = {
    window, document,
    localStorage: { getItem: () => null, setItem: () => {} },
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
  return { root, panel, pill, summary, requests };
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
  result.pill.listeners.click();
  assert.equal(result.panel.hidden, false, 'Pill should expand details');

  const error = await runCase(null, 403);
  assert.equal(error.summary.textContent, '额度不可用');

  const missing = await runCase({ rate_limit: { primary_window: { limit_window_seconds: 18000 } } });
  assert.equal(missing.summary.textContent, '额度不可用', 'Never fabricate missing percentages');

  console.log('PASS: DOM mount, quota parsing, extra window, expand, HTTP error, missing data');
})().catch(e => {
  console.error(e);
  process.exitCode = 1;
});
