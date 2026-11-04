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
  return { lighting, calls };
}

// The Host log gives working/error/idle; hints add the UI-only states.
{
  const sessions = [session('s1', WORKING), session('s2', IDLE), session('s3', FAILED)];
  const { lighting, calls } = harness({ slots: ['s1', 's2', 's3', null, null, null], sessions });
  lighting.setHints({ selected: 's2', statuses: { s2: 'unread', s3: 'awaiting-approval' }, voiceState: 'idle' });
  const threads = calls.threads.at(-1);
  assert.equal(threads[0].e, EFFECT.solid, 'working is solid');
  assert.equal(threads[1].c, STATUS_COLORS.unread, 'the unread hint wins over idle');
  assert.equal(threads[2].c, STATUS_COLORS['awaiting-approval'], 'the approval hint wins over the error status');
  assert.equal(threads[2].e, EFFECT.breath, 'a pending approval pulses');
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

console.log('session lighting test: OK');
console.log('  §4.6 thstatus (solid/breath) + rgbcfg (working snake, 4 s window, voice), hints merge, dedupe, repaint');
