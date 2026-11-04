/**
 * Host-side smoke test for lib/index.js against the real device.
 *
 * Boots the plugin with a fake cordis context shaped like the host's
 * (`ctx.effect`, `ctx.inject(['webServer'])`, `ctx.inject(['tools'])`), lets it
 * spawn lib/bridge.cjs, then drives the HTTP handlers directly: settings
 * persistence, lighting, bulk agent slots, "remove device" and the
 * degraded-boot paths that must never throw.
 *
 * HOME/USERPROFILE is redirected by the caller so the real
 * ~/.dsh/codex-micro-bindings.json is never touched.
 *
 *   USERPROFILE=/tmp/cm-test npm run test:host
 */
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { readFileSync, existsSync } from 'node:fs';
import * as plugin from '../lib/index.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const routes = new Map();
const effects = [];
const disposers = [];
const tools = [];

const ctx = {
  effect(fn, label) {
    effects.push(label);
    const dispose = fn();
    if (typeof dispose === 'function') disposers.push({ label, dispose });
    return typeof dispose === 'function' ? dispose : () => {};
  },
  inject(names, fn) {
    if (names.includes('webServer')) {
      fn({
        effect: ctx.effect,
        webServer: {
          register: (route) => {
            routes.set(route.path, route.handler);
            return () => routes.delete(route.path);
          },
        },
      });
    }
    if (names.includes('tools')) {
      fn({
        effect: ctx.effect,
        tools: {
          register: (tool) => {
            tools.push(tool);
            return () => {};
          },
        },
      });
    }
  },
  get() {
    return undefined;
  },
  on() {
    return () => {};
  },
  loader: { entries: () => [] },
};

plugin.apply(ctx, { autoConnect: true });
await sleep(2500);

const call = (pathname, body) =>
  new Promise((resolve, reject) => {
    const handler = routes.get(pathname);
    if (!handler) return reject(new Error(`no route ${pathname}`));
    const req = {
      method: body === undefined ? 'GET' : 'POST',
      on(event, fn) {
        if (event === 'data' && body !== undefined) fn(Buffer.from(JSON.stringify(body)));
        if (event === 'end') fn();
        return req;
      },
    };
    const res = {
      statusCode: 0,
      headers: {},
      writeHead(status, headers) {
        this.statusCode = status;
        this.headers = headers;
      },
      end(text) {
        try {
          resolve({ status: this.statusCode, body: JSON.parse(text) });
        } catch (error) {
          reject(error);
        }
      },
      write() {},
    };
    handler(req, res);
  });

// ---- plugin surface -----------------------------------------------------
assert.equal(plugin.name, 'codex-micro');
assert.deepEqual(plugin.inject, [], 'inject must stay empty: a missing service would stop the row from activating');
assert.ok(routes.has('/codex-micro/state'), 'state route missing');
assert.ok(routes.has('/codex-micro/action'), 'action route missing');

// ---- tool definition ----------------------------------------------------
assert.equal(tools.length, 1, 'codex_micro tool was not registered');
const tool = tools[0];
assert.equal(tool.name, 'codex_micro');
assert.equal(tool.parameters.type, 'object', 'parameters must be a JSON Schema object');
assert.deepEqual(tool.parameters.required, ['action'], 'required must be a schema array, not per-property flags');
assert.equal(tool.parameters.properties.action.type, 'string');
assert.ok(!('required' in tool.parameters.properties.agent), 'per-property `required` is not valid JSON Schema');
assert.equal(typeof tool.execute, 'function');
assert.equal(typeof tool.output.render, 'function');

// ---- device -------------------------------------------------------------
const state = await call('/codex-micro/state');
assert.equal(state.status, 200);
console.log('  device:', JSON.stringify(state.body.deviceState));
assert.equal(state.body.deviceState.driver, true, 'the bundled HID runtime did not load');
assert.equal(state.body.deviceState.driverSource, 'vendored', `driver source: ${state.body.deviceState.driverSource}`);
assert.equal(state.body.deviceState.status, 'connected', 'expected the real device to connect');

// the model-facing tool works against the same bridge
const toolResult = await tool.execute({ action: 'status' });
assert.equal(toolResult.ok, true, `tool status failed: ${toolResult.message}`);
assert.match(toolResult.message, /connected/);

// ---- settings are persisted (atomic write to the sandboxed home) --------
const settings = await call('/codex-micro/action', { op: 'settings', brightness: 40, autoOff: '10-minutes', encoderMode: 'reasoning' });
assert.equal(settings.status, 200);
assert.equal(settings.body.settings.brightness, 40);
assert.equal(settings.body.settings.autoOff, '10-minutes');
const file = path.join(os.homedir(), '.dsh', 'codex-micro-bindings.json');
assert.ok(existsSync(file), `expected ${file} to exist`);
const stored = JSON.parse(readFileSync(file, 'utf8'));
assert.equal(stored.settings.brightness, 40, 'brightness not persisted');
assert.equal(stored.version, 2);

// ---- lighting writes reach the firmware ---------------------------------
const light = await call('/codex-micro/action', {
  op: 'light',
  threads: [{ id: 0, c: 0x304ffe, b: 1, e: 2, s: 0.4, sk: 0, sa: 0 }],
});
assert.equal(light.body.ok, true);

// ---- bulk agent slots / bindings ----------------------------------------
const slots = await call('/codex-micro/action', { op: 'agent-slots', slots: ['a', null, 'b', null, null, null] });
assert.deepEqual(slots.body.agentSlots, ['a', null, 'b', null, null, null]);

const bind = await call('/codex-micro/action', { op: 'bind-all', bindings: { ACT06: 'TERM', NOPE: 'x' } });
assert.equal(bind.body.bindings.ACT06, 'TERM');
assert.equal(bind.body.bindings.NOPE, undefined);

await call('/codex-micro/action', { op: 'bind', key: 'AG00', action: 'command:toggleTerminal' });
const reset = await call('/codex-micro/action', { op: 'reset-bindings' });
assert.equal(reset.body.bindings.AG00, 'command:toggleTerminal', 'reset must not clobber agent keys');
assert.equal(reset.body.bindings.ACT06, 'FAST', 'reset must restore the layout');

// ---- unknown op is a 400, not a crash -----------------------------------
const unknown = await call('/codex-micro/action', { op: 'nope' });
assert.equal(unknown.status, 400);

// ---- remove device stops watching and stays disconnected ----------------
const remove = await call('/codex-micro/action', { op: 'remove' });
assert.equal(remove.body.settings.autoConnect, false);
await sleep(2600);
const afterRemove = await call('/codex-micro/state');
assert.equal(afterRemove.body.connected, false, 'device reconnected after remove');
const storedAfter = JSON.parse(readFileSync(file, 'utf8'));
assert.equal(storedAfter.settings.autoConnect, false, 'autoConnect=false was not persisted');

// ---- retry clears the breaker -------------------------------------------
const retry = await call('/codex-micro/action', { op: 'retry' });
assert.equal(retry.body.ok, true);

// ---- SSE teardown -------------------------------------------------------
// Unregistering a route does NOT close responses already serving on it, so a
// fiber disposal has to end its streams itself. Without this, every panel the
// user ever opened leaves one live response and one 15 s heartbeat behind.
let closeFromPeer = null;
let ended = false;
const frames = [];
const sseReq = {
  method: 'GET',
  on(event, fn) {
    if (event === 'close') closeFromPeer = fn;
    return sseReq;
  },
};
const sseRes = {
  writeHead() {},
  write(chunk) {
    frames.push(String(chunk));
    return true;
  },
  end() {
    ended = true;
  },
};
routes.get('/codex-micro/events')(sseReq, sseRes);
assert.ok(frames.some((frame) => frame.includes('"type":"hello"')), 'SSE should open with a hello frame');
assert.equal(ended, false, 'SSE stream must stay open while the plugin is mounted');

const bridgeEffect = disposers.find((entry) => entry.label.includes('bridge process'));
assert.ok(bridgeEffect, 'bridge effect must be registered');
bridgeEffect.dispose();
assert.equal(ended, true, 'plugin teardown must end open SSE responses');
closeFromPeer();
assert.equal(ended, true, 'a late peer close after teardown must be harmless');
console.log('  sse teardown: OK');

// ---- degraded boot: a context without webServer/tools must not throw ----
const bare = {
  effect(fn) {
    return fn() ?? (() => {});
  },
  inject() {
    /* services never arrive */
  },
};
// reportError writes to stderr by design; keep the expected failure quiet here.
const stderrWrite = process.stderr.write.bind(process.stderr);
process.stderr.write = () => true;
try {
  plugin.apply(bare, {});
  plugin.apply(undefined, {});
  plugin.apply({ effect() {}, inject() {} }, 'not-an-object');
} finally {
  process.stderr.write = stderrWrite;
}
console.log('  degraded apply: OK');

console.log('host smoke test: OK');
console.log('  routes:', [...routes.keys()].join(' '));
console.log('  effects:', effects.join(' | '));
process.exit(0);
