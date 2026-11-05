#!/usr/bin/env node
/**
 * DSH Micro HID bridge.
 *
 * Runs as a separate OS process (see ../lib/index.js for why) and speaks
 * newline-delimited JSON on stdio. It owns the USB HID connection and the
 * JSON-RPC framing; the host plugin only sends intents and receives events.
 *
 *   stdin  : {"t":"list"} {"t":"connect","path":?} {"t":"disconnect"}
 *            {"t":"rpc","method":"...","params":{},"timeoutMs":?}
 *            {"t":"watch","enabled":true} {"t":"shutdown"}
 *   stdout : {"t":"devices","devices":[...]}
 *            {"t":"state","connected":bool,"device":{...}?,"error":{...}?}
 *            {"t":"response","id":n,"ok":bool,"result":?,"error":{...}?}
 *            {"t":"notify","method":"v.oai.hid","params":{...}}
 *            {"t":"log","channel":"debug","line":"..."}
 *            {"t":"error","message":"..."} {"t":"fatal","message":"..."}
 *
 * Wire format (reverse engineered from the Work Louder SDK bundled in the
 * Codex desktop app):
 *   64-byte HID report: [0]=6 report id, [1]=channel (1=debug, 2=rpc),
 *   [2]=payload length (<= 61), [3..]=UTF-8 JSON text, split into frames.
 *   Inbound payloads are accumulated per channel and split on \r?\n.
 *   The firmware speaks a private JSON-RPC dialect: `{id, method, params}`
 *   with no `jsonrpc` member, ids in 0..998, one request in flight.
 */
'use strict';

const hidRuntime = require('./hid.cjs');

const WL_VID = 0x303a;
const RPC_USAGE_PAGE = 0xff00;
const REPORT_ID = 6;
const CHANNEL_DEBUG = 1;
const CHANNEL_RPC = 2;
const MAX_CHUNK = 61;
const DEFAULT_TIMEOUT_MS = 10_000;
/** The firmware drops requests that arrive back-to-back. */
const QUEUE_COOLDOWN_MS = 50;
/** A stranded partial payload is garbage, not a slow packet. */
const MAX_BUFFER_CHARS = 64 * 1024;

const {
  transportOf,
  deviceTypeOf,
  focusAppPayload,
  focusAppDisabled,
  minimizeSide,
  minimizeThread,
} = require('./lighting-wire.cjs');

/** Period between host.focused_app announces while a device is connected. */
const FOCUS_APP_INTERVAL_MS = 5000;
/** Reconnect backoff, matching the reference service (no attempt cap). */
const BACKOFF_MS = [1000, 2000, 5000, 10000];

function emit(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function escapeUnicode(str) {
  return str.replace(/[^\x00-\x7F]/gu, (ch) => {
    const cp = ch.codePointAt(0);
    if (cp > 0xffff) {
      const high = ((cp - 0x10000) >> 10) | 0xd800;
      const low = ((cp - 0x10000) & 0x3ff) | 0xdc00;
      return `\\u${high.toString(16).padStart(4, '0')}\\u${low.toString(16).padStart(4, '0')}`;
    }
    return `\\u${cp.toString(16).padStart(4, '0')}`;
  });
}

function encodeFrames(json) {
  const payload = Buffer.from(escapeUnicode(json), 'utf8');
  const frames = [];
  for (let offset = 0; offset < payload.length; offset += MAX_CHUNK) {
    const chunk = payload.subarray(offset, offset + Math.min(MAX_CHUNK, payload.length - offset));
    const frame = Buffer.alloc(64);
    frame[0] = REPORT_ID;
    frame[1] = CHANNEL_RPC;
    frame[2] = chunk.length;
    chunk.copy(frame, 3);
    frames.push(frame);
  }
  return frames;
}

function decodeReport(buf) {
  if (!buf || buf.length < 3) return { channel: CHANNEL_RPC, text: '' };
  const channel = buf[1];
  const length = buf[2];
  const text = buf.subarray(3, 3 + length).toString('utf8');
  return { channel, text };
}

function scanDevices() {
  const HID = hidRuntime.driver().hid;
  if (!HID) return [];
  let all = [];
  try {
    all = HID.devices();
  } catch (error) {
    emit({ t: 'error', message: `hid enumerate failed: ${error.message}` });
    return [];
  }
  return all
    .filter((d) => d.vendorId === WL_VID)
    .map((d) => {
      const type = deviceTypeOf(d);
      return {
        path: d.path,
        productId: d.productId,
        type,
        usagePage: d.usagePage,
        manufacturer: d.manufacturer ?? null,
        product: d.product ?? null,
        interface: d.interface,
        serialNumber: d.serialNumber ?? null,
        transport: transportOf(d),
        rpc: d.usagePage === RPC_USAGE_PAGE && type !== 'unknown',
      };
    })
    .filter((d) => d.path);
}

/**
 * Pick the RPC interface out of the several HID interfaces the device exposes.
 * The reference implementation only ever talks to usagePage 0xFF00, prefers a
 * device that calls itself "Work Louder", and otherwise takes the first match.
 */
function rankCandidates(devices) {
  return devices
    .filter((d) => d.rpc)
    .sort((a, b) => {
      const brand = (d) => (/work\s*louder/i.test(String(d.manufacturer ?? d.product ?? '')) ? 0 : 1);
      const usb = (d) => (d.transport === 'usb' ? 0 : 1);
      return brand(a) - brand(b) || usb(a) - usb(b);
    });
}

class Bridge {
  constructor() {
    this.device = null;
    this.deviceInfo = null;
    this.buffers = { [CHANNEL_DEBUG]: '', [CHANNEL_RPC]: '' };
    this.pending = new Map();
    this.nextId = 1;
    this.queue = Promise.resolve();
    this.lastWriteAt = 0;
    /** Diagnostics: reports received on the RPC channel, and the last payload. */
    this.inboundCount = 0;
    this.lastInbound = null;
    this.inboundEmitAt = 0;
    /** Diagnostics: the device's plain keyboard interface (see startKeyboardMonitor). */
    this.keyboard = null;
    this.keyReports = 0;
    this.lastKeyReport = null;
    this.keyEmitAt = 0;
    this.watchTimer = null;
    this.retryTimer = null;
    this.retryStep = 0;
    this.lastScanKey = '';
    this.closing = false;
    /** Set by an explicit `disconnect` so the watcher stops resurrecting the link. */
    this.holdDisconnected = false;
    /** Periodic `host.focused_app` announce while a device is connected. */
    this.focusTimer = null;
    this.focusInFlight = false;
    /**
     * Responses for request ids we never sent. The device is shared with other
     * hosts (the vendor's `input.exe` polls `host.focused_app`/`device.status` on
     * the same channel), and their replies land on the report stream we read.
     * Count them and log a summary instead of one line per reply, which used to
     * fill the whole diagnostic ring.
     */
    this.orphanCount = 0;
    this.orphanLoggedAt = 0;
  }

  async connect(path) {
    if (this.device) return { connected: true, device: this.deviceInfo };
    const HID = hidRuntime.driver().hid;
    if (!HID) {
      emit({ t: 'state', connected: false, error: { code: 'DRIVER_MISSING', message: 'HID driver unavailable' } });
      return { connected: false };
    }
    this.holdDisconnected = false;
    const devices = scanDevices();
    const candidates = path ? devices.filter((d) => d.path === path) : rankCandidates(devices);
    if (candidates.length === 0) {
      emit({ t: 'state', connected: false, error: { code: 'NOT_FOUND', message: 'no DSH Micro interface found' } });
      return { connected: false };
    }
    let lastError = null;
    for (const target of candidates) {
      if (!target.rpc) {
        lastError = { code: 'WRONG_INTERFACE', message: `${target.path} is not the RPC interface (usagePage != 0xFF00)` };
        continue;
      }
      try {
        // macOS needs non-exclusive access or the open fails while another
        // process (Input Monitoring) holds the interface.
        this.device = process.platform === 'darwin'
          ? await HID.HIDAsync.open(target.path, { nonExclusive: true }).catch(() => HID.HIDAsync.open(target.path))
          : await HID.HIDAsync.open(target.path);
      } catch (error) {
        lastError = { code: 'OPEN_FAILED', message: `open failed: ${error.message}` };
        this.device = null;
        continue;
      }
      this.deviceInfo = target;
      this.buffers = { [CHANNEL_DEBUG]: '', [CHANNEL_RPC]: '' };
      this.retryStep = 0;
      if (this.retryTimer) clearTimeout(this.retryTimer);
      this.retryTimer = null;
      this.device.on('data', (buf) => this.onData(buf));
      this.device.on('error', (error) => {
        emit({ t: 'error', message: `hid error: ${error.message}` });
        this.teardown({ code: 'HID_ERROR', message: error.message });
      });
      // Some platforms only report a unplug through `close`; without this the
      // host keeps writing into a dead file descriptor.
      this.device.on('close', () => this.teardown({ code: 'DEVICE_CLOSED', message: 'device closed the interface' }));
      emit({ t: 'state', connected: true, device: this.deviceInfo });
      this.startFocusApp();
      void this.startKeyboardMonitor();
      return { connected: true, device: this.deviceInfo };
    }
    emit({ t: 'state', connected: false, error: lastError });
    return { connected: false, error: lastError };
  }

  teardown(error = null) {
    const was = this.device !== null;
    this.stopFocusApp();
    this.stopKeyboardMonitor();
    this.device = null;
    this.deviceInfo = null;
    this.buffers = { [CHANNEL_DEBUG]: '', [CHANNEL_RPC]: '' };
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.resolve({ ok: false, error: { code: 'DEVICE_DISCONNECTED', message: 'device disconnected' } });
    }
    this.pending.clear();
    if (was) emit({ t: 'state', connected: false, error });
  }

  async disconnect() {
    this.holdDisconnected = true;
    const device = this.device;
    this.teardown();
    if (device) {
      try {
        await device.close();
      } catch {
        /* already gone */
      }
    }
    return { connected: false };
  }

  /**
   * Announce the focused desktop application to the device, now and every few
   * seconds. Fire and forget: the reply is empty, and a slow reply must never
   * hold up the request queue (the firmware answers this with `{}`).
   */
  startFocusApp() {
    if (focusAppDisabled()) return;
    this.stopFocusApp();
    const announce = () => {
      // One at a time: the firmware serializes requests, so a stalled focus
      // announce must not queue up behind itself and delay the lighting writes.
      if (this.focusInFlight) return;
      this.focusInFlight = true;
      void this.rpc('host.focused_app', focusAppPayload(), 1000)
        .catch(() => undefined)
        .finally(() => {
          this.focusInFlight = false;
        });
    };
    announce();
    this.focusTimer = setInterval(announce, FOCUS_APP_INTERVAL_MS);
    this.focusTimer.unref?.();
  }

  stopFocusApp() {
    if (this.focusTimer) clearInterval(this.focusTimer);
    this.focusTimer = null;
  }

  onData(buf) {
    let packet;
    try {
      packet = decodeReport(buf);
    } catch {
      return;
    }
    const channel = packet.channel === CHANNEL_DEBUG ? CHANNEL_DEBUG : CHANNEL_RPC;
    const merged = (this.buffers[channel] ?? '') + packet.text;
    if (merged.length > MAX_BUFFER_CHARS) {
      emit({ t: 'log', channel: 'rpc', line: `dropping oversized ${merged.length}-char partial payload` });
      this.buffers[channel] = '';
      return;
    }
    const parts = merged.split(/\r?\n/);
    this.buffers[channel] = parts.pop() ?? '';
    // 诊断：设备到底有没有在发东西（不管解析成响应还是通知）。
    this.inboundCount = (this.inboundCount ?? 0) + 1;
    this.lastInbound = String(packet.text ?? '').slice(0, 120);
    const nowInbound = Date.now();
    if (nowInbound - (this.inboundEmitAt ?? 0) > 500) {
      this.inboundEmitAt = nowInbound;
      emit({ t: 'inbound', count: this.inboundCount, last: this.lastInbound, at: nowInbound });
    }
    for (const raw of parts) {
      const line = raw.trim();
      if (!line) continue;
      if (channel === CHANNEL_DEBUG) {
        emit({ t: 'log', channel: 'debug', line });
        continue;
      }
      this.onRpcLine(line);
    }
  }

  onRpcLine(line) {
    const start = line.indexOf('{');
    const text = start <= 0 ? line : line.slice(start);
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      // Fragmented JSON without a newline boundary: keep the tail and wait for
      // the next report. It must stay *after* anything already buffered.
      this.buffers[CHANNEL_RPC] = text.slice(-MAX_BUFFER_CHARS);
      return;
    }
    const id = message.id ?? message.i;
    const method = message.method ?? message.m;
    if (id === undefined && method !== undefined) {
      emit({ t: 'notify', method, params: message.params ?? message.p ?? null });
      return;
    }
    const key = String(id);
    const entry = this.pending.get(key);
    // The reply echoes the method, so a same-id reply meant for another host's
    // request cannot resolve ours. Without this check a colliding id could hand
    // a lighting write the wrong result (or swallow it) while the vendor app is
    // running on the same channel.
    if (!entry || (entry.method && method && entry.method !== method)) {
      this.orphanCount += 1;
      const now = Date.now();
      if (now - this.orphanLoggedAt > 10_000) {
        this.orphanLoggedAt = now;
        emit({
          t: 'log',
          channel: 'rpc',
          line: `${this.orphanCount} repl${this.orphanCount === 1 ? 'y' : 'ies'} for ids this process did not send (another host shares the device)`,
        });
        this.orphanCount = 0;
      }
      return;
    }
    clearTimeout(entry.timer);
    this.pending.delete(key);
    if (message.error) {
      entry.resolve({ ok: false, error: message.error });
    } else {
      entry.resolve({ ok: true, result: message.result ?? null });
    }
  }

  rpc(method, params, timeoutMs = DEFAULT_TIMEOUT_MS) {
    const send = async () => {
      if (!this.device) {
        return { ok: false, error: { code: 'DEVICE_DISCONNECTED', message: 'no device connected' } };
      }
      const wait = QUEUE_COOLDOWN_MS - (Date.now() - this.lastWriteAt);
      if (wait > 0) await sleep(wait);
      return new Promise((resolve) => {
        // Firmware only accepts request ids in 0..998.
        const id = this.nextId;
        this.nextId = this.nextId >= 998 ? 1 : this.nextId + 1;
        const request = { id, method, params: params ?? null };
        const timer = setTimeout(() => {
          this.pending.delete(String(id));
          resolve({ ok: false, error: { code: 'TIMEOUT', message: `timeout after ${timeoutMs}ms` } });
        }, timeoutMs);
        this.pending.set(String(id), { resolve, timer, method });
        this.lastWriteAt = Date.now();
        (async () => {
          try {
            for (const frame of encodeFrames(JSON.stringify(request))) {
              await this.device.write(frame);
            }
          } catch (error) {
            clearTimeout(timer);
            this.pending.delete(String(id));
            resolve({ ok: false, error: { code: 'WRITE_FAILED', message: error.message } });
          }
        })();
      });
    };
    // Serialize: firmware handles one request at a time.
    const result = this.queue.then(send, send);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  /**
   * 只读的键盘接口监视器：用来区分"设备根本没发按键"和"设备发的是普通键盘
   * 报文、没有发 v.oai.hid（keymap/场景不在 agent 层）"。
   */
  async startKeyboardMonitor() {
    if (this.keyboard) return;
    const HID = hidRuntime.driver().hid;
    if (!HID) return;
    const candidate = scanDevices().find((d) => d.usagePage === 1 && d.rpc === false);
    if (!candidate) return;
    try {
      this.keyboard = await HID.HIDAsync.open(candidate.path);
    } catch {
      this.keyboard = null;
      return;
    }
    this.keyboard.on('data', (buf) => {
      this.keyReports = (this.keyReports ?? 0) + 1;
      this.lastKeyReport = Buffer.from(buf).toString('hex').slice(0, 64);
      const now = Date.now();
      if (now - (this.keyEmitAt ?? 0) > 1000) {
        this.keyEmitAt = now;
        emit({ t: 'keys', count: this.keyReports, last: this.lastKeyReport, at: now });
      }
    });
    // 先报一次 0：证明监视器确实打开了（null 分不清“没按键”和“打不开”）。
    emit({ t: 'keys', count: 0, last: null, at: Date.now() });
    this.keyboard.on('error', () => {
      this.stopKeyboardMonitor();
    });
  }

  stopKeyboardMonitor() {
    const handle = this.keyboard;
    this.keyboard = null;
    if (handle) {
      try {
        handle.close();
      } catch {
        /* already closed */
      }
    }
  }

  startWatch(intervalMs = 2000) {
    if (this.watchTimer) return;
    this.watchTimer = setInterval(() => {
      const devices = scanDevices();
      const key = devices.map((d) => `${d.path}:${d.productId}`).join('|');
      if (key !== this.lastScanKey) {
        this.lastScanKey = key;
        emit({ t: 'devices', devices });
      }
      if (this.device || this.holdDisconnected) return;
      const [candidate] = rankCandidates(devices);
      if (candidate) void this.connect(candidate.path);
    }, intervalMs);
    this.watchTimer.unref?.();
  }

  stopWatch() {
    if (this.watchTimer) clearInterval(this.watchTimer);
    this.watchTimer = null;
  }
}

const bridge = new Bridge();

function handle(msg) {
  switch (msg.t) {
    case 'list': {
      const devices = scanDevices();
      bridge.lastScanKey = devices.map((d) => `${d.path}:${d.productId}`).join('|');
      emit({ t: 'devices', devices });
      break;
    }
    case 'connect':
      void bridge.connect(msg.path);
      break;
    case 'disconnect':
      void bridge.disconnect();
      break;
    case 'rpc': {
      void bridge.rpc(msg.method, msg.params, msg.timeoutMs).then((outcome) => {
        emit({ t: 'response', id: msg.id ?? null, ...outcome });
      });
      break;
    }
    // Lighting intents, so callers do not have to know the wire shape: the
    // long form is minimized here exactly like the vendor kit does.
    case 'light': {
      const threads = Array.isArray(msg.threads)
        ? msg.threads.filter((thread) => thread && typeof thread === 'object').map(minimizeThread)
        : [];
      void bridge.rpc('v.oai.thstatus', threads, msg.timeoutMs).then((outcome) => {
        emit({ t: 'response', id: msg.id ?? null, ...outcome });
      });
      break;
    }
    case 'config': {
      const config = msg.config && typeof msg.config === 'object'
        ? { ambient: minimizeSide(msg.config.ambient), keys: minimizeSide(msg.config.keys) }
        : null;
      void bridge.rpc('v.oai.rgbcfg', config, msg.timeoutMs).then((outcome) => {
        emit({ t: 'response', id: msg.id ?? null, ...outcome });
      });
      break;
    }
    case 'watch':
      if (msg.enabled === false) {
        bridge.stopWatch();
        bridge.holdDisconnected = true;
      } else {
        bridge.startWatch(msg.intervalMs);
      }
      break;
    case 'shutdown':
      void bridge.disconnect().finally(() => process.exit(0));
      break;
    default:
      emit({ t: 'error', message: `unknown command ${JSON.stringify(msg.t)}` });
  }
}

let stdinBuffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  stdinBuffer += chunk;
  const lines = stdinBuffer.split('\n');
  stdinBuffer = lines.pop() ?? '';
  for (const line of lines) {
    const text = line.trim();
    if (!text) continue;
    try {
      handle(JSON.parse(text));
    } catch (error) {
      emit({ t: 'error', message: `bad command line: ${error.message}` });
    }
  }
});

// The host went away: release the HID interface instead of becoming an orphan
// that keeps it open and makes the next launch fail to connect.
process.stdin.on('end', () => {
  bridge.closing = true;
  void bridge.disconnect().finally(() => process.exit(0));
});

process.on('uncaughtException', (error) => {
  emit({ t: 'fatal', message: error?.stack ?? String(error) });
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  emit({ t: 'fatal', message: String(reason) });
});
process.on('SIGTERM', () => {
  void bridge.disconnect().finally(() => process.exit(0));
});

const runtime = hidRuntime.driver();
emit({
  t: 'ready',
  pid: process.pid,
  driver: { ok: runtime.hid !== null, source: runtime.source, errors: runtime.errors },
});
if (!runtime.hid) {
  // Nothing this process can do. Report once and leave quietly: exiting non-zero
  // would make the host treat a missing driver as a crash and respawn forever.
  emit({
    t: 'unavailable',
    code: 'DRIVER_MISSING',
    message: 'HID driver could not be loaded',
    detail: runtime.errors,
  });
  process.exit(0);
}
emit({ t: 'devices', devices: scanDevices() });
