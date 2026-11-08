/**
 * Transport selection for the Codex Micro HID link.
 *
 * Ported from the reference desktop service (`CodexMicroService`, the app's
 * `service-*.js` chunk):
 *
 *   - discovery keeps only interfaces whose HID usage page is 0xFF00 and whose
 *     product id belongs to the Codex Micro / Creator Micro v2 family;
 *   - the wired link is preferred over the HID-over-GATT one. On platforms
 *     whose HID stack does not expose the transport, the reference derives it
 *     from the firmware's `bcdDevice`: USB builds report a release that is a
 *     multiple of 4, the Bluetooth build does not;
 *   - candidates are ranked wired-first, then by product id preference.
 *
 * The same helpers are used by the bridge (runtime) and the test suite (pure).
 */
'use strict';

const WL_VID = 0x303a;
const RPC_USAGE_PAGE = 0xff00;

/** Codex Micro (`kbd-1.0-codex-micro`). */
const PID_CODEX_MICRO = 33632;
/** Creator Micro v2 builds share the Codex Micro layout and firmware family. */
const PID_CREATOR_MICRO_V2 = [33431, 33432];
/** Preference order from the reference service: the Codex Micro first. */
const PID_ORDER = [PID_CODEX_MICRO, ...PID_CREATOR_MICRO_V2];

/** Reconnect backoff shared with the reference reconnect loop. */
const BACKOFF_MS = [1000, 2000, 5000, 10000];
/** After a topology change the re-enumeration needs a moment to settle. */
const SETTLE_RETRY_MS = [250, 1000, 3000];
/** Reference fallback scan when no topology watcher is available. */
const FALLBACK_SCAN_MS = 30_000;
/** Polling interval used instead of the reference's native topology watcher. */
const WATCH_INTERVAL_MS = 1000;
/** A handoff must not flap: minimum time between two automatic switches. */
const HANDOFF_GUARD_MS = 1500;

/** HID-over-GATT paths carry the Bluetooth HID service UUID. */
const BLE_PATH = /\{00001812-/i;
/** Windows also renders the BLE interface as `Dev_VID&…`. */
const BLE_DEV_PATH = /Dev_VID&/i;
/** Wired interfaces carry `VID_…&PID_…` in the path. */
const USB_PATH = /VID_[0-9A-F]{4}&PID_/i;

function transportOf(device) {
  const explicit = String(device?.transport ?? '').toLowerCase();
  if (explicit === 'usb' || explicit === 'bluetooth') return explicit;
  const path = String(device?.path ?? '');
  if (BLE_PATH.test(path) || BLE_DEV_PATH.test(path)) return 'bluetooth';
  if (USB_PATH.test(path)) return 'usb';
  return isUsbConnection(device) ? 'usb' : 'bluetooth';
}

/**
 * The reference's wired/Bluetooth split: an explicit transport wins, otherwise
 * `bcdDevice % 4 === 0` marks the USB firmware build.
 */
function isUsbConnection(device) {
  const transport = String(device?.transport ?? '').toLowerCase();
  if (transport === 'usb') return true;
  if (transport === 'bluetooth' || transport === 'ble') return false;
  const path = String(device?.path ?? '');
  if (BLE_PATH.test(path) || BLE_DEV_PATH.test(path)) return false;
  if (USB_PATH.test(path)) return true;
  const release = Number(device?.release);
  if (!Number.isFinite(release)) return true;
  return release % 4 === 0;
}

function productRank(productId) {
  const index = PID_ORDER.indexOf(Number(productId));
  return index === -1 ? PID_ORDER.length : index;
}

/**
 * Pick the interface the firmware's JSON-RPC channel listens on.
 * Order: RPC usage page, wired before Bluetooth, Codex Micro before Creator
 * Micro, then the vendor's own product string as a tie-breaker.
 */
function rankCandidates(devices) {
  const brand = (device) => (/work\s*louder/i.test(String(device?.manufacturer ?? device?.product ?? '')) ? 0 : 1);
  return (Array.isArray(devices) ? devices : [])
    .filter((device) => device && device.rpc === true)
    .sort((a, b) => {
      const usb = Number(isUsbConnection(b)) - Number(isUsbConnection(a));
      if (usb !== 0) return usb;
      const pid = productRank(a.productId) - productRank(b.productId);
      if (pid !== 0) return pid;
      return brand(a) - brand(b);
    });
}

/** Stable identity for topology diffing (path + ids + transport). */
function topologyKey(devices) {
  return (Array.isArray(devices) ? devices : [])
    .map((device) => `${device.path}:${device.productId}:${transportOf(device)}`)
    .sort()
    .join('|');
}

module.exports = {
  WL_VID,
  RPC_USAGE_PAGE,
  PID_CODEX_MICRO,
  PID_CREATOR_MICRO_V2,
  PID_ORDER,
  BACKOFF_MS,
  SETTLE_RETRY_MS,
  FALLBACK_SCAN_MS,
  WATCH_INTERVAL_MS,
  HANDOFF_GUARD_MS,
  isUsbConnection,
  transportOf,
  productRank,
  rankCandidates,
  topologyKey,
};
