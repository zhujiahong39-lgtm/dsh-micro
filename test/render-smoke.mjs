/**
 * Server-render the settings panel with real React.
 *
 * The bundle is written for the harness webview (`window.__ModuleLoader__`);
 * this harness evaluates it in a vm, hands it the real `react` package and
 * renders the exported section component through react-dom/server. It catches
 * the class of failures that only show up while painting: TDZ, undefined
 * components, bad props.
 *
 *   node .tools/render-smoke.mjs
 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import assert from 'node:assert';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const require = createRequire(import.meta.url);
const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');

const element = () => ({
  dataset: {},
  style: {},
  children: [],
  appendChild(child) {
    this.children.push(child);
  },
  setAttribute() {},
  removeAttribute() {},
  querySelector: () => null,
  scrollIntoView() {},
  addEventListener() {},
  removeEventListener() {},
});

const store = new Map();
const localStorage = {
  getItem: (key) => (store.has(key) ? store.get(key) : null),
  setItem: (key, value) => store.set(key, String(value)),
  removeItem: (key) => store.delete(key),
};

const documentStub = {
  activeElement: null,
  body: element(),
  documentElement: element(),
  head: element(),
  createElement: () => element(),
  querySelector: () => null,
  querySelectorAll: () => [],
  getElementById: () => null,
  addEventListener() {},
  execCommand: () => true,
};

const statePayload = {
  ready: true,
  connected: true,
  device: { type: 'codex_micro', transport: 'usb' },
  devices: [{ type: 'codex_micro', rpc: true }],
  lastStatus: { version: '0.7.8', battery: 96, is_charging: false },
  deviceState: {
    status: 'connected',
    controlPlaneStatus: 'available',
    model: 'codex_micro',
    transport: 'usb',
    battery: 96,
    charging: false,
    firmware: '0.7.8',
    error: null,
  },
  bindings: { ACT06: 'FAST', ACT07: 'APPR', ACT08: 'REJ', ACT09: 'SPLIT', ACT10: 'MIC1', ACT11: 'EMPT1', ACT12: 'CODEX' },
  overrides: {},
  agentSlots: ['s1', null, 's2', null, null, null],
  settings: {
    brightness: 80,
    autoOff: '3-minutes',
    encoderMode: 'composer-navigation',
    agentSource: 'recent',
    splitMic: false,
    singleTapAgentKeys: false,
    autoConnect: true,
  },
};

let registration = null;
const windowStub = {
  __ModuleLoader__: {
    load(options) {
      registration = options;
    },
  },
  localStorage,
  addEventListener() {},
  removeEventListener() {},
  dispatchEvent: () => true,
  getComputedStyle: () => ({ overflowY: 'visible' }),
  scrollBy() {},
  scrollTo() {},
  open() {},
};

const sandbox = {
  window: windowStub,
  document: documentStub,
  console,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  Promise,
  JSON,
  Math,
  Date,
  Object,
  Array,
  String,
  Number,
  Boolean,
  Set,
  Map,
  Error,
  Symbol,
  Reflect,
  CustomEvent: class CustomEvent {
    constructor(type, init) {
      this.type = type;
      this.detail = init?.detail;
    }
  },
  KeyboardEvent: class KeyboardEvent {
    constructor(type, init) {
      Object.assign(this, init);
    }
  },
  Event: class Event {
    constructor(type) {
      this.type = type;
    }
  },
  EventSource: undefined,
  BroadcastChannel: undefined,
  navigator: { clipboard: { writeText: async () => {} } },
  HTMLTextAreaElement: class {},
  fetch: async () => ({ ok: true, status: 200, json: async () => statePayload }),
};
sandbox.globalThis = sandbox;

vm.createContext(sandbox);
vm.runInContext(source, sandbox, { filename: 'client.js' });

const moduleExports = registration.factory((name) => {
  if (name === 'react') return React;
  if (name === 'react/jsx-runtime') return require('react/jsx-runtime');
  throw new Error(`unexpected require: ${name}`);
});

const sessions = [
  { id: 's1', title: '修复登录流程', updatedAt: 30, status: 'working' },
  { id: 's2', title: '整理协议文档', updatedAt: 20, unread: true },
];
const ctx = {
  effect: (fn) => {
    const dispose = fn();
    return typeof dispose === 'function' ? dispose : () => {};
  },
  inject() {},
  get(name) {
    if (name === 'sessions') return { list: sessions };
    return undefined;
  },
  slots: { inject(n, fn) { fn(); }, register: () => () => {} },
};
let section = null;
const panels = new Map();
ctx.slots.register = (options, component) => {
  panels.set(options.name, component);
  section = component;
  return () => {};
};
moduleExports.apply(ctx);
section = panels.get('main');
assert.ok(section, 'no main panel registered');
assert.ok(panels.has('sidebar.panellist'), 'no sidebar panel row registered');

// react-dom/server does not run effects, which is exactly the first paint.
// First paint has no /state yet, which is the state that used to throw (TDZ).
// React reports bad prop usage through console.error. A key spread into props
// still renders, but the dev build logs one warning per call site, and the
// host's console does not belong to us — so collect and assert instead.
const reactWarnings = [];
const realConsoleError = console.error;
console.error = (...args) => {
  reactWarnings.push(args.map((value) => String(value)).join(' '));
  realConsoleError(...args);
};
const html = renderToStaticMarkup(React.createElement(section));
assert.ok(html.includes('DSH Micro'), 'panel title missing');
assert.ok(!html.includes('面板渲染失败'), 'boundary caught a render error');
// The page owns the main column's scroll container, its padding and the top
// strip: a bare body in `main` would overflow the frame instead of scrolling.
assert.ok(html.includes('cm-page'), 'main-panel page wrapper missing');
assert.ok(html.includes('aria-label="DSH Micro"'), 'page landmark lost its accessible name');

// ---- device layout ------------------------------------------------------
// The surface is a 4x4 grid filled in DOM order, so a missing or extra cell
// shifts the rest of the row instead of throwing. 0.3.1 dropped the touch
// strip / LED cell from the bottom row and appended an invisible filler at the
// end, which slid the wide MIC key under ACT06 and left a fake key at the right
// edge. No render error, no failed assertion anywhere — only a positional check
// like this one notices.
assert.ok(html.includes('class="cm-touch"'), 'bottom row lost its touch strip and LED cell');
assert.ok(!html.includes('cm-key-placeholder'), 'the invisible filler cell is back at the end of the grid');
const surfaceAt = html.indexOf('class="cm-surface"');
const touchAt = html.indexOf('class="cm-touch"');
const micAt = html.indexOf('cm-key wide');
assert.ok(surfaceAt >= 0, 'device surface missing from the page');
assert.ok(touchAt > surfaceAt, 'touch strip must be inside the device surface');
assert.ok(
  micAt < 0 || touchAt < micAt,
  'touch strip must come before the wide MIC key: it owns the first column of the bottom row',
);
// Full bottom row, in grid order: ACT09 ends the third row, then the touch
// strip, the MIC key spanning two columns, and ACT12 in the last column.
const row4 = [
  html.indexOf('aria-label="ACT09'),
  html.indexOf('class="cm-touch"'),
  html.indexOf('cm-key wide'),
  html.indexOf('aria-label="ACT12"'),
];
assert.ok(row4.every((at) => at > 0), `bottom row is incomplete: ${row4.join(',')}`);
assert.deepEqual(
  [...row4].sort((a, b) => a - b),
  row4,
  `bottom row is out of order: ${row4.join(',')}`,
);

// The sidebar row renders the icon as its direct child, so the component has to
// return the svg itself at the edge the row asks for — a wrapper div would land
// as a line box inside the row's glyph slot.
const iconHtml = renderToStaticMarkup(React.createElement(panels.get('sidebar.panellist'), { size: 20, active: true }));
assert.ok(iconHtml.startsWith('<svg'), `sidebar icon must render svg as its root, got: ${iconHtml.slice(0, 24)}`);
assert.ok(iconHtml.includes('width="20"'), 'sidebar icon ignored the requested size');
assert.ok(!iconHtml.includes('aria-label'), 'the sidebar row owns the accessible name, not the icon');
for (const row of ['连接', '亮度', '自动调暗', '布局', '智能体按键', '旋钮']) {
  assert.ok(html.includes(row), `row missing: ${row}`);
}
assert.ok(html.includes('未检测到'), 'disconnected status label missing');

// The agent-key tooltip and the layout grid must be built from the catalog.
assert.ok(html.includes('cm-surface'), 'device preview missing');
assert.ok((html.match(/cm-key/g) ?? []).length >= 10, 'layout grid looks empty');

// ---- device card geometry ----------------------------------------------
// The original Codex app draws the device as a SQUARE 4x4 grid capped at
// 15rem (app.asar → webview/assets/async/623696.*.js). A rectangular grid
// stretches the keys and squashes the round controls, which is exactly how the
// card used to look wrong. These numbers are copied from the upstream bundle,
// so pin them here — the DOM assertions above cannot see a wrong aspect ratio.
const css = documentStub.head.children.map((tag) => tag.textContent).join('\n');
const rule = (selector) => {
  const at = css.indexOf(`${selector}{`);
  if (at < 0) return '';
  return css.slice(at + selector.length + 1, css.indexOf('}', at));
};
assert.ok(css.length > 0, 'the panel did not inject its stylesheet');

const surface = rule('.cm-surface');
assert.ok(/aspect-ratio:1\/1/.test(surface), `the device surface must stay square, got: ${surface}`);
assert.ok(/max-width:15rem/.test(surface), `the device surface must cap at 15rem, got: ${surface}`);
assert.ok(/gap:4px/.test(surface), `the 4x4 gutters must be 4px, got: ${surface}`);

// The encoder is 92% of BOTH axes: sizing it by width alone overflows the row
// and flattens the circle.
assert.ok(/width:92%;height:92%/.test(rule('.cm-knob')), `the encoder must be square, got: ${rule('.cm-knob')}`);
assert.ok(/width:72%;height:72%/.test(rule('.cm-stick-knob')), `the joystick puck must be 72%, got: ${rule('.cm-stick-knob')}`);
assert.ok(/width:58%;height:58%/.test(rule('.cm-touch-pad')), `the touch pad must be 58%, got: ${rule('.cm-touch-pad')}`);

// The agent cap keeps its frosted fill; the session status rides on a
// translucent light layer, like the physical backlight. Repainting the whole
// cap with a status gradient is what this replaced.
assert.ok(!/linear-gradient\(180deg/.test(css), 'the agent cap must not be repainted with a status gradient');
assert.ok(css.includes('opacity:var(--cm-light-o)'), 'the status must ride on a translucent light layer');
assert.ok(/--cm-light-o:\.4/.test(css), 'an assigned agent key must light at 40%, matching the original');
assert.ok(/--cm-light-o:0/.test(rule('.cm-key.agent')), 'an unassigned agent key must not light');

// The violet dot marks the key and never carries state.
const dot = rule('.cm-key .cap-dot');
assert.ok(/width:12px/.test(dot) && /height:12px/.test(dot), `the violet dot must stay 12px, got: ${dot}`);
assert.ok(!css.includes('.cap-dot[data-status'), 'the dot must not change colour with the session status');

// The host styles plain elements with a blanket radius whose selector carries
// more weight than a bare class, so `border-radius:999px` loses the cascade
// there: the knob, the joystick puck and the touch pad came out as rounded
// rectangles in the app while this preview showed circles. `!important` wins
// the cascade back, and every round shape needs it.
const roundShapes = (css.match(/border-radius:999px(?!!important)/g) ?? []).length;
assert.equal(roundShapes, 0, `${roundShapes} round shapes lost their radius to the host's blanket rule`);
assert.ok(css.includes('border-radius:999px!important'), 'the round shapes must force their radius');

// Second pass: a connected snapshot (battery row, agent-key colours).
windowStub.__CM_INITIAL_STATE__ = statePayload;
const html2 = renderToStaticMarkup(React.createElement(section));
for (const needle of ['已连接', '96%', '0.7.8', 'USB']) {
  assert.ok(html2.includes(needle), `connected snapshot missing: ${needle}`);
}
assert.ok(!html2.includes('未检测到'), 'connected snapshot still shows the disconnected label');
assert.ok(html2.includes('37adf') === false);

// Assigned agent keys are backlit, empty ones stay dark. The fixture assigns
// slots 0 and 2, so exactly two caps are lit. The automatic scope still fills
// the empty slots with a preview chat, and that must not light them up.
const litCaps = (html2.match(/data-assigned="true"/g) ?? []).length;
const darkCaps = (html2.match(/data-assigned="false"/g) ?? []).length;
assert.equal(litCaps, 2, `expected 2 lit agent keys (s1, s2), got ${litCaps}`);
assert.equal(darkCaps, 4, `expected 4 dark agent keys, got ${darkCaps}`);

// ---- agent-key sources (reference settings §5.1) -------------------------
// The dropdown must actually swap the six chats, not merely reorder a list:
//   pinned   → only the pinned chats, in pin order
//   priority → attention first (unread/waiting/working), then recency
//   custom   → only the user's own picks; nothing is checked by default
const previousGet = ctx.get;
ctx.get = (name) => {
  if (name === 'workspaces') {
    return { list: { getSnapshot: () => ({ pinnedSessionIds: ['s2'] }) } };
  }
  return previousGet(name);
};
const renderWith = (patch) => {
  windowStub.__CM_INITIAL_STATE__ = {
    ...statePayload,
    ...patch,
    settings: { ...statePayload.settings, ...(patch.settings ?? {}) },
  };
  return renderToStaticMarkup(React.createElement(section));
};
const S1 = '修复登录流程';
const S2 = '整理协议文档';

// pinned: s1 is not pinned, so it must not appear at all.
const htmlPinned = renderWith({ agentSlots: ['s2', null, null, null, null, null], settings: { agentSource: 'pinned' } });
assert.ok(htmlPinned.includes(S2), 'pinned mode must show the pinned chat');
assert.ok(!htmlPinned.includes(S1), 'pinned mode must not fall back to unpinned chats');

// priority: s2 is unread, s1 is the current chat, so s2 comes first.
const htmlPriority = renderWith({ agentSlots: ['s2', 's1', null, null, null, null], settings: { agentSource: 'priority' } });
assert.ok(htmlPriority.indexOf(S2) < htmlPriority.indexOf(S1), 'priority mode must put the unread chat first');

// custom: one pick lights one key; the other five stay dark and unassigned
// (the automatic scopes fill them with preview chats, custom must not).
const htmlCustom = renderWith({
  agentSlots: ['s2', null, null, null, null, null],
  customSlots: ['s2', null, null, null, null, null],
  settings: { agentSource: 'custom' },
});
assert.equal((htmlCustom.match(/data-assigned="true"/g) ?? []).length, 1, 'custom mode lights only the picked key');
assert.equal((htmlCustom.match(/data-assigned="false"/g) ?? []).length, 5, 'custom mode leaves the rest unchecked');
assert.ok(htmlCustom.includes('未给智能体键 2'), 'custom mode must show the empty slot, not a preview chat');
ctx.get = previousGet;

// Third pass: the two dialogs I rewrote, opened through the debug hooks.
windowStub.__CM_DEBUG_EDITOR__ = 'ACT06';
const htmlEditor = renderToStaticMarkup(React.createElement(section));
assert.ok(htmlEditor.includes('编辑键帽'), 'keycap editor did not open');
assert.ok(htmlEditor.includes('搜索键帽'), 'editor search box missing');
windowStub.__CM_DEBUG_EDITOR__ = 'STICK';
const htmlStick = renderToStaticMarkup(React.createElement(section));
assert.ok(htmlStick.includes('模拟摇杆') || htmlStick.includes('摇杆方向映射'), 'stick editor did not open');
delete windowStub.__CM_DEBUG_EDITOR__;

windowStub.__CM_DEBUG_AGENT__ = '0';
const htmlAgent = renderToStaticMarkup(React.createElement(section));
assert.ok(htmlAgent.includes('分配'), 'agent key dialog did not open');
delete windowStub.__CM_DEBUG_AGENT__;

// Every string must resolve: a raw key in the markup means a message that no
// dictionary covers, and it would ship as gibberish to users.
const KEY_PREFIX =
  'panel|state|action|device|options|editor|agent|knob|encoder|analog|catalog|toast|log|diag|cmd|cmdDesc|keycap|summary|dialog|gesture|short|status|editor|reset|meta';
const leaked = (haystack) =>
  (haystack.match(new RegExp(`\\b(?:${KEY_PREFIX})\\.[A-Za-z][A-Za-z0-9.]*\\b`)) ?? [])[0];
for (const [label, markup] of [
  ['initial', html],
  ['connected', html2],
  ['keycap editor', htmlEditor],
  ['stick editor', htmlStick],
  ['agent dialog', htmlAgent],
]) {
  assert.ok(!leaked(markup), `raw message key leaked into ${label}: ${leaked(markup)}`);
}

// The built-in dictionaries follow <html lang>: DSH's locale plugin sets it on
// every language switch, so the panel keeps following the user even when the
// Host locale service is missing or its dictionary registration was rejected.
const { builtinLocale } = moduleExports.__internals;
documentStub.documentElement.lang = 'en';
assert.equal(builtinLocale(), 'en', '<html lang="en"> must select the English dictionary');
documentStub.documentElement.lang = 'zh-CN';
assert.equal(builtinLocale(), 'zh', 'a Chinese document must select the Chinese dictionary');
delete documentStub.documentElement.lang;
assert.equal(builtinLocale(), 'zh', 'no document language falls back to Chinese');

// Fourth pass: English. The Host locale service indexes the dictionary by key
// and substitutes `{name}`; mimic that and render again. This is the check that
// the whole migration exists for — copy the panel shows in a second language.
const localeDicts = new Map();
const fakeLocale = {
  register(namespace, dictionaries) {
    for (const [lang, dict] of Object.entries(dictionaries)) {
      localeDicts.set(`${namespace}:${lang}`, dict);
    }
    return () => {};
  },
  bind(namespace) {
    return (key, params) => {
      const template = localeDicts.get(`${namespace}:en`)?.[key];
      if (template === undefined) return key;
      if (!params) return template;
      return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match));
    };
  },
};

const ctxEn = {
  effect: (fn) => {
    const dispose = fn();
    return typeof dispose === 'function' ? dispose : () => {};
  },
  inject(names, fn) {
    if (names.includes('locale')) fn({ locale: fakeLocale });
  },
  get(name) {
    if (name === 'sessions') return { list: sessions };
    return undefined;
  },
  slots: {
    inject(name, fn) {
      fn();
    },
    register(options, component) {
      if (options.name === 'main') section = component;
      return () => {};
    },
  },
};

moduleExports.apply(ctxEn);
assert.ok(localeDicts.has('dsh-micro:en'), 'english dictionary was not registered');

const htmlEn = renderToStaticMarkup(React.createElement(section));
for (const needle of ['Connection', 'Firmware', 'Battery', 'DSH Micro']) {
  assert.ok(htmlEn.includes(needle), `english panel missing: ${needle}`);
}
// Chat titles come from the user's data and stay as-is; everything else must be
// English, or the panel is mixing languages again.
const userData = /修复登录流程|整理协议文档/g;
assert.ok(
  !/[\u4e00-\u9fff]/.test(htmlEn.replace(userData, '')),
  'english panel still contains Chinese copy',
);
assert.ok(!leaked(htmlEn), `raw message key leaked into english panel: ${leaked(htmlEn)}`);

// Composer overlay: the HUD and the mini-game hang above the chat input, as in
// the reference (composer context), not only inside the panel.
const ctrl = moduleExports.__controller();
assert.ok(ctrl, 'controller missing after apply()');
const composerNode = {
  nodeType: 1,
  isConnected: true,
  tagName: 'TEXTAREA',
  disabled: false,
  readOnly: false,
  closest: () => null,
  getBoundingClientRect: () => ({ left: 320, right: 960, top: 700, bottom: 744, width: 640, height: 44 }),
};
const plainQuerySelectorAll = documentStub.querySelectorAll;
const plainQuerySelector = documentStub.querySelector;
windowStub.innerHeight = 900;
documentStub.querySelectorAll = (selector) =>
  String(selector).includes('contenteditable') || String(selector).includes('textarea') ? [composerNode] : [];
ctrl.hud = {
  action: 'plan.toggle',
  actionTitle: '计划模式',
  direction: 'up',
  status: 'tracked',
  visible: true,
  gameActivationProgress: 0,
  event: { angle: 0.75, distance: 0.6 },
};
const hudHtml = renderToStaticMarkup(React.createElement(moduleExports.__components.ComposerOverlay));
assert.ok(hudHtml.includes('cm-overlay'), 'overlay root was not rendered');
assert.ok(hudHtml.includes('cm-hud'), 'HUD was not rendered into the overlay');
assert.ok(hudHtml.includes('计划模式'), 'HUD lost the action title');
assert.ok(hudHtml.includes('top:700') || hudHtml.includes('bottom:'), 'overlay was not positioned above the composer');

ctrl.game = { id: 'snake', joystick: { angle: 0, distance: 0 }, fireRequested: false, startedAt: Date.now() };
const gameHtml = renderToStaticMarkup(React.createElement(moduleExports.__components.ComposerOverlay));
assert.ok(gameHtml.includes('cm-game-card'), 'the mini-game was not rendered into the overlay');
assert.ok(gameHtml.includes('cm-game-canvas'), 'the mini-game canvas is missing');
ctrl.game = null;
ctrl.hud = { action: null, actionTitle: null, direction: 'right', status: 'tracking', visible: false, gameActivationProgress: 0, event: { angle: 0, distance: 0 } };

// Panel open: the panel already draws the HUD/game, so the overlay must stay out
// of the way instead of double-rendering (and double-stepping) the game.
documentStub.querySelector = (selector) =>
  String(selector) === '.cm-root' ? { getBoundingClientRect: () => ({ width: 640, height: 900 }) } : null;
assert.equal(renderToStaticMarkup(React.createElement(moduleExports.__components.ComposerOverlay)), '', 'overlay must stay hidden while the panel is mounted');
// A panel node left mounted but not visible must not suppress the overlay.
ctrl.hud = { ...ctrl.hud, visible: true };
documentStub.querySelector = (selector) =>
  String(selector) === '.cm-root' ? { getBoundingClientRect: () => ({ width: 0, height: 0 }) } : null;
assert.ok(
  renderToStaticMarkup(React.createElement(moduleExports.__components.ComposerOverlay)).includes('cm-overlay'),
  'a hidden panel must not hide the composer overlay',
);
documentStub.querySelector = plainQuerySelector;
documentStub.querySelectorAll = plainQuerySelectorAll;

const keyWarnings = reactWarnings.filter((line) => /key[^\n]*(prop|spread)|spread[^\n]*key/i.test(line));
assert.deepEqual(keyWarnings, [], `React key-in-props warning: ${keyWarnings[0] ?? ''}`);

console.log('render smoke test: OK,', html.length, '/', html2.length, 'bytes of markup');
console.log('  dialogs: keycap', htmlEditor.length, '| stick', htmlStick.length, '| agent', htmlAgent.length);
console.log('  english pass:', htmlEn.length, 'bytes, no Chinese copy, no raw keys');
