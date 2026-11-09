/**
 * Host-side session -> LED model, following the reference synthesis (§4.6).
 *
 *   node test/session-lighting.mjs
 *
 * Covers the two builders directly (they are pure) and the SessionLighting
 * service around them: status merge with the renderer's UI hints, the 4 s
 * selection window, voice ambient, dedupe and the reconnect repaint.
 */
import assert from 'node:assert';
import { internals } from '../lib/index.js';

const { SessionLighting, buildConfig, buildThreads, STATUS_COLORS, EFFECT } = internals;

const OFF = { e: EFFECT.off, b: 0, s: 0, m: 0, c: 0 };
const slot = (id, status, extra = {}) => ({ id, status, selected: false, pulsing: false, ...extra });

// ---------------------------------------------------------------- builders

// §4.6 B: off slots send a complete all-zero record; selected/pulsing breathe;
// everything else — including working — is solid.
{
  const threads = buildThreads([slot(0, 'off'), slot(1, 'working'), slot(2, 'idle', { selected: true }), slot(3, 'unread', { pulsing: true })], 0.8);
  assert.deepEqual(threads[0], { id: 0, c: 0, b: 0, e: EFFECT.off, s: 0, sk: 0, sa: 0 }, 'off slot is a full zero record');
  assert.deepEqual(
    { c: threads[1].c, e: threads[1].e, s: threads[1].s, b: threads[1].b },
    { c: STATUS_COLORS.working, e: EFFECT.solid, s: 0, b: 0.8 },
    'working is SOLID blue, not a snake',
  );
  assert.deepEqual({ e: threads[2].e, s: threads[2].s }, { e: EFFECT.breath, s: 0.4 }, 'the selected slot breathes');
  assert.deepEqual({ e: threads[3].e, s: threads[3].s }, { e: EFFECT.breath, s: 0.4 }, 'a pulsing (unread) slot breathes');
  for (const thread of threads) assert.deepEqual([thread.sk, thread.sa], [0, 0], 'sk/sa stay 0');
}

// §4.6 A: with no selection and no voice, both zones are off.
{
  const config = buildConfig({ brightness: 1, voiceState: 'idle', snakingAmbientStatus: null, slots: [slot(0, 'working'), slot(1, 'idle')] }, false);
  assert.deepEqual(config.keys, OFF, 'key backlight stays off without a selection');
  assert.deepEqual(config.ambient, OFF, 'ambient stays off without a selection');
}

// §4.6 A: a selected working thread snakes the ambient ring; the key backlight
// follows only inside the selection window.
{
  const model = { brightness: 0.5, voiceState: 'idle', snakingAmbientStatus: null, slots: [slot(0, 'working', { selected: true })] };
  const during = buildConfig(model, true);
  assert.deepEqual(during.ambient, { e: EFFECT.snake, b: 0.5, s: 0.4, m: 0, c: STATUS_COLORS.working }, 'working ambient is a snake');
  assert.deepEqual(during.keys, { e: EFFECT.solid, b: 0.5, s: 0, m: 0, c: STATUS_COLORS.working }, 'keys follow the selected colour');
  const after = buildConfig(model, false);
  assert.deepEqual(after.keys, OFF, 'after the window the key backlight goes off');
  assert.deepEqual(after.ambient.e, EFFECT.snake, 'a selected working ambient stays on');
}

// §4.6 A: a selected idle thread only lights during the 4 s window.
{
  const model = { brightness: 1, voiceState: 'idle', snakingAmbientStatus: null, slots: [slot(0, 'idle', { selected: true })] };
  assert.equal(buildConfig(model, true).ambient.c, STATUS_COLORS.idle);
  assert.deepEqual(buildConfig(model, false).ambient, OFF, 'an idle selection goes dark after the window');
}

// §4.6 A: voice states own the ambient ring.
{
  for (const [voiceState, effect, color] of [
    ['recording', EFFECT.snake, 0x2e8b57],
    ['processing', EFFECT.snake, 0xffffff],
    ['completed', EFFECT.solid, 0xffffff],
  ]) {
    const config = buildConfig({ brightness: 1, voiceState, snakingAmbientStatus: null, slots: [slot(0, 'idle')] }, false);
    assert.deepEqual({ e: config.ambient.e, c: config.ambient.c }, { e: effect, c: color }, `${voiceState} ambient`);
  }
}

// §4.6 A: snakingAmbientStatus overrides everything and turns the keys off.
{
  const config = buildConfig(
    { brightness: 1, voiceState: 'recording', snakingAmbientStatus: 'unread', slots: [slot(0, 'idle', { selected: true })] },
    true,
  );
  assert.deepEqual(config.keys, OFF);
  assert.deepEqual({ e: config.ambient.e, c: config.ambient.c }, { e: EFFECT.snake, c: STATUS_COLORS.unread });
}

// ------------------------------------------------------------- the service

function session(id, events, createdAt = 1) {
  return { id, seq: events.length, header: { createdAt }, snapshotEvents: (from, to) => events.slice(from, to) };
}
const WORKING = [{ type: 'turn/start', data: { turn: 1 } }];
const IDLE = [
  { type: 'turn/start', data: { turn: 1 } },
  { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
];
const FAILED = [
  { type: 'turn/start', data: { turn: 1 } },
  { type: 'turn/end', data: { turn: 1, reason: { kind: 'error' } } },
];

function harness({ slots, sessions, brightness = 100, selectionWindowMs = 20 }) {
  const calls = { threads: [], config: [] };
  const store = { get: (id) => sessions.find((entry) => entry.id === id), list: () => sessions.slice() };
  const ctx = { get: (name) => (name === 'sessions' ? store : undefined) };
  const bridge = {
    connected: true,
    agentSlots: slots,
    settings: { brightness },
    lighting: {
      setThreads: (threads) => calls.threads.push(threads),
      setConfig: (config) => calls.config.push(config),
    },
  };
  const lighting = new SessionLighting(ctx, bridge, { selectionWindowMs });
  return { lighting, calls, bridge };
}

// The Host log gives working/error/idle; hints add the UI-only states.
{
  const sessions = [session('s1', WORKING), session('s2', IDLE), session('s3', FAILED)];
  const { lighting, calls } = harness({ slots: ['s1', 's2', 's3', null, null, null], sessions });
  lighting.setHints({ selected: 's2', statuses: { s2: 'unread', s3: 'awaiting-approval' }, voiceState: 'idle' });
  const threads = calls.threads.at(-1);
  assert.equal(threads[0].e, EFFECT.solid, 'working is solid');
  assert.equal(threads[1].c, STATUS_COLORS.unread, 'the unread hint wins over idle');
  // Reference order is error > approval > input > working > unread: a turn that
  // ended in an error stays red even if an approval hint is also around.
  assert.equal(threads[2].c, STATUS_COLORS.error, 'error outranks the approval hint');
  assert.equal(threads[2].e, EFFECT.solid, 'an unselected approval/error key is solid (no pulsing producer in the reference)');
  const config = calls.config.at(-1);
  assert.deepEqual(
    config.keys,
    { e: EFFECT.solid, b: 1, s: 0, m: 0, c: STATUS_COLORS.unread },
    'the key backlight follows the selected unread colour inside the window',
  );
  assert.equal(lighting.selectionVisible, true, 'a selection opens the window');
}

// The selection window closes on its own and the key backlight turns off.
{
  const sessions = [session('s1', IDLE)];
  const { lighting, calls } = harness({ slots: ['s1', null, null, null, null, null], sessions, selectionWindowMs: 30 });
  lighting.setHints({ selected: 's1', statuses: {}, voiceState: 'idle' });
  assert.equal(lighting.selectionVisible, true);
  assert.notDeepEqual(calls.config.at(-1).keys, OFF, 'keys light during the window');
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(lighting.selectionVisible, false, 'the window closes by itself');
  assert.deepEqual(calls.config.at(-1).keys, OFF, 'keys go dark after the window');
}

// The window key is the selected slot id alone (reference `selectedSlotId`):
// a status change on the same selected slot must not reopen the 4 s window.
{
  const sessions = [session('s1', IDLE)];
  const { lighting } = harness({ slots: ['s1', null, null, null, null, null], sessions, selectionWindowMs: 30 });
  lighting.setHints({ selected: 's1', statuses: {}, voiceState: 'idle' });
  assert.equal(lighting.selectionVisible, true);
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(lighting.selectionVisible, false);
  sessions[0] = session('s1', WORKING);
  lighting.tick();
  assert.equal(lighting.selectionVisible, false, 'a status change alone must not reopen the window');
  lighting.setHints({ selected: 's1', statuses: { s1: 'unread' }, voiceState: 'idle' });
  assert.equal(lighting.selectionVisible, false, 'a hint change alone must not reopen the window');
}


// No session store at all: a configured slot still lights (idle) instead of going dark.
{
  const calls = { threads: [], config: [] };
  const bridge = {
    connected: true,
    agentSlots: ['gone', null, null, null, null, null],
    settings: { brightness: 100 },
    lighting: { setThreads: (t) => calls.threads.push(t), setConfig: (c) => calls.config.push(c) },
  };
  const lighting = new SessionLighting({ get: () => undefined }, bridge);
  lighting.tick();
  assert.equal(calls.threads[0][0].c, STATUS_COLORS.idle, 'a bound slot lights idle without a session store');
}

// A fresh install (nothing assigned) fills the slots from recent sessions.
{
  const sessions = [session('old', IDLE, 1), session('new', WORKING, 2)];
  const { lighting, calls } = harness({ slots: [null, null, null, null, null, null], sessions });
  lighting.tick();
  const threads = calls.threads.at(-1);
  assert.equal(threads[0].c, STATUS_COLORS.working, 'newest session first');
  assert.equal(threads[0].e, EFFECT.solid, 'and it is solid');
  assert.equal(threads[1].c, STATUS_COLORS.idle);
  assert.equal(threads[2].c, 0, 'remaining slots off');
}

// Subagent sessions are delegated runs, not chats the user holds: they never
// fill an agent key, and the renderer is told their ids so its pickers skip them.
{
  const sub = { ...session('sub', WORKING, 3), header: { createdAt: 3, origin: 'subagent' } };
  const sessions = [session('main', IDLE, 1), sub];
  const { lighting, calls } = harness({ slots: [null, null, null, null, null, null], sessions });
  lighting.tick();
  const threads = calls.threads.at(-1);
  assert.equal(threads[0].c, STATUS_COLORS.idle, 'the main chat fills the slot');
  assert.equal(threads[1].c, 0, 'the subagent run stays off even though it is newer');
  assert.deepEqual(lighting.subagentIds(), ['sub'], 'the subagent id is reported to the renderer');
}

// Unchanged models are deduped; a fresh link forces one repaint.
{
  const sessions = [session('s1', IDLE)];
  const { lighting, calls } = harness({ slots: ['s1', null, null, null, null, null], sessions });
  lighting.tick();
  const count = calls.threads.length;
  lighting.tick();
  assert.equal(calls.threads.length, count, 'an unchanged model must not be re-sent');
  lighting.lastKey = ''; // what onConnected does after a replug
  lighting.tick();
  assert.equal(calls.threads.length, count + 1, 'a reconnect must repaint');
}

// A long turn keeps appending events after `turn/start`; folding a fixed tail
// window used to read it as idle, which is why a working chat lit solid white.
{
  const filler = Array.from({ length: 300 }, (_, index) => ({ type: 'tool/call', data: { index } }));
  const sessions = [session('s1', [...WORKING, ...filler])];
  const { lighting, calls } = harness({ slots: ['s1', null, null, null, null, null], sessions });
  lighting.tick();
  assert.equal(calls.threads.at(-1)[0].c, STATUS_COLORS.working, 'a long active turn still reads working');
  // Only appended events are folded on the next tick. The turn end happened
  // while nobody was looking, so it turns unread (the reference unread flag).
  sessions[0] = session('s1', [...WORKING, ...filler, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }]);
  lighting.tick();
  assert.equal(calls.threads.at(-1)[0].c, STATUS_COLORS.unread, 'a finished background turn is unread');
  // Opening it clears that (selected + focused = read).
  lighting.setHints({ selected: 's1', focused: true, statuses: {}, voiceState: 'idle' });
  assert.equal(calls.threads.at(-1)[0].c, STATUS_COLORS.idle, 'opening the thread returns the key to idle');
}

// A pending `approval/asked` without `approval/decided` is the host-side
// equivalent of the reference `attention.kind === "approval"` status.
{
  const asked = { type: 'approval/asked', data: { id: 'req-1', toolName: 'pwsh' } };
  const sessions = [session('s1', [...WORKING, asked])];
  const { lighting, calls } = harness({ slots: ['s1', null, null, null, null, null], sessions });
  lighting.tick();
  assert.equal(calls.threads.at(-1)[0].c, STATUS_COLORS['awaiting-approval'], 'an open approval asks for attention');
  // Nothing in the reference sets the `pulsing` field, so an unselected
  // approval key is solid; only the selected key breathes.
  assert.equal(calls.threads.at(-1)[0].e, EFFECT.solid, 'an unselected approval key is solid');
  sessions[0] = session('s1', [...WORKING, asked, { type: 'approval/decided', data: { id: 'req-1', outcome: 'allow' } }]);
  lighting.tick();
  assert.equal(calls.threads.at(-1)[0].c, STATUS_COLORS.working, 'deciding it returns to the turn status');
}

// Reference `rQ`: the focused window clears `unread` on the selected thread.
{
  const sessions = [session('s1', IDLE), session('s2', IDLE)];
  const { lighting, calls } = harness({ slots: ['s1', 's2', null, null, null, null], sessions });
  lighting.setHints({ selected: 's1', focused: false, statuses: { s1: 'unread' }, voiceState: 'idle' });
  assert.equal(calls.threads.at(-1)[0].c, STATUS_COLORS.unread, 'unread stays while the window is not focused');
  lighting.setHints({ selected: 's1', focused: true, statuses: { s1: 'unread' }, voiceState: 'idle' });
  assert.equal(calls.threads.at(-1)[0].c, STATUS_COLORS.idle, 'focused + selected unread shows idle');
  assert.equal(calls.threads.at(-1)[0].e, EFFECT.breath, 'the selected key still breathes');
  lighting.setHints({ selected: 's1', focused: true, statuses: { s2: 'unread' }, voiceState: 'idle' });
  assert.equal(calls.threads.at(-1)[1].c, STATUS_COLORS.unread, 'another chat keeps its unread status');
}

// The 4 s countdown only runs while the control plane can take writes: a hint
// that arrives before the link is up must not burn the window (reference
// `updateLighting` gates on `initialLightingPending`/`controlPlaneStatus`).
{
  const sessions = [session('s1', IDLE)];
  const { lighting, bridge } = harness({ slots: ['s1', null, null, null, null, null], sessions, selectionWindowMs: 30 });
  bridge.connected = false;
  lighting.setHints({ selected: 's1', statuses: {}, voiceState: 'idle' });
  assert.equal(lighting.selectionVisible, true, 'the selection is recorded while offline');
  assert.equal(lighting.selectionTimer, null, 'no countdown before the device is writable');
  await new Promise((resolve) => setTimeout(resolve, 70));
  assert.equal(lighting.selectionVisible, true, 'the window did not burn away offline');
  bridge.connected = true;
  lighting.tick();
  assert.ok(lighting.selectionTimer, 'the countdown starts once the link is writable');
  await new Promise((resolve) => setTimeout(resolve, 70));
  assert.equal(lighting.selectionVisible, false, 'and closes after the window');
}

// Losing the link clears the open window; the same selection does not reopen it
// on replug (reference keeps `selectedSlotId`, clears `selectionLightingVisible`).
{
  const sessions = [session('s1', IDLE)];
  const { lighting, bridge } = harness({ slots: ['s1', null, null, null, null, null], sessions, selectionWindowMs: 30 });
  lighting.setHints({ selected: 's1', statuses: {}, voiceState: 'idle' });
  assert.equal(lighting.selectionVisible, true);
  bridge.connected = false;
  lighting.onDisconnected();
  assert.equal(lighting.selectionVisible, false, 'link loss clears the window');
  bridge.connected = true;
  lighting.tick();
  assert.equal(lighting.selectionVisible, false, 'the same selection does not reopen on replug');
}

// `unread` is synthesized from the log: a turn that ended after the user last
// looked at the thread is unread; looking at it (selected + focused) clears it.
{
  const sessions = [session('s1', IDLE)];
  const { lighting, calls } = harness({ slots: ['s1', null, null, null, null, null], sessions });
  lighting.setHints({ selected: 's1', focused: true, statuses: {}, voiceState: 'idle' });
  assert.equal(calls.threads.at(-1)[0].c, STATUS_COLORS.idle, 'a focused selected thread is read');
  // The user switches away; a new turn finishes in the background.
  lighting.setHints({ selected: null, focused: false, statuses: {}, voiceState: 'idle' });
  sessions[0] = session('s1', [
    ...IDLE,
    { type: 'turn/start', data: { turn: 2 } },
    { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } },
  ]);
  lighting.tick();
  assert.equal(calls.threads.at(-1)[0].c, STATUS_COLORS.unread, 'a finished background turn is unread');
  assert.equal(calls.threads.at(-1)[0].e, EFFECT.solid, 'unread is solid, like the reference');
  // Opening it again (selected + focused) marks it read.
  lighting.setHints({ selected: 's1', focused: true, statuses: {}, voiceState: 'idle' });
  assert.equal(calls.threads.at(-1)[0].c, STATUS_COLORS.idle, 'opening the thread clears unread');
}

// Hints can accelerate a status the Host log has not seen yet: the renderer's
// `uiSession.sessionStatus` reports `running` before turn/start is folded.
{
  const sessions = [session('s1', IDLE)];
  const { lighting, calls, bridge } = harness({ slots: ['s1', null, null, null, null, null], sessions });
  bridge.client = { at: Date.now() };
  lighting.setHints({ selected: null, focused: false, statuses: { s1: 'working' }, voiceState: 'idle' });
  assert.equal(calls.threads.at(-1)[0].c, STATUS_COLORS.working, 'the running hint turns the key working');
}

// The createdAt fallback only applies when no renderer ever reported slots: a
// live renderer is the model owner, and a creation-order guess would disagree
// with the labels on the keys.
{
  const sessions = [session('old', IDLE, 1), session('new', IDLE, 2)];
  const { lighting, calls, bridge } = harness({ slots: [null, null, null, null, null, null], sessions });
  bridge.client = { at: Date.now() };
  lighting.tick();
  assert.equal(calls.threads.at(-1)[0].c, 0, 'no createdAt guess while the renderer is live');
  bridge.client = { at: Date.now() - 60_000 };
  lighting.tick();
  assert.equal(calls.threads.at(-1)[0].c, STATUS_COLORS.idle, 'stale renderer: fall back to the store');
}

console.log('session lighting test: OK');
console.log('  §4.6 thstatus (solid/breath) + rgbcfg (working snake, 4 s window, voice), hints merge, dedupe, repaint');
