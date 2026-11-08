/**
 * Transport-selection contract for the Codex Micro link.
 *
 * The reference desktop service derives wired vs Bluetooth from the HID path
 * (HID-over-GATT) or, when the platform hides it, from the firmware build
 * number (`bcdDevice % 4 === 0` is the wired firmware). Wired always wins, and
 * device ids follow the vendor's preference order. These rules are pure, so
 * they are tested without the device.
 */
import assert from 'node:assert';

const transport = await import('../lib/transport.cjs');
const {
  BACKOFF_MS,
  SETTLE_RETRY_MS,
  PID_CODEX_MICRO,
  PID_CREATOR_MICRO_V2,
  isUsbConnection,
  transportOf,
  rankCandidates,
  topologyKey,
} = transport;

const wired = {
  path: '\\\\?\\HID#VID_303A&PID_8360&Col04#7&1a2b3c&0&0003',
  productId: 33632,
  release: 1024, // USB firmware build: divisible by 4
  rpc: true,
};
const overGatt = {
  path: '\\\\?\\HID#{00001812-0000-1000-8000-00805f9b34fb}_Dev_VID&02303a_PID&8360&Col04#7&9f8e7d&0&0000',
  productId: 33632,
  release: 1022, // Bluetooth build
  rpc: true,
};
const keyboardInterface = { ...wired, path: wired.path.replace('Col04', 'Col02'), usagePage: 1, rpc: false };

// 1. wired / Bluetooth detection
assert.equal(isUsbConnection(wired), true, 'the VID/PID path is wired');
assert.equal(isUsbConnection(overGatt), false, 'the HID-over-GATT path is Bluetooth');
assert.equal(transportOf(wired), 'usb');
assert.equal(transportOf(overGatt), 'bluetooth');
// explicit transport wins over the path
assert.equal(isUsbConnection({ ...overGatt, transport: 'usb' }), true);
assert.equal(isUsbConnection({ ...wired, transport: 'bluetooth' }), false);
// unknown path falls back to the firmware-build heuristic
assert.equal(isUsbConnection({ path: '', productId: 33632, release: 1024 }), true);
assert.equal(isUsbConnection({ path: '', productId: 33632, release: 1023 }), false);
// transportOf uses the same fallback when the path is opaque
assert.equal(transportOf({ path: '', release: 1024 }), 'usb');
assert.equal(transportOf({ path: '', release: 1023 }), 'bluetooth');
console.log('  transport: wired/Bluetooth detection (path + firmware build)');

// 2. candidate ranking: RPC interfaces only, wired first, then product order
const ranked = rankCandidates([overGatt, keyboardInterface, wired]);
assert.deepEqual(ranked.map((entry) => entry.path), [wired.path, overGatt.path], 'wired must rank first and non-RPC interfaces must be dropped');
const creator = { ...overGatt, productId: PID_CREATOR_MICRO_V2[0] };
assert.equal(rankCandidates([creator, overGatt])[0].productId, PID_CODEX_MICRO, 'on the same transport the Codex Micro ranks before Creator Micro');
assert.equal(rankCandidates([{ ...wired, rpc: false }]).length, 0, 'no RPC interface means no candidate');
console.log('  transport: wired-first ranking with product preference');

// 3. topology diffing: same interface set is stable, transport/path changes are not
assert.equal(topologyKey([wired, keyboardInterface]), topologyKey([keyboardInterface, wired]), 'topology key is order-independent');
assert.notEqual(topologyKey([wired]), topologyKey([wired, overGatt]), 'a new interface changes the key');
assert.notEqual(topologyKey([wired]), topologyKey([{ ...wired, path: pluginPath('VID_303A&PID_8360&Col04#other') }]), 'a new path changes the key');
console.log('  transport: topology keys detect hotplug changes');

// 4. reference timings are preserved
assert.deepEqual(BACKOFF_MS, [1000, 2000, 5000, 10000], 'reconnect backoff must match the reference');
assert.deepEqual(SETTLE_RETRY_MS, [250, 1000, 3000], 'settle retries must match the reference');
console.log('  transport: reference backoff / settle timings');

function pluginPath(rest) {
  return `\\\\?\\HID#${rest}#7&deadbeef&0&0001`;
}

console.log('transport test: OK');
