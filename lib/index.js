/**
 * Codex Micro host plugin.
 *
 * Owns the USB HID device through a child process (./bridge.cjs), keeps the
 * lighting state machine, exposes an HTTP/SSE surface for the browser panel,
 * and registers a model-facing `codex_micro` tool.
 *
 * Deliberately imports nothing from `@deepseek-ai/*`: the profile's installed
 * copies (0.1.0-rc.6) can differ from the running desktop host (0.2.1-rc.5),
 * and a second copy of cordis/tools would break context identity.
 *
 * Protocol: see ../../../docs/codex-micro-protocol.md
 */
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Compile the author-facing schema *spec* into the raw JSON Schema subset the
 * tool registry enforces.
 *
 * Two different author shapes exist, and mixing them up produces a schema the
 * model provider rejects (`type: null`):
 *   - parameters: a *property map* (`{ field: { type, required } }`) that must be
 *     wrapped into `{ type: "object", properties, required }`;
 *   - output schema: a *value node* that already carries `type`/`properties`.
 *
 * This mirrors `parameterSchemaSpecToJsonSchema` / `valueSchemaSpecToJsonSchema`
 * from `@deepseek-ai/dsh-tools`, so the plugin still works when that package is
 * not resolvable from the profile.
 */
function specToJsonSchema(spec) {
  if (!spec || typeof spec !== 'object') return spec;
  if (spec.type === 'object') {
    const out = { type: 'object' };
    const properties = {};
    const required = [];
    for (const [key, value] of Object.entries(spec.properties ?? {})) {
      properties[key] = specToJsonSchema(value);
      if (value && value.required === true) required.push(key);
    }
    // An object without declared members is an open bag: emit only the
    // annotation keys the official compiler would emit.
    if (Object.keys(properties).length > 0) out.properties = properties;
    if (required.length > 0) out.required = required;
    if (spec.additionalProperties === false) out.additionalProperties = false;
    else if (spec.additionalProperties === true) out.additionalProperties = true;
    if (spec.description) out.description = spec.description;
    return out;
  }
  const { required, ...rest } = spec;
  if (rest.items) rest.items = specToJsonSchema(rest.items);
  return rest;
}

/** Wrap a parameter property map into an object-rooted schema. */
function parametersToJsonSchema(map) {
  const properties = {};
  const required = [];
  for (const [key, value] of Object.entries(map ?? {})) {
    properties[key] = specToJsonSchema(value);
    if (value && value.required === true) required.push(key);
  }
  return required.length > 0 ? { type: 'object', properties, required } : { type: 'object', properties };
}

/** Append a failure to a temp log; a broken plugin must not be silent. */
function reportError(scope, error) {
  const line = `${new Date().toISOString()} [${scope}] ${error?.stack ?? error}\n`;
  try {
    appendFileSync(path.join(os.tmpdir(), 'dsh-codex-micro.log'), line, 'utf8');
  } catch {
    /* ignore */
  }
  try {
    process.stderr.write(`[codex-micro] ${line}`);
  } catch {
    /* ignore */
  }
}

export const name = 'codex-micro';
export const inject = ['tools'];

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(HERE, '..');
const BRIDGE_PATH = path.join(HERE, 'bridge.cjs');
const BINDINGS_PATH = path.join(os.homedir(), '.dsh', 'codex-micro-bindings.json');

/** Default hardware -> harness action table; users override individual keys. */
const DEFAULT_BINDINGS = {
  ACT06: 'effort.up',
  ACT07: 'approval.allow',
  ACT08: 'approval.reject',
  ACT09: 'session.fork',
  ACT10: 'noop',
  ACT11: 'noop',
  ACT12: 'session.new',
  AG00: 'session.open:0',
  AG01: 'session.open:1',
  AG02: 'session.open:2',
  AG03: 'session.open:3',
  AG04: 'session.open:4',
  AG05: 'session.open:5',
  ENC_CW: 'effort.down',
  ENC_CC: 'effort.up',
  ENC: 'plan.toggle',
  STICK_UP: 'plan.toggle',
  STICK_DOWN: 'session.new',
  STICK_LEFT: 'session.prev',
  STICK_RIGHT: 'session.next',
};

function loadStore() {
  try {
    const raw = JSON.parse(readFileSync(BINDINGS_PATH, 'utf8'));
    if (raw && typeof raw === 'object' && (raw.bindings || raw.overrides)) {
      return {
        bindings: { ...DEFAULT_BINDINGS, ...(raw.bindings ?? {}) },
        overrides: { ...(raw.overrides ?? {}) },
        agentSlots: normalizeAgentSlots(raw.agentSlots),
      };
    }
    if (raw && typeof raw === 'object') {
      return { bindings: { ...DEFAULT_BINDINGS, ...raw }, overrides: {}, agentSlots: normalizeAgentSlots() };
    }
  } catch {
    /* first run */
  }
  return { bindings: { ...DEFAULT_BINDINGS }, overrides: {}, agentSlots: normalizeAgentSlots() };
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

function saveStore(store) {
  try {
    writeFileSync(BINDINGS_PATH, JSON.stringify(store, null, 2), 'utf8');
    return true;
  } catch (error) {
    reportError('save bindings', error);
    return false;
  }
}

const NODE_CANDIDATES = [
  process.env.DSH_CODEX_MICRO_NODE,
  'C:\\Program Files\\nodejs\\node.exe',
  'C:\\Program Files (x86)\\nodejs\\node.exe',
];

const DEFAULTS = {
  autoConnect: true,
  nodePath: null,
  brightness: 1,
  // Reference default is "auto-dim after 3 minutes".
  autoOffMs: 180000,
};

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
  const explicit = [config.nodePath, ...NODE_CANDIDATES].filter(Boolean);
  for (const candidate of explicit) {
    if (candidate === 'node') return candidate;
    if (existsSync(candidate)) return candidate;
  }
  return 'node';
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
 * Status -> `v.oai.thstatus` entry. Mirrors the reference implementation:
 * working is a snake sweep, selected/attention pulses, everything else is solid.
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
    e: status === 'working' ? EFFECT.snake : pulsing ? EFFECT.breath : EFFECT.solid,
    s: status === 'working' ? 0.4 : pulsing ? 0.3 : 0,
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
    this.busy = false;
    this.pauseUntil = 0;
    this.idleTimer = null;
    this.autoOffMs = 0;
    this.brightness = 1;
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

  allOff() {
    const threads = Array.from({ length: 6 }, (_, slot) => threadEntry(slot, 'off'));
    this.pendingThreads = threads;
    this.schedule(true);
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
          if (outcome.ok) this.lastConfigKey = key;
          else this.log(`rgbcfg failed: ${outcome.error?.message ?? 'unknown'}`);
        }
      }
      const threads = this.pendingThreads;
      if (threads) {
        this.pendingThreads = null;
        const key = JSON.stringify(threads);
        if (key !== this.lastThreadsKey) {
          const outcome = await this.withRetry('v.oai.thstatus', threads);
          if (outcome.ok) this.lastThreadsKey = key;
          else this.log(`thstatus failed: ${outcome.error?.message ?? 'unknown'}`);
        }
      }
    } finally {
      this.busy = false;
      if (this.pendingThreads || this.pendingConfig) this.schedule();
    }
  }

  async withRetry(method, params) {
    const delays = [1000, 2000, 5000, 10000];
    let outcome = await this.callRpc(method, params);
    for (const delay of delays) {
      if (outcome.ok) return outcome;
      const code = outcome.error?.code;
      if (code === 'DEVICE_DISCONNECTED' || code === 'BRIDGE_UNAVAILABLE') return outcome;
      await new Promise((resolve) => setTimeout(resolve, delay).unref?.());
      outcome = await this.callRpc(method, params);
    }
    return outcome;
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
    this.lastStatus = null;
    this.events = [];
    this.seq = 0;
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
    this.lighting = new Lighting((method, params) => this.call(method, params, 8000), (line) => this.pushLog(line));
  }

  start() {
    if (this.child) return;
    const node = resolveNode(this.config);
    let child;
    try {
      child = spawn(node, [BRIDGE_PATH], {
        cwd: PLUGIN_ROOT,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        env: { ...process.env, NODE_OPTIONS: '' },
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
      if (!this.disposed) {
        this.restartTimer = setTimeout(() => this.start(), 3000);
        this.restartTimer.unref?.();
      }
    });
    child.on('error', (error) => this.record({ type: 'error', message: `bridge error: ${error.message}` }));
  }

  stop() {
    this.disposed = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
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
        this.send({ t: 'list' });
        if (this.config.autoConnect !== false) this.send({ t: 'watch', enabled: true });
        break;
      case 'devices':
        this.devices = msg.devices ?? [];
        this.record({ type: 'devices', devices: this.devices });
        break;
      case 'state':
        this.connected = Boolean(msg.connected);
        this.device = msg.device ?? null;
        this.record({ type: 'state', connected: this.connected, device: this.device });
        if (this.connected) void this.refreshStatus();
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
      case 'notify':
        this.lighting.touch();
        this.record({ type: 'notify', method: msg.method, params: msg.params });
        break;
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
    const id = this.nextId;
    this.nextId = this.nextId >= 998 ? 1 : this.nextId + 1;
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

  record(event) {
    this.seq += 1;
    const payload = { seq: this.seq, at: Date.now(), ...event };
    this.events.push(payload);
    if (this.events.length > 300) this.events.shift();
    for (const res of this.subscribers) {
      try {
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
      } catch {
        this.subscribers.delete(res);
      }
    }
  }

  persist() {
    this.store = { bindings: this.bindings, overrides: this.overrides, agentSlots: this.agentSlots };
    saveStore(this.store);
  }

  snapshot() {
    return {
      ready: this.ready,
      connected: this.connected,
      device: this.device,
      devices: this.devices,
      lastStatus: this.lastStatus,
      seq: this.seq,
      client: this.client,
      bindings: this.bindings,
      overrides: this.overrides,
      agentSlots: this.agentSlots,
      settings: {
        brightness: this.lighting.brightness,
        autoOffMs: this.lighting.autoOffMs,
      },
      log: this.log.slice(-40),
    };
  }
}

export function apply(ctx, config = {}) {
  const settings = { ...DEFAULTS, ...config };
  const bridge = new MicroBridge(ctx, settings);
  bridge.lighting.configure(settings);
  bridge.start();

  ctx.effect(() => () => bridge.stop(), 'codex-micro: bridge process');

  // ---- model-facing tool -------------------------------------------------
  // The registry consumes compiled JSON Schema and an args validator, so the
  // definition goes through the host's own `defineTool` (spec -> schema).
  void (async () => {
    let defineTool;
    try {
      ({ defineTool } = await import('@deepseek-ai/dsh-tools'));
    } catch (error) {
      // Expected when the profile does not carry the package; the local spec
      // compiler produces an equivalent registry-ready definition.
      reportError('import @deepseek-ai/dsh-tools (falling back to local schema compiler)', error);
    }
    try {
      const toolSpec = {
    name: 'codex_micro',
    description:
      'Inspect and control a Work Louder "Codex Micro" HID macro-pad connected over USB. ' +
      'Actions: status/devices/connect/disconnect, light_agent (light one of the six agent keys by slot 0-5), ' +
      'light_all (statuses for all six slots), light_config (ambient ring + key backlight), rpc (escape hatch for ' +
      'firmware methods such as sys.version, device.status, ui.home_accent_color, fs.list, appmgr.list_installed).',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['status', 'devices', 'connect', 'disconnect', 'light_agent', 'light_all', 'light_config', 'rpc'],
        description: 'Which operation to perform.',
      },
      agent: { type: 'integer', description: 'Agent slot 0..5 for light_agent.' },
      status: {
        type: 'string',
        enum: ['off', 'idle', 'working', 'unread', 'awaiting-approval', 'awaiting-response', 'error'],
        description: 'Semantic status to render as colour for light_agent / light_all.',
      },
      statuses: {
        type: 'array',
        description: 'Six statuses, one per agent slot, for light_all.',
        items: { type: 'string' },
      },
      selected: { type: 'boolean', description: 'Pulse the slot (breath) instead of steady.' },
      brightness: { type: 'number', description: '0..1 (or 0..100).' },
      color: { type: 'string', description: 'Colour for light_config, e.g. #ff5500.' },
      effect: { type: 'string', description: 'off|solid|snake|rainbow|breath|gradient|shallowBreath.' },
      method: { type: 'string', description: 'Firmware JSON-RPC method for action=rpc.' },
      params: { type: 'object', description: 'JSON params for action=rpc.', additionalProperties: true },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          message: { type: 'string', required: true },
          data: { type: 'object', additionalProperties: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.message }],
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const action = String(args.action ?? 'status');
      if (action === 'status') {
        if (bridge.connected) await bridge.refreshStatus().catch(() => undefined);
        const snap = bridge.snapshot();
        const battery = snap.lastStatus?.battery ?? snap.lastStatus?.battery_percentage;
        const parts = [
          snap.connected ? `connected: ${snap.device?.type ?? 'device'}` : 'not connected',
          snap.lastStatus ? `firmware ${snap.lastStatus.version ?? '?'}` : null,
          typeof battery === 'number' ? `battery ${battery}%` : null,
          snap.lastStatus?.is_charging ? 'charging' : null,
        ].filter(Boolean);
        return { ok: true, message: `Codex Micro: ${parts.join(', ')}.`, data: snap };
      }
      if (action === 'devices') {
        bridge.send({ t: 'list' });
        return { ok: true, message: `${bridge.devices.length} Work Louder device(s) visible.`, data: { devices: bridge.devices } };
      }
      if (action === 'connect') {
        bridge.send({ t: 'connect' });
        return { ok: true, message: 'Connecting to the Codex Micro…' };
      }
      if (action === 'disconnect') {
        bridge.send({ t: 'disconnect' });
        return { ok: true, message: 'Disconnected from the Codex Micro.' };
      }
      if (action === 'light_agent') {
        const slot = Number(args.agent ?? 0);
        if (!Number.isInteger(slot) || slot < 0 || slot > 5) {
          return { ok: false, message: 'agent must be 0..5.' };
        }
        bridge.lighting.setThreads([threadEntry(slot, String(args.status ?? 'idle'), { selected: args.selected === true })]);
        return { ok: true, message: `Slot ${slot} set to ${args.status ?? 'idle'}.` };
      }
      if (action === 'light_all') {
        const statuses = Array.isArray(args.statuses) ? args.statuses : [];
        const threads = Array.from({ length: 6 }, (_, slot) =>
          threadEntry(slot, String(statuses[slot] ?? 'off'), { selected: slot === Number(args.agent ?? -1) }),
        );
        bridge.lighting.setThreads(threads);
        return { ok: true, message: `Updated ${threads.length} agent slots.` };
      }
      if (action === 'light_config') {
        const side = {
          e: effectCode(args.effect ?? 'solid') ?? EFFECT.solid,
          b: unit(args.brightness ?? 1, 1),
          s: 0.4,
          m: 0,
          c: toPackedColor(args.color ?? '#ffffff'),
        };
        bridge.lighting.setConfig({ ambient: side, keys: { e: EFFECT.off, b: 0, s: 0, m: 0, c: 0 } });
        return { ok: true, message: 'Lighting configuration queued.' };
      }
      if (action === 'rpc') {
        if (!args.method) return { ok: false, message: 'action=rpc needs a method.' };
        const res = await bridge.call(String(args.method), args.params ?? null, 15_000);
        return {
          ok: res.ok,
          message: res.ok ? `${args.method}: ${JSON.stringify(res.result).slice(0, 800)}` : `${args.method} failed: ${res.error?.message}`,
          data: res.ok ? { result: res.result } : { error: res.error },
        };
      }
        return { ok: false, message: `Unknown action ${action}.` };
      },
      };
      ctx.tools.register(defineTool ? defineTool(toolSpec) : {
        ...toolSpec,
        parameters: parametersToJsonSchema(toolSpec.parameters),
        output: { ...toolSpec.output, schema: specToJsonSchema(toolSpec.output.schema) },
      });
    } catch (error) {
      reportError('register codex_micro tool', error);
    }
  })();

  // ---- HTTP surface for the browser panel --------------------------------
  ctx.inject(['webServer'], (web) => {
    const prefix = '/codex-micro';

    const json = (res, status, body) => {
      res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      });
      res.end(JSON.stringify(body));
    };

    const readBody = (req) =>
      new Promise((resolve, reject) => {
        let text = '';
        req.on('data', (chunk) => {
          text += chunk;
          if (text.length > 1_000_000) reject(new Error('body too large'));
        });
        req.on('end', () => {
          try {
            resolve(text ? JSON.parse(text) : {});
          } catch (error) {
            reject(error);
          }
        });
        req.on('error', reject);
      });

    /** Register a route whose disposer is owned by this plugin's fiber. */
    const route = (path, handler) =>
      ctx.effect(() => {
        const off = web.webServer.register({ kind: 'exact', path, handler });
        return () => off?.();
      }, `codex-micro: route ${path}`);

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
          .filter((entry) => entry.name === 'dsh-plugin-codex-micro' || entry.id === 'codex-micro');
      } catch (error) {
        info.loaderError = String(error?.message ?? error);
      }
      try {
        const modules = ctx.get?.('clientModules');
        const graph = modules?.graph?.();
        const rows = Array.isArray(graph) ? graph : (graph?.entries ?? []);
        info.bootGraph = rows
          .map((row) => ({ id: row?.id, url: row?.url, rev: row?.rev }))
          .filter((row) => String(row.id ?? '').includes('codex-micro'));
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
        bridge.subscribers.add(res);
        const alive = setInterval(() => {
          try {
            res.write(': ping\n\n');
          } catch {
            clearInterval(alive);
            bridge.subscribers.delete(res);
          }
        }, 15_000);
        alive.unref?.();
        req.on('close', () => {
          clearInterval(alive);
          bridge.subscribers.delete(res);
        });
      });

    route(`${prefix}/action`,
      async (req, res) => {
        if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
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
            return json(res, 200, { ok: true, bindings: bridge.bindings, overrides: bridge.overrides, agentSlots: bridge.agentSlots });
          }
          if (op === 'reset-bindings') {
            bridge.bindings = { ...DEFAULT_BINDINGS };
            bridge.overrides = {};
            bridge.persist();
            return json(res, 200, { ok: true, bindings: bridge.bindings, overrides: bridge.overrides });
          }
          if (op === 'connect') {
            bridge.send({ t: 'connect' });
            return json(res, 200, { ok: true });
          }
          if (op === 'disconnect' || op === 'remove') {
            if (op === 'remove') bridge.config.autoConnect = false;
            bridge.send({ t: 'disconnect' });
            return json(res, 200, { ok: true });
          }
          if (op === 'bind') {
            const key = String(body.key ?? '');
            const action = String(body.action ?? '');
            if (!(key in DEFAULT_BINDINGS)) return json(res, 400, { error: `unknown binding key ${key}` });
            if (!action) return json(res, 400, { error: 'action is required' });
            bridge.bindings = { ...bridge.bindings, [key]: action };
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
            return json(res, 200, { ok: true, bindings: bridge.bindings, overrides: bridge.overrides, agentSlots: bridge.agentSlots });
          }
          if (op === 'reset-bindings') {
            bridge.bindings = { ...DEFAULT_BINDINGS };
            bridge.overrides = {};
            bridge.persist();
            return json(res, 200, { ok: true, bindings: bridge.bindings, overrides: bridge.overrides });
          }
          if (op === 'connect') {
            bridge.config.autoConnect = true;
            bridge.send({ t: 'connect' });
            return json(res, 200, { ok: true });
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
            };
            return json(res, 200, { ok: true });
          }
          if (op === 'settings') {
            bridge.lighting.configure({ brightness: body.brightness, autoOffMs: body.autoOffMs });
            return json(res, 200, { ok: true, settings: bridge.snapshot().settings });
          }
          if (op === 'light') {
            const threads = Array.isArray(body.threads) ? body.threads : [];
            bridge.lighting.setThreads(threads);
            return json(res, 200, { ok: true });
          }
          if (op === 'config') {
            bridge.lighting.setConfig(body.config ?? null);
            return json(res, 200, { ok: true });
          }
          if (op === 'rpc') {
            const result = await bridge.call(String(body.method), body.params ?? null, 15_000);
            return json(res, 200, result);
          }
        } catch (error) {
          return json(res, 500, { error: error?.message ?? String(error) });
        }
        return json(res, 400, { error: `unknown op ${JSON.stringify(op)}` });
      });
  });
}

export const internals = { threadEntry, keyIndex, STATUS_COLORS, EFFECT, toPackedColor, unit, effectCode, specToJsonSchema, parametersToJsonSchema };
