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
    voiceButtonMode: 'push-to-talk',
    joystickDisabled: false,
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
ctx.slots.register = (options, component) => {
  section = component;
  return () => {};
};
moduleExports.apply(ctx);
assert.ok(section, 'no section component registered');

// react-dom/server does not run effects, which is exactly the first paint.
// First paint has no /state yet, which is the state that used to throw (TDZ).
const html = renderToStaticMarkup(React.createElement(section));
assert.ok(html.includes('Codex Micro'), 'panel title missing');
assert.ok(!html.includes('面板渲染失败'), 'boundary caught a render error');
for (const row of ['连接', '亮度', '自动调暗', '布局', '智能体按键', '旋钮', '麦克风键', '模拟摇杆']) {
  assert.ok(html.includes(row), `row missing: ${row}`);
}
assert.ok(html.includes('未检测到'), 'disconnected status label missing');

// The agent-key tooltip and the layout grid must be built from the catalog.
assert.ok(html.includes('cm-surface'), 'device preview missing');
assert.ok((html.match(/cm-key/g) ?? []).length >= 10, 'layout grid looks empty');

// Second pass: a connected snapshot (battery row, agent-key colours).
windowStub.__CM_INITIAL_STATE__ = statePayload;
const html2 = renderToStaticMarkup(React.createElement(section));
for (const needle of ['已连接', '96%', '0.7.8', 'USB']) {
  assert.ok(html2.includes(needle), `connected snapshot missing: ${needle}`);
}
assert.ok(!html2.includes('未检测到'), 'connected snapshot still shows the disconnected label');
assert.ok(html2.includes('37adf') === false);

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
      section = component;
      return () => {};
    },
  },
};

moduleExports.apply(ctxEn);
assert.ok(localeDicts.has('codex-micro:en'), 'english dictionary was not registered');

const htmlEn = renderToStaticMarkup(React.createElement(section));
for (const needle of ['Connection', 'Firmware', 'Battery', 'Codex Micro']) {
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

console.log('render smoke test: OK,', html.length, '/', html2.length, 'bytes of markup');
console.log('  dialogs: keycap', htmlEditor.length, '| stick', htmlStick.length, '| agent', htmlAgent.length);
console.log('  english pass:', htmlEn.length, 'bytes, no Chinese copy, no raw keys');
