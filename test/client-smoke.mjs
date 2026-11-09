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
  // Voice capture encodes the recording for the host speech Remote.
  btoa: (text) => Buffer.from(text, "binary").toString("base64"),
  atob: (text) => Buffer.from(text, "base64").toString("binary"),
  AbortController,
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

// 3. apply() wires the home-sidebar panel: the sidebar row and the main-column
//    page it selects must be registered under one shared id, and the settings
//    section the plugin used to own must be gone.
const registered = new Map();
const effects = [];
// The Host locale service, present like the real host. The plugin binds
// "dsh-micro" for panel copy and "voice-input" for the official dictation
// button's aria-label. `officialVoiceLabels` starts empty (the plugin then uses
// its built-in copy) and section 6i fills it with a non-zh/en language: the
// official voice-input keys are `retryRecording` / `setupPrompt.trigger`, not
// our kinds, so this is where a wrong key lookup shows up.
const officialVoiceLabels = {};
const localeStub = {
  register: () => () => {},
  bind: (ns) => (key) => {
    if (ns === 'voice-input') return officialVoiceLabels[key];
    return undefined;
  },
  subscribe: () => () => {},
  getSnapshot: () => ({ active: 'zh' }),
};
const ctx = {
  effect(fn, label) {
    effects.push(label);
    const dispose = fn();
    return typeof dispose === 'function' ? dispose : () => {};
  },
  inject(names, fn) {
    const list = Array.isArray(names) ? names : [names];
    if (list.includes('locale')) fn({ locale: localeStub });
  },
  get() {
    return undefined;
  },
  slots: {
    inject(name, fn) {
      fn();
    },
    register(options, component) {
      registered.set(options.name, { options, component });
      return () => {};
    },
  },
};
moduleExports.apply(ctx);
const panelRow = registered.get('sidebar.panellist');
const panelPage = registered.get('main');
assert.ok(panelRow, 'sidebar panel row was not registered');
assert.ok(panelPage, 'main panel page was not registered');
assert.equal(panelRow.options.id, 'dsh-micro');
assert.equal(panelPage.options.key, panelRow.options.id, 'the row id must address the main key');
assert.equal(typeof panelRow.options.label, 'function', 'the row label must be a thunk so it follows the locale');
assert.equal(typeof panelRow.options.order, 'number');
assert.ok(!registered.has('settings.section'), 'the panel must not register a settings section any more');

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
// The controller now derives the six slots itself (the panel does not own them
// any more), so give it the store before the agent-key cases run.
ctrl.syncAgentSlots();

// 1. a single press on a thread-bound agent key opens/switches that chat — the
//    reference opens on act===1 and only uses the double tap to raise the
//    window (original-settings.md §5.5).
opened.length = 0;
ctrl.onKey({ k: 'AG00', act: 1 });
ctrl.onKey({ k: 'AG00', act: 0 });
await sleep(20);
assert.deepEqual(opened, ['s1'], `single press opened ${JSON.stringify(opened)}`);

// 2. a second press inside 350 ms must NOT re-open the same chat; it only asks
//    for window focus (the OS decides).
opened.length = 0;
let focusCalls = 0;
ctrl.focusWindow = () => {
  focusCalls += 1;
};
ctrl.onKey({ k: 'AG00', act: 1 });
await sleep(80);
ctrl.onKey({ k: 'AG00', act: 0 });
ctrl.onKey({ k: 'AG00', act: 1 });
await sleep(20);
assert.deepEqual(opened, ['s1'], `double press must not open twice: ${JSON.stringify(opened)}`);
assert.equal(focusCalls, 1, 'the second press asks for window focus');
await sleep(400);

// 2b. singleTapAgentKeys only adds the focus request, never gates the switch.
ctrl.settings.singleTapAgentKeys = true;
opened.length = 0;
focusCalls = 0;
ctrl.onKey({ k: 'AG01', act: 1 });
ctrl.onKey({ k: 'AG01', act: 0 });
await sleep(20);
assert.deepEqual(opened, ['s2'], 'single tap still switches with singleTapAgentKeys on');
assert.equal(focusCalls, 1, 'and it also asks for focus');
ctrl.settings.singleTapAgentKeys = false;
await sleep(400);

// 2c. an agent key bound to an action is NOT a chat slot: the binding runs on
//     press, with no open and no focus request (parity B4). Keycap ids resolve
//     to their action; an empty binding stays a thread slot.
const actionCalls = [];
ctrl.dispatch = async (action) => {
  actionCalls.push(action);
};
ctrl.bindings = { ...ctrl.bindings, AG02: 'command:forkThread' };
opened.length = 0;
focusCalls = 0;
ctrl.onKey({ k: 'AG02', act: 1 });
ctrl.onKey({ k: 'AG02', act: 0 });
await sleep(20);
assert.deepEqual(actionCalls, ['command:forkThread'], `action binding ran: ${actionCalls}`);
assert.deepEqual(opened, [], 'an action binding must not open a chat');
assert.equal(focusCalls, 0, 'an action binding must not ask for focus');

actionCalls.length = 0;
ctrl.bindings = { ...ctrl.bindings, AG02: 'SPLIT' };
ctrl.onKey({ k: 'AG02', act: 1 });
ctrl.onKey({ k: 'AG02', act: 0 });
await sleep(20);
assert.deepEqual(actionCalls, ['session.fork'], `a keycap id resolves to its action: ${actionCalls}`);

actionCalls.length = 0;
ctrl.bindings = { ...ctrl.bindings, AG02: '' };
ctrl.onKey({ k: 'AG02', act: 1 });
ctrl.onKey({ k: 'AG02', act: 0 });
await sleep(20);
assert.deepEqual(actionCalls, [], 'an empty binding is a thread slot, not an action');

// 2d. the reference switches chats in the background on a single press; the
//     window is only raised on the second press (or when 单击即切换 is on).
opened.length = 0;
focusCalls = 0;
ctrl.onKey({ k: 'AG00', act: 1 });
ctrl.onKey({ k: 'AG00', act: 0 });
await sleep(20);
assert.deepEqual(opened, ['s1'], `single press switches chat: ${JSON.stringify(opened)}`);
assert.equal(focusCalls, 0, 'a single press stays in the background');
await sleep(20);
ctrl.onKey({ k: 'AG00', act: 1 });
ctrl.onKey({ k: 'AG00', act: 0 });
await sleep(20);
assert.equal(focusCalls, 1, 'the second press raises the window');
await sleep(400);

ctrl.settings.singleTapAgentKeys = true;
opened.length = 0;
focusCalls = 0;
ctrl.onKey({ k: 'AG00', act: 1 });
ctrl.onKey({ k: 'AG00', act: 0 });
await sleep(20);
assert.equal(focusCalls, 1, '单击即切换 raises on the first press');
ctrl.settings.singleTapAgentKeys = false;
await sleep(400);

// 2e. switching a chat reports the selection right away: the reference reopens
//     the 4 s selection highlight on the same frame, while the renderer only has
//     hints to send — waiting for the 1.5 s poll would start the highlight after
//     the user already switched (switch-animation.md).
let hintPushes = 0;
ctrl.pushLightHints = () => {
  hintPushes += 1;
  return Promise.resolve();
};
opened.length = 0;
ctrl.openAgentSlot(0);
assert.deepEqual(opened, ['s1'], `the slot opened its chat: ${JSON.stringify(opened)}`);
assert.ok(hintPushes >= 1, 'opening a chat flushes the lighting hints');
ctrl.scheduleLighting();
assert.equal(hintPushes, 1, 'scheduleLighting is debounced, not immediate');
await sleep(80);
assert.ok(hintPushes >= 2, 'the debounced push follows');
delete ctrl.pushLightHints;

// 2f. agent keys follow main conversations only: a subagent session is a
//     delegated run, not a chat the user holds, so the pickers skip it. The host
//     reports the authoritative ids; a self-describing entry is skipped too.
const { mainSessionEntries } = moduleExports.__internals;
assert.deepEqual(
  mainSessionEntries(
    [
      { id: 'main', title: 'main', updatedAt: 30 },
      { id: 'sub', title: 'sub', updatedAt: 20, origin: 'subagent' },
      { id: 'deep', title: 'deep', updatedAt: 10, delegationDepth: 2 },
    ],
    [],
  ).map((entry) => entry.id),
  ['main'],
  'subagent sessions are not offered as agent-key chats',
);
assert.deepEqual(
  mainSessionEntries([{ id: 'reported', title: 'x', updatedAt: 1 }], ['reported']),
  [],
  'the host-reported subagent id is excluded',
);
ctrl.subagentIds = ['s2'];
// The controller derives the six slots itself (the panel is not open here), so a
// subagent id reported by the host must be excluded from that derivation too.
ctrl.syncAgentSlots();
opened.length = 0;
ctrl.openAgentSlot(1);
assert.deepEqual(opened, ['s3'], `a slot skips the subagent chat: ${JSON.stringify(opened)}`);
ctrl.subagentIds = [];
ctrl.syncAgentSlots();

// 2g. a chat created while the panel is closed still reaches the agent keys: the
//     controller re-derives on its own schedule instead of waiting for the panel.
services.sessions.list.push({ id: 's4', title: 'just created', updatedAt: 40 });
ctrl.syncAgentSlots();
assert.equal(ctrl.agentSlots[0], 's4', 'a new chat becomes the first agent key');
assert.equal(ctrl.agentSlots[1], 's1', 'the rest follow recency order');
services.sessions.list = services.sessions.list.filter((entry) => entry.id !== 's4');
ctrl.syncAgentSlots();
assert.equal(ctrl.agentSlots[0], 's1', 'removing it re-derives back');

// 2h. the selected chat comes from `uiSession.current` (the binding source the
//     sidebar writes), never from "the most recent chat": breathing, the 4 s
//     window, the ambient colour and the selected+focused+unread rule all hang
//     off this id.
ctx.get = (name) => (name === 'uiSession' ? { current: { getSnapshot: () => ({ key: 's2' }) } } : services[name]);
assert.equal(ctrl.currentSessionId(), 's2', 'the open chat is the selected one');
assert.equal(ctrl.lightHints().selected, 's2', 'the hint carries the open chat');
ctx.get = (name) => services[name];
ctrl.lastOpenedSessionId = null;
assert.notEqual(ctrl.currentSessionId(), 's1', 'never guess the first recent chat as selected');

// 2i. off slots are inert in automatic modes: the device shows them dark, so a
//     press must not open "the slot-th recent chat" instead.
ctrl.agentSlots = Array.from({ length: 6 }, () => null);
opened.length = 0;
ctrl.openAgentSlot(0);
assert.deepEqual(opened, [], 'an empty slot does not open some other chat');
ctrl.syncAgentSlots();
assert.equal(ctrl.agentSlots[0], 's1', 'the derived slots come back');

// 2j. priority ordering follows the reference OJ comparator:
//     approval/input/error/waiting > unread > working > idle.
ctx.get = (name) =>
  name === 'uiSession'
    ? {
        sessionStatus: {
          getSnapshot: () => new Map([
            ['s2', { completionUnread: true }],
            ['s3', { running: true }],
          ]),
        },
      }
    : services[name];
const priorityOrder = ctrl
  .orderAgentEntries(
    [
      { id: 's1', updatedAt: 1 },
      { id: 's2', updatedAt: 2 },
      { id: 's3', updatedAt: 3 },
    ],
    'priority',
  )
  .map((entry) => entry.id);
assert.deepEqual(priorityOrder, ['s2', 's3', 's1'], `priority order: ${priorityOrder}`);
ctx.get = (name) => services[name];

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

// 6. knob rotation in reasoning mode: clockwise lowers effort.
//    The firmware reports one quadrature tick as act=2 (original-runtime.md §5).
dispatched.length = 0;
ctrl.settings.encoderMode = 'reasoning';
ctrl.knob.lastPulseAt = 0;
ctrl.onKey({ k: 'ENC_CW', act: 2 });
await sleep(10);
assert.deepEqual(dispatched, ['effort.down'], `reasoning rotation: ${dispatched}`);
dispatched.length = 0;
ctrl.knob.lastPulseAt = 0;
ctrl.onKey({ k: 'ENC_CC', act: 2 });
await sleep(10);
assert.deepEqual(dispatched, ['effort.up'], `reasoning rotation (ccw): ${dispatched}`);

// 6b. every tick is one action: fast rotation must not be merged away
dispatched.length = 0;
ctrl.onKey({ k: 'ENC_CW', act: 2 });
ctrl.onKey({ k: 'ENC_CW', act: 2 });
ctrl.onKey({ k: 'ENC_CW', act: 2 });
await sleep(10);
assert.deepEqual(dispatched, ['effort.down', 'effort.down', 'effort.down'], `three ticks: ${dispatched}`);

// 6c. a press-style tick (act=1) still works on builds that report it that way
dispatched.length = 0;
ctrl.onKey({ k: 'ENC_CW', act: 1 });
await sleep(60);
assert.deepEqual(dispatched, ['effort.down'], `press-style tick: ${dispatched}`);

// 6d. reasoning mode really steps the DSH model directory. The old code read
//     `snapshot.reasoning.efforts`, a shape DSH never had, so it only logged
//     "this build does not expose a reasoning catalog" and did nothing.
{
  const selected = [];
  const catalog = {
    reasoningFor: () => ({
      defaultEffort: 'medium',
      efforts: [
        { id: 'low', name: 'Low' },
        { id: 'medium', name: 'Medium' },
        { id: 'high', name: 'High' },
      ],
    }),
  };
  let current = { provider: 'openai', model: 'gpt-5', reasoningEffort: 'medium' };
  const directory = {
    store: { getSnapshot: () => ({ current }) },
    load: async () => {},
    select: async (selection) => {
      selected.push(selection);
      current = { ...current, reasoningEffort: selection.reasoningEffort };
      return { ok: true };
    },
  };
  const previousGet = ctx.get;
  ctx.get = (name) => (name === 'modelDirectories' ? { directoryFor: () => directory, catalog } : previousGet(name));
  await ctrl.stepEffort('s1', 1);
  assert.deepEqual(
    selected,
    [{ provider: 'openai', model: 'gpt-5', reasoningEffort: 'high' }],
    `effort up should pick the next level: ${JSON.stringify(selected)}`,
  );
  await ctrl.stepEffort('s1', 1);
  assert.equal(selected.at(-1).reasoningEffort, 'low', 'effort wraps around the catalog');
  ctx.get = previousGet;
}

// 6e. composer-navigation moves focus between the composer's real controls: DSH
//     has no `data-composer-navigation-target` protocol, so arrow keys alone only
//     move the caret. The ring/dot pulse and the focus ring are the feedback.
{
  const focused = [];
  const clicked = [];
  const target = (label) => ({
    nodeType: 1,
    isConnected: true,
    tagName: 'BUTTON',
    label,
    disabled: false,
    readOnly: false,
    attrs: {},
    getAttribute(name) {
      return this.attrs[name] ?? null;
    },
    setAttribute(name) {
      this.attrs[name] = 'true';
    },
    removeAttribute(name) {
      delete this.attrs[name];
    },
    getBoundingClientRect: () => ({ width: 24, height: 24 }),
    closest: () => null,
    scrollIntoView() {},
    focus() {
      focused.push(label);
      documentStub.activeElement = this;
    },
    click() {
      clicked.push(label);
    },
  });
  const first = target('model');
  const second = target('send');
  const card = { querySelectorAll: () => [first, second] };
  const savedQuery = documentStub.querySelector;
  const savedActive = documentStub.activeElement;
  documentStub.querySelector = (selector) => (selector === '[data-composer-card]' ? card : savedQuery(selector));
  documentStub.activeElement = null;
  ctrl.settings.encoderMode = 'composer-navigation';
  ctrl.onKey({ k: 'ENC_CW', act: 2 });
  assert.deepEqual(focused, ['send'], `clockwise from no selection starts at the last control: ${focused}`);
  assert.equal(second.attrs['data-cm-nav-focus'], 'true', 'the focused control gets the visible highlight');
  ctrl.onKey({ k: 'ENC_CW', act: 2 });
  assert.deepEqual(focused, ['send', 'model'], `clockwise moves back one control: ${focused}`);
  assert.equal(first.attrs['data-cm-nav-focus'], 'true', 'the highlight moves with the focus');
  assert.equal(second.attrs['data-cm-nav-focus'], undefined, 'the old highlight is removed');
  ctrl.onKey({ k: 'ENC_CC', act: 2 });
  assert.deepEqual(focused, ['send', 'model', 'send'], `counterclockwise moves forward: ${focused}`);
  ctrl.onKnobClick();
  assert.deepEqual(clicked, ['send'], `click activates the focused control: ${clicked}`);
  documentStub.querySelector = savedQuery;
  documentStub.activeElement = savedActive;
  ctrl.settings.encoderMode = 'reasoning';
}

// 6f. When a menu / listbox / dialog is open, rotation navigates the overlay
//     (permission presets and the model picker portal their options to <body>),
//     not the composer behind it. DSH menus implement ArrowUp/ArrowDown
//     themselves, so we hand the key over after focusing the checked item.
{
  const focused = [];
  const clicked = [];
  const events = [];
  const menuItem = (label, checked) => ({
    nodeType: 1,
    isConnected: true,
    tagName: 'BUTTON',
    role: 'menuitemradio',
    attrs: { 'aria-checked': checked ? 'true' : 'false' },
    getAttribute(name) {
      return this.attrs[name] ?? null;
    },
    setAttribute(name) {
      this.attrs[name] = 'true';
    },
    removeAttribute(name) {
      delete this.attrs[name];
    },
    getBoundingClientRect: () => ({ width: 120, height: 28 }),
    closest: () => null,
    scrollIntoView() {},
    focus() {
      focused.push(label);
      documentStub.activeElement = this;
    },
    click() {
      clicked.push(label);
    },
    dispatchEvent(event) {
      events.push({ type: event.type, key: event.key });
      return true;
    },
  });
  const currentModel = menuItem('DeepSeek V4.1 Flash', true);
  const otherModel = menuItem('DeepSeek V4.1 Pro', false);
  const overlay = {
    getBoundingClientRect: () => ({ width: 240, height: 120 }),
    closest: () => null,
    contains: (node) => node === currentModel || node === otherModel,
    querySelectorAll: () => [currentModel, otherModel],
  };
  const savedQueryAll = documentStub.querySelectorAll;
  const savedQuery = documentStub.querySelector;
  const savedActive = documentStub.activeElement;
  documentStub.querySelectorAll = (selector) => (String(selector).includes('[role="menu"]') ? [overlay] : []);
  documentStub.querySelector = () => null;
  documentStub.activeElement = null;
  ctrl.settings.encoderMode = 'composer-navigation';
  ctrl.onKey({ k: 'ENC_CW', act: 2 });
  assert.deepEqual(focused, ['DeepSeek V4.1 Flash'], `rotation enters the menu at the checked item: ${focused}`);
  assert.equal(currentModel.attrs['data-cm-nav-focus'], 'true', 'the menu item gets the visible highlight');
  ctrl.onKey({ k: 'ENC_CW', act: 2 });
  assert.deepEqual(focused, ['DeepSeek V4.1 Flash', 'DeepSeek V4.1 Pro'], `rotation walks the plain menu itself: ${focused}`);
  assert.equal(otherModel.attrs['data-cm-nav-focus'], 'true', 'the highlight follows the focused option');
  assert.equal(currentModel.attrs['data-cm-nav-focus'], undefined, 'the old highlight is removed');
  assert.deepEqual(events, [], 'a plain menu has no host arrow handling to hand the tick to');
  ctrl.onKnobClick();
  assert.deepEqual(clicked, ['DeepSeek V4.1 Pro'], `click activates the focused menu item: ${clicked}`);
  documentStub.querySelectorAll = savedQueryAll;
  documentStub.querySelector = savedQuery;
  documentStub.activeElement = savedActive;
  ctrl.settings.encoderMode = 'reasoning';
}

// 6g. The model picker is a drilled pane with a search box: DSH moves its
//     *highlighted row* (not focus) when ArrowUp/ArrowDown is pressed in the
//     search input, and `aria-controls`/`aria-expanded` point at that whole
//     popover root. Entering must land in the search box, otherwise rotation
//     bounces between "current model" and the search field.
{
  const focused = [];
  const events = [];
  const makeItem = (label, checked) => ({
    nodeType: 1,
    isConnected: true,
    tagName: 'BUTTON',
    role: 'menuitemradio',
    attrs: { 'aria-checked': checked ? 'true' : 'false' },
    getAttribute(name) {
      return this.attrs[name] ?? null;
    },
    setAttribute(name) {
      this.attrs[name] = 'true';
    },
    removeAttribute(name) {
      delete this.attrs[name];
    },
    getBoundingClientRect: () => ({ width: 120, height: 28 }),
    closest: () => null,
    scrollIntoView() {},
    focus() {
      focused.push(label);
      documentStub.activeElement = this;
    },
    click() {},
    dispatchEvent(event) {
      events.push({ type: event.type, key: event.key });
      return true;
    },
  });
  const currentModel = makeItem('DeepSeek V4.1 Flash', true);
  const otherModel = makeItem('DeepSeek V4.1 Pro', false);
  const search = {
    nodeType: 1,
    isConnected: true,
    tagName: 'INPUT',
    role: 'searchbox',
    attrs: {},
    getAttribute(name) {
      return this.attrs[name] ?? null;
    },
    setAttribute(name) {
      this.attrs[name] = 'true';
    },
    removeAttribute(name) {
      delete this.attrs[name];
    },
    getBoundingClientRect: () => ({ width: 200, height: 32 }),
    closest: () => null,
    scrollIntoView() {},
    focus() {
      focused.push('search');
      documentStub.activeElement = this;
    },
    dispatchEvent(event) {
      events.push({ type: event.type, key: event.key });
      return true;
    },
  };
  const overlay = {
    getBoundingClientRect: () => ({ width: 240, height: 300 }),
    closest: () => null,
    contains: (node) => node === search || node === currentModel || node === otherModel,
    querySelector: (selector) => (String(selector).includes('input') ? search : null),
    querySelectorAll: () => [currentModel, otherModel],
  };
  const savedQueryAll = documentStub.querySelectorAll;
  const savedQuery = documentStub.querySelector;
  const savedActive = documentStub.activeElement;
  documentStub.querySelectorAll = (selector) => (String(selector).includes('[role="menu"]') ? [overlay] : []);
  documentStub.querySelector = () => null;
  documentStub.activeElement = null;
  ctrl.settings.encoderMode = 'composer-navigation';
  ctrl.onKey({ k: 'ENC_CW', act: 2 });
  assert.deepEqual(focused, ['search'], `rotation enters the search box of a searchable menu: ${focused}`);
  ctrl.onKey({ k: 'ENC_CW', act: 2 });
  assert.equal(events.at(-1)?.key, 'ArrowUp', 'the arrow key goes to the search box so the host moves its highlighted row');
  ctrl.onKnobClick();
  assert.equal(events.at(-1)?.key, 'Enter', 'click chooses the highlighted model from the search box');
  documentStub.querySelectorAll = savedQueryAll;
  documentStub.querySelector = savedQuery;
  documentStub.activeElement = savedActive;
  ctrl.settings.encoderMode = 'reasoning';
}


delete services['remote.speech'];
const plainSelector = documentStub.querySelector;
let voicePress = ctrl.logs.length;
ctrl.onKey({ k: 'ACT10', act: 1 });
assert.equal(ctrl.ptt.state, 'idle', 'a press cannot start recording without the voice plugin');
assert.ok(
  ctrl.logs.slice(voicePress).some((line) => line.includes('语音输入插件未开启')),
  `missing-plugin hint was not logged: ${ctrl.logs.slice(voicePress)}`,
);
ctrl.onKey({ k: 'ACT10', act: 0 });
await sleep(30);

// 6e. voice bundle on but the composer is not mounted: still no recording, and
//     the hint points at the missing button instead of a missing plugin.
services['remote.speech'] = { transcribe: async () => ({ ok: true, value: { text: '' } }) };
voicePress = ctrl.logs.length;
ctrl.onKey({ k: 'ACT10', act: 1 });
assert.equal(ctrl.ptt.state, 'idle', 'no button means no recording');
assert.ok(
  ctrl.logs.slice(voicePress).some((line) => line.includes('找不到听写按钮')),
  `missing-button hint was not logged: ${ctrl.logs.slice(voicePress)}`,
);
ctrl.onKey({ k: 'ACT10', act: 0 });
await sleep(30);
delete services['remote.speech'];

// 6f. with the official dictation button present, the physical key presses that
//     button: the capture animation, permission prompt, "识别中…" and insertion
//     are all the official component's state machine.
let startClicks = 0;
let stopClicks = 0;
let retryClicks = 0;
let activityPhase = null;
const startButton = { disabled: false, click: () => { startClicks += 1; activityPhase = 'recording'; } };
const stopButton = { disabled: false, click: () => { stopClicks += 1; activityPhase = 'transcribing'; } };
const retryButton = { disabled: false, click: () => { retryClicks += 1; activityPhase = 'recording'; } };
const cancelButton = { disabled: false, click: () => { activityPhase = null; } };
const activityElement = { getAttribute: () => activityPhase };
documentStub.querySelector = (selector) => {
  if (typeof selector === 'string' && selector.startsWith('button[aria-label=')) {
    if (selector.includes('开始录音') || selector.includes('Start recording')) return activityPhase === null ? startButton : null;
    if (selector.includes('停止并识别') || selector.includes('Stop and transcribe')) return activityPhase === 'recording' ? stopButton : null;
    if (selector.includes('重新录音') || selector.includes('Record again')) return activityPhase === 'feedback' ? retryButton : null;
    if (selector.includes('取消') || selector.includes('Cancel')) return cancelButton;
    return null;
  }
  if (selector === '[data-voice-activity]') return activityPhase === null ? null : activityElement;
  return null;
};
ctrl.voiceState = 'idle';
ctrl.ptt = { state: 'idle', startedAt: 0, deadline: 0, timer: null, down: false };
ctrl.onKey({ k: 'ACT10', act: 1 });
assert.equal(startClicks, 1, 'the physical key must click the official dictation button');
assert.equal(ctrl.voiceState, 'recording', 'the device lighting follows the official recording phase');
await sleep(20);
ctrl.onKey({ k: 'ACT10', act: 0 });
await sleep(430);
assert.equal(stopClicks, 1, 'release must click the official stop button');
assert.equal(ctrl.voiceState, 'processing', 'the transcribing phase maps to the processing light');
activityPhase = null;
await sleep(240);
assert.equal(ctrl.voiceState, 'completed', 'a finished official recording reports completed');
ctrl.stopVoiceUiWatch();

// 6g. the "not recognised / failed" feedback row must not cost an extra press:
//     pressing the mic key again starts the next take directly (retry button).
ctrl.voiceState = 'idle';
ctrl.ptt = { state: 'idle', startedAt: 0, deadline: 0, timer: null, down: false };
activityPhase = 'feedback';
ctrl.onKey({ k: 'ACT10', act: 1 });
assert.equal(retryClicks, 1, 'a feedback row must resume recording in one press');
assert.equal(activityPhase, 'recording', 'the resumed take is recording again');
ctrl.onKey({ k: 'ACT10', act: 0 });
await sleep(430);
assert.equal(stopClicks, 2, 'the resumed take stops through the official stop button');
activityPhase = null;
await sleep(240);
ctrl.stopVoiceUiWatch();

// 6h. while the official component is transcribing, a press must not start a
//     second recording (and must not interrupt the running one).
startClicks = 0;
ctrl.voiceState = 'idle';
ctrl.ptt = { state: 'idle', startedAt: 0, deadline: 0, timer: null, down: false };
activityPhase = 'transcribing';
ctrl.onKey({ k: 'ACT10', act: 1 });
assert.equal(startClicks, 0, 'a transcribing session must not be replaced');
assert.equal(ctrl.ptt.state, 'idle', 'the press is ignored while transcribing');
ctrl.onKey({ k: 'ACT10', act: 0 });
activityPhase = null;
await sleep(30);
documentStub.querySelector = plainSelector;
ctrl.stopVoiceUiWatch();

// 6i. DSH 0.2.2 ships de/es/fr/ja/pt/ru on top of zh/en. The dictation button's
//     aria-label comes from the voice-input namespace, and two of its keys are
//     not named like our kinds (`retryRecording`, `setupPrompt.trigger`). With a
//     language this plugin does not translate, the label must still be found;
//     a lookup by our own kind falls back to the built-in Chinese copy and
//     matches nothing.
officialVoiceLabels.start = '録音開始';
officialVoiceLabels.stop = '停止して文字起こし';
officialVoiceLabels.cancel = 'キャンセル';
officialVoiceLabels.discard = '文字起こしを破棄';
officialVoiceLabels.retryRecording = 'もう一度録音';
officialVoiceLabels['setupPrompt.trigger'] = '音声入力の設定を開く';

let jaStart = 0;
let jaRetry = 0;
let jaSetup = 0;
let jaDiscard = 0;
let startMissing = false;
let retryMissing = false;
const jaStartButton = { disabled: false, click: () => { jaStart += 1; activityPhase = 'recording'; } };
const jaRetryButton = { disabled: false, click: () => { jaRetry += 1; activityPhase = 'recording'; } };
const jaSetupButton = { disabled: false, click: () => { jaSetup += 1; } };
const jaDiscardButton = { disabled: false, click: () => { jaDiscard += 1; activityPhase = null; } };
documentStub.querySelector = (selector) => {
  if (typeof selector === 'string' && selector.startsWith('button[aria-label=')) {
    if (selector.includes('もう一度録音')) return retryMissing || activityPhase !== 'feedback' ? null : jaRetryButton;
    if (selector.includes('文字起こしを破棄')) return activityPhase === 'feedback' ? jaDiscardButton : null;
    if (selector.includes('音声入力の設定を開く')) return jaSetupButton;
    if (selector.includes('録音開始')) return startMissing || activityPhase !== null ? null : jaStartButton;
    // The built-in Chinese/English labels are deliberately absent from this DOM.
    return null;
  }
  if (selector === '[data-voice-activity]') return activityPhase === null ? null : activityElement;
  return null;
};

// 6i-1. "record again" row: one press resumes without any zh/en label.
ctrl.voiceState = 'idle';
ctrl.ptt = { state: 'idle', startedAt: 0, deadline: 0, timer: null, down: false };
activityPhase = 'feedback';
ctrl.onKey({ k: 'ACT10', act: 1 });
assert.equal(jaRetry, 1, 'a ja label must still find the official retry button');
assert.equal(activityPhase, 'recording');
ctrl.onKey({ k: 'ACT10', act: 0 });
await sleep(430);
activityPhase = null;
await sleep(240);
ctrl.stopVoiceUiWatch();

// 6i-2. a row without "record again": the official discard button clears it (a
//       missing helper used to throw here), then the same press starts the take.
ctrl.voiceState = 'idle';
ctrl.ptt = { state: 'idle', startedAt: 0, deadline: 0, timer: null, down: false };
jaRetry = 0;
retryMissing = true;
activityPhase = 'feedback';
ctrl.onKey({ k: 'ACT10', act: 1 });
assert.equal(jaRetry, 0);
assert.equal(jaDiscard, 1, 'the feedback row is dismissed through the official discard button');
await sleep(140);
assert.equal(jaStart, 1, 'after dismissing the row the same press starts the next take');
retryMissing = false;
ctrl.onKey({ k: 'ACT10', act: 0 });
await sleep(430);
ctrl.stopVoiceUiWatch();

// 6i-3. no dictation button but a setup trigger: found through setupPrompt.trigger.
ctrl.voiceState = 'idle';
ctrl.ptt = { state: 'idle', startedAt: 0, deadline: 0, timer: null, down: false };
activityPhase = null;
startMissing = true;
ctrl.onKey({ k: 'ACT10', act: 1 });
assert.equal(jaSetup, 1, 'the setup trigger is found through setupPrompt.trigger');
ctrl.onKey({ k: 'ACT10', act: 0 });
await sleep(30);

documentStub.querySelector = plainSelector;
startMissing = false;
for (const key of Object.keys(officialVoiceLabels)) delete officialVoiceLabels[key];
ctrl.stopVoiceUiWatch();

// 7. push-to-talk follows the reference state machine (original-runtime.md §6.2)
let voiceStarts = 0;
let voiceStops = 0;
ctrl.voiceStart = () => {
  voiceStarts += 1;
};
ctrl.voiceStop = () => {
  voiceStops += 1;
};

// 7a. one short tap: recording starts, and with no second tap it stops itself
//     after the 350 ms window (it must NOT latch).
ctrl.onKey({ k: 'ACT10', act: 1 });
ctrl.onKey({ k: 'ACT10', act: 0 });
assert.equal(ctrl.ptt.state, 'waiting', `ptt after short tap: ${ctrl.ptt.state}`);
assert.equal(voiceStarts, 1);
assert.equal(voiceStops, 0, 'a short tap must not stop immediately');
await sleep(420);
assert.equal(ctrl.ptt.state, 'idle');
assert.equal(voiceStops, 1, 'the second-tap window closes and recording stops');

// 7b. a second tap inside 350 ms latches hands-free
voiceStarts = 0;
voiceStops = 0;
ctrl.onKey({ k: 'ACT10', act: 1 });
ctrl.onKey({ k: 'ACT10', act: 0 });
await sleep(80);
ctrl.onKey({ k: 'ACT10', act: 1 });
assert.equal(ctrl.ptt.state, 'latched', `ptt after double tap: ${ctrl.ptt.state}`);
assert.equal(voiceStarts, 1, 'latching must not restart recording');
assert.equal(voiceStops, 0, 'latching must not stop recording');
ctrl.onKey({ k: 'ACT10', act: 0 });
await sleep(420);
assert.equal(ctrl.ptt.state, 'latched', 'latched survives the release');

// 7c. pressing again stops, then swallows presses for 350 ms
ctrl.onKey({ k: 'ACT10', act: 1 });
assert.equal(ctrl.ptt.state, 'suppressing', `ptt while stopping: ${ctrl.ptt.state}`);
assert.equal(voiceStops, 1);
ctrl.onKey({ k: 'ACT10', act: 0 });
ctrl.onKey({ k: 'ACT10', act: 1 });
assert.equal(ctrl.ptt.state, 'suppressing', 'presses inside the suppress window are swallowed');
ctrl.onKey({ k: 'ACT10', act: 0 });
await sleep(420);
assert.equal(ctrl.ptt.state, 'idle');

// 7d. holding >=350 ms is push-to-talk: stop on release
voiceStarts = 0;
voiceStops = 0;
ctrl.onKey({ k: 'ACT10', act: 1 });
await sleep(380);
ctrl.onKey({ k: 'ACT10', act: 0 });
assert.equal(ctrl.ptt.state, 'idle');
assert.equal(voiceStarts, 1);
assert.equal(voiceStops, 1);

// 8. joystick right maps to the STICK_RIGHT binding
// Each isolated push resets the circling detector: real hardware streams many
// samples per turn, while the test jumps straight to one angle (a jump would
// otherwise read as part of a circle and be captured).
const resetStickGesture = () => {
	ctrl.gameGesture = { accumulatedTurns: 0, direction: 0, lastAngle: null, lastAt: null, startedAt: null };
};
dispatched.length = 0;
ctrl.lastStick = 0;
resetStickGesture();
ctrl.onStick({ d: 0.9, a: 0.0 });
await sleep(10);
assert.deepEqual(dispatched, ['session.next'], `joystick right: ${dispatched}`);

// 8b. sector boundaries follow the reference (original-runtime.md §4.1):
//     up = [.625,.875), down = [.125,.375) — this pair used to be swapped.
dispatched.length = 0;
ctrl.lastStick = 0;
resetStickGesture();
ctrl.onStick({ d: 0.9, a: 0.75 });
await sleep(10);
assert.deepEqual(dispatched, ['plan.toggle'], `joystick up: ${dispatched}`);
dispatched.length = 0;
ctrl.lastStick = 0;
resetStickGesture();
ctrl.onStick({ d: 0.9, a: 0.25 });
await sleep(10);
assert.deepEqual(dispatched, ['session.new'], `joystick down: ${dispatched}`);
dispatched.length = 0;
ctrl.lastStick = 0;
resetStickGesture();
ctrl.onStick({ d: 0.9, a: 0.5 });
await sleep(10);
assert.deepEqual(dispatched, ['session.prev'], `joystick left: ${dispatched}`);

// 9. The Host half owns the LED synthesis (lib/index.js SessionLighting, §4.6);
//    the renderer only reports the UI-only state it can see: the selected
//    session, unread/approval, voice. It must never build or push a model —
//    that is what left the keyboard dark before (its projection is empty until
//    the panel mounts).
assert.equal(typeof ctrl.lightingModel, 'undefined', 'the renderer must not build the LED model');
assert.equal(typeof ctrl.pushLighting, 'undefined', 'the renderer must not push the LED model');
assert.equal(typeof ctrl.lightHints, 'function', 'the renderer reports UI hints');
assert.equal(typeof ctrl.pushLightHints, 'function');
const hints = ctrl.lightHints();
assert.ok(hints && typeof hints === 'object', 'lightHints returns a payload');
assert.equal(typeof hints.voiceState, 'string', 'hints carry the voice state');
assert.ok('selected' in hints, 'hints carry the selected session');
assert.equal(typeof hints.statuses, 'object', 'hints carry per-session unread/approval status');
assert.equal(ctrl.scheduleLighting(), undefined, 'scheduleLighting debounces a hint push');

console.log('client.js runtime test: OK');
console.log('  agent single-tap switch + double-tap focus + action bindings, split mic, knob long/short/reasoning, ptt latch + official dictation button, joystick sectors, light hints');

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

// ------------------------------------------------- joystick HUD + mini-games
const interactions = moduleExports.__interactions;
assert.ok(interactions, 'interaction seam missing');
assert.deepEqual([...interactions.MINI_GAME_IDS], ['brick-breaker', 'asteroids', 'snake']);

const freshGesture = () => ({ accumulatedTurns: 0, direction: 0, lastAngle: null, lastAt: null, startedAt: null });
ctrl.lastStick = 0;
ctrl.game = null;
ctrl.gameRearm = false;
ctrl.gameGesture = freshGesture();
ctrl.hud = interactions.JOYSTICK_FEEDBACK.initialFeedback();
ctrl.onStick({ d: 0.3, a: 0 });
assert.equal(ctrl.hud.visible, true, 'HUD shows while the stick leaves the deadzone');
assert.equal(ctrl.hud.direction, 'right');
assert.equal(ctrl.hud.status, 'tracking');
ctrl.gameGesture = freshGesture();
ctrl.lastStick = 0;
ctrl.onStick({ d: 0.9, a: 0.75 });
assert.equal(ctrl.hud.direction, 'up', 'HUD follows the sector');
ctrl.onStick({ d: 0.02, a: 0 });
assert.equal(ctrl.hud.visible, false, 'HUD hides when the stick returns to neutral');
const triggered = interactions.JOYSTICK_FEEDBACK.nextFeedback(
	interactions.JOYSTICK_FEEDBACK.initialFeedback(),
	{ angle: 0.75, distance: 0.9 },
	{ enabled: true, direction: 'up', mappingAction: 'plan.toggle', status: 'triggered', activeDirection: 'up', previousActiveDirection: null },
);
assert.equal(triggered.status, 'triggered', 'the trigger tick reports the dispatched status');
assert.equal(triggered.direction, 'up');

// Circling the stick (1.9 turns in <6 s) starts one of the three mini-games.
// The reference only activates with a composer context; the composer is what the
// overlay canvas hangs above, so the test provides one here.
windowStub.innerHeight = 900;
const composerNode = {
  nodeType: 1,
  isConnected: true,
  tagName: 'TEXTAREA',
  disabled: false,
  readOnly: false,
  closest: () => null,
  getBoundingClientRect: () => ({ left: 300, right: 940, top: 700, bottom: 740, width: 640, height: 40 }),
};
documentStub.querySelectorAll = (selector) =>
  String(selector).includes('contenteditable') || String(selector).includes('textarea') ? [composerNode] : [];
assert.equal(interactions.findComposerElement(), composerNode, 'a visible textarea is the composer');
assert.equal(interactions.canHostMiniGame(), true, 'composer present: a game has somewhere to draw');
const plainQuerySelectorAll = () => [];

ctrl.game = null;
ctrl.gameRearm = false;
ctrl.gameGesture = { accumulatedTurns: 0, direction: 0, lastAngle: null, lastAt: null, startedAt: null };
for (let step = 1; step <= 140 && ctrl.game == null; step += 1) ctrl.onStick({ d: 0.9, a: (step * 0.02) % 1 });
assert.ok(ctrl.game != null, 'circling activates a mini-game');
assert.ok(interactions.MINI_GAME_IDS.includes(ctrl.game.id), `unknown game ${ctrl.game?.id}`);
ctrl.stopMiniGame();
assert.equal(ctrl.game, null);
assert.equal(ctrl.gameRearm, true, 'stopping a game re-arms the gesture');

// While a game runs (and until the stick re-centres afterwards) the reference
// joystick handler returns early, so the stick HUD is never painted.
ctrl.gameRearm = false;
ctrl.hud = { ...interactions.JOYSTICK_FEEDBACK.initialFeedback(), visible: true, status: 'tracking', event: { angle: 0.2, distance: 0.6 } };
ctrl.game = { id: 'snake', joystick: { angle: 0, distance: 0 }, fireRequested: false, startedAt: Date.now() };
ctrl.onStick({ d: 0.9, a: 0.3 });
assert.equal(ctrl.hud.visible, false, 'no stick HUD while a mini-game is running');
assert.equal(ctrl.game.joystick.distance, 0.9, 'the stick still feeds the running game');
ctrl.game = null;
ctrl.gameRearm = true;
ctrl.onStick({ d: 0.9, a: 0.3 });
assert.equal(ctrl.hud.visible, false, 'no stick HUD until the post-game rearm finishes');
ctrl.onStick({ d: 0.02, a: 0.3 });
assert.equal(ctrl.gameRearm, false, 'returning to centre re-arms the gesture');

// Circling is a captured gesture: the reference (`pZ` captured branch) clears the
// pending action timer, resets the previous direction and returns — direction
// bindings must NOT fire while the stick is being circled. Only the 1.9-turn
// activation starts a game.
dispatched.length = 0;
ctrl.game = null;
ctrl.gameRearm = false;
ctrl.gameGesture = freshGesture();
ctrl.lastStick = 0;
ctrl.hud = interactions.JOYSTICK_FEEDBACK.initialFeedback();
for (let step = 1; step <= 40; step += 1) ctrl.onStick({ d: 0.9, a: (step * 0.02) % 1 });
assert.deepEqual(dispatched, [], 'circling must not dispatch direction actions');
assert.equal(ctrl.game, null, '0.8 turns stays below the 1.9-turn activation');
assert.equal(ctrl.hud.status, 'game-gesture', 'circling shows the game-gesture HUD');
assert.ok(ctrl.hud.gameActivationProgress > 0 && ctrl.hud.gameActivationProgress < 1, 'the gesture shows partial progress');
// Leaving the circle and pushing a direction behaves normally again (with a
// composer present the reference delays the action 220 ms to filter sweeps).
ctrl.onStick({ d: 0.02, a: 0 });
dispatched.length = 0;
ctrl.onStick({ d: 0.9, a: 0.9 });
await sleep(260);
assert.deepEqual(dispatched, ['session.next'], `a normal push after the circle fires again: ${dispatched}`);

// Without a composer and without the panel open there is nowhere to render the
// game; the reference does not activate then, so neither do we (and no game can
// run invisibly in the background).
documentStub.querySelectorAll = plainQuerySelectorAll;
assert.equal(interactions.findComposerElement(), null, 'no composer once the textarea is gone');
assert.equal(interactions.canHostMiniGame(), false, 'no composer, no panel: the gesture must stay inert');
ctrl.game = null;
ctrl.gameRearm = false;
ctrl.gameGesture = { accumulatedTurns: 0, direction: 0, lastAngle: null, lastAt: null, startedAt: null };
for (let step = 1; step <= 140; step += 1) ctrl.onStick({ d: 0.9, a: (step * 0.02) % 1 });
assert.equal(ctrl.game, null, 'circling without a composer must not start a game');

// Knob pulses drive the ring/dot animation and clear themselves.
ctrl.onEncoder('ENC_CW', 2);
assert.equal(ctrl.knobAnim, 'clockwise', 'clockwise pulse lights the right dot');
await sleep(260);
assert.equal(ctrl.knobAnim, null, 'knob pulse clears after 220 ms');
// Compatible firmwares may report one `ENC` key with the direction in the
// payload instead of dedicated ENC_CW/ENC_CC keys; the pulse must still fire.
ctrl.onEncoder('ENC', 2, { delta: -1 });
assert.equal(ctrl.knobAnim, 'counterclockwise', 'a payload-direction knob still lights the left dot');
await sleep(260);
assert.equal(ctrl.knobAnim, null, 'the payload-direction pulse clears too');
ctrl.onEncoder('ENC', 1);
ctrl.onEncoder('ENC', 0);
assert.equal(ctrl.knobAnim, null, 'a plain encoder press is not a rotation');

// Each engine runs a frame and paints at least one primitive.
for (const id of interactions.MINI_GAME_IDS) {
	const state = interactions.createMiniGameState(id, {
		width: 640,
		height: 192,
		levelGlyphs: interactions.layoutLevelGlyphs('DSH MICRO'),
	});
	interactions.stepMiniGame(state, id, 1 / 60, { joystick: { angle: 0.25, distance: 0.6 }, fire: true });
	const painted = [];
	const recording = new Proxy(
		{ measureText: () => ({ width: 8 }) },
		{
			get: (target, prop) => (prop in target ? target[prop] : (...args) => painted.push([String(prop), ...args])),
			set: () => true,
		},
	);
	interactions.renderMiniGame(recording, state, id, { color: '#ededed', fontFamily: 'monospace', fontSize: 13 });
	assert.ok(painted.length > 0, `${id} renderer painted nothing`);
}
// Onboarding tour animation: 12 s cycle with 3480/7440/11520 ms buckets.
const onboarding = interactions.ONBOARDING;
assert.equal(onboarding.agentRows.length, 6);
assert.equal(onboarding.keycapRows.length, 6);
assert.deepEqual(onboarding.buckets, [3480, 7440, 11520]);
const frame0 = interactions.onboardingFrame(0);
// 相位：智能体键 i*800ms、命令键 (r+1)*700ms；桶 = <3480:0 / <7440:1 / <11520:2 / else 0。
assert.deepEqual(frame0.agentSlots.map((slot) => slot.status), ['working', 'unread', 'awaiting-approval', 'idle', 'working', 'working']);
assert.deepEqual(frame0.actionKeycapIds, ['FAST', 'APPR', 'REJ', 'SPLIT', 'NEW', 'APPR']);
const frameLater = interactions.onboardingFrame(7441);
assert.equal(frameLater.agentSlots[0].status, 'error', 'second bucket maps to the third status');
assert.equal(frameLater.actionKeycapIds[0], 'BUG', 'keycap row advances into the third bucket');
const pausedFrame = interactions.onboardingFrame(-1);
assert.deepEqual(pausedFrame, interactions.onboardingFrame(0), 'reduced motion freezes on the first frame');
// 11a. The game band is real layout, not an overlay: it grows the composer seat
//      and the conversation scroller follows to the new bottom (otherwise the
//      last message would just be covered by the taller sticky composer).
{
  const seat = {
    style: { paddingTop: '' },
    attrs: {},
    getAttribute(name) {
      return this.attrs[name] ?? null;
    },
    setAttribute(name, value) {
      this.attrs[name] = value;
    },
    removeAttribute(name) {
      delete this.attrs[name];
    },
  };
  const scroller = { scrollHeight: 1000, clientHeight: 600, scrollTop: 400 };
  // Growing the seat grows the scroll content, exactly like the host layout.
  const originalSet = seat.setAttribute.bind(seat);
  seat.setAttribute = (name, value) => {
    originalSet(name, value);
    if (name === 'data-cm-game-space' && value === '1') scroller.scrollHeight += 200;
  };
  const originalRemove = seat.removeAttribute.bind(seat);
  seat.removeAttribute = (name) => {
    const wasReserved = seat.attrs[name] === '1' || (name === 'data-cm-game-padding' && seat.attrs['data-cm-game-space'] === '1');
    originalRemove(name);
    if (wasReserved && name === 'data-cm-game-space') scroller.scrollHeight -= 200;
  };
  const savedQuery = documentStub.querySelector;
  documentStub.querySelector = (selector) =>
    selector === '[data-composer-seat]' ? seat : selector === '[data-conversation-scroll]' ? scroller : null;
  interactions.setGameSpace(true);
  assert.equal(seat.style.paddingTop, '200px', 'the composer seat grows by the game band');
  assert.equal(scroller.scrollTop, 600, 'a reader at the bottom follows the new bottom: the text moves up');
  scroller.scrollTop = 100; // the user scrolled up: do not yank them to the bottom
  interactions.setGameSpace(false);
  assert.equal(seat.style.paddingTop, '', 'the original padding is restored');
  assert.equal(scroller.scrollTop, 100, 'a reader mid-history is left where they were');
  documentStub.querySelector = savedQuery;
}

console.log('  interactions: HUD feedback, circling gesture, knob pulse, three game engines');

// A selection observable (when the host exposes one) is an accelerator for the
// 4 s selection highlight, and it must come off again in stop().
let selectionSubscribed = 0;
let selectionReleased = 0;
const selectionStore = {
  subscribe: () => {
    selectionSubscribed += 1;
    return () => {
      selectionReleased += 1;
    };
  },
};
const previousGet = ctx.get;
ctx.get = (name) => (name === 'uiSession' ? { current: selectionStore } : previousGet(name));
assert.equal(ctrl.watchSelection(), true, 'watchSelection subscribes to an observable');
assert.equal(selectionSubscribed, 1, 'the selection watch subscribed once');
ctx.get = previousGet;

ctrl.stop();
assert.equal(selectionReleased, 1, 'stop() left the selection subscription attached');
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
