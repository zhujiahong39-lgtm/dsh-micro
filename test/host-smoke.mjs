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

const call = (pathname, body, headers = {}) =>
  new Promise((resolve, reject) => {
    const handler = routes.get(pathname);
    if (!handler) return reject(new Error(`no route ${pathname}`));
    const req = {
      method: body === undefined ? 'GET' : 'POST',
      // What the browser's own fetch sends: same-origin, JSON body. Tests that
      // mean to be cross-site override these.
      headers: body === undefined
        ? {}
        : {
            host: '127.0.0.1:3080',
            origin: 'http://127.0.0.1:3080',
            'sec-fetch-site': 'same-origin',
            'content-type': 'application/json',
            ...headers,
          },
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

// ---- the write route refuses cross-site callers -------------------------
// These routes live on the Harness web server, so any page open in the same
// browser can POST to them; only the reply is unreadable without CORS. Each
// refusal is asserted on its own, and a same-origin JSON call still has to
// reach the handler, so the guard cannot become a wall around the panel.
const refused = { op: 'nope' };
// An old client that predates Sec-Fetch-Site: Origin is all we have.
assert.equal(
  (await call('/codex-micro/action', refused, { origin: 'https://evil.example', 'sec-fetch-site': undefined })).status,
  403,
  'a foreign Origin must be refused',
);
assert.equal(
  (await call('/codex-micro/action', refused, { 'sec-fetch-site': 'cross-site' })).status,
  403,
  'Sec-Fetch-Site: cross-site must be refused',
);
assert.equal(
  (await call('/codex-micro/action', refused, { 'content-type': 'application/x-www-form-urlencoded' })).status,
  403,
  'a form content type must be refused: it would not preflight',
);
assert.equal(
  (await call('/codex-micro/action', refused)).status,
  400,
  'a same-origin JSON request must still reach the handler',
);

// ---- arbitrary firmware methods are not reachable over HTTP -------------
// The panel never called this op, so it was pure attack surface: an
// unauthenticated relay from any same-origin script to the firmware.
const httpRpc = await call('/codex-micro/action', { op: 'rpc', method: 'sys.version' });
assert.equal(httpRpc.status, 400, 'op=rpc must not be served over HTTP');
assert.match(String(httpRpc.body.error), /codex_micro tool/);

// The model keeps the escape hatch, minus the irreversible methods.
const blockedRpc = await tool.execute({ action: 'rpc', method: 'sys.bootloader' });
assert.equal(blockedRpc.ok, false, 'the tool must refuse bootloader entry');
assert.match(String(blockedRpc.message), /panel/);
const allowedRpc = await tool.execute({ action: 'rpc', method: 'sys.version' });
assert.equal(allowedRpc.ok, true, `read-only rpc was blocked: ${allowedRpc.message}`);

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

// ---- request body is bounded -------------------------------------------
// A size cap alone is not enough: the reader has to stop appending and tear
// the socket down, or an oversized upload still costs memory until the client
// gives up on its own.
const postRaw = (chunks) =>
  new Promise((resolve, reject) => {
    const handler = routes.get('/codex-micro/action');
    if (!handler) return reject(new Error('no action route'));
    const listeners = new Map();
    const req = {
      method: 'POST',
      destroyed: false,
      headers: {
        host: '127.0.0.1:3080',
        origin: 'http://127.0.0.1:3080',
        'sec-fetch-site': 'same-origin',
        'content-type': 'application/json',
      },
      on(event, fn) {
        listeners.set(event, fn);
        return req;
      },
      destroy() {
        req.destroyed = true;
      },
    };
    const res = {
      statusCode: 0,
      writeHead(status) {
        this.statusCode = status;
      },
      end(text) {
        try {
          resolve({ status: this.statusCode, body: JSON.parse(text), destroyed: req.destroyed });
        } catch (error) {
          reject(error);
        }
      },
      write() {},
    };
    Promise.resolve(handler(req, res)).catch(reject);
    for (const chunk of chunks) listeners.get('data')?.(chunk);
    listeners.get('end')?.();
  });

const over = await postRaw([Buffer.alloc(1_100_000, 0x61)]);
assert.equal(over.status, 400, 'oversized body was not refused');
assert.match(String(over.body.error), /too large/);
assert.equal(over.destroyed, true, 'oversized request was not destroyed, so reading continued');

const badJson = await postRaw([Buffer.from('{ nope')]);
assert.equal(badJson.status, 400, 'malformed JSON was not refused');
console.log('  request body: oversized and malformed refused');

console.log('host smoke test: OK');
console.log('  routes:', [...routes.keys()].join(' '));
console.log('  effects:', effects.join(' | '));
process.exit(0);
