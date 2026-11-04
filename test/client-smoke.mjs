/**
 * Offline smoke test for lib/client.js.
 *
 * The bundle normally runs inside the harness webview behind
 * `window.__ModuleLoader__`. This stub provides just enough DOM + React to
 * evaluate the module, run apply(), and drive the Controller through a few
 * hardware events — which is where the interesting logic lives.
 *
 *   node .tools/client-smoke.mjs
 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert';

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
  execCommand() {
    return true;
  },
};

const React = {
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect() {},
  useRef: (initial) => ({ current: initial }),
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
  Component: class {
    constructor(props) {
      this.props = props;
    }
    setState() {}
  },
};

const jsx = (type, props) => ({ type, props });
const runtime = { jsx, jsxs: jsx, Fragment: 'Fragment' };

let registration = null;
// Count what the controller attaches: disposal is only provable if the stub
// remembers who subscribed, and `stop()` must leave nothing behind.
const windowListeners = new Map();
const broadcastChannels = [];
const windowStub = {
  __ModuleLoader__: {
    load(options) {
      registration = options;
    },
  },
  localStorage,
  addEventListener(type, fn) {
    if (!windowListeners.has(type)) windowListeners.set(type, new Set());
    windowListeners.get(type).add(fn);
  },
  removeEventListener(type, fn) {
    windowListeners.get(type)?.delete(fn);
  },
  dispatchEvent: () => true,
  getComputedStyle: () => ({ overflowY: 'visible' }),
  scrollBy() {},
  scrollTo() {},
  open() {},
  CustomEvent: class {},
  KeyboardEvent: class {},
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
  BroadcastChannel: class BroadcastChannelStub {
    constructor(name) {
      this.name = name;
      this.closed = false;
      this.onmessage = null;
      broadcastChannels.push(this);
    }
    postMessage() {}
    close() {
      this.closed = true;
    }
  },
  fetch: async () => ({ ok: true, json: async () => ({}) }),
  navigator: { clipboard: { writeText: async () => {} } },
  HTMLTextAreaElement: class {},
};
sandbox.globalThis = sandbox;

vm.createContext(sandbox);
vm.runInContext(source, sandbox, { filename: 'client.js' });

assert.ok(registration, 'module did not register with the loader');
const moduleExports = registration.factory((name) => {
  if (name === 'react') return React;
  if (name === 'react/jsx-runtime') return runtime;
  throw new Error(`unexpected require: ${name}`);
});
assert.equal(typeof moduleExports.apply, 'function', 'apply() missing');
assert.ok(Array.isArray(moduleExports.__KEYCAPS) && moduleExports.__KEYCAPS.length === 39, 'expected 39 keycaps');

// 1. every keycap resolves to something executable except the blank ones
const blank = new Set(['EMPT1', 'EMPT2', 'EMPT3', 'EMPT4', 'EMPT5']);
const unresolved = moduleExports.__KEYCAPS.filter(
  (keycap) => keycap.action === 'noop' && !blank.has(keycap.id),
);
assert.deepEqual(unresolved.map((k) => k.id), [], `keycaps still defaulting to noop: ${unresolved.map((k) => k.id)}`);

// 2. action model round-trip
const { actionFromReference, parseAction, actionLabel } = moduleExports.__internals;
assert.equal(actionFromReference({ type: 'named', label: 'Push to talk' }), 'ptt');
assert.equal(actionFromReference({ type: 'composer-text', text: ':yolo:' }), 'text::yolo:');
assert.equal(actionFromReference({ type: 'external-url', url: 'https://x' }), 'url:https://x');
assert.equal(actionFromReference({ type: 'command', command: 'forkThread' }), 'session.fork');
assert.equal(actionFromReference({ type: 'custom-shortcut' }), 'noop');
assert.deepEqual(parseAction('text::yolo:'), { type: 'text', value: ':yolo:' });
assert.equal(actionLabel('command:git.commit'), 'Git 提交');

// 3. apply() wires the settings section
let section = null;
const effects = [];
const ctx = {
  effect(fn, label) {
    effects.push(label);
    const dispose = fn();
    return typeof dispose === 'function' ? dispose : () => {};
  },
  inject() {},
  get() {
    return undefined;
  },
  slots: {
    inject(name, fn) {
      fn();
    },
    register(options, component) {
      section = { options, component };
      return () => {};
    },
  },
};
moduleExports.apply(ctx);
assert.ok(section, 'settings section was not registered');
assert.equal(section.options.id, 'codex-micro');

console.log('client.js smoke test: OK');
console.log('  keycaps:', moduleExports.__KEYCAPS.length, '| executable:', moduleExports.__KEYCAPS.filter((k) => k.action !== 'noop').length);
console.log('  effects:', effects.join(' | '));

// ---------------------------------------------------------------- runtime
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ctrl = moduleExports.__controller();
assert.ok(ctrl, 'controller was not created by apply()');
ctrl.owner = true; // bypass the cross-window lease in this single-realm test

const opened = [];
const services = {
  sessions: {
    list: [
      { id: 's1', title: '第一个', updatedAt: 30, status: 'working' },
      { id: 's2', title: '第二个', updatedAt: 20, unread: true },
      { id: 's3', title: '第三个', updatedAt: 10 },
    ],
  },
  uiWorkspace: {
    openSession: (id) => opened.push(id),
    startSession: () => 's9',
  },
};
ctx.get = (name) => services[name];

// 1. double-tap an agent key opens exactly one chat
ctrl.onKey({ k: 'AG00', act: 1 });
ctrl.onKey({ k: 'AG00', act: 0 });
ctrl.onKey({ k: 'AG00', act: 1 });
assert.deepEqual(opened, ['s1'], `agent double tap opened ${JSON.stringify(opened)}`);

// 2. a single tap alone must not open anything
opened.length = 0;
ctrl.onKey({ k: 'AG01', act: 1 });
ctrl.onKey({ k: 'AG01', act: 0 });
await sleep(420);
assert.deepEqual(opened, [], 'single tap opened a chat without singleTapAgentKeys');

// 3. split-mic off drops the second switch
const dispatched = [];
ctrl.dispatch = async (action) => {
  dispatched.push(action);
};
ctrl.onKey({ k: 'ACT11', act: 1 });
assert.deepEqual(dispatched, [], 'ACT11 must be ignored while the mic key is merged');

// 4. knob: 500 ms press becomes a long press, release then must not click
ctrl.onKey({ k: 'ENC', act: 1 });
await sleep(560);
assert.ok(dispatched.includes('settings.open'), `long press did not open settings: ${dispatched}`);
dispatched.length = 0;
ctrl.onKey({ k: 'ENC', act: 0 });
assert.deepEqual(dispatched, [], 'release after a long press must not fire a click');

// 5. knob: short press release is a click (custom mode uses the ENC binding)
ctrl.settings.encoderMode = 'custom';
ctrl.bindings = { ...ctrl.bindings, ENC: 'session.new' };
ctrl.onKey({ k: 'ENC', act: 1 });
ctrl.onKey({ k: 'ENC', act: 0 });
await sleep(10);
assert.deepEqual(dispatched, ['session.new'], `short press click: ${dispatched}`);

// 6. knob rotation in reasoning mode: clockwise lowers effort
dispatched.length = 0;
ctrl.settings.encoderMode = 'reasoning';
ctrl.knob.lastPulseAt = 0;
ctrl.onKey({ k: 'ENC_CW', act: 1 });
await sleep(10);
assert.deepEqual(dispatched, ['effort.down'], `reasoning rotation: ${dispatched}`);
dispatched.length = 0;
ctrl.knob.lastPulseAt = 0;
ctrl.onKey({ k: 'ENC_CC', act: 1 });
await sleep(10);
assert.deepEqual(dispatched, ['effort.up'], `reasoning rotation (ccw): ${dispatched}`);

// 7. push-to-talk: short tap latches, second tap stops
let voiceStarts = 0;
let voiceStops = 0;
ctrl.voiceStart = () => {
  voiceStarts += 1;
};
ctrl.voiceStop = () => {
  voiceStops += 1;
};
ctrl.onKey({ k: 'ACT10', act: 1 });
ctrl.onKey({ k: 'ACT10', act: 0 });
assert.equal(ctrl.ptt.state, 'latched', `ptt state after short tap: ${ctrl.ptt.state}`);
assert.equal(voiceStarts, 1);
ctrl.onKey({ k: 'ACT10', act: 1 });
assert.equal(ctrl.ptt.state, 'idle');
assert.equal(voiceStops, 1);

// 8. joystick right maps to the STICK_RIGHT binding
dispatched.length = 0;
ctrl.lastStick = 0;
ctrl.settings.joystickDisabled = false;
ctrl.onStick({ d: 0.9, a: 0.0 });
await sleep(10);
assert.deepEqual(dispatched, ['session.next'], `joystick right: ${dispatched}`);

// 9. lighting model reflects the six slots
const model = ctrl.lightingModel();
assert.equal(model.length, 6);
assert.equal(model[0].c, 0x304ffe, 'working slot should be blue');
assert.equal(model[1].c, 0x00ff4c, 'unread slot should be green');
assert.equal(model[5].c, 0, 'empty slot should be off');

console.log('client.js runtime test: OK');
console.log('  agent double-tap, split mic, knob long/short/reasoning, ptt latch, joystick, lighting');

// 10. the shipped locale JSON must equal the dictionary the bundle registers.
// Plugin Manager reads the files for meta.title / meta.description while the
// bundle carries its own copy (no file access at runtime); drift between them
// shows one title in the plugin list and another inside the panel.
const dictStart = source.indexOf('const LOCALE = {');
assert.ok(dictStart > 0, 'LOCALE dictionary present in the bundle');
let depth = 0;
let dictEnd = -1;
for (let i = source.indexOf('{', dictStart); i < source.length; i += 1) {
  if (source[i] === '{') depth += 1;
  else if (source[i] === '}') {
    depth -= 1;
    if (depth === 0) {
      dictEnd = i + 1;
      break;
    }
  }
}
const bundleLocale = new Function(`return ${source.slice(source.indexOf('{', dictStart), dictEnd)}`)();
const locales = Object.keys(bundleLocale);
assert.deepEqual(locales.sort(), ['en', 'zh'], 'both shipped locales are present');

// The panel looks strings up flat (the Host indexes the dictionary by key, it
// does not walk a path), so every entry must be a plain string, not a nested
// object — a nested table silently degrades every label to its key.
for (const lang of locales) {
  const dict = bundleLocale[lang];
  const nested = Object.entries(dict).filter(([, value]) => typeof value !== 'string');
  assert.deepEqual(nested.map(([key]) => key), [], `${lang} dictionary is flat`);
  assert.ok(Object.keys(dict).length > 400, `${lang} dictionary covers the panel (${Object.keys(dict).length} keys)`);
}

// Every key must exist in both languages, or the UI mixes languages at runtime.
const zhKeys = Object.keys(bundleLocale.zh).sort();
const enKeys = Object.keys(bundleLocale.en).sort();
assert.deepEqual(enKeys, zhKeys, 'zh and en define the same keys');

for (const lang of locales) {
  const file = JSON.parse(readFileSync(new URL(`../locale/${lang}.json`, import.meta.url), 'utf8'));
  const { meta, ...strings } = file;
  assert.deepEqual(
    strings,
    bundleLocale[lang],
    `locale/${lang}.json drifted from the bundle dictionary — run node tools/i18n.mjs --write`,
  );
  assert.ok(meta?.title && meta?.description, `locale/${lang}.json carries meta.title and meta.description`);
}
console.log('  locale/*.json matches the registered dictionary');

// No hard-coded Chinese outside the dictionaries: any literal that creeps back
// in is a string no other language will ever show.
const withoutDict =
  source.slice(0, dictStart) +
  '\n'.repeat(source.slice(dictStart, dictEnd).split('\n').length - 1) +
  source.slice(dictEnd);
const strayHan = withoutDict
  .split('\n')
  .map((line, index) => ({ line: index + 1, text: line.trim() }))
  .filter(({ text }) => /[\u4e00-\u9fff]/.test(text))
  .filter(({ text }) => !text.startsWith('//') && !text.startsWith('*') && !text.startsWith('/*'));
assert.deepEqual(strayHan, [], 'no hard-coded Chinese copy outside the dictionaries');
console.log('  no stray Chinese literals outside LOCALE');

// Every literal t("...") must name a key the dictionary defines. A typo or a
// retired key renders itself in the panel, which is the exact failure the
// dictionaries exist to prevent.
const literalKeys = new Set();
for (const match of source.matchAll(/\bt\(\s*"([^"]+)"\s*[,)]/g)) literalKeys.add(match[1]);
const undefinedKeys = [...literalKeys].filter((key) => !(key in bundleLocale.zh));
assert.deepEqual(undefinedKeys, [], 't() references a key the dictionary does not define');
console.log(`  all ${literalKeys.size} literal t() keys are defined`);

// ------------------------------------------------------------- disposal
// Everything start() attaches has to come off again in stop(). Neither the
// ownership lease listener nor the BroadcastChannel is visible in the panel,
// so a regression here would only show up as a slow leak across reloads.
assert.ok(
  (windowListeners.get('storage')?.size ?? 0) > 0,
  'start() did not subscribe to the ownership lease',
);
assert.ok(broadcastChannels.length > 0, 'start() did not open the cross-window channel');
ctrl.stop();
assert.equal(
  windowListeners.get('storage')?.size ?? 0,
  0,
  'stop() left the storage listener attached',
);
assert.ok(
  broadcastChannels.every((channel) => channel.closed),
  'stop() left a BroadcastChannel open',
);
console.log('  disposal: storage listener and channel released');
