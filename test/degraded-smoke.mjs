/**
 * Degraded-boot test: what happens on a machine with no usable HID runtime.
 *
 * This is the failure mode that matters most for an installer — a plugin that
 * throws, or one whose child process keeps crashing, takes the host with it.
 * The requirement is narrow and absolute:
 *
 *   - `apply()` returns normally and every half still mounts;
 *   - the bridge child exits 0 and is NOT respawned;
 *   - `/state` says `driver: false` with a reason the panel can show;
 *   - `retry` is a no-op that does not throw.
 *
 *   node test/degraded-smoke.mjs
 */
process.env.DSH_CODEX_MICRO_HID = 'off';

import assert from 'node:assert';
import * as plugin from '../lib/index.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const routes = new Map();
const tools = [];
const ctx = {
  effect(fn) {
    const dispose = fn();
    return typeof dispose === 'function' ? dispose : () => {};
  },
  inject(names, fn) {
    if (names.includes('webServer')) {
      fn({ effect: ctx.effect, webServer: { register: (route) => (routes.set(route.path, route.handler), () => routes.delete(route.path)) } });
    }
    if (names.includes('tools')) {
      fn({ effect: ctx.effect, tools: { register: (tool) => (tools.push(tool), () => {}) } });
    }
  },
  get() {
    return undefined;
  },
};

assert.doesNotThrow(() => plugin.apply(ctx, {}), 'apply threw with no HID runtime');

// The child reports, then exits; give it a moment, then read the state.
await sleep(2500);

const handler = routes.get('/codex-micro/state');
assert.ok(handler, 'state route was not registered');
const body = await new Promise((resolve, reject) => {
  const res = {
    statusCode: 0,
    writeHead(status) {
      this.statusCode = status;
    },
    end(text) {
      resolve(JSON.parse(text));
    },
    write() {},
  };
  handler({ method: 'GET', on() {} }, res);
});

assert.equal(body.connected, false);
assert.equal(body.deviceState.driver, false, 'driver should read as unavailable');
assert.equal(body.deviceState.suspended?.code, 'DRIVER_MISSING', `suspended: ${JSON.stringify(body.deviceState.suspended)}`);

// The tool still exists and answers with a readable message instead of failing.
assert.equal(tools.length, 1);
const status = await tools[0].execute({ action: 'status' });
assert.equal(status.ok, true);
assert.match(status.message, /not connected|HID driver unavailable/);

// No crash loop: the child reported `unavailable` and exited 0, so it must not
// have been respawned. Two or more exit records mean the backoff is not
// holding and the host would spin forever.
const exits = (body.log ?? []).filter((line) => String(line).includes('bridge exited'));
assert.ok(exits.length <= 1, `bridge appears to have restarted: ${exits.join(' | ')}`);

// retry must be safe even when nothing can be started.
const action = routes.get('/codex-micro/action');
await new Promise((resolve, reject) => {
  const req = {
    method: 'POST',
    on(event, fn) {
      if (event === 'data') fn(Buffer.from(JSON.stringify({ op: 'retry' })));
      if (event === 'end') fn();
      return req;
    },
  };
  const res = {
    statusCode: 0,
    writeHead(status) {
      this.statusCode = status;
    },
    end(text) {
      try {
        const parsed = JSON.parse(text);
        assert.equal(this.statusCode, 200);
        assert.equal(parsed.ok, true);
        resolve(parsed);
      } catch (error) {
        reject(error);
      }
    },
    write() {},
  };
  action(req, res);
});

console.log('degraded smoke test: OK');
console.log('  suspended:', JSON.stringify(body.deviceState.suspended));
process.exit(0);
