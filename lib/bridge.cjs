#!/usr/bin/env node
/**
 * Codex Micro HID bridge.
 *
 * Runs as a separate OS process (see ../lib/index.js for why) and speaks
 * newline-delimited JSON on stdio. It owns the USB HID connection and the
 * JSON-RPC framing; the host plugin only sends intents and receives events.
 *
 *   stdin  : {"t":"list"} {"t":"connect","path":?} {"t":"disconnect"}
 *            {"t":"rpc","method":"...","params":{},"timeoutMs":?}
 *            {"t":"watch","enabled":true} {"t":"shutdown"}
 *   stdout : {"t":"devices","devices":[...]}
 *            {"t":"state","connected":bool,"device":{...}?}
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
 */
'use strict';

const HID = require('node-hid');

const WL_VID = 0x303a;
const RPC_USAGE_PAGE = 0xff00;
const REPORT_ID = 6;
const CHANNEL_DEBUG = 1;
const CHANNEL_RPC = 2;
const MAX_CHUNK = 61;
const DEFAULT_TIMEOUT_MS = 10_000;

const DEVICE_TYPES = new Map([
  [0x8360, 'codex_micro'],
  [33431, 'creator_micro_v2'],
  [33432, 'creator_micro_v2'],
]);

function emit(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
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
  const channel = buf[1];
  const length = buf[2];
  const text = buf.subarray(3, 3 + length).toString('utf8');
  return { channel, text };
}

function scanDevices() {
  let all = [];
  try {
    all = HID.devices();
  } catch (error) {
    emit({ t: 'error', message: `hid enumerate failed: ${error.message}` });
    return [];
  }
  return all
    .filter((d) => d.vendorId === WL_VID)
    .map((d) => ({
      path: d.path,
      productId: d.productId,
      type: DEVICE_TYPES.get(d.productId) ?? 'unknown',
      usagePage: d.usagePage,
      manufacturer: d.manufacturer ?? null,
      product: d.product ?? null,
      interface: d.interface,
      serialNumber: d.serialNumber ?? null,
      rpc: d.usagePage === RPC_USAGE_PAGE && DEVICE_TYPES.has(d.productId),
    }))
    .filter((d) => d.path);
}

class Bridge {
  constructor() {
    this.device = null;
    this.deviceInfo = null;
    this.buffers = { [CHANNEL_DEBUG]: '', [CHANNEL_RPC]: '' };
    this.pending = new Map();
    this.nextId = 1;
    this.queue = Promise.resolve();
    this.watchTimer = null;
    this.lastScanKey = '';
    this.closing = false;
  }

  async connect(path) {
    if (this.device) return { connected: true, device: this.deviceInfo };
    const target = path
      ? scanDevices().find((d) => d.path === path)
      : scanDevices().find((d) => d.rpc);
    if (!target) {
      emit({ t: 'error', message: 'no Codex Micro interface found' });
      return { connected: false };
    }
    if (!target.rpc) {
      emit({ t: 'error', message: `device ${target.path} is not the RPC interface (usagePage != 0xFF00)` });
      return { connected: false };
    }
    try {
      this.device = await HID.HIDAsync.open(target.path);
    } catch (error) {
      emit({ t: 'error', message: `open failed: ${error.message}` });
      return { connected: false };
    }
    this.deviceInfo = target;
    this.buffers = { [CHANNEL_DEBUG]: '', [CHANNEL_RPC]: '' };
    this.device.on('data', (buf) => this.onData(buf));
    this.device.on('error', (error) => {
      emit({ t: 'error', message: `hid error: ${error.message}` });
      this.teardown();
    });
    emit({ t: 'state', connected: true, device: this.deviceInfo });
    return { connected: true, device: this.deviceInfo };
  }

  teardown() {
    const was = this.device !== null;
    this.device = null;
    this.deviceInfo = null;
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error('device disconnected'));
    }
    this.pending.clear();
    if (was) emit({ t: 'state', connected: false });
  }

  async disconnect() {
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

  onData(buf) {
    let packet;
    try {
      packet = decodeReport(buf);
    } catch {
      return;
    }
    const channel = packet.channel === CHANNEL_DEBUG ? CHANNEL_DEBUG : CHANNEL_RPC;
    this.buffers[channel] = (this.buffers[channel] ?? '') + packet.text;
    const parts = this.buffers[channel].split(/\r?\n/);
    this.buffers[channel] = parts.pop() ?? '';
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
      // Fragmented JSON without a newline boundary; keep appending next round.
      this.buffers[CHANNEL_RPC] = `${text}${this.buffers[CHANNEL_RPC] ?? ''}`;
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
    if (!entry) {
      emit({ t: 'log', channel: 'rpc', line: `orphan response ${key}: ${line}` });
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
    const send = () => new Promise((resolve) => {
      if (!this.device) {
        resolve({ ok: false, error: { code: 'DEVICE_DISCONNECTED', message: 'no device connected' } });
        return;
      }
      // Firmware only accepts request ids in 0..998.
      const id = this.nextId;
      this.nextId = this.nextId >= 998 ? 1 : this.nextId + 1;
      const request = { jsonrpc: '2.0', id, method, params: params ?? null };
      const timer = setTimeout(() => {
        this.pending.delete(String(id));
        resolve({ ok: false, error: { code: 'TIMEOUT', message: `timeout after ${timeoutMs}ms` } });
      }, timeoutMs);
      this.pending.set(String(id), { resolve, timer });
      const write = async () => {
        try {
          for (const frame of encodeFrames(JSON.stringify(request))) {
            await this.device.write(frame);
          }
        } catch (error) {
          clearTimeout(timer);
          this.pending.delete(String(id));
          resolve({ ok: false, error: { code: 'WRITE_FAILED', message: error.message } });
        }
      };
      void write();
    });
    // Serialize: firmware handles one request at a time.
    const result = this.queue.then(send, send);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
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
      if (!this.device) {
        const candidate = devices.find((d) => d.rpc);
        if (candidate) void this.connect(candidate.path);
      }
    }, intervalMs);
    this.watchTimer.unref?.();
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
    case 'watch':
      if (msg.enabled === false) {
        if (bridge.watchTimer) clearInterval(bridge.watchTimer);
        bridge.watchTimer = null;
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

emit({ t: 'ready', pid: process.pid });
emit({ t: 'devices', devices: scanDevices() });
