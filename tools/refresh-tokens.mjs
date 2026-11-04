/**
 * Regenerate tools/theme-tokens.txt from an unpacked theme package.
 *
 *   npm pack @deepseek-ai/dsh-client-ui-theme
 *   tar -xzf deepseek-ai-dsh-client-ui-theme-*.tgz
 *   node tools/refresh-tokens.mjs ./package
 *
 * Run this after a host upgrade, then run `node test/tokens.mjs`: if the panel
 * referenced a token the new theme removed, that test names it.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = process.argv[2];
if (!pkgRoot) {
  console.error('usage: node tools/refresh-tokens.mjs <unpacked theme package>');
  process.exit(2);
}

const styles = join(pkgRoot, 'lib', 'styles');
const tokens = new Set();
for (const file of readdirSync(styles).filter((name) => name.endsWith('.css'))) {
  const text = readFileSync(join(styles, file), 'utf8');
  // Definitions only: `--dsw-x:` not `var(--dsw-x)`.
  for (const match of text.matchAll(/(--dsw-[a-z0-9-]+)\s*:/g)) tokens.add(match[1]);
}

const list = [...tokens].filter((token) => !token.endsWith('-')).sort();
if (list.length < 100) {
  console.error(`refusing to write ${list.length} tokens — wrong package?`);
  process.exit(1);
}

writeFileSync(
  join(here, 'theme-tokens.txt'),
  '# Theme tokens defined by @deepseek-ai/dsh-client-ui-theme (lib/styles/*.css).\n' +
    '# Regenerate with tools/refresh-tokens.mjs when the host ships a new theme;\n' +
    '# test/tokens.mjs fails on any reference outside this list.\n' +
    list.join('\n') +
    '\n',
);
console.log(`wrote ${list.length} tokens`);
