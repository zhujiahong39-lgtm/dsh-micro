/**
 * Theme-token gate.
 *
 * The panel renders inside the host, so every colour it paints has to come from
 * the host's own tokens. A typo — or a token that never existed — degrades
 * silently: `var(--dsw-alias-switch-thumb, #fff)` looks fine in dark mode and
 * paints the fallback forever, and the fallback is a literal that ignores the
 * theme. Nothing in the render tests can catch that, because the browser drops
 * an unresolved custom property without an error.
 *
 * `tools/theme-tokens.txt` is the set of tokens the theme package actually
 * defines. This test fails when the panel references anything outside it.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const known = new Set(
  readFileSync(join(root, 'tools', 'theme-tokens.txt'), 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#')),
);

assert.ok(known.size > 100, `token list looks truncated: ${known.size} entries`);
assert.ok(known.has('--dsw-alias-bg-layer-1'), 'token list is missing a token the panel uses');

const source = readFileSync(join(root, 'lib', 'client.js'), 'utf8');
const used = new Set(source.match(/--dsw-[a-z0-9-]+/g) ?? []);
assert.ok(used.size > 5, `expected the panel to use theme tokens, found ${used.size}`);

const unknown = [...used].filter((token) => !known.has(token)).sort();
assert.deepEqual(unknown, [], `tokens not defined by the host theme: ${unknown.join(', ')}`);

console.log(`token test: OK, ${used.size} tokens referenced, all defined by the host theme`);
