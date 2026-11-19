// ==UserScript==
// @name         ChatGPT 额度速览
// @name:en      ChatGPT Quota Dock
// @namespace    https://chatgpt.com/
// @version      1.1.0
// @description  在 ChatGPT 页面显示可读取的剩余额度、重置时间和刷新状态
// @description:en Displays available ChatGPT quota windows and reset countdowns.
// @author       marce006982
// @match        https://chatgpt.com/*
// @match        https://www.chatgpt.com/*
// @run-at       document-idle
// @noframes
// @grant        none
// @homepageURL  https://github.com/marce006982/chatgpt-usage-dock
// @supportURL   https://github.com/marce006982/chatgpt-usage-dock/issues
// @updateURL    https://raw.githubusercontent.com/marce006982/chatgpt-usage-dock/main/chatgpt-usage-dock.user.js
// @downloadURL  https://raw.githubusercontent.com/marce006982/chatgpt-usage-dock/main/chatgpt-usage-dock.user.js
// ==/UserScript==

(function () {
  'use strict';

  // ChatGPT's usage endpoint is undocumented and may change. No information
  // is sent to third parties; session data is kept in memory only.
  if (window.top !== window || document.getElementById('cgqd-root')) return;

  const REFRESH_MS = 5 * 60 * 1000;
  const URL_USAGE = '/backend-api/wham/usage';
  const URL_SESSION = '/api/auth/session';
  const URL_SETTINGS = 'https://chatgpt.com/settings/usage';
  const state = { records: [], refreshed: 0, attempted: 0, error: '', busy: false };
  const LS = 'cgqd-v1-';

  function getPreference(key) {
    try { return localStorage.getItem(LS + key); } catch (_) { return null; }
  }
  function setPreference(key, value) {
    try { localStorage.setItem(LS + key, value); } catch (_) { /* optional */ }
  }
  function numeric(x) {
    if (x === undefined || x === null || x === '') return null;
    const n = Number(x);
    return Number.isFinite(n) ? n : null;
  }
  function limit(x, a, b) { return Math.min(Math.max(x, a), b); }
  function nested(obj, names, depth, seen) {
    if (!obj || typeof obj !== 'object' || depth > 7 || seen.has(obj)) return null;
    seen.add(obj);
    for (const name of names) {
      if (Object.prototype.hasOwnProperty.call(obj, name) && obj[name] != null) return obj[name];
    }
    for (const child of Object.values(obj)) {
      if (child && typeof child === 'object') {
        const hit = nested(child, names, depth + 1, seen);
        if (hit != null) return hit;
      }
    }
    return null;
  }
  function field(obj, names) { return nested(obj, names, 0, new Set()); }
  function jwtClaims(token) {
    try {
      const payload = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      return JSON.parse(atob(payload.padEnd(Math.ceil(payload.length / 4) * 4, '=')));
    } catch (_) { return null; }
  }
  async function getJson(url, headers) {
    const controller = new AbortController();
    const timeout = setTimeout(function () { controller.abort(); }, 12000);
    try {
      const result = await fetch(url, {
        method: 'GET', credentials: 'include', cache: 'no-store',
        headers: Object.assign({ Accept: 'application/json' }, headers || {}),
        signal: controller.signal
      });
      if (!result.ok) throw new Error('HTTP ' + result.status);
      return await result.json();
    } finally {
      clearTimeout(timeout);
    }
  }
  async function retrieve() {
    const headers = {};
    try {
      const session = await getJson(URL_SESSION);
      const token = field(session, ['accessToken', 'access_token']);
      if (typeof token === 'string' && token) {
        headers.Authorization = 'Bearer ' + token;
        const account = field(session, ['chatgpt_account_id', 'chatgptAccountId', 'account_id'])
          || field(jwtClaims(token), ['chatgpt_account_id', 'chatgptAccountId', 'account_id']);
        if (typeof account === 'string' && account) {
          headers['ChatGPT-Account-Id'] = account;
        }
      }
    } catch (_) {
      // Try same-origin cookies if the session endpoint is unavailable.
    }
    return getJson(URL_USAGE, headers);
  }
  function normalize(raw, category) {
    if (!raw || typeof raw !== 'object') return null;
    const used = numeric(raw.used_percent);
    // Do not pretend a quota percentage exists when the server omitted it.
    if (used === null) return null;
    const seconds = numeric(raw.limit_window_seconds) || 0;
    let reset = numeric(raw.reset_at);
    if (reset !== null) reset = reset > 1e12 ? reset : reset * 1000;
    else {
      const after = numeric(raw.reset_after_seconds);
      reset = after !== null ? Date.now() + after * 1000 : null;
    }
    return { category: category, seconds: seconds, remaining: limit(100 - used, 0, 100), reset: reset };
  }
  function parseUsage(data) {
    if (!data || typeof data !== 'object') return [];
    const sources = [{ name: '通用额度', data: data.rate_limit || data.rate_limits }];
    const additional = Array.isArray(data.additional_rate_limits) ? data.additional_rate_limits : [];
    additional.forEach(function (item) {
      sources.push({
        name: item.limit_name || item.metered_feature || '其他额度',
        data: item.rate_limit || item.rate_limits
      });
    });
    const windows = [];
    sources.forEach(function (item) {
      ['primary_window', 'secondary_window'].forEach(function (key) {
        const info = normalize(item.data && item.data[key], item.name);
        if (info) windows.push(info);
      });
    });
    return windows.sort(function (a, b) {
      return (a.category === '通用额度' ? 0 : 1) - (b.category === '通用额度' ? 0 : 1)
        || a.seconds - b.seconds;
    });
  }
  function period(s) {
    if (!s) return '额度';
    if (Math.abs(s - 18000) < 3600) return '5小时';
    if (Math.abs(s - 604800) < 18000) return '7天';
    if (s >= 86400) return Math.round(s / 86400) + '天';
    if (s >= 3600) return Math.round(s / 3600) + '小时';
    return Math.round(s / 60) + '分钟';
  }
  function countdown(ms) {
    if (!ms) return '重置时间未提供';
    const s = Math.max(0, Math.ceil((ms - Date.now()) / 1000));
    if (!s) return '已到重置时间';
    const d = Math.floor(s / 86400);
    const h = Math.floor(s % 86400 / 3600);
    const m = Math.ceil(s % 3600 / 60);
    if (d) return d + '天' + h + '小时';
    if (h) return h + '小时' + m + '分';
    return m + '分钟';
  }

  const css = document.createElement('style');
  css.textContent = [
    '#cgqd-root{position:fixed;top:84px;right:20px;z-index:2147483000;color:var(--text-primary,#222);font:12px/1.5 "Segoe UI","Microsoft YaHei",sans-serif;user-select:none}',
    '#cgqd-root *{box-sizing:border-box}',
    '#cgqd-root button{font:inherit;color:inherit;cursor:pointer}',
    '#cgqd-root .cgqd-pill{display:flex;align-items:center;gap:7px;padding:6px 11px;border-radius:25px;border:1px solid var(--border-light,#ddd);background:var(--main-surface-primary,#fff);box-shadow:0 4px 14px #0002;font-weight:600;max-width:275px;cursor:grab;touch-action:none}',
    '#cgqd-root .cgqd-pill:active{cursor:grabbing}',
    '#cgqd-root .cgqd-dot{width:7px;height:7px;flex-shrink:0;background:#888;border-radius:50%}',
    '#cgqd-root .cgqd-panel{width:292px;max-width:calc(100vw - 25px);margin-top:7px;background:var(--main-surface-primary,#fff);border:1px solid var(--border-light,#ddd);border-radius:12px;padding:13px;box-shadow:0 6px 24px #0002}',
    '#cgqd-root [hidden]{display:none!important}',
    '#cgqd-root .cgqd-header{display:flex;align-items:center;justify-content:space-between;font-weight:600;cursor:move;touch-action:none}',
    '#cgqd-root .cgqd-actions button{background:none;border:0;padding:4px 6px;border-radius:5px}',
    '#cgqd-root .cgqd-actions button:hover{background:#8882}',
    '#cgqd-root .cgqd-row{display:flex;justify-content:space-between;gap:8px;margin:12px 0 5px}',
    '#cgqd-root .cgqd-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '#cgqd-root .cgqd-pct{font-weight:700;font-variant-numeric:tabular-nums}',
    '#cgqd-root .cgqd-track{height:6px;border-radius:8px;background:#8883;overflow:hidden}',
    '#cgqd-root .cgqd-fill{height:100%;background:#278675}',
    '#cgqd-root .cgqd-reset{font-size:11px;color:var(--text-secondary,#888);margin-top:4px}',
    '#cgqd-root .cgqd-bottom{border-top:1px solid var(--border-light,#ddd);padding-top:8px;margin-top:12px;display:flex;justify-content:space-between;gap:8px;color:var(--text-secondary,#888);font-size:11px}',
    '#cgqd-root .cgqd-bottom a{color:inherit;text-decoration:underline}',
    '#cgqd-root .cgqd-error{font-size:11px;color:#bc7440;margin-top:8px}',
    '@media (prefers-color-scheme:dark){#cgqd-root .cgqd-panel,#cgqd-root .cgqd-pill{background:var(--main-surface-primary,#262626);border-color:var(--border-light,#555)}}'
  ].join('\n');
  (document.head || document.documentElement).appendChild(css);

  function node(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }
  const root = node('div'); root.id = 'cgqd-root';
  const pill = node('button', 'cgqd-pill'); pill.type = 'button';
  const dot = node('span', 'cgqd-dot');
  const summary = node('span', '', '额度读取中…'); pill.append(dot, summary);
  const panel = node('section', 'cgqd-panel'); panel.hidden = true;
  const header = node('div', 'cgqd-header');
  const heading = node('span', '', 'ChatGPT 剩余额度');
  const actions = node('span', 'cgqd-actions');
  const refreshButton = node('button', '', '↻ 刷新');
  refreshButton.type = 'button';
  const closeButton = node('button', '', '×');
  closeButton.type = 'button';
  actions.append(refreshButton, closeButton); header.append(heading, actions);
  const body = node('div');
  const bottom = node('div', 'cgqd-bottom');
  const updated = node('span', '', '尚未读取');
  const link = node('a', '', '官方使用情况');
  link.href = URL_SETTINGS; link.target = '_blank'; link.rel = 'noopener noreferrer';
  bottom.append(updated, link);
  panel.append(header, body, bottom); root.append(pill, panel);
  (document.body || document.documentElement).appendChild(root);

  function open(value) {
    panel.hidden = !value;
    pill.setAttribute('aria-expanded', String(value));
    setPreference('expanded', value ? 'yes' : 'no');
    // Expanding the wider details panel must not push it offscreen.
    if (root.style.left) keepInView();
  }
  let suppressPillClick = false;
  pill.addEventListener('click', function (e) {
    if (suppressPillClick && e && e.detail !== 0) {
      suppressPillClick = false;
      e.preventDefault();
      return;
    }
    suppressPillClick = false;
    open(panel.hidden);
  });
  closeButton.addEventListener('click', function () { open(false); });
  refreshButton.addEventListener('click', function () { refresh(); });
  open(getPreference('expanded') === 'yes');

  function render() {
    const primary = state.records.filter(function (x) { return x.category === '通用额度'; });
    const shown = (primary.length ? primary : state.records).slice(0, 2);
    summary.textContent = shown.length
      ? shown.map(function (x) { return period(x.seconds) + ' ' + Math.round(x.remaining) + '%'; }).join(' · ')
      : (state.error ? '额度不可用' : '额度读取中…');
    dot.style.background = state.error ? '#bc7440' : state.records.length ? '#278675' : '#999';
    body.replaceChildren();
    if (!state.records.length) body.appendChild(node('p', '', state.busy ? '正在读取…' : '没有可显示的额度数据'));
    state.records.forEach(function (x) {
      const wrap = node('div');
      const row = node('div', 'cgqd-row');
      row.append(
        node('span', 'cgqd-name', (x.category === '通用额度' ? '' : x.category + ' · ') + period(x.seconds)),
        node('span', 'cgqd-pct', Math.round(x.remaining) + '%')
      );
      const track = node('div', 'cgqd-track');
      const fill = node('div', 'cgqd-fill');
      fill.style.width = x.remaining + '%';
      if (x.remaining <= 15) fill.style.background = '#b67245';
      track.append(fill);
      const reset = node('div', 'cgqd-reset', '距离重置：' + countdown(x.reset));
      if (x.reset) {
        reset.dataset.reset = String(x.reset);
        reset.title = new Date(x.reset).toLocaleString('zh-CN');
      }
      wrap.append(row, track, reset);
      body.append(wrap);
    });
    if (state.error) body.append(node('div', 'cgqd-error', state.error));
    updated.textContent = state.refreshed
      ? '更新于 ' + new Date(state.refreshed).toLocaleTimeString('zh-CN')
          + (state.error ? '（旧数据）' : '')
      : '尚未成功读取';
    refreshButton.disabled = state.busy;
  }

  async function refresh() {
    if (state.busy) return;
    state.busy = true;
    state.error = '';
    state.attempted = Date.now();
    render();
    try {
      const result = parseUsage(await retrieve());
      if (!result.length) throw new Error('EMPTY_WINDOWS');
      state.records = result;
      state.refreshed = Date.now();
    } catch (e) {
      const message = String(e && e.message || e);
      state.error = message.includes('401') || message.includes('403')
        ? '登录认证失败；请刷新 ChatGPT 后重试'
        : message.includes('404')
          ? '用量接口不可用（404），可能已调整'
          : message === 'EMPTY_WINDOWS'
            ? '接口未返回可识别的额度窗口'
            : '读取失败；请展开面板手动刷新';
    } finally {
      state.busy = false;
      render();
    }
  }

  // Both the collapsed pill and the expanded header are drag handles.
  // Only a movement of at least 5px counts as dragging, so clicking still opens the panel.
  function placeAt(left, top) {
    const rect = root.getBoundingClientRect();
    root.style.left = limit(left, 0, Math.max(0, window.innerWidth - rect.width)) + 'px';
    root.style.top = limit(top, 0, Math.max(0, window.innerHeight - rect.height)) + 'px';
    root.style.right = 'auto';
  }
  function keepInView() {
    if (!root.style.left || !root.style.top) return;
    placeAt(parseFloat(root.style.left), parseFloat(root.style.top));
  }
  function savePosition() {
    setPreference('position', JSON.stringify({ left: root.style.left, top: root.style.top }));
  }

  let drag = null;
  function enableDrag(handle, ignoreActions) {
    handle.addEventListener('pointerdown', function (e) {
      if (e.button !== 0 || (ignoreActions && e.target.closest('button,a'))) return;
      if (handle === pill) suppressPillClick = false;
      const rect = root.getBoundingClientRect();
      drag = {
        handle: handle, pointerId: e.pointerId, x: e.clientX, y: e.clientY,
        left: rect.left, top: rect.top, moved: false
      };
      handle.setPointerCapture(e.pointerId);
    });
    handle.addEventListener('pointermove', function (e) {
      if (!drag || drag.handle !== handle || drag.pointerId !== e.pointerId) return;
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) < 5) return;
      drag.moved = true;
      if (handle === pill) suppressPillClick = true;
      placeAt(drag.left + dx, drag.top + dy);
    });
    function finishDrag(e) {
      if (!drag || drag.handle !== handle || drag.pointerId !== e.pointerId) return;
      if (drag.moved) savePosition();
      drag = null;
    }
    handle.addEventListener('pointerup', finishDrag);
    handle.addEventListener('pointercancel', finishDrag);
    handle.addEventListener('lostpointercapture', finishDrag);
  }
  enableDrag(pill, false);
  enableDrag(header, true);

  try {
    const position = JSON.parse(getPreference('position') || 'null');
    if (position && Number.isFinite(parseFloat(position.left)) &&
        Number.isFinite(parseFloat(position.top))) {
      placeAt(parseFloat(position.left), parseFloat(position.top));
    }
  } catch (_) { /* no saved position */ }
  window.addEventListener('resize', function () {
    if (!root.style.left) return;
    keepInView();
    savePosition();
  });

  // Refresh while visible; keep the displayed reset time counting down.
  setInterval(function () {
    root.querySelectorAll('[data-reset]').forEach(function (item) {
      item.textContent = '距离重置：' + countdown(Number(item.dataset.reset));
    });
  }, 30000);
  setInterval(function () { if (!document.hidden) refresh(); }, REFRESH_MS);
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && Date.now() - state.attempted >= REFRESH_MS) refresh();
  });
  refresh();
})();
