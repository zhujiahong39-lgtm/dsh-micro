/**
 * Device-layer smoke test for lib/bridge.cjs.
 *
 * Runs the child process exactly as the host does and checks three contract
 * points that must hold on every machine, with or without the hardware:
 *
 *   1. the bundled HID runtime loads and the device can be enumerated;
 *   2. `shutdown` closes the process cleanly (exit 0, interface released);
 *   3. with no HID runtime at all the child reports `unavailable` and exits 0
 *      instead of crashing — a non-zero exit there is what makes the host
 *      respawn it forever.
 *
 *   npm run test:bridge
 */
'use strict';

const assert = require('node:assert');
const path = require('node:path');
const { spawn } = require('node:child_process');

const BRIDGE = path.join(__dirname, '..', 'lib', 'bridge.cjs');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Spawn the bridge and collect its newline-delimited JSON frames.
 * @returns {Promise<{frames: object[], code: number|null}>}
 */
function runBridge(env, { shutdownAfterMs = 1200 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BRIDGE], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    });
    const frames = [];
    let buffer = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          frames.push(JSON.parse(line));
        } catch {
          /* a partial frame, the next chunk completes it */
        }
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });

    const timer = setTimeout(() => {
      try {
        child.stdin.write(`${JSON.stringify({ t: 'shutdown' })}\n`);
      } catch {
        /* already gone */
      }
    }, shutdownAfterMs);

    const killer = setTimeout(() => {
      child.kill();
      reject(new Error(`bridge did not exit; stderr: ${stderr.slice(-400)}`));
    }, shutdownAfterMs + 6000);

    child.on('exit', (code) => {
      clearTimeout(timer);
      clearTimeout(killer);
      resolve({ frames, code, stderr });
    });
    child.on('error', reject);
  });
}

async function normalPath() {
  const { frames, code } = await runBridge({});
  assert.equal(code, 0, 'bridge did not exit cleanly on shutdown');

  const ready = frames.find((frame) => frame.t === 'ready');
  assert.ok(ready, 'no ready frame');
  assert.equal(ready.driver.ok, true, `driver failed to load: ${JSON.stringify(ready.driver.errors)}`);
  assert.equal(ready.driver.source, 'vendored', `unexpected driver source: ${ready.driver.source}`);

  const devices = frames.find((frame) => frame.t === 'devices');
  assert.ok(devices, 'no devices frame');
  assert.ok(Array.isArray(devices.devices), 'devices is not an array');

  console.log(`bridge: driver=${ready.driver.source}, devices=${devices.devices.length}`);

  // A device is present on the developer's machine; assert the RPC interface is
  // recognised rather than requiring the hardware to be plugged in.
  const rpc = devices.devices.filter((device) => device.rpc);
  if (rpc.length > 0) {
    assert.match(String(rpc[0].path), /HID#/, 'rpc device has no path');
    console.log(`  rpc interface: ${rpc[0].type} (${rpc[0].productId})`);
  } else {
    console.log('  no DSH Micro attached — enumeration only');
  }
}

async function degradedPath() {
  const { frames, code } = await runBridge({ DSH_MICRO_HID: 'off' }, { shutdownAfterMs: 500 });
  assert.equal(code, 0, 'a missing driver must not exit non-zero');

  const ready = frames.find((frame) => frame.t === 'ready');
  assert.ok(ready, 'no ready frame in the degraded path');
  assert.equal(ready.driver.ok, false, 'driver reported ok with no runtime');

  const unavailable = frames.find((frame) => frame.t === 'unavailable');
  assert.ok(unavailable, 'no unavailable frame');
  assert.equal(unavailable.code, 'DRIVER_MISSING');
  assert.ok(Array.isArray(unavailable.detail), 'unavailable frame carries no detail');
  assert.ok(!frames.some((frame) => frame.t === 'fatal'), 'degraded path emitted a fatal frame');

  console.log('bridge degraded path: unavailable + exit 0');
}

(async () => {
  await normalPath();
  await degradedPath();
  console.log('bridge smoke test: OK');
  process.exit(0);
})().catch((error) => {
  console.error('bridge smoke test FAILED:', error);
  process.exit(1);
});
