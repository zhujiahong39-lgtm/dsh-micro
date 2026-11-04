/**
 * Wire-level facts for the macro-pad (lib/lighting-wire.cjs).
 *
 * These are the parts an independent reimplementation must get exactly right,
 * so they are tested without a device: short-key minimization, the 1/0 sync
 * flags, USB-vs-Bluetooth path detection, product-string typing (pids are not
 * stable across firmware builds) and the focus-app announce payload.
 *
 *   node test/lighting-wire.mjs
 */
import assert from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  transportOf,
  deviceTypeOf,
  focusAppPayload,
  focusAppDisabled,
  minimizeSide,
  minimizeThread,
} = require('../lib/lighting-wire.cjs');

// 1. thread entries: long form -> the firmware's short keys, sk/sa as 1/0.
{
  const minimized = minimizeThread({
    id: 3,
    color: 0xff0000,
    brightness: 0.5,
    effect: 2,
    speed: 0.4,
    syncKeysLighting: true,
    syncAmbientLighting: false,
  });
  assert.deepEqual(minimized, { id: 3, c: 0xff0000, b: 0.5, e: 2, s: 0.4, sk: 1, sa: 0 });
}
{
  // Already-short entries pass through untouched, and unset fields stay absent
  // (the firmware keeps its current value for an omitted field).
  const minimized = minimizeThread({ id: 0, c: 0x00ff00, b: 1, e: 1, s: 0, sk: 0, sa: 0 });
  assert.deepEqual(minimized, { id: 0, c: 0x00ff00, b: 1, e: 1, s: 0, sk: 0, sa: 0 });
}
{
  const minimized = minimizeThread({ id: 5 });
  assert.deepEqual(minimized, { id: 5 }, 'only the id is mandatory');
}

// 2. rgbcfg sides: two zones, five short keys each.
{
  assert.deepEqual(minimizeSide({ effect: 1, brightness: 1, speed: 0.4, magic: 0, color: 0xffffff }), {
    e: 1,
    b: 1,
    s: 0.4,
    m: 0,
    c: 0xffffff,
  });
  assert.deepEqual(minimizeSide({ e: 0, b: 0, s: 0, m: 0, c: 0 }), { e: 0, b: 0, s: 0, m: 0, c: 0 });
  assert.equal(minimizeSide(null), undefined, 'a missing zone stays undefined');
}

// 3. transport comes from the OS path, not from a release-number heuristic.
{
  const usb = '\\\\?\\HID#VID_303A&PID_8360&Col04#7&1c6e3a78&0&0003#{4d1e55b2-f16f-11cf-88cb-001111000030}';
  const ble =
    '\\\\?\\HID#{00001812-0000-1000-8000-00805f9b34fb}_Dev_VID&02303a_PID&8360_REV&0101_fc5640305201&Col04#9&70c68cb&0&0003#{4d1e55b2-f16f-11cf-88cb-001111000030}';
  assert.equal(transportOf({ path: usb }), 'usb');
  assert.equal(transportOf({ path: ble }), 'bluetooth');
  assert.equal(transportOf({ path: usb, transport: 'USB' }), 'usb', 'node-hid transport wins when present');
  assert.equal(transportOf({}), 'usb', 'unknown falls back to wired');
}

// 4. typing follows the product string, because the pid flips across firmware
//    builds of the same unit (0x8360 <-> 0x8297/0x8298 observed).
{
  const yogo = { productId: 0x8298, product: 'Yogo Micro', manufacturer: 'ATK' };
  assert.equal(deviceTypeOf(yogo), 'codex_micro', 'the OAI unit is identified by its product name');
  assert.equal(deviceTypeOf({ productId: 0x8360, product: 'DSH Micro' }), 'codex_micro');
  assert.equal(deviceTypeOf({ productId: 0x8298, product: 'Creator Micro' }), 'creator_micro_v2');
  assert.equal(deviceTypeOf({ productId: 0x1234, product: 'Something' }), 'unknown');
}

// 5. focus-app announce: name override and off switch.
{
  const payload = focusAppPayload({}, 'C:\\Program Files\\Harness\\Harness.exe');
  assert.deepEqual(payload, {
    appName: 'DeepSeek Harness',
    process: 'Harness.exe',
    path: 'C:\\Program Files\\Harness\\Harness.exe',
  });
  assert.equal(focusAppPayload({ DSH_MICRO_FOCUS_APP: 'Codex' }).appName, 'Codex');
  assert.equal(focusAppDisabled({}), false);
  for (const off of ['off', '0', 'false', 'no']) {
    assert.equal(focusAppDisabled({ DSH_MICRO_FOCUS_APP: off }), true, `${off} disables the announce`);
  }
}

console.log('lighting wire test: OK');
console.log('  thstatus/rgbcfg minimization, 1/0 sync flags, usb-vs-ble path, product typing, focus payload');
