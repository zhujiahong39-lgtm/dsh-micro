/**
 * DSH Micro host plugin.
 *
 * Owns the USB HID device through a child process (./bridge.cjs), keeps the
 * lighting state machine, exposes an HTTP/SSE surface for the browser panel,
 * and registers a model-facing `dsh_micro` tool.
 *
 * Deliberately imports nothing from `@deepseek-ai/*`: the profile's installed
 * copies (0.1.0-rc.6) can differ from the running desktop host (0.2.1-rc.5),
 * and a second copy of cordis/tools would break context identity.
 *
 * Protocol: newline-delimited JSON over stdio, defined by ./bridge.cjs, which is
 * also the only reader of it. Frames are documented at the top of that file.
 */
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { writeFileSync } from 'node:fs';
import path from 'node:path';

/** Append a failure to a temp log; a broken plugin must not be silent. */
function reportError(scope, error) {
  const line = `${new Date().toISOString()} [${scope}] ${error?.stack ?? error}\n`;
  try {
    appendFileSync(path.join(os.tmpdir(), 'dsh-micro.log'), line, 'utf8');
  } catch {
    /* ignore */
  }
  try {
    process.stderr.write(`[dsh-micro] ${line}`);
  } catch {
    /* ignore */
  }
}

export const name = 'dsh-micro';
/**
 * No hard service dependency.
 *
 * `inject` is the list cordis *waits for* before calling `apply`; a service
 * listed here that a profile never provides keeps the plugin — and, in the
 * host's accounting, the whole row — from activating (`1 required plugin did
 * not activate`). Both services this plugin wants are optional by nature: the
 * panel needs `webServer`, the model tool needs `tools`, and a headless or
 * `--no-tools` profile should still boot with the device working. Each half
 * therefore asks for its own service through `ctx.inject([...])`.
 */
export const inject = [];

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(HERE, '..');
const BRIDGE_PATH = path.join(HERE, 'bridge.cjs');
const BINDINGS_PATH = path.join(os.homedir(), '.dsh', 'dsh-micro-bindings.json');
/** Pre-rename path; read as a fallback so an upgrade keeps the user's setup. */
const LEGACY_BINDINGS_PATH = path.join(os.homedir(), '.dsh', 'codex-micro-bindings.json');

/**
 * Default hardware -> keycap table, mirroring the reference layout. A value is
 * either a keycap id (`FAST`, resolved by the panel against that keycap's own
 * action) or an action string (`session.fork`). Agent keys hold their slot
 * binding so the panel can swap between chat/command/keycap assignments.
 */
const DEFAULT_BINDINGS = {
  ACT06: 'FAST',
  ACT07: 'APPR',
  ACT08: 'REJ',
  ACT09: 'SPLIT',
  ACT10: 'MIC1',
  ACT11: 'EMPT1',
  ACT12: 'CODEX',
  AG00: 'session.open:0',
  AG01: 'session.open:1',
  AG02: 'session.open:2',
  AG03: 'session.open:3',
  AG04: 'session.open:4',
  AG05: 'session.open:5',
  // Rotation follows `encoderMode`; these are only used in custom mode.
  ENC_CW: 'noop',
  ENC_CC: 'noop',
  ENC: 'noop',
  ENC_LONG: 'settings.open',
  STICK_UP: 'plan.toggle',
  STICK_DOWN: 'session.new',
  STICK_LEFT: 'session.prev',
  STICK_RIGHT: 'session.next',
};

/** Auto-dim presets, spelled the way the reference settings file spells them. */
const AUTO_OFF_MS = {
  off: 0,
  '30-seconds': 30_000,
  '1-minute': 60_000,
  '3-minutes': 180_000,
  '10-minutes': 600_000,
  '30-minutes': 1_800_000,
  '1-hour': 3_600_000,
};

/** Panel preferences, persisted next to the bindings so they survive a restart. */
const DEFAULT_SETTINGS = {
  /** 0..100, as the reference stores it. */
  brightness: 100,
  autoOff: '3-minutes',
  /** composer-navigation | conversation-scroll | reasoning | custom */
  encoderMode: 'composer-navigation',
  /** pinned | recent | priority | custom */
  agentSource: 'recent',
  splitMic: false,
  singleTapAgentKeys: false,
  /** push-to-talk | realtime */
  layoutVersion: 1,
  /** Set to false by "Remove device": stop watching, stay disconnected. */
  autoConnect: true,
};

function normalizeSettings(raw) {
  const out = { ...DEFAULT_SETTINGS };
  if (!raw || typeof raw !== 'object') return out;
  if (typeof raw.brightness === 'number' && Number.isFinite(raw.brightness)) {
    out.brightness = Math.max(0, Math.min(100, Math.round(raw.brightness)));
  }
  if (typeof raw.autoOff === 'string' && raw.autoOff in AUTO_OFF_MS) out.autoOff = raw.autoOff;
  else if (typeof raw.autoOffMs === 'number') {
    // Older files stored milliseconds directly; keep the closest preset.
    const match = Object.entries(AUTO_OFF_MS).find(([, ms]) => ms === raw.autoOffMs);
    if (match) out.autoOff = match[0];
  }
  if (['composer-navigation', 'conversation-scroll', 'reasoning', 'custom'].includes(raw.encoderMode)) {
    out.encoderMode = raw.encoderMode;
  } else if (['composer', 'effort', 'scroll', 'custom'].includes(raw.encoderMode)) {
    // Legacy names used by 0.2.x.
    out.encoderMode = { composer: 'composer-navigation', effort: 'reasoning', scroll: 'conversation-scroll' }[raw.encoderMode];
  }
  if (['pinned', 'recent', 'priority', 'custom'].includes(raw.agentSource)) out.agentSource = raw.agentSource;
  if (typeof raw.splitMic === 'boolean') out.splitMic = raw.splitMic;
  if (typeof raw.singleTapAgentKeys === 'boolean') out.singleTapAgentKeys = raw.singleTapAgentKeys;
  if (typeof raw.autoConnect === 'boolean') out.autoConnect = raw.autoConnect;
  if (typeof raw.layoutVersion === 'number') out.layoutVersion = raw.layoutVersion;
  return out;
}

/** Milliseconds for the current auto-dim preset. */
function autoOffMs(settings) {
  return AUTO_OFF_MS[settings.autoOff] ?? AUTO_OFF_MS['3-minutes'];
}

/** Above this the file is not ours any more (truncated write, foreign file). */
const MAX_STORE_BYTES = 8 * 1024 * 1024;

/**
 * Read the store from the current path, then from the pre-rename path once, so
 * renaming the plugin does not silently drop a user's bindings and slots.
 */
function loadStore() {
  for (const [index, candidate] of [BINDINGS_PATH, LEGACY_BINDINGS_PATH].entries()) {
    const parsed = loadStoreFile(candidate);
    if (!parsed) continue;
    // 迁移：旧文件名下读到的存储立刻写到新路径，之后只读写新文件。
    if (index === 1) {
      try {
        saveStore(parsed);
      } catch {
        /* a read-only home keeps working from the legacy file */
      }
    }
    return parsed;
  }
  return {
    version: 2,
    bindings: { ...DEFAULT_BINDINGS },
    overrides: {},
    agentSlots: normalizeAgentSlots(),
    customSlots: normalizeAgentSlots(),
    settings: normalizeSettings(),
  };
}

/** One file's contents, or null when it is absent/unusable. */
function loadStoreFile(file) {
  try {
    // Read a corrupt-but-huge file only to throw it away is a good way to make
    // the host run out of memory at boot; the store is a few kilobytes.
    const size = statSync(file).size;
    if (size > MAX_STORE_BYTES) {
      reportError('load bindings', new Error(`store is ${size} bytes; ignoring it`));
      return null;
    }
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    const usable = (value) => value && typeof value === 'object' && !Array.isArray(value);
    if (usable(raw) && (usable(raw.bindings) || usable(raw.overrides))) {
      return {
        version: 2,
        bindings: { ...DEFAULT_BINDINGS, ...(raw.bindings ?? {}) },
        overrides: { ...(raw.overrides ?? {}) },
        agentSlots: normalizeAgentSlots(raw.agentSlots),
        customSlots: normalizeAgentSlots(raw.customSlots),
        settings: normalizeSettings(raw.settings),
      };
    }
    // 0.1/0.2 files were a flat hardware-key -> action map.
    if (usable(raw)) {
      return {
        version: 2,
        bindings: { ...DEFAULT_BINDINGS, ...raw },
        overrides: {},
        agentSlots: normalizeAgentSlots(),
        customSlots: normalizeAgentSlots(),
        settings: normalizeSettings(),
      };
    }
  } catch {
    return null;
  }
  return null;
}

/** Six agent-key slots, each holding a session id or null (reference: customAgentAssignments). */
function normalizeAgentSlots(value) {
  const slots = Array.from({ length: 6 }, () => null);
  if (Array.isArray(value)) {
    for (let index = 0; index < 6; index += 1) {
      const entry = value[index];
      if (typeof entry === 'string' && entry.length > 0) slots[index] = entry;
    }
  }
  return slots;
}

/**
 * Write `tmp` then rename, so a crash mid-write cannot truncate the user's
 * key bindings (a truncated file silently falls back to defaults on load).
 */
function saveStore(store) {
  const tmp = `${BINDINGS_PATH}.${process.pid}.tmp`;
  try {
    mkdirSync(path.dirname(BINDINGS_PATH), { recursive: true });
    writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf8');
    renameSync(tmp, BINDINGS_PATH);
    return true;
  } catch (error) {
    reportError('save bindings', error);
    try {
      writeFileSync(BINDINGS_PATH, JSON.stringify(store, null, 2), 'utf8');
      return true;
    } catch {
      return false;
    }
  }
}

const NODE_CANDIDATES = [
  process.env.DSH_MICRO_NODE,
  'C:\\Program Files\\nodejs\\node.exe',
  'C:\\Program Files (x86)\\nodejs\\node.exe',
];

const DEFAULTS = {
  autoConnect: true,
  nodePath: null,
  ...DEFAULT_SETTINGS,
};

/**
 * Read the row config regardless of who built it.
 *
 * The loader hands over a plain object for a profile patch row, but a
 * schemastery-declared plugin receives a live schema instance whose fields are
 * `Observable`s (`config.autoConnect.get()`). Reading such a field as if it
 * were the value yields a truthy object and silently disables `autoConnect:
 * false`, so both shapes are unwrapped here.
 */
function readConfig(config) {
  if (!config || typeof config !== 'object') return { ...DEFAULTS };
  const out = {};
  for (const [key, raw] of Object.entries(config)) {
    out[key] = raw && typeof raw === 'object' && typeof raw.get === 'function' ? raw.get() : raw;
  }
  return { ...DEFAULTS, ...out };
}

/** Status palette, copied from the reference implementation. */
const STATUS_COLORS = {
  working: 0x304ffe,
  unread: 0x00ff4c,
  idle: 0xffffff,
  'awaiting-approval': 0xff6d00,
  'awaiting-response': 0xff6d00,
  error: 0xff0033,
  off: 0,
};

const EFFECT = { off: 0, solid: 1, snake: 2, rainbow: 3, breath: 4, gradient: 5, shallowBreath: 6 };

function resolveNode(config) {
  // `process.execPath` first: it is the interpreter already running this
  // plugin, so it exists, matches the host's ABI and needs no PATH lookup.
  // Falling back to a PATH `node` is what turns a missing interpreter into a
  // spawn loop (ENOENT on every retry) instead of a readable error.
  //
  // Under Electron that path is the app binary, not node. It only acts as an
  // interpreter when the child carries ELECTRON_RUN_AS_NODE, and depending on
  // the launcher to export it is what turns a packaging change into a second
  // GUI process instead of a bridge. `spawnBridge` therefore sets the flag
  // explicitly rather than inheriting it; see the spawn options below.
  const explicit = [config.nodePath, process.execPath, ...NODE_CANDIDATES].filter(Boolean);
  for (const candidate of explicit) {
    if (candidate === 'node') return candidate;
    if (existsSync(candidate)) return candidate;
  }
  return 'node';
}

/**
 * Firmware methods the agent may not reach through the `rpc` escape hatch.
 *
 * The hatch exists for introspection and settings (`sys.version`, `fs.list`),
 * which is what the panel itself uses. A few methods are not recoverable on the
 * device: they park the MCU in the ROM bootloader, erase storage, or reboot
 * mid-write, and a wrong call leaves a board that needs a USB reflash. Those
 * stay behind the panel, where the user is looking at the device and the click
 * is deliberate. Prefix matching keeps a firmware rename from slipping a
 * variant through.
 */
const BLOCKED_FIRMWARE_METHODS = [
  'sys.bootloader',
  'sys.dfu',
  'sys.reboot',
  'sys.reset',
  'sys.erase',
  'fs.format',
  'fs.erase',
];

function blockedFirmwareMethod(method) {
  const name = String(method ?? '').trim().toLowerCase();
  if (!/^[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)*$/.test(name)) {
    return `"${method}" is not a firmware method name (expected something like sys.version).`;
  }
  const hit = BLOCKED_FIRMWARE_METHODS.find(
    (prefix) => name === prefix || name.startsWith(`${prefix}.`) || name.startsWith(`${prefix}_`),
  );
  if (!hit) return null;
  return (
    `${name} changes the device in a way this tool cannot undo (bootloader, erase, or reboot). ` +
    'Ask the user to run it from the DSH Micro panel, where the device is in front of them.'
  );
}

/** Accept `0xff5500`, `#ff5500`, or `{r,g,b}` and return the packed int the firmware wants. */
function toPackedColor(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value >>> 0;
  if (typeof value === 'string') {
    const hex = value.trim().replace(/^#/, '');
    if (/^[0-9a-f]{1,6}$/i.test(hex)) return Number.parseInt(hex, 16);
  }
  if (value && typeof value === 'object') {
    const r = Number(value.r) & 0xff;
    const g = Number(value.g) & 0xff;
    const b = Number(value.b) & 0xff;
    return ((r << 16) | (g << 8) | b) >>> 0;
  }
  return 0;
}

/** Clamp a 0..1 normalized parameter, accepting 0..100 too. */
function unit(value, fallback = 0) {
  if (typeof value !== 'number' || Number.isNaN(value)) return fallback;
  const scaled = value > 1 ? value / 100 : value;
  return Math.min(1, Math.max(0, scaled));
}

function effectCode(value) {
  if (typeof value === 'number') return value;
  if (typeof value !== 'string') return undefined;
  return EFFECT[value.toLowerCase()];
}

/**
 * Status -> `v.oai.thstatus` entry for the model tool (`light_agent`).
 *
 * Same rule as the session-driven model (§4.6 B): selected/attention pulse,
 * everything else — including `working` — is solid. The snake belongs to the
 * ambient ring, never to a thread.
 */
function threadEntry(slot, status, options = {}) {
  const brightness = unit(options.brightness ?? 1, 1);
  const color = STATUS_COLORS[status] ?? STATUS_COLORS.off;
  if (status === 'off' || color === 0) {
    return { id: slot, c: 0, b: 0, e: EFFECT.off, s: 0, sk: 0, sa: 0 };
  }
  const pulsing = options.selected === true || options.attention === true;
  return {
    id: slot,
    c: color,
    b: brightness,
    e: pulsing ? EFFECT.breath : EFFECT.solid,
    s: pulsing ? 0.4 : 0,
    sk: 0,
    sa: 0,
  };
}

/** Device -> lighting slot, per the physical layout (ACT10+ACT11 are one double key). */
function keyIndex(key) {
  if (typeof key !== 'string') return undefined;
  const text = key.trim().toUpperCase();
  const agent = /^AG0?(\d)$/.exec(text);
  if (agent) return Number(agent[1]);
  const physical = /^ACT(\d{1,2})(?:_ACT\d{1,2})?$/.exec(text);
  if (!physical) return undefined;
  return { 6: 0, 7: 1, 8: 2, 9: 3, 10: 4, 11: 4, 12: 5 }[Number(physical[1])];
}

/**
 * Serialized, de-duplicated, retrying writer for the two lighting RPCs.
 * Input events pause writes for 100 ms so a burst of key presses is not
 * interleaved with 64-byte HID frames.
 */
class Lighting {
  constructor(callRpc, log) {
    this.callRpc = callRpc;
    this.log = log;
    this.lastThreadsKey = '';
    this.lastConfigKey = '';
    this.timer = null;
    this.pendingThreads = null;
    this.pendingConfig = null;
    /** Last accepted values, replayed after a reconnect (the device boots dark). */
    this.appliedThreads = null;
    this.appliedConfig = null;
    this.busy = false;
    this.pauseUntil = 0;
    this.idleTimer = null;
    this.autoOffMs = 0;
    this.brightness = 1;
    /** Set when the control plane rejects our writes; surfaced in the panel. */
    this.unavailable = false;
  }

  configure({ brightness, autoOffMs }) {
    if (typeof brightness === 'number') this.brightness = unit(brightness, 1);
    if (typeof autoOffMs === 'number') this.autoOffMs = Math.max(0, autoOffMs);
    this.touch();
  }

  /** Any user input resets the inactivity countdown. */
  touch() {
    this.pauseUntil = Date.now() + 100;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.autoOffMs > 0) {
      this.idleTimer = setTimeout(() => this.allOff(), this.autoOffMs);
      this.idleTimer.unref?.();
    }
  }

  setThreads(threads) {
    if (!Array.isArray(threads) || threads.length === 0) return;
    this.pendingThreads = threads;
    this.schedule();
  }

  setConfig(config) {
    if (!config || typeof config !== 'object') return;
    this.pendingConfig = config;
    this.schedule();
  }

  /** All six agent keys dark, ambient ring and key backlight off too. */
  allOff() {
    const off = { e: EFFECT.off, b: 0, s: 0, m: 0, c: 0 };
    this.pendingThreads = Array.from({ length: 6 }, (_, slot) => threadEntry(slot, 'off'));
    this.pendingConfig = { ambient: off, keys: { ...off } };
    this.schedule(true);
  }

  /**
   * The device forgets its lighting on unplug, so a reconnect must re-send the
   * last model even though its content did not change.
   */
  reapply() {
    this.lastThreadsKey = '';
    this.lastConfigKey = '';
    this.unavailable = false;
    if (this.appliedConfig) this.pendingConfig = this.appliedConfig;
    if (this.appliedThreads) this.pendingThreads = this.appliedThreads;
    this.schedule();
  }

  schedule(force = false) {
    if (force) this.lastThreadsKey = '';
    if (this.timer) return;
    const delay = Math.max(0, this.pauseUntil - Date.now());
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, delay);
    this.timer.unref?.();
  }

  async flush() {
    if (this.busy) return;
    this.busy = true;
    try {
      const config = this.pendingConfig;
      if (config) {
        this.pendingConfig = null;
        const key = JSON.stringify(config);
        if (key !== this.lastConfigKey) {
          const outcome = await this.withRetry('v.oai.rgbcfg', config);
          if (outcome.ok) {
            this.lastConfigKey = key;
            this.appliedConfig = config;
            this.unavailable = false;
          } else {
            this.unavailable = outcome.error?.code !== 'DEVICE_DISCONNECTED';
            this.log(`rgbcfg failed: ${outcome.error?.message ?? 'unknown'}`);
          }
        }
      }
      const threads = this.pendingThreads;
      if (threads) {
        this.pendingThreads = null;
        const key = JSON.stringify(threads);
        if (key !== this.lastThreadsKey) {
          const outcome = await this.withRetry('v.oai.thstatus', threads);
          if (outcome.ok) {
            this.lastThreadsKey = key;
            this.appliedThreads = threads;
            this.unavailable = false;
          } else {
            this.unavailable = outcome.error?.code !== 'DEVICE_DISCONNECTED';
            this.log(`thstatus failed: ${outcome.error?.message ?? 'unknown'}`);
          }
        }
      }
    } finally {
      this.busy = false;
      if (this.pendingThreads || this.pendingConfig) this.schedule();
    }
  }

  /**
   * One retry, not four: the reference retries a timed-out lighting write once.
   * A long backoff here blocks the whole queue and freezes the panel's lights.
   */
  async withRetry(method, params) {
    const first = await this.callRpc(method, params);
    if (first.ok) return first;
    const code = first.error?.code;
    if (code === 'DEVICE_DISCONNECTED' || code === 'BRIDGE_UNAVAILABLE' || code === 'BRIDGE_EXIT') return first;
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 250);
      timer.unref?.();
    });
    return this.callRpc(method, params);
  }
}

/**
 * Session state -> the six agent-key LEDs, the ambient ring and the key
 * backlight, following the reference implementation's synthesis (§4.6 of
 * .ref/notes/original-service.md):
 *
 *   thstatus   selected or pulsing -> breath, everything else -> solid
 *   rgbcfg     the ambient ring only lights for a selected working thread, the
 *              4 s selection window, or a voice state; the key backlight only
 *              lights during that selection window
 *
 * Status comes from the Host's session store: an open turn is `working`, a turn
 * that ended with an error is `error`, otherwise `idle`. The three UI-only
 * states (unread, awaiting-approval/response) and the selected session are
 * reported by the renderer through `op:light-hints` — the reference app builds
 * its model in the renderer for exactly that reason. Here only the hints cross
 * the boundary, so the synthesis stays in one place.
 */
const OFF_SIDE = { e: 0, b: 0, s: 0, m: 0, c: 0 };
/** How long the key backlight follows the selected thread's colour. */
const SELECTION_WINDOW_MS = 4000;
/** Voice-state ambient colours (§4.4). */
const VOICE_AMBIENT = {
  recording: { e: EFFECT.snake, s: 0.4, c: 0x2e8b57 },
  processing: { e: EFFECT.snake, s: 0.4, c: 0xffffff },
  completed: { e: EFFECT.solid, s: 0, c: 0xffffff },
};

function colorOf(status) {
  return STATUS_COLORS[status] ?? STATUS_COLORS.idle;
}

function voiceAmbient(voiceState, brightness) {
  const side = VOICE_AMBIENT[voiceState];
  if (!side) return null;
  return { e: side.e, b: brightness, s: side.s, m: 0, c: side.c };
}

/** §4.6 A — ambient ring + key backlight. */
function buildConfig(model, selectionVisible) {
  const brightness = model.brightness;
  if (model.snakingAmbientStatus) {
    return {
      keys: { ...OFF_SIDE },
      ambient: { e: EFFECT.snake, b: brightness, s: 0.4, m: 0, c: colorOf(model.snakingAmbientStatus) },
    };
  }
  const selected = model.slots.find((slot) => slot.selected === true);
  const voice = voiceAmbient(model.voiceState, brightness);
  if (!selected || selected.status === 'off') {
    return { keys: { ...OFF_SIDE }, ambient: voice ?? { ...OFF_SIDE } };
  }
  const working = selected.status === 'working';
  const side = { e: working ? EFFECT.snake : EFFECT.solid, b: brightness, s: working ? 0.4 : 0, m: 0, c: colorOf(selected.status) };
  const ambient = voice ?? (working || selectionVisible ? side : { ...OFF_SIDE });
  const keys = selectionVisible ? { e: EFFECT.solid, b: brightness, s: 0, m: 0, c: ambient.c } : { ...OFF_SIDE };
  return { keys, ambient };
}

/** §4.6 B — the six agent keys. An off slot sends a complete all-zero record. */
function buildThreads(slots, brightness) {
  return slots.map((slot) => {
    if (slot.status === 'off') return { id: slot.id, c: 0, b: 0, e: EFFECT.off, s: 0, sk: 0, sa: 0 };
    const pulse = slot.selected === true || slot.pulsing === true;
    return {
      id: slot.id,
      c: colorOf(slot.status),
      b: brightness,
      e: pulse ? EFFECT.breath : EFFECT.solid,
      s: pulse ? 0.4 : 0,
      sk: 0,
      sa: 0,
    };
  });
}

class SessionLighting {
  constructor(ctx, bridge, options = {}) {
    this.ctx = ctx;
    this.bridge = bridge;
    this.timer = null;
    this.lastKey = '';
    this.selectionWindowMs = options.selectionWindowMs ?? SELECTION_WINDOW_MS;
    /** Renderer-reported UI state: selected session, unread/approval, voice. */
    this.hints = { selected: null, voiceState: 'idle', statuses: {}, snakingAmbientStatus: null };
    /** Service state (§4.6): true for a few seconds after the selection changes. */
    this.selectionVisible = false;
    this.selectionTimer = null;
    this.selectionKey = '';
    /** Last computed model, surfaced through /state for diagnosis. */
    this.last = null;
  }

  /** The live Host session store, or null when this build does not provide one. */
  store() {
    // `ctx.get` is the sanctioned optional accessor (undefined when the service
    // is absent); `ctx.sessions` is the declared-service spelling and throws
    // without an inject, so it is only a fallback.
    try {
      const optional = this.ctx.get?.('sessions');
      if (optional && typeof optional.get === 'function') return optional;
    } catch {
      /* fall through */
    }
    try {
      const declared = this.ctx.sessions;
      if (declared && typeof declared.get === 'function') return declared;
    } catch {
      /* no session service in this composition */
    }
    return null;
  }

  /** Turn state from the tail of one session log. */
  statusOf(session) {
    try {
      const seq = Number(session?.seq ?? 0);
      if (!seq || typeof session.snapshotEvents !== 'function') return 'idle';
      const from = Math.max(0, seq - 80);
      const events = session.snapshotEvents(from, seq);
      let working = false;
      let error = false;
      for (const event of events) {
        if (event?.type === 'turn/start') {
          working = true;
          error = false;
        } else if (event?.type === 'turn/end') {
          working = false;
          error = event.data?.reason?.kind === 'error';
        }
      }
      if (working) return 'working';
      if (error) return 'error';
      return 'idle';
    } catch {
      return 'idle';
    }
  }

  /**
   * Merge the renderer's UI-only state. Approval is the most urgent (it blocks
   * the turn), then the Host's own working/error, then unread.
   */
  setHints(hints) {
    if (!hints || typeof hints !== 'object') return;
    const statuses = hints.statuses && typeof hints.statuses === 'object' ? { ...hints.statuses } : {};
    const next = {
      selected: typeof hints.selected === 'string' && hints.selected ? hints.selected : null,
      voiceState: Object.prototype.hasOwnProperty.call(VOICE_AMBIENT, hints.voiceState) || hints.voiceState === 'idle' ? hints.voiceState : 'idle',
      statuses,
      snakingAmbientStatus: ['working', 'unread', 'error'].includes(hints.snakingAmbientStatus) ? hints.snakingAmbientStatus : null,
    };
    if (JSON.stringify(next) === JSON.stringify(this.hints)) return;
    this.hints = next;
    this.tick();
  }

  /** One slot's status: the Host log state refined by the renderer's hints. */
  slotStatus(sessionId, logStatus) {
    const hint = this.hints.statuses?.[sessionId];
    if (hint === 'awaiting-approval' || hint === 'awaiting-response') return hint;
    if (logStatus === 'working' || logStatus === 'error') return logStatus;
    if (hint === 'unread') return 'unread';
    return logStatus;
  }

  /**
   * A subagent session is a delegated run, not a conversation the user holds:
   * DSH marks it with `SessionHeader.origin === "subagent"` (and a delegation
   * depth). The six agent keys follow and open main chats only; a fork stays a
   * main chat because the user started it.
   */
  isSubagent(session) {
    const header = session?.header ?? {};
    return header.origin === 'subagent' || Number(header.delegationDepth ?? 0) > 0;
  }

  /** Live subagent ids, so the renderer keeps them out of the chat pickers. */
  subagentIds() {
    try {
      const store = this.store();
      const listed = store && typeof store.list === 'function' ? store.list() : [];
      if (!Array.isArray(listed)) return [];
      return listed.filter((session) => this.isSubagent(session)).map((session) => String(session.id));
    } catch {
      return [];
    }
  }

  /**
   * Six slots: the persisted agent-key assignment wins, otherwise the most
   * recently created live sessions fill the empty slots.
   */
  slots() {
    const store = this.store();
    let sessions = [];
    try {
      const listed = store ? store.list() : [];
      // Subagent runs never occupy an agent key.
      if (Array.isArray(listed)) sessions = listed.filter((session) => !this.isSubagent(session));
    } catch {
      sessions = [];
    }
    const byId = new Map(sessions.map((session) => [String(session.id), session]));
    const assigned = Array.isArray(this.bridge.agentSlots) ? this.bridge.agentSlots : [];
    // Only fall back to "most recent sessions" when nothing is assigned at all
    // (a fresh install). A custom assignment with empty slots must stay dark.
    const configured = assigned.some((id) => Boolean(id));
    const recent = configured
      ? []
      : sessions
          .slice()
          .sort((left, right) => Number(right?.header?.createdAt ?? 0) - Number(left?.header?.createdAt ?? 0))
          .map((session) => String(session.id));
    return Array.from({ length: 6 }, (_, index) => {
      const bound = assigned[index] ? String(assigned[index]) : recent[index] ?? null;
      if (!bound) return { id: index, status: 'off', selected: false, pulsing: false };
      const session = byId.get(bound);
      const logStatus = session ? this.statusOf(session) : 'idle';
      const status = this.slotStatus(bound, logStatus);
      return {
        id: index,
        status,
        selected: this.hints.selected === bound,
        // Unread and a pending approval are the states that pulse on the device.
        pulsing: status === 'unread' || status === 'awaiting-approval' || status === 'awaiting-response',
      };
    });
  }

  model() {
    const brightness = Math.min(1, Math.max(0, Number(this.bridge.settings?.brightness ?? 100) / 100));
    return {
      brightness,
      voiceState: this.hints.voiceState,
      snakingAmbientStatus: this.hints.snakingAmbientStatus,
      slots: this.slots(),
    };
  }

  /**
   * Restart the 4 s selection window when the *selected slot* changes.
   *
   * The reference tracks a single `selectedSlotId` (`.ref/notes/switch-animation.md`,
   * service chunk `updateLighting`): only a change of that id reopens the window.
   * Keying on the status as well restarted the 4 s highlight every time a turn
   * started or ended, which kept the device lit long after a switch instead of
   * briefly.
   */
  updateSelectionWindow(slots) {
    const selected = slots.find((slot) => slot.selected === true && slot.status !== 'off');
    const key = selected ? String(selected.id) : '';
    if (key === this.selectionKey) return;
    this.selectionKey = key;
    if (!selected) {
      this.selectionVisible = false;
      return;
    }
    this.selectionVisible = true;
    if (this.selectionTimer) clearTimeout(this.selectionTimer);
    this.selectionTimer = setTimeout(() => {
      this.selectionTimer = null;
      this.selectionVisible = false;
      this.tick();
    }, this.selectionWindowMs);
    this.selectionTimer.unref?.();
  }

  /** Recompute and push only what changed. */
  tick() {
    // Called from a 1.5 s interval: a host shape we did not expect must never
    // throw out of the timer (an unhandled interval throw takes the plugin down).
    try {
      const model = this.model();
      this.updateSelectionWindow(model.slots);
      const threads = buildThreads(model.slots, model.brightness);
      const config = buildConfig(model, this.selectionVisible);
      const key = `${JSON.stringify(threads)}|${JSON.stringify(config)}`;
      this.last = {
        at: Date.now(),
        key,
        model,
        threads,
        config,
        selectionVisible: this.selectionVisible,
        connected: this.bridge.connected === true,
      };
      if (key === this.lastKey) return;
      this.lastKey = key;
      this.bridge.lighting.setThreads(threads);
      this.bridge.lighting.setConfig(config);
    } catch (error) {
      this.last = { at: Date.now(), error: String(error?.message ?? error) };
    }
  }

  start() {
    if (this.timer) return;
    // 1.5 s safety poll: the renderer pushes hints on every state change, so this
    // only catches changes nothing reported (a turn that started or ended).
    this.timer = setInterval(() => this.tick(), 1500);
    this.timer.unref?.();
    this.tick();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.selectionTimer) clearTimeout(this.selectionTimer);
    this.selectionTimer = null;
  }
}

/** Owns the bridge child process, the request queue and the event ring. */
class MicroBridge {
  constructor(ctx, config) {
    this.ctx = ctx;
    this.config = config;
    this.child = null;
    this.ready = false;
    this.devices = [];
    this.connected = false;
    this.device = null;
    /** Reference lifecycle cause of the last bridge state (see case 'state'). */
    this.devicePhase = null;
    this.connectionCause = null;
    this.lastStatus = null;
    this.events = [];
    this.seq = 0;
    /** Last v.oai.hid / v.oai.rad notification seen from the device (diagnostics). */
    this.lastHid = null;
    this.lastRad = null;
    this.hidCount = 0;
    this.radCount = 0;
    this.pending = new Map();
    this.nextId = 1;
    this.subscribers = new Set();
    this.restartTimer = null;
    this.log = [];
    this.disposed = false;
    /** Beacon from the browser bundle: proves the client half actually executed. */
    this.client = null;
    /** Hardware -> keycap bindings plus per-keycap action overrides, persisted. */
    this.store = loadStore();
    this.bindings = this.store.bindings;
    this.overrides = this.store.overrides;
    this.agentSlots = this.store.agentSlots ?? normalizeAgentSlots();
    /**
     * The user's own assignments, kept apart from `agentSlots` (the six slots
     * the hardware currently shows). In 自定义分配 mode the effective slots are
     * exactly these, so switching into that mode starts unchecked until the
     * user picks a chat or an action.
     */
    this.customSlots = this.store.customSlots ?? normalizeAgentSlots();
    this.settings = this.store.settings ?? normalizeSettings();
    if (this.settings.agentSource === 'custom') this.agentSlots = [...this.customSlots];
    /** detected: an interface exists but is not ours to drive; error: last open/IO failure. */
    this.deviceError = null;
    /** Consecutive bridge starts that died before becoming useful. */
    this.rapidExits = 0;
    this.lastSpawnAt = 0;
    /** Set when respawning is pointless until someone asks for a retry. */
    this.suspended = null;
    /** { ok, source, errors } as reported by the child's `ready` frame. */
    this.driver = null;
    this.connectedAt = 0;
    /** Remembered so the panel can name the device while it is unplugged. */
    this.lastModel = null;
    this.statusTimer = null;
    this.lighting = new Lighting((method, params) => this.call(method, params, 8000), (line) => this.pushLog(line));
    this.lighting.configure({ brightness: this.settings.brightness, autoOffMs: autoOffMs(this.settings) });
    /** Set by `setup` to the session-driven lighting owner; fired on every connect. */
    this.onConnected = null;
    /** Session state -> LEDs; `null` until `setup` installs it. */
    this.sessionLighting = null;
  }

  start({ force = false } = {}) {
    if (this.child) return;
    if (this.suspended && !force) return;
    if (force) {
      this.suspended = null;
      this.rapidExits = 0;
    }
    this.lastSpawnAt = Date.now();
    const node = resolveNode(this.config);
    let child;
    try {
      child = spawn(node, [BRIDGE_PATH], {
        cwd: PLUGIN_ROOT,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        env: {
          ...process.env,
          NODE_OPTIONS: '',
          // `process.execPath` is the Electron app binary in the desktop host.
          // It runs as node only with this flag, so set it here instead of
          // relying on the launcher having exported it: otherwise a launcher
          // change spawns a second GUI window that never speaks the bridge
          // protocol, and the failure looks like a silent hang. A real node
          // ignores the variable.
          ELECTRON_RUN_AS_NODE: '1',
        },
      });
    } catch (error) {
      this.record({ type: 'error', message: `spawn failed: ${error.message}` });
      return;
    }
    this.child = child;
    const rl = createInterface({ input: child.stdout });
    rl.on('line', (line) => this.handleLine(line));
    child.stderr.on('data', (chunk) => {
      const text = String(chunk).trim();
      if (text) this.record({ type: 'stderr', message: text });
    });
    child.on('exit', (code, signal) => {
      this.child = null;
      this.ready = false;
      this.connected = false;
      this.device = null;
      for (const [, entry] of this.pending) {
        clearTimeout(entry.timer);
        entry.resolve({ ok: false, error: { code: 'BRIDGE_EXIT', message: `bridge exited (${code ?? signal})` } });
      }
      this.pending.clear();
      this.record({ type: 'bridge-exit', code, signal });
      if (this.disposed) return;
      // A bridge that dies within a few seconds of spawning never got as far
      // as the device, so an immediate retry only repeats the same failure.
      // Unbounded retries are what turns a missing driver into a hot loop:
      // respawn every 3 s forever, one log line each time, for the whole life
      // of the host process.
      const livedMs = Date.now() - this.lastSpawnAt;
      this.rapidExits = livedMs < 10_000 ? this.rapidExits + 1 : 0;
      if (this.rapidExits >= 5) {
        this.suspended = {
          code: 'BRIDGE_CRASH_LOOP',
          message: `bridge exited ${this.rapidExits} times in a row; stopped respawning`,
        };
        this.record({ type: 'suspended', ...this.suspended });
        return;
      }
      const delay = Math.min(30_000, 1000 * 2 ** Math.max(0, this.rapidExits - 1));
      this.restartTimer = setTimeout(() => this.start(), delay);
      this.restartTimer.unref?.();
    });
    child.on('error', (error) => this.record({ type: 'error', message: `bridge error: ${error.message}` }));
  }

  stop() {
    this.disposed = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    this.stopStatusPoll();
    if (this.lighting.timer) clearTimeout(this.lighting.timer);
    this.lighting.timer = null;
    if (this.lighting.idleTimer) clearTimeout(this.lighting.idleTimer);
    this.lighting.idleTimer = null;
    // SSE responses are not owned by a route disposer: unregistering a route
    // does not close the sockets already serving on it. End them here or a
    // disable/enable cycle leaves one live stream — and one 15 s heartbeat —
    // per panel the user ever opened.
    for (const sub of [...this.subscribers]) this.dropSubscriber(sub);
    const child = this.child;
    this.child = null;
    if (child) {
      try {
        child.stdin.write(`${JSON.stringify({ t: 'shutdown' })}\n`);
      } catch {
        /* ignore */
      }
      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          /* ignore */
        }
      }, 500);
      timer.unref?.();
    }
  }

  send(message) {
    if (!this.child) {
      this.start();
      return false;
    }
    try {
      this.child.stdin.write(`${JSON.stringify(message)}\n`);
      return true;
    } catch (error) {
      this.record({ type: 'error', message: `bridge write failed: ${error.message}` });
      return false;
    }
  }

  handleLine(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    switch (msg.t) {
      case 'ready':
        this.ready = true;
        this.driver = msg.driver ?? null;
        this.record({ type: 'ready', driver: this.driver });
        if (this.driver && this.driver.ok === false) {
          // The child already reported it, but be explicit: no respawn will
          // fix a missing driver, and a respawn loop is worse than no device.
          this.suspended = { code: 'DRIVER_MISSING', message: 'HID driver unavailable' };
          this.record({ type: 'suspended', ...this.suspended });
          break;
        }
        this.send({ t: 'list' });
        this.send({ t: 'watch', enabled: this.settings.autoConnect !== false });
        break;
      case 'unavailable':
        this.driver = { ok: false, errors: msg.detail ?? [] };
        this.suspended = { code: msg.code ?? 'UNAVAILABLE', message: msg.message ?? 'device unavailable' };
        this.record({ type: 'suspended', ...this.suspended });
        break;
      case 'devices':
        this.devices = msg.devices ?? [];
        this.record({ type: 'devices', devices: this.devices });
        break;
      case 'state':
        this.connected = Boolean(msg.connected);
        this.device = msg.device ?? null;
        this.deviceError = msg.error ?? null;
        // Reference lifecycle causes: detected / connected / reconnected /
        // connection-lost / connection-failed / transport-handoff / device-lifecycle.
        this.devicePhase = msg.phase ?? (this.connected ? 'connected' : 'detected');
        this.connectionCause = msg.cause ?? null;
        if (this.connected) {
          this.connectedAt = Date.now();
          this.deviceError = null;
          if (this.device?.type && this.device.type !== 'unknown') this.lastModel = this.device.type;
          // The device forgets its lighting across a replug.
          this.lighting.reapply();
          // ...and the session-driven model has to be re-sent as well: the
          // lighting queue's dedupe key survives a reconnect.
          try {
            this.onConnected?.();
          } catch {
            /* lighting must never break the link */
          }
          this.startStatusPoll();
          void this.refreshStatus();
        } else {
          this.stopStatusPoll();
        }
        this.record({ type: 'state', connected: this.connected, device: this.device, error: this.deviceError });
        break;
      case 'response': {
        const entry = this.pending.get(msg.id);
        if (entry) {
          clearTimeout(entry.timer);
          this.pending.delete(msg.id);
          entry.resolve(msg);
        }
        break;
      }
      case 'keys':
        this.keyReports = { at: msg.at ?? Date.now(), count: msg.count ?? 0, last: msg.last ?? null };
        break;
      case 'inbound':
        this.inbound = { at: msg.at ?? Date.now(), count: msg.count ?? 0, last: msg.last ?? null };
        break;
      case 'notify': {
        this.lighting.touch();
        const params = msg.params && typeof msg.params === 'object' ? msg.params : {};
        if (msg.method === 'v.oai.hid') {
          this.hidCount = (this.hidCount ?? 0) + 1;
          this.lastHid = { at: Date.now(), key: params.key ?? null, act: params.act ?? null, agent: params.agent ?? null };
        } else if (msg.method === 'v.oai.rad') {
          this.radCount = (this.radCount ?? 0) + 1;
          this.lastRad = { at: Date.now(), angle: params.a ?? null, distance: params.d ?? null };
        }
        this.record({ type: 'notify', method: msg.method, params: msg.params });
        break;
      }
      case 'log':
        this.pushLog(`[${msg.channel}] ${msg.line}`);
        break;
      case 'error':
        this.record({ type: 'error', message: msg.message });
        break;
      case 'fatal':
        this.record({ type: 'fatal', message: msg.message });
        break;
      default:
        break;
    }
  }

  pushLog(line) {
    this.log.push(line);
    if (this.log.length > 200) this.log.shift();
  }

  async call(method, params, timeoutMs = 10_000) {
    if (!this.ready) this.start();
    // The id space wraps at 999, so a wrapped id can still belong to a request
    // that has not answered yet. Overwriting that entry would strand its timer
    // and let the old timeout delete the NEW request's entry — pick a free id.
    let id = this.nextId;
    for (let tries = 0; tries < 999 && this.pending.has(id); tries += 1) {
      id = id >= 998 ? 1 : id + 1;
    }
    if (this.pending.has(id)) {
      return { ok: false, error: { code: 'BRIDGE_BUSY', message: 'no free rpc id' } };
    }
    this.nextId = id >= 998 ? 1 : id + 1;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ ok: false, error: { code: 'TIMEOUT', message: `no answer to ${method}` } });
      }, timeoutMs + 500);
      this.pending.set(id, { resolve, timer });
      const sent = this.send({ t: 'rpc', id, method, params, timeoutMs });
      if (!sent) {
        clearTimeout(timer);
        this.pending.delete(id);
        resolve({ ok: false, error: { code: 'BRIDGE_UNAVAILABLE', message: 'bridge process not running' } });
      }
    });
  }

  async refreshStatus() {
    const res = await this.call('device.status', null, 5000);
    if (res.ok) {
      this.lastStatus = res.result;
      this.record({ type: 'status', status: res.result });
    }
    return res;
  }

  /** Battery/firmware drift while plugged in; the reference polls every 60 s. */
  startStatusPoll() {
    if (this.statusTimer) return;
    this.statusTimer = setInterval(() => {
      if (this.connected) void this.refreshStatus().catch(() => undefined);
    }, 60_000);
    this.statusTimer.unref?.();
  }

  stopStatusPoll() {
    if (this.statusTimer) clearInterval(this.statusTimer);
    this.statusTimer = null;
  }

  record(event) {
    this.seq += 1;
    const payload = { seq: this.seq, at: Date.now(), ...event };
    this.events.push(payload);
    if (this.events.length > 300) this.events.shift();
    for (const sub of this.subscribers) {
      try {
        sub.res.write(`data: ${JSON.stringify(payload)}\n\n`);
      } catch {
        this.dropSubscriber(sub);
      }
    }
  }

  /**
   * Register one SSE response and own its heartbeat.
   *
   * The interval lives in the record rather than the route closure because
   * `stop()` has to end both: a fiber disposal unregisters the route but never
   * closes the socket, so a response kept only in the closure would outlive the
   * plugin with its timer still firing.
   */
  addSubscriber(res, alive) {
    const sub = { res, alive };
    if (this.disposed) {
      try {
        res.end();
      } catch {
        /* already gone */
      }
      return sub;
    }
    this.subscribers.add(sub);
    return sub;
  }

  /** End one SSE response and forget it. Safe to call twice. */
  dropSubscriber(sub) {
    if (!sub) return;
    if (sub.alive) clearInterval(sub.alive);
    this.subscribers.delete(sub);
    try {
      sub.res.end();
    } catch {
      /* the peer is gone */
    }
  }

  persist() {
    this.store = {
      version: 2,
      bindings: this.bindings,
      overrides: this.overrides,
      agentSlots: this.agentSlots,
      customSlots: this.customSlots,
      settings: this.settings,
    };
    saveStore(this.store);
  }

  /** Merge a partial settings patch, apply it to the live lighting writer, persist. */
  updateSettings(patch) {
    const merged = { ...this.settings, ...(patch && typeof patch === 'object' ? patch : {}) };
    this.settings = normalizeSettings(merged);
    this.lighting.configure({
      brightness: this.settings.brightness,
      autoOffMs: autoOffMs(this.settings),
    });
    this.persist();
    return this.settings;
  }

  /**
   * The reference exposes a four-way control-plane state, a firmware/battery
   * snapshot and the last transport error; the panel renders all three.
   */
  deviceState() {
    const battery = this.lastStatus?.battery ?? this.lastStatus?.battery_percentage;
    return {
      status: this.connected ? 'connected' : this.devices.some((d) => d.rpc) ? 'detected' : 'not-detected',
      controlPlaneStatus: this.connected ? (this.lighting.unavailable ? 'unavailable' : 'available') : 'unavailable',
      model: this.device?.type ?? this.lastModel ?? null,
      transport: this.device?.transport ?? null,
      isUsb: this.device?.isUsb ?? null,
      /** One of the reference lifecycle causes (connected / reconnected / …). */
      connectionCause: this.connectionCause ?? null,
      /** Bridge phase while not connected: detected / connection-failed / … */
      phase: this.devicePhase ?? null,
      /** Machine-readable transport error (NOT_FOUND / OPEN_FAILED / …). */
      errorCode: this.deviceError?.code ?? null,
      battery: typeof battery === 'number' ? battery : null,
      charging: Boolean(this.lastStatus?.is_charging),
      firmware: this.lastStatus?.version ?? null,
      error: this.deviceError,
      connectedAt: this.connectedAt || null,
      /** true/false once the child has reported, null while it has not started. */
      driver: this.driver ? this.driver.ok === true : null,
      driverSource: this.driver?.source ?? null,
      suspended: this.suspended,
    };
  }

  snapshot() {
    return {
      ready: this.ready,
      connected: this.connected,
      device: this.device,
      devices: this.devices,
      lastStatus: this.lastStatus,
      deviceState: this.deviceState(),
      seq: this.seq,
      client: this.client,
      /** 设备最近一次按下：证明 HID 通知是否到达宿主（键无反应时先看这里）。 */
      lastHid: this.lastHid ?? null,
      /** 桥收到的原始报文（含非通知内容），证明设备是否在发数据。 */
      inbound: this.inbound ?? null,
      /** 普通键盘接口上收到的报文：有它但没有 v.oai.hid = 设备在发普通键盘按键。 */
      keyReports: this.keyReports ?? null,
      lastRad: this.lastRad ?? null,
      hidCount: this.hidCount ?? 0,
      bindings: this.bindings,
      overrides: this.overrides,
      agentSlots: this.agentSlots,
      /** 自定义分配：与 agentSlots 分开存，切回该模式时未勾选就是空。 */
      customSlots: this.customSlots,
      /** Delegated subagent sessions: never offered for an agent key. */
      subagentIds: this.sessionLighting?.subagentIds?.() ?? [],
      settings: { ...this.settings, autoOffMs: autoOffMs(this.settings) },
      /** Last session-driven lighting model (diagnostic: what the LEDs should show). */
      sessionLighting: this.sessionLighting?.last ?? null,
      log: this.log.slice(-40),
    };
  }
}

/**
 * Mount the plugin.
 *
 * The body lives in `setup` so that a failure — a read-only home, a corrupt
 * store, an unexpected host shape — is contained here instead of propagating
 * out of `apply`. A throw from `apply` fails the whole loader row and the host
 * reports "1 required plugin did not activate"; a device panel is never worth
 * that.
 */
export function apply(ctx, rawConfig = {}) {
  const handles = {};
  try {
    setup(ctx, rawConfig, handles);
  } catch (error) {
    reportError('dsh-micro: apply', error);
    // `ctx.effect` never ran for the half-built plugin, so release the child
    // process by hand: an orphan bridge keeps the HID interface open and the
    // next launch cannot open it.
    try {
      handles.bridge?.stop();
    } catch {
      /* nothing left to release */
    }
  }
}

function setup(ctx, rawConfig = {}, handles = {}) {
  const config = readConfig(rawConfig);
  const settings = { ...config };
  const bridge = new MicroBridge(ctx, settings);
  handles.bridge = bridge;
  // A profile that pins autoConnect:false wins over the persisted preference.
  if (config.autoConnect === false) bridge.settings.autoConnect = false;
  bridge.lighting.configure({
    brightness: bridge.settings.brightness,
    autoOffMs: autoOffMs(bridge.settings),
  });
  // Teardown first, spawn last: if anything below throws, the effect is already
  // registered and `apply`'s catch stops the child, so no spawn survives a
  // half-mounted plugin.
  ctx.effect(() => () => bridge.stop(), 'dsh-micro: bridge process');

  // ---- session state -> agent-key LEDs -----------------------------------
  // Owned by the Host half, like the reference implementation: the renderer's
  // session store is a UI projection, so driving the device from there left the
  // keyboard dark whenever the panel was closed or the projection was empty.
  const sessionLighting = new SessionLighting(ctx, bridge);
  bridge.sessionLighting = sessionLighting;
  bridge.onConnected = () => {
    // A fresh link must repaint even when the model did not change.
    sessionLighting.lastKey = '';
    sessionLighting.tick();
  };
  ctx.effect(() => {
    sessionLighting.start();
    return () => sessionLighting.stop();
  }, 'dsh-micro: session lighting');

  // ---- model-facing tool -------------------------------------------------
  // A plain literal definition with JSON Schema in `parameters` / `output`,
  // exactly like the in-tree `git_worktree` tool: the registry takes the
  // compiled schema directly, so there is no `defineTool` import and therefore
  // no host package in our dependency tree (a duplicated `@deepseek-ai/*`
  // package is what breaks the host's own plugins at boot).
  ctx.inject(['tools'], (toolCtx) => {
    const tool = {
      name: 'dsh_micro',
      description:
        'Inspect and control the DSH Micro HID macro-pad (Work Louder "Codex Micro") connected over USB. ' +
        'Actions: status/devices/connect/disconnect, light_agent (light one of the six agent keys by slot 0-5), ' +
        'light_all (statuses for all six slots), light_config (ambient ring + key backlight), rpc (escape hatch for ' +
        'read-mostly firmware methods such as sys.version, device.status, ui.home_accent_color, fs.list, ' +
        'appmgr.list_installed). rpc refuses bootloader, erase and reboot methods: tell the user to run those from ' +
        'the panel instead of retrying another spelling.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: {
            type: 'string',
            enum: ['status', 'devices', 'connect', 'disconnect', 'light_agent', 'light_all', 'light_config', 'rpc'],
            description: 'Which operation to perform.',
          },
          agent: { type: 'integer', minimum: 0, maximum: 5, description: 'Agent slot 0..5 for light_agent.' },
          status: {
            type: 'string',
            enum: ['off', 'idle', 'working', 'unread', 'awaiting-approval', 'awaiting-response', 'error'],
            description: 'Semantic status to render as colour for light_agent.',
          },
          statuses: {
            type: 'array',
            items: { type: 'string' },
            description: 'Six statuses, one per agent slot, for light_all.',
          },
          selected: { type: 'boolean', description: 'Pulse the slot (breath) instead of steady.' },
          brightness: { type: 'number', minimum: 0, maximum: 100, description: '0..1 (or 0..100).' },
          color: { type: 'string', description: 'Colour for light_config, e.g. #ff5500.' },
          effect: {
            type: 'string',
            enum: ['off', 'solid', 'snake', 'rainbow', 'breath', 'gradient', 'shallowBreath'],
            description: 'Ambient effect for light_config.',
          },
          method: { type: 'string', description: 'Firmware JSON-RPC method for action=rpc.' },
          params: { type: 'object', additionalProperties: true, description: 'JSON params for action=rpc.' },
        },
        required: ['action'],
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [{ type: 'text', text: String(value?.message ?? '') }],
      },
      timeoutMs: 30_000,
      async execute(args) {
        const input = args && typeof args === 'object' ? args : {};
        const action = String(input.action ?? 'status');

        if (action === 'status') {
          if (bridge.connected) await bridge.refreshStatus().catch(() => undefined);
          const snap = bridge.snapshot();
          const battery = snap.lastStatus?.battery ?? snap.lastStatus?.battery_percentage;
          const parts = [
            snap.connected ? `connected: ${snap.device?.type ?? 'device'}` : 'not connected',
            snap.lastStatus ? `firmware ${snap.lastStatus.version ?? '?'}` : null,
            typeof battery === 'number' ? `battery ${battery}%` : null,
            snap.lastStatus?.is_charging ? 'charging' : null,
            snap.deviceState?.driver === false ? 'HID driver unavailable' : null,
          ].filter(Boolean);
          return { ok: true, message: `DSH Micro: ${parts.join(', ')}.`, data: snap };
        }
        if (action === 'devices') {
          bridge.send({ t: 'list' });
          return { ok: true, message: `${bridge.devices.length} Work Louder device(s) visible.`, data: { devices: bridge.devices } };
        }
        if (action === 'connect') {
          bridge.send({ t: 'connect' });
          return { ok: true, message: 'Connecting to the DSH Micro…' };
        }
        if (action === 'disconnect') {
          bridge.send({ t: 'disconnect' });
          return { ok: true, message: 'Disconnected from the DSH Micro.' };
        }
        if (action === 'light_agent') {
          const slot = Number(input.agent ?? 0);
          if (!Number.isInteger(slot) || slot < 0 || slot > 5) return { ok: false, message: 'agent must be 0..5.' };
          bridge.lighting.setThreads([threadEntry(slot, String(input.status ?? 'idle'), { selected: input.selected === true })]);
          return { ok: true, message: `Slot ${slot} set to ${input.status ?? 'idle'}.` };
        }
        if (action === 'light_all') {
          const statuses = Array.isArray(input.statuses) ? input.statuses : [];
          const threads = Array.from({ length: 6 }, (_, slot) =>
            threadEntry(slot, String(statuses[slot] ?? 'off'), { selected: slot === Number(input.agent ?? -1) }),
          );
          bridge.lighting.setThreads(threads);
          return { ok: true, message: `Updated ${threads.length} agent slots.` };
        }
        if (action === 'light_config') {
          const side = {
            e: effectCode(input.effect ?? 'solid') ?? EFFECT.solid,
            b: unit(input.brightness ?? 1, 1),
            s: 0.4,
            m: 0,
            c: toPackedColor(input.color ?? '#ffffff'),
          };
          bridge.lighting.setConfig({ ambient: side, keys: { e: EFFECT.off, b: 0, s: 0, m: 0, c: 0 } });
          return { ok: true, message: 'Lighting configuration queued.' };
        }
        if (action === 'rpc') {
          if (!input.method) return { ok: false, message: 'action=rpc needs a method.' };
          const method = String(input.method);
          const blocked = blockedFirmwareMethod(method);
          if (blocked) return { ok: false, message: blocked };
          const res = await bridge.call(method, input.params ?? null, 15_000);
          return {
            ok: res.ok,
            message: res.ok
              ? `${input.method}: ${JSON.stringify(res.result).slice(0, 800)}`
              : `${input.method} failed: ${res.error?.message}`,
            data: res.ok ? { result: res.result } : { error: res.error },
          };
        }
        return { ok: false, message: `Unknown action ${action}.` };
      },
    };

    toolCtx.effect(() => toolCtx.tools.register(tool), 'dsh-micro: dsh_micro tool');
  });
  // ---- HTTP surface for the browser panel --------------------------------
  ctx.inject(['webServer'], (web) => {
    const prefix = '/dsh-micro';

    const json = (res, status, body) => {
      res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      });
      res.end(JSON.stringify(body));
    };

    /**
     * Bounded JSON body reader.
     *
     * A cap alone is not enough: the previous version kept appending chunks
     * after rejecting, so an oversized upload still grew the string for as
     * long as the client kept sending. Stop reading and tear the request down
     * on the first overflow, and settle exactly once.
     */
    const MAX_BODY_BYTES = 1_000_000;
    const readBody = (req) =>
      new Promise((resolve, reject) => {
        let text = '';
        let bytes = 0;
        let settled = false;
        const fail = (error) => {
          if (settled) return;
          settled = true;
          text = '';
          try {
            req.destroy();
          } catch {
            /* already closed */
          }
          reject(error);
        };
        req.on('data', (chunk) => {
          if (settled) return;
          bytes += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk));
          if (bytes > MAX_BODY_BYTES) {
            fail(new Error('body too large'));
            return;
          }
          text += chunk;
        });
        req.on('end', () => {
          if (settled) return;
          settled = true;
          try {
            resolve(text ? JSON.parse(text) : {});
          } catch (error) {
            reject(error);
          }
        });
        req.on('error', fail);
      });

    /**
     * Cross-site guard for the write surface.
     *
     * These routes live on the Harness web server, which the user's browser can
     * reach from any tab: a page they visit can POST here even though it cannot
     * read the reply, because reads are already blocked by the absence of CORS
     * headers. Only writes need a check, and there are three cheap ones:
     *
     *  - `Sec-Fetch-Site` cannot be set by page script, so when the browser
     *    sends it, it decides. Checking it first also keeps a reverse proxy
     *    usable: behind one, `Origin` names the public host while `Host` may
     *    already be the upstream address, and comparing those two would refuse
     *    a panel that is working correctly.
     *  - Without it (older clients, non-browser callers), `Origin` has to name
     *    this host, honouring `X-Forwarded-Host` when a proxy sets it.
     *  - The body must claim JSON. `application/json` is not a CORS-simple
     *    content type, so a cross-site write has to preflight first, and this
     *    server answers no preflight.
     *
     * Refusing all three closes the unauthenticated write path without adding a
     * token the client would have to fetch over the same channel.
     */
    const crossSite = (req) => {
      const headers = req.headers ?? {};
      const site = headers['sec-fetch-site'];
      if (site) {
        if (site !== 'same-origin' && site !== 'none') return `cross-site request (${site})`;
      } else if (headers.origin && headers.origin !== 'null') {
        // `null` says nothing: an opaque origin (file://, sandboxed frame) and a
        // barriered one both send it. Falling through is still safe, because
        // such a caller cannot send `application/json` cross-origin without a
        // preflight this server never answers.
        let host;
        try {
          host = new URL(headers.origin).host;
        } catch {
          return 'malformed Origin';
        }
        if (host !== (headers['x-forwarded-host'] ?? headers.host)) return 'cross-origin request';
      }
      const type = String(headers['content-type'] ?? '').toLowerCase();
      if (!type.startsWith('application/json')) return 'content-type must be application/json';
      return null;
    };

    /** Register a route whose disposer is owned by this plugin's fiber. */
    const route = (path, handler) =>
      ctx.effect(() => {
        const off = web.webServer.register({ kind: 'exact', path, handler });
        return () => off?.();
      }, `dsh-micro: route ${path}`);

    route(`${prefix}/state`,
      (req, res) => {
        if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' });
        return json(res, 200, bridge.snapshot());
      });

    /**
     * Self-check: what the host believes about this plugin, its client bundle,
     * and the browser boot graph. Reached over plain HTTP, so it works even when
     * the settings panel renders nothing.
     */
    route(`${prefix}/diag`, (req, res) => {
      if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' });
      const info = { pluginRoot: PLUGIN_ROOT };
      try {
        const manifest = JSON.parse(readFileSync(path.join(PLUGIN_ROOT, 'package.json'), 'utf8'));
        info.package = {
          name: manifest.name,
          version: manifest.version,
          dsh: manifest.dsh ?? null,
          exports: manifest.exports ?? null,
        };
        const clientRel = manifest?.exports?.['./client']?.default ?? manifest?.exports?.['./client'];
        if (typeof clientRel === 'string') {
          const clientPath = path.join(PLUGIN_ROOT, clientRel);
          info.clientBundle = {
            path: clientPath,
            exists: existsSync(clientPath),
            size: existsSync(clientPath) ? statSync(clientPath).size : null,
            mtime: existsSync(clientPath) ? statSync(clientPath).mtime.toISOString() : null,
            sha1: existsSync(clientPath)
              ? createHash('sha1').update(readFileSync(clientPath)).digest('hex').slice(0, 12)
              : null,
          };
        }
      } catch (error) {
        info.packageError = String(error?.message ?? error);
      }
      try {
        const entries = ctx.loader?.entries?.() ?? [];
        info.loaderEntries = entries
          .map((entry) => ({
            name: entry?.options?.name,
            id: entry?.options?.id,
            disabled: entry?.options?.disabled ?? false,
            phase: entry?.fiber?.state ?? entry?.state ?? null,
          }))
          .filter((entry) => entry.name === 'dsh-micro' || entry.name === 'dsh-plugin-micro' || entry.id === 'dsh-micro');
      } catch (error) {
        info.loaderError = String(error?.message ?? error);
      }
      try {
        const modules = ctx.get?.('clientModules');
        const graph = modules?.graph?.();
        const rows = Array.isArray(graph) ? graph : (graph?.entries ?? []);
        info.bootGraph = rows
          .map((row) => ({ id: row?.id, url: row?.url, rev: row?.rev }))
          .filter((row) => String(row.id ?? '').includes('dsh-micro'));
        info.bootGraphTotal = rows.length;
      } catch (error) {
        info.bootGraphError = String(error?.message ?? error);
      }
      info.router = Boolean(ctx.get?.('webServer'));
      return json(res, 200, info);
    });

    route(`${prefix}/events`,
      (req, res) => {
        if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' });
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-store',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
        });
        res.write(`retry: 2000\ndata: ${JSON.stringify({ type: 'hello', seq: bridge.seq })}\n\n`);
        const alive = setInterval(() => {
          try {
            res.write(': ping\n\n');
          } catch {
            clearInterval(alive);
          }
        }, 15_000);
        alive.unref?.();
        const sub = bridge.addSubscriber(res, alive);
        req.on('close', () => {
          bridge.dropSubscriber(sub);
        });
      });

    route(`${prefix}/action`,
      async (req, res) => {
        if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
        const refusal = crossSite(req);
        if (refusal) return json(res, 403, { error: refusal });
        let body;
        try {
          body = await readBody(req);
        } catch (error) {
          return json(res, 400, { error: error.message });
        }
        const op = body?.op;
        try {
          if (op === 'bind') {
            const key = String(body.key ?? '');
            const action = String(body.action ?? '');
            if (!(key in DEFAULT_BINDINGS)) return json(res, 400, { error: `unknown binding key ${key}` });
            if (!action) return json(res, 400, { error: 'action is required' });
            bridge.bindings = { ...bridge.bindings, [key]: action };
            bridge.persist();
            return json(res, 200, { ok: true, bindings: bridge.bindings, overrides: bridge.overrides });
          }
          if (op === 'bind-all') {
            // The six derived agent-key bindings are written once, not six times:
            // a half-applied patch would leave the keys pointing at mixed layouts.
            const patch = body.bindings;
            if (!patch || typeof patch !== 'object') return json(res, 400, { error: 'bindings is required' });
            const next = { ...bridge.bindings };
            for (const [key, value] of Object.entries(patch)) {
              if (key in DEFAULT_BINDINGS && typeof value === 'string' && value) next[key] = value;
            }
            bridge.bindings = next;
            bridge.persist();
            return json(res, 200, { ok: true, bindings: bridge.bindings, overrides: bridge.overrides });
          }
          if (op === 'override') {
            const keycap = String(body.keycap ?? '');
            if (!keycap) return json(res, 400, { error: 'keycap is required' });
            // An empty action restores the keycap's predefined action (reference: "Use keycap default").
            const action = body.action == null ? '' : String(body.action);
            const next = { ...bridge.overrides };
            if (action === '') delete next[keycap];
            else next[keycap] = action;
            bridge.overrides = next;
            bridge.persist();
            return json(res, 200, { ok: true, bindings: bridge.bindings, overrides: bridge.overrides });
          }
          if (op === 'overrides') {
            // Batch form used by the keycap editor: { overrides: { [keycap]: action } }, '' deletes.
            const patch = body.overrides;
            if (!patch || typeof patch !== 'object') return json(res, 400, { error: 'overrides is required' });
            const next = { ...bridge.overrides };
            for (const [keycap, value] of Object.entries(patch)) {
              const action = value == null ? '' : String(value);
              if (action === '') delete next[keycap];
              else next[keycap] = action;
            }
            bridge.overrides = next;
            bridge.persist();
            return json(res, 200, { ok: true, bindings: bridge.bindings, overrides: bridge.overrides });
          }
          if (op === 'agent-slot') {
            const slot = Number(body.slot);
            if (!Number.isInteger(slot) || slot < 0 || slot > 5) {
              return json(res, 400, { error: 'slot must be 0..5' });
            }
            const sessionId = body.sessionId == null ? null : String(body.sessionId);
            const next = [...bridge.agentSlots];
            next[slot] = sessionId && sessionId.length > 0 ? sessionId : null;
            bridge.agentSlots = next;
            bridge.persist();
            return json(res, 200, { ok: true, agentSlots: bridge.agentSlots });
          }
          if (op === 'agent-slots') {
            if (!Array.isArray(body.slots)) return json(res, 400, { error: 'slots must be an array' });
            bridge.agentSlots = normalizeAgentSlots(body.slots);
            bridge.persist();
            return json(res, 200, { ok: true, agentSlots: bridge.agentSlots });
          }
          if (op === 'custom-slot' || op === 'custom-slots') {
            // 自定义分配写的是用户自己的那份映射；只有当前模式是 custom 时
            // 才同时成为硬件显示的六个槽位。
            if (op === 'custom-slot') {
              const slot = Number(body.slot);
              if (!Number.isInteger(slot) || slot < 0 || slot > 5) {
                return json(res, 400, { error: 'slot must be 0..5' });
              }
              const sessionId = body.sessionId == null ? null : String(body.sessionId);
              const next = [...bridge.customSlots];
              next[slot] = sessionId && sessionId.length > 0 ? sessionId : null;
              bridge.customSlots = next;
            } else {
              if (!Array.isArray(body.slots)) return json(res, 400, { error: 'slots must be an array' });
              bridge.customSlots = normalizeAgentSlots(body.slots);
            }
            if (bridge.settings.agentSource === 'custom') bridge.agentSlots = [...bridge.customSlots];
            bridge.persist();
            bridge.sessionLighting?.tick?.();
            return json(res, 200, { ok: true, customSlots: bridge.customSlots, agentSlots: bridge.agentSlots });
          }
          if (op === 'reset-bindings') {
            // Reference "Reset layout" restores the keycaps only; the six agent
            // keys keep whatever the user assigned to them.
            const kept = {};
            for (const key of Object.keys(DEFAULT_BINDINGS)) {
              if (key.startsWith('AG') && bridge.bindings[key]) kept[key] = bridge.bindings[key];
            }
            bridge.bindings = { ...DEFAULT_BINDINGS, ...kept };
            bridge.overrides = {};
            bridge.persist();
            return json(res, 200, { ok: true, bindings: bridge.bindings, overrides: bridge.overrides });
          }
          if (op === 'reset-all') {
            bridge.bindings = { ...DEFAULT_BINDINGS };
            bridge.overrides = {};
            bridge.agentSlots = normalizeAgentSlots();
            bridge.persist();
            return json(res, 200, { ok: true, bindings: bridge.bindings, overrides: bridge.overrides, agentSlots: bridge.agentSlots });
          }
          if (op === 'connect') {
            bridge.settings = bridge.updateSettings({ autoConnect: true });
            bridge.send({ t: 'watch', enabled: true });
            bridge.send({ t: 'connect' });
            return json(res, 200, { ok: true, settings: bridge.snapshot().settings });
          }
          if (op === 'retry') {
            // Clear the crash-loop breaker and start a fresh bridge.
            bridge.start({ force: true });
            return json(res, 200, { ok: true, driver: bridge.driver, suspended: bridge.suspended });
          }
          if (op === 'disconnect') {
            bridge.send({ t: 'disconnect' });
            return json(res, 200, { ok: true });
          }
          if (op === 'remove') {
            // "Remove" must survive a restart: persist autoConnect=false and stop
            // the watcher, otherwise the bridge re-opens the device 2 s later.
            bridge.settings = bridge.updateSettings({ autoConnect: false });
            bridge.send({ t: 'watch', enabled: false });
            bridge.send({ t: 'disconnect' });
            return json(res, 200, { ok: true, settings: bridge.snapshot().settings });
          }
          if (op === 'refresh') {
            await bridge.refreshStatus().catch(() => undefined);
            return json(res, 200, bridge.snapshot());
          }
          if (op === 'client-ready') {
            bridge.client = {
              at: Date.now(),
              url: body.url ?? null,
              version: body.version ?? null,
              beacon: body.beacon ?? null,
              slots: body.slots ?? null,
              /** What the panel believes the active locale is (diagnostics). */
              locale: body.locale && typeof body.locale === 'object' ? body.locale : null,
              /** Whether the panel can see the voice bundle's `remote.speech`. */
              speech: typeof body.speech === 'boolean' ? body.speech : null,
              /** Multi-window lease: false means this window ignores hardware input. */
              owner: typeof body.owner === 'boolean' ? body.owner : null,
              /** Key notifications this panel saw (proves SSE delivery). */
              hidSeen: typeof body.hidSeen === 'number' ? body.hidSeen : null,
            };
            return json(res, 200, { ok: true });
          }
          if (op === 'settings') {
            const patch = {};
            for (const key of ['brightness', 'autoOff', 'autoOffMs', 'encoderMode', 'agentSource', 'splitMic', 'singleTapAgentKeys']) {
              if (body[key] !== undefined) patch[key] = body[key];
            }
            const previousSource = bridge.settings.agentSource;
            bridge.settings = bridge.updateSettings(patch);
            // 切到「自定义分配」时硬件显示的就是用户自己那份映射：没勾选过
            // 就是空，而不是沿用上一个模式派生出来的聊天。
            if (bridge.settings.agentSource === 'custom' && previousSource !== 'custom') {
              bridge.agentSlots = [...bridge.customSlots];
              bridge.persist();
            }
            bridge.sessionLighting?.tick?.();
            return json(res, 200, {
              ok: true,
              settings: bridge.snapshot().settings,
              agentSlots: bridge.agentSlots,
              customSlots: bridge.customSlots,
            });
          }
          if (op === 'light') {
            const threads = Array.isArray(body.threads) ? body.threads.filter((entry) => entry && typeof entry === 'object') : [];
            if (threads.length === 0) return json(res, 400, { error: 'threads must be a non-empty array' });
            bridge.lighting.setThreads(threads);
            return json(res, 200, { ok: true });
          }
          if (op === 'config') {
            if (!body.config || typeof body.config !== 'object') return json(res, 400, { error: 'config is required' });
            bridge.lighting.setConfig(body.config);
            return json(res, 200, { ok: true });
          }
          if (op === 'light-hints') {
            // UI-only lighting state the Host cannot observe: which session is
            // selected, which ones are unread or waiting for an approval, and
            // the voice state. The Host owns the synthesis (§4.6), so this is
            // hints, not a model.
            if (!body.hints || typeof body.hints !== 'object') return json(res, 400, { error: 'hints is required' });
            sessionLighting.setHints(body.hints);
            return json(res, 200, { ok: true });
          }
          if (op === 'rpc') {
            // Deliberately not implemented. This used to forward any method to
            // the firmware, and nothing in the panel calls it: the only caller
            // was the model tool, which has its own guarded path. Keeping an
            // unauthenticated arbitrary-method relay on an HTTP route buys
            // nothing and hands any same-origin script the device.
            return json(res, 400, { error: 'rpc is not exposed over HTTP; use the dsh_micro tool' });
          }
        } catch (error) {
          return json(res, 500, { error: error?.message ?? String(error) });
        }
        return json(res, 400, { error: `unknown op ${JSON.stringify(op)}` });
      });
  });

  // Everything is wired: now start talking to the device. A spawn failure at
  // this point is already contained (`start` records it), so the plugin still
  // mounts with the panel explaining what is wrong.
  bridge.start();
}

export const internals = {
  threadEntry,
  keyIndex,
  STATUS_COLORS,
  EFFECT,
  SessionLighting,
  buildConfig,
  buildThreads,
  toPackedColor,
  unit,
  effectCode,
};
