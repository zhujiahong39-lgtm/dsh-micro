/**
 * Run the host smoke test against a throwaway HOME.
 *
 * `lib/index.js` resolves `~/.dsh/dsh-micro-bindings.json` at module load, so
 * the redirect has to happen before that module is evaluated — a static import
 * in the test file would already have run it. This wrapper sets the variables,
 * then imports the test dynamically.
 *
 * Without it the suite read and wrote the developer's real settings: a
 * "remove device" step persisted `autoConnect: false` into the live profile and
 * every later run failed to connect, which looked exactly like a driver bug.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'cm-host-'));
process.env.USERPROFILE = home;
process.env.HOME = home;
process.env.USERPROFILE_WAS = home;

try {
  await import('./host-smoke.mjs');
} finally {
  try {
    rmSync(home, { recursive: true, force: true });
  } catch {
    /* Windows may still hold a handle; the temp dir is disposable */
  }
}
