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

// 2d. the reference focuses on a single press when the window is not in front
//     (openWindowForAgentTap -> showWindow); only an already-foreground window
//     needs the double tap. The page's signal for that is document.hasFocus().
opened.length = 0;
focusCalls = 0;
ctrl.pageHasFocus = () => false;
ctrl.onKey({ k: 'AG00', act: 1 });
ctrl.onKey({ k: 'AG00', act: 0 });
await sleep(20);
assert.deepEqual(opened, ['s1'], `unfocused page still switches chat: ${JSON.stringify(opened)}`);
assert.equal(focusCalls, 1, 'an unfocused page is raised on the first press');
await sleep(400);

opened.length = 0;
focusCalls = 0;
ctrl.pageHasFocus = () => true;
ctrl.onKey({ k: 'AG00', act: 1 });
ctrl.onKey({ k: 'AG00', act: 0 });
await sleep(20);
assert.deepEqual(opened, ['s1'], 'a focused page switches chat');
assert.equal(focusCalls, 0, 'a focused page is not raised on the first press');
await sleep(400);
delete ctrl.pageHasFocus;

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
opened.length = 0;
ctrl.openAgentSlot(1);
assert.deepEqual(opened, ['s3'], `a slot skips the subagent chat: ${JSON.stringify(opened)}`);
ctrl.subagentIds = [];

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

// 6d. no official dictation button in the DOM and no voice bundle: the press
//     must NOT latch a recording, and the plugin says which piece is missing.
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
dispatched.length = 0;
ctrl.lastStick = 0;
ctrl.onStick({ d: 0.9, a: 0.0 });
await sleep(10);
assert.deepEqual(dispatched, ['session.next'], `joystick right: ${dispatched}`);

// 8b. sector boundaries follow the reference (original-runtime.md §4.1):
//     up = [.625,.875), down = [.125,.375) — this pair used to be swapped.
dispatched.length = 0;
ctrl.lastStick = 0;
ctrl.onStick({ d: 0.9, a: 0.75 });
await sleep(10);
assert.deepEqual(dispatched, ['plan.toggle'], `joystick up: ${dispatched}`);
dispatched.length = 0;
ctrl.lastStick = 0;
ctrl.onStick({ d: 0.9, a: 0.25 });
await sleep(10);
assert.deepEqual(dispatched, ['session.new'], `joystick down: ${dispatched}`);
dispatched.length = 0;
ctrl.lastStick = 0;
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
ctx.get = (name) => (name === 'uiSession' ? selectionStore : previousGet(name));
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
