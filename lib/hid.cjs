/**
 * HID driver resolution.
 *
 * The plugin ships a prebuilt `node-hid` runtime under `./vendor` so that a
 * plain `npm i`/git install needs no compiler, no post-install script and no
 * pnpm build approval — a native dependency with an install script makes
 * pnpm 11 abort the whole profile install with `ERR_PNPM_IGNORED_BUILDS`.
 *
 * Order of preference:
 *   1. the vendored copy (always present, pinned, no build step);
 *   2. a `node-hid` the user installed themselves (newer platform support);
 *   3. nothing — the caller reports `DRIVER_MISSING` and the plugin keeps
 *      running with the device surface disabled instead of crashing.
 *
 * `load()` never throws: a missing or broken driver is a state, not a fault.
 */
'use strict';

const path = require('node:path');

const VENDORED = path.join(__dirname, 'vendor', 'node-hid', 'nodehid.cjs');

function describe(error) {
  return {
    name: error?.name ?? 'Error',
    code: error?.code ?? null,
    message: String(error?.message ?? error),
  };
}

/**
 * @returns {{ hid: object|null, source: string|null, errors: object[] }}
 */
function load() {
  const errors = [];

  // Escape hatch for support and tests: simulate a machine with no HID stack
  // (and therefore a plugin that must degrade instead of crashing).
  if (String(process.env.DSH_MICRO_HID ?? '').toLowerCase() === 'off') {
    return { hid: null, source: null, errors: [{ source: 'disabled', message: 'DSH_MICRO_HID=off' }] };
  }

  const attempts = [
    { source: 'vendored', load: () => require(VENDORED) },
    { source: 'installed', load: () => require('node-hid') },
  ];

  for (const attempt of attempts) {
    try {
      const hid = attempt.load();
      // A module that loads but lost its native half is not usable: probe the
      // one call every code path depends on before declaring victory.
      if (typeof hid?.devices !== 'function') {
        throw new Error('module loaded but exposes no devices()');
      }
      return { hid, source: attempt.source, errors };
    } catch (error) {
      errors.push({ source: attempt.source, ...describe(error) });
    }
  }

  return { hid: null, source: null, errors };
}

let cached = null;

/** Memoised `load()`; the driver does not appear at runtime. */
function driver() {
  if (cached === null) cached = load();
  return cached;
}

/** Force a re-probe (used after the user installs a driver by hand). */
function reload() {
  cached = null;
  return driver();
}

module.exports = { load, driver, reload, VENDORED };
