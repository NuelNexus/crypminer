#!/usr/bin/env node
// Kiln in the terminal. Run: node app/tui.js [--worker NAME] [--address WALLET] [--mine]
// If Kiln (the desktop app or Kiln.cmd) is already running, this attaches to it.
// Otherwise it runs the miner itself, and quitting stops mining.
'use strict';

const readline = require('readline');
const { execFile } = require('child_process');

const BASE = `http://127.0.0.1:${Number(process.env.KILN_PORT) || 4545}`;
const out = process.stdout;

// ---------- formatting ----------

const useColor = out.isTTY && !process.env.NO_COLOR;
const paint = (code) => (s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const c = {
  bold: paint('1'), dim: paint('2'), green: paint('32'), red: paint('31'), yellow: paint('33'),
  cyan: paint('36'), magenta: paint('35'), inverse: paint('7'),
};
const visible = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '');
const width = (s) => [...visible(s)].length;
function pad(s, n, right = false) {
  s = String(s);
  const gap = Math.max(0, n - width(s));
  return right ? ' '.repeat(gap) + s : s + ' '.repeat(gap);
}
function clip(s, n) {
  // Cut a coloured string to n visible characters.
  let seen = 0, res = '';
  for (const part of String(s).split(/(\x1b\[[0-9;]*m)/)) {
    if (/^\x1b\[/.test(part)) { res += part; continue; }
    for (const ch of part) { if (seen >= n) return res + (useColor ? '\x1b[0m' : ''); res += ch; seen++; }
  }
  return res;
}

const num = (n, d = 0) => (n == null || !Number.isFinite(n) ? '—' : n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }));
function hash(h) {
  if (h == null) return '—';
  if (h >= 1e6) return num(h / 1e6, 2) + ' MH/s';
  if (h >= 1e4) return num(h / 1e3, 1) + ' kH/s';
  return num(h, 0) + ' H/s';
}
function coin(x, sym = '') {
  if (x == null || !Number.isFinite(x)) return '—';
  const s = x === 0 ? '0' : x < 0.01 ? x.toFixed(8) : x < 10 ? x.toFixed(6) : x.toFixed(4);
  return sym ? `${s} ${sym}` : s;
}
const usd = (x) => (x == null || !Number.isFinite(x) ? '—' : '$' + (x < 1 ? x.toFixed(4) : num(x, 2)));
function dur(sec) {
  if (sec == null) return '—';
  sec = Math.floor(sec);
  const d = Math.floor(sec / 86400), h = Math.floor(sec / 3600) % 24, m = Math.floor(sec / 60) % 60;
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${String(m).padStart(2, '0')}m`;
  return `${m}m ${String(sec % 60).padStart(2, '0')}s`;
}
function ago(t) {
  if (!t) return '—';
  const s = (Date.now() - t) / 1000;
  return s < 120 ? 'now' : dur(s) + ' ago';
}
function bar(frac, n) {
  frac = Math.max(0, Math.min(1, frac || 0));
  const full = Math.round(frac * n);
  return c.green('█'.repeat(full)) + c.dim('░'.repeat(n - full));
}
function spark(points, n) {
  if (!points.length || n <= 0) return '';
  const ticks = '▁▂▃▄▅▆▇█';
  const vals = [];
  for (let i = 0; i < n; i++) {
    const a = Math.floor((i * points.length) / n), b = Math.max(a + 1, Math.floor(((i + 1) * points.length) / n));
    const slice = points.slice(a, b).map((p) => p[1]);
    vals.push(slice.length ? slice.reduce((x, y) => x + y, 0) / slice.length : 0);
  }
  const max = Math.max(...vals) || 1, min = Math.min(...vals);
  const range = max - min || 1;
  return c.cyan(vals.map((v) => ticks[Math.min(7, Math.floor(((v - min) / range) * 7.99))]).join(''));
}
const short = (a) => (a && a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-6)}` : a || '—');

// ---------- talking to Kiln ----------

async function api(route, body) {
  const res = await fetch(BASE + route, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(4000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || Object.values(json.errors || {})[0] || `HTTP ${res.status}`);
  return json;
}

let core = null; // set when this process runs the miner itself
let state = null;
let logLines = [];
let logSeq = 0;
let flash = null; // { text, bad, until }
let input = null; // { label, value, onDone }
let lastError = null;

function say(text, bad = false) { flash = { text, bad, until: Date.now() + 5000 }; render(); }

async function connect() {
  try {
    await api('/api/state');
    return 'attached';
  } catch { /* nothing running yet */ }
  process.env.KILN_QUIET = '1';
  core = require('./server.js');
  await core.ready;
  if (process.argv.includes('--mine')) core.start();
  return 'owned';
}

async function poll() {
  try {
    state = await api('/api/state');
    const l = await api('/api/log?since=' + logSeq);
    logSeq = l.seq;
    logLines = logLines.concat(l.lines).slice(-200);
    lastError = null;
  } catch (err) {
    lastError = err.message;
  }
  render();
}

// ---------- drawing ----------

function statusLabel(m) {
  const map = {
    running: c.green('● mining'), starting: c.yellow('◐ starting'), stopping: c.yellow('◑ stopping'),
    stopped: c.dim('○ stopped'), crashed: c.red('✖ crashed'),
  };
  return map[m.status] || m.status;
}

function section(title, extra = '') {
  return c.bold(c.magenta(title)) + (extra ? '  ' + c.dim(extra) : '');
}

// An older Kiln that is still running has no per-device data: build a rough one from the pool's worker list.
function legacyFleet(s) {
  const e = s.earnings;
  const devices = (e.poolWorkers || []).map((w) => ({
    name: w.name, local: w.name === s.settings.worker, online: !!w.online, hashrate: Number(w.rhr) || 0, lastSeen: w.last,
  }));
  const total = devices.reduce((a, d) => a + d.hashrate, 0);
  const earned = e.balance != null ? e.balance + (e.paid || 0) : null;
  for (const d of devices) {
    d.share = total ? d.hashrate / total : 0;
    d.perDay = e.perHash != null ? d.hashrate * 86400 * e.perHash : null;
    d.earned = earned != null ? earned * d.share : null;
    d.past24h = e.past24h != null ? e.past24h * d.share : null;
  }
  return { devices, online: devices.filter((d) => d.online).length, hashrate: total, perDay: e.perHash != null ? total * 86400 * e.perHash : null, earned, past24h: e.past24h, trackedSince: null, legacy: true };
}

function frame() {
  const W = Math.max(60, out.columns || 100);
  const H = Math.max(20, out.rows || 40);
  const L = [];
  const s = state;

  if (!s) {
    L.push(c.bold(' KILN'), '', '  Connecting to Kiln…' + (lastError ? c.red('  ' + lastError) : ''));
    return { lines: L, W, H };
  }

  const m = s.miner, e = s.earnings, sym = e.coin;
  const f = s.fleet || legacyFleet(s);
  const clock = new Date().toLocaleTimeString('en-GB');
  const head = ` ${c.bold(c.inverse(' KILN '))}  ${statusLabel(m)}  ${c.dim('·')} ${m.threads || s.settings.threads} threads ${c.dim('·')} ${s.settings.mode} mode`
    + (s.tune.active ? c.yellow(`  · auto-tune ${s.tune.step}/${s.tune.steps} (${s.tune.current} threads, ${s.tune.phase})`) : '');
  const headRight = `${c.dim('device')} ${c.bold(s.settings.worker)}  ${c.dim('wallet')} ${short(s.settings.address)}  ${c.dim(clock)}`;
  L.push(head + ' '.repeat(Math.max(2, W - width(head) - width(headRight) - 1)) + headRight);
  L.push(c.dim('─'.repeat(W)));

  // This device
  L.push(section('THIS DEVICE', `${s.system.cpuName} · ${s.system.logical} logical cores · ${s.system.elevated ? 'admin' : 'not admin'}`));
  const hr = m.hashrate;
  const sparkW = Math.max(10, W - 60);
  L.push(`  Hashrate   ${c.bold(pad(hash(hr.s10), 12))} ${c.dim('1m')} ${pad(hash(hr.m1), 11)} ${c.dim('15m')} ${pad(hash(hr.m15), 11)} ${spark(s.live, sparkW)}`);
  L.push(`  Shares     ${c.green(num(m.shares.good))}/${num(m.shares.total)} accepted ${c.dim('·')} ping ${m.pool.ping != null ? m.pool.ping + ' ms' : '—'} ${c.dim('·')} uptime ${dur(m.uptime)} ${c.dim('·')} CPU load ${num(s.system.load * 100)}%`);
  const hp = m.hugepages ? `${m.hugepages[0]}/${m.hugepages[1]}` : '—';
  L.push(`  Tuning     huge pages ${hp} ${c.dim('·')} MSR ${m.msr === 'ok' ? c.green('ok') : m.msr === 'failed' ? c.yellow('failed (run as admin)') : '—'} ${c.dim('·')} recommended ${s.system.recommended} threads ${c.dim('·')} this device est. ${coin(e.perDay, sym)}/day`);
  if (s.setup.error) L.push('  ' + c.red(s.setup.error));
  else if (s.setup.downloading) L.push('  ' + c.yellow('Downloading XMRig…'));
  L.push('');

  // Wallet
  L.push(section(`WALLET · ${sym}`, `all devices combined · pool data ${ago(e.poolUpdated)}${e.poolError ? ' · ' + e.poolError : ''}`));
  const price = sym === 'SOL' ? s.market.solUsd : null;
  const frac = e.balance != null && e.threshold ? e.balance / e.threshold : 0;
  L.push(`  Balance    ${c.bold(coin(e.balance, sym))} ${c.dim(usd(e.balance != null && price ? e.balance * price : null))}   payout at ${coin(e.threshold, sym)}  ${bar(frac, 20)} ${num(frac * 100, 1)}%`);
  L.push(`  Earned     24h ${coin(e.past24h)} ${c.dim('·')} 7d ${coin(e.past7d)} ${c.dim('·')} 30d ${coin(e.past30d)} ${c.dim('·')} paid out ${coin(e.paid)} ${c.dim('·')} fee ${e.fee}%`);
  L.push(`  Fleet rate ${c.bold(hash(f.hashrate))} from ${f.online} device${f.online === 1 ? '' : 's'} ${c.dim('·')} est. ${c.bold(coin(f.perDay, sym))}/day ${c.dim(usd(f.perDay != null && price ? f.perDay * price : null) + '/day')} ${c.dim('·')} SOL ${usd(s.market.solUsd)} XMR ${usd(s.market.xmrUsd)}`);
  L.push('');

  // Devices
  L.push(section('DEVICES', f.legacy
    ? 'split by current hashrate · restart Kiln to track each device over time'
    : `earnings split by each device's share of hashes${f.trackedSince ? ' since ' + new Date(f.trackedSince).toLocaleDateString() : ''}`));
  const cols = [['DEVICE', 18], ['STATUS', 9], ['HASHRATE', 12, true], ['SHARE', 8, true], ['EST / DAY', 14, true], ['EARNED 24H', 14, true], ['EARNED TOTAL', 14, true], ['LAST SEEN', 11, true]];
  const row = (cells) => '  ' + cells.map((v, i) => pad(v, cols[i][1], cols[i][2])).join(' ');
  L.push(c.dim(row(cols.map((x) => x[0]))));
  const room = Math.max(3, H - L.length - 12);
  const devices = f.devices.slice(0, room);
  for (const d of devices) {
    const name = (d.local ? '▸ ' : '  ') + d.name;
    L.push(row([
      d.local ? c.bold(name) : name,
      d.online ? c.green('online') : c.dim('offline'),
      d.online ? hash(d.hashrate) : c.dim('—'),
      num(d.share * 100, 1) + '%',
      d.online ? coin(d.perDay) : c.dim('—'),
      coin(d.past24h),
      c.bold(coin(d.earned)),
      ago(d.lastSeen),
    ]));
  }
  if (f.devices.length > devices.length) L.push(c.dim(`  … ${f.devices.length - devices.length} more`));
  L.push(c.dim(row(['total', '', '', '', '', '', '', ''].map(() => '─'.repeat(6)))));
  L.push(row([c.bold('all devices'), `${f.online}/${f.devices.length}`, c.bold(hash(f.hashrate)), '100%', c.bold(coin(f.perDay)), coin(f.past24h), c.bold(coin(f.earned)), '']));
  L.push('');

  // Log fills the rest
  const footerLines = 2;
  const logRoom = H - L.length - footerLines - 1;
  if (logRoom > 0) {
    L.push(section('LOG'));
    const color = { good: c.green, bad: c.red, dim: c.dim, info: (x) => x };
    for (const l of logLines.slice(-(logRoom - 1))) {
      const t = new Date(l.t).toLocaleTimeString('en-GB');
      L.push(`  ${c.dim(t)} ${l.source === 'kiln' ? c.cyan('kiln ') : c.dim('xmrig')} ${color[l.level](l.text)}`);
    }
  }

  return { lines: L, W, H };
}

function footer(W) {
  if (input) return c.inverse(` ${input.label}: `) + ' ' + input.value + '█' + c.dim('   enter to save · esc to cancel');
  if (flash && flash.until > Date.now()) return ' ' + (flash.bad ? c.red(flash.text) : c.green(flash.text));
  const mining = state && ['running', 'starting'].includes(state.miner.status);
  const keys = [
    ['s', mining ? 'stop' : 'start'], ['m', 'mode'], ['+/-', 'threads'], ['0', 'auto'],
    ['t', state?.tune.active ? 'cancel tune' : 'auto-tune'], ['w', 'rename'], ['d', 'web'],
    ['q', core ? 'quit + stop mining' : 'quit (Kiln keeps mining)'],
  ];
  return ' ' + keys.map(([k, v]) => `${c.bold(c.cyan(k))} ${v}`).join(c.dim(' · '));
}

let renderQueued = false;
function render() {
  if (renderQueued) return;
  renderQueued = true;
  setImmediate(() => {
    renderQueued = false;
    const { lines, W, H } = frame();
    const body = lines.slice(0, H - 2).map((l) => clip(l, W) + '\x1b[K');
    while (body.length < H - 2) body.push('\x1b[K');
    body.push(c.dim('─'.repeat(W)) + '\x1b[K', clip(footer(W), W) + '\x1b[K');
    out.write('\x1b[H' + body.join('\n'));
  });
}

// ---------- keys ----------

async function act(fn, okText) {
  try { await fn(); if (okText) say(okText); } catch (err) { say(err.message, true); }
  poll();
}

function onKey(str, key = {}) {
  if (key.ctrl && key.name === 'c') return quit();

  if (input) {
    if (key.name === 'escape') input = null;
    else if (key.name === 'return') { const done = input.onDone, v = input.value; input = null; done(v); }
    else if (key.name === 'backspace') input.value = input.value.slice(0, -1);
    else if (str && str.length === 1 && str >= ' ') input.value += str;
    return render();
  }
  if (!state) return;
  const st = state;
  switch (str) {
    case 's': case 'S': {
      const mining = ['running', 'starting'].includes(st.miner.status);
      return act(() => api(mining ? '/api/stop' : '/api/start', {}), mining ? 'Stopping…' : 'Starting…');
    }
    case 'm': case 'M': {
      const mode = st.settings.mode === 'max' ? 'balanced' : 'max';
      return act(() => api('/api/settings', { mode }), `Mode: ${mode}`);
    }
    case '+': case '=': case '-': case '_': {
      const n = Math.max(1, Math.min(st.system.logical, st.settings.threads + (str === '+' || str === '=' ? 1 : -1)));
      return act(() => api('/api/settings', { threads: n }), `Threads: ${n}`);
    }
    case '0': return act(() => api('/api/settings', { threads: null }), `Threads: auto (${st.system.recommended})`);
    case 't': case 'T':
      return st.tune.active
        ? act(() => api('/api/autotune/cancel', {}), 'Auto-tune cancelled')
        : act(() => api('/api/autotune', {}), 'Auto-tune started: tries a few thread counts, about a minute each');
    case 'w': case 'W':
      input = { label: 'Device name', value: st.settings.worker, onDone: (v) => act(() => api('/api/settings', { worker: v }), `Device name: ${v}`) };
      return render();
    case 'd': case 'D': {
      const opener = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', BASE]] : [process.platform === 'darwin' ? 'open' : 'xdg-open', [BASE]];
      execFile(opener[0], opener[1], { windowsHide: true }, () => {});
      return say('Opened ' + BASE);
    }
    case 'q': case 'Q': return quit();
  }
}

// ---------- start / stop ----------

let quitting = false;
async function quit() {
  if (quitting) return;
  quitting = true;
  if (core) { flash = { text: 'Stopping miner…', until: Infinity }; render(); await core.shutdown(); }
  restore();
  process.exit(0);
}

function restore() {
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  out.write('\x1b[?25h\x1b[?1049l');
}

async function main() {
  if (!out.isTTY) {
    console.error('Kiln TUI needs an interactive terminal.');
    process.exit(1);
  }
  out.write('\x1b[?1049h\x1b[?25l\x1b[2J');
  process.on('exit', () => out.write('\x1b[?25h\x1b[?1049l'));
  render();

  let mode;
  try { mode = await connect(); } catch (err) {
    restore();
    console.error('Kiln could not start: ' + err.message);
    process.exit(1);
  }
  if (mode === 'attached') say('Attached to the Kiln that is already running.');

  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.on('keypress', onKey);
  out.on('resize', () => { out.write('\x1b[2J'); render(); });
  process.on('SIGTERM', quit);

  await poll();
  setInterval(poll, 2000);
  setInterval(render, 1000);
}

main();
