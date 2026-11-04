/**
 * Wire-level facts for the Work Louder / OpenAI macro-pad, kept in one pure
 * module so they can be tested without a device.
 *
 * Everything here is an independent reimplementation from observed traffic
 * (HID reports and JSON-RPC bodies exchanged with the device) and from the
 * device's own answers — no vendor package is vendored or copied.
 *
 *   v.oai.thstatus  params: [{ id, c, b, e, s, sk, sa }]   (short keys only;
 *                   omitted fields keep their device value, sk/sa are 1|0)
 *   v.oai.rgbcfg    params: { ambient: {e,b,s,m,c}, keys: {e,b,s,m,c} }
 *   host.focused_app params: { appName?, process?, path? }
 */
'use strict';

/** Pid table for the Work Louder hardware this plugin can drive. */
const DEVICE_TYPES = new Map([
  [0x8360, 'codex_micro'], // 33632 — Work Louder Codex Micro / Creator Micro "Yogo"
  [33431, 'creator_micro_v2'],
  [33432, 'creator_micro_v2'],
]);

/**
 * Product ids are not a stable identity for the OpenAI unit: one physical
 * macro-pad (serial 907069EA6FD4) enumerated as 0x8360 and as 0x8297/0x8298
 * while it was being reflashed, and the vendor lighting RPCs answered in every
 * case. Identify it by the product string it reports, and keep the pid table
 * only as the fallback for other Work Louder hardware.
 */
const OAI_PRODUCT = /yogo|codex/i;

/**
 * Wired vs Bluetooth, from the HID path the OS reports.
 *
 *   USB      \\?\HID#VID_303A&PID_8360&Col04#...
 *   BLE HID  \\?\HID#{00001812-...-00805f9b34fb}_Dev_VID&02303a_PID&8360_...
 *
 * The second form carries the HID-over-GATT service UUID; both arrive through
 * node-hid, so `transport` is presentation, not a different code path.
 */
function transportOf(device) {
  if (typeof device?.transport === 'string' && device.transport) return device.transport.toLowerCase();
  const path = String(device?.path ?? '');
  if (/\{00001812-/i.test(path) || /Dev_VID&/i.test(path)) return 'bluetooth';
  if (/VID_[0-9A-F]{4}&PID_/i.test(path)) return 'usb';
  return 'usb';
}

function deviceTypeOf(device) {
  const product = `${device?.product ?? ''} ${device?.manufacturer ?? ''}`;
  if (OAI_PRODUCT.test(product)) return 'codex_micro';
  return DEVICE_TYPES.get(device?.productId) ?? 'unknown';
}

/**
 * The firmware asks the desktop which application is focused
 * (`host.focused_app`) for its on-device context UI. The reference app answers
 * on connect and keeps refreshing it; an unanswered request just times out on
 * the device. `DSH_MICRO_FOCUS_APP` overrides the name, or turns the
 * announce off (`off` / `0` / `false` / `no`).
 */
function focusAppPayload(env = process.env, execPath = process.execPath) {
  const setting = env.DSH_MICRO_FOCUS_APP ?? '';
  const disabled = /^(off|0|false|no)$/i.test(setting);
  const path = String(execPath ?? '');
  return {
    appName: setting && !disabled ? setting : 'DeepSeek Harness',
    process: path.split(/[\\/]/).pop() ?? '',
    path,
  };
}

function focusAppDisabled(env = process.env) {
  return /^(off|0|false|no)$/i.test(env.DSH_MICRO_FOCUS_APP ?? '');
}

/** Long-form lighting objects (`effect/brightness/...`) -> the firmware's short keys. */
function minimizeSide(side) {
  if (!side || typeof side !== 'object') return undefined;
  const out = {};
  for (const [short, long] of [
    ['e', 'effect'],
    ['b', 'brightness'],
    ['s', 'speed'],
    ['m', 'magic'],
    ['c', 'color'],
  ]) {
    const value = side[short] !== undefined ? side[short] : side[long];
    if (value !== undefined) out[short] = value;
  }
  return out;
}

function minimizeThread(thread) {
  const out = { id: thread.id };
  for (const [short, long] of [
    ['c', 'color'],
    ['b', 'brightness'],
    ['e', 'effect'],
    ['s', 'speed'],
  ]) {
    const value = thread[short] !== undefined ? thread[short] : thread[long];
    if (value !== undefined) out[short] = value;
  }
  // The firmware wants 1/0, not booleans, and only when the caller set it.
  if (thread.syncKeysLighting !== undefined) out.sk = thread.syncKeysLighting ? 1 : 0;
  else if (thread.sk !== undefined) out.sk = thread.sk;
  if (thread.syncAmbientLighting !== undefined) out.sa = thread.syncAmbientLighting ? 1 : 0;
  else if (thread.sa !== undefined) out.sa = thread.sa;
  return out;
}

module.exports = {
  DEVICE_TYPES,
  OAI_PRODUCT,
  transportOf,
  deviceTypeOf,
  focusAppPayload,
  focusAppDisabled,
  minimizeSide,
  minimizeThread,
};
