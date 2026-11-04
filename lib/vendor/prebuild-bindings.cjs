/**
 * Prebuilt-binary resolver (vendored).
 *
 * This is `pkg-prebuilds/bindings.js` (MIT, Julian Waller) reduced to the one
 * thing we need and inlined here so the plugin can be installed with a plain
 * `git`/tarball copy and no `node_modules` of its own.
 *
 * Why it exists at all: `node-hid` is only available as a native addon, and any
 * dependency carrying an install script makes pnpm 11 fail the whole profile
 * install (`ERR_PNPM_IGNORED_BUILDS`, exit 1) even though the prebuilt binary
 * ships inside the tarball and needs no compiler. Vendoring the runtime takes
 * pnpm out of the picture: nothing to build, nothing to approve.
 *
 * Behaviour is the same as upstream: look for `prebuilds/<name>-<platform>-
 * <arch>/<runtime>-napi-v<n>.node`, then (for a local build) `build/Release`.
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { getPrebuildName, isAlpine } = require('./prebuild.cjs');

function resolvePath(basePath, options, throwOnMissing) {
  if (typeof basePath !== 'string' || basePath === '') throw new Error('Invalid basePath to prebuild-bindings');
  if (!options || typeof options !== 'object') throw new Error('Invalid options to prebuild-bindings');
  if (typeof options.name !== 'string' || options.name === '') throw new Error('Invalid name to prebuild-bindings');
  if (!Array.isArray(options.napi_versions) || options.napi_versions.length === 0) {
    throw new Error('Only Node-API prebuilds are supported');
  }

  const arch = os.arch();
  const platform = os.platform();
  const libc = isAlpine(platform) ? 'musl' : undefined;

  const candidates = [
    path.join(basePath, 'build', 'Debug', `${options.name}.node`),
    path.join(basePath, 'build', 'Release', `${options.name}.node`),
  ];
  for (const version of options.napi_versions) {
    candidates.push(
      path.join(
        basePath,
        'prebuilds',
        getPrebuildName({ name: options.name, platform, arch, libc, napi_version: version, runtime: 'node' }),
      ),
    );
  }

  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      /* try the next candidate */
    }
  }

  if (throwOnMissing) {
    throw new Error(
      `No prebuilt binding for ${options.name} (${platform}-${arch}${libc ? `-${libc}` : ''}, node-api ${options.napi_versions.join('/')}).\n` +
        `Tried:\n${candidates.map((item) => ` - ${item}`).join('\n')}`,
    );
  }
  return null;
}

function loadBinding(basePath, options) {
  const found = resolvePath(basePath, options, true);
  // eslint-disable-next-line import/no-dynamic-require
  return require(found);
}

loadBinding.resolve = (basePath, options) => resolvePath(basePath, options, false);

module.exports = loadBinding;
