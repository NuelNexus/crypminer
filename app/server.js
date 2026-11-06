// Kiln — local dashboard + controller for XMRig, paying out through unMineable.
// No dependencies: run with `node server.js`, then open http://127.0.0.1:4545
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');

const APP = __dirname;
// KILN_ROOT is set by the desktop app, because a packaged app's own folder is read-only.
const ROOT = process.env.KILN_ROOT || path.resolve(APP, '..');
const PUBLIC = path.join(APP, 'public');
const DATA = path.join(ROOT, 'data');
const IS_WIN = process.platform === 'win32';
const XMRIG_VERSION = '6.26.0';
const XMRIG_DIR = path.join(ROOT, `xmrig-${XMRIG_VERSION}`);
const XMRIG_EXE = path.join(XMRIG_DIR, IS_WIN ? 'xmrig.exe' : 'xmrig');

// Official XMRig release files and their SHA-256 (from the release's SHA256SUMS).
const XMRIG_ASSETS = {
  'win32-x64': ['windows-x64.zip', 'bba8097cb37d9b458a1cb1137876b27cde6740d17fe4ccbc086ba07d87d9e147'],
  'win32-arm64': ['windows-arm64.zip', '958952de131c392a4e1e9656a1d70c3916d09d5a1f5e3f8c67dc0e6f35dbd76a'],
  'linux-x64': ['linux-static-x64.tar.gz', 'fc6f8ae5f64e4f17481f7e3be29a1c56949f216a998414188003eae1db20c9e5'],
  'darwin-x64': ['macos-x64.tar.gz', '1da924b358c0089e361540c4a9e6f8b09538b29efeafa2379590e0f6db358ff4'],
  'darwin-arm64': ['macos-arm64.tar.gz', '6ae4eb4216e99a201ae9a3d2c3a7c275207c5165cfc25da1f3d735d6c4829c18'],
};
const XMRIG_ASSET = XMRIG_ASSETS[`${process.platform}-${process.arch}`] || null;
const XMRIG_ARCHIVE = XMRIG_ASSET && path.join(ROOT, 'download', `xmrig-${XMRIG_VERSION}-${XMRIG_ASSET[0]}`);
const XMRIG_URL = XMRIG_ASSET && `https://github.com/xmrig/xmrig/releases/download/v${XMRIG_VERSION}/xmrig-${XMRIG_VERSION}-${XMRIG_ASSET[0]}`;
const LEGACY_ZIP = path.join(ROOT, 'download', 'xmrig.zip'); // where earlier versions kept the Windows download
const RUNTIME_CONFIG = path.join(DATA, 'xmrig-runtime.json');

const PORT = Number(process.env.KILN_PORT) || 4545;
const API_PORT = 18088;
const API_TOKEN = crypto.randomBytes(16).toString('hex');

const POOL_URL = 'rx.unmineable.com:443';
const BLOCKS_PER_DAY = 720; // Monero: one block every 2 minutes

fs.mkdirSync(DATA, { recursive: true });
// Move data from the earlier location (app/data) the first time.
for (const f of ['settings.json', 'totals.json', 'history.json']) {
  const old = path.join(ROOT, 'app', 'data', f);
  if (fs.existsSync(old) && !fs.existsSync(path.join(DATA, f))) fs.copyFileSync(old, path.join(DATA, f));
}

// ---------- persistence ----------

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(path.join(DATA, file), 'utf8')); }
  catch { return fallback; }
}
function writeJson(file, value) {
  const target = path.join(DATA, file);
  fs.writeFileSync(target + '.tmp', JSON.stringify(value));
  fs.renameSync(target + '.tmp', target);
}

// Each device mines to the same wallet under its own worker name (the computer name by default),
// so unMineable can tell the devices apart.
const defaultWorker = (os.hostname().replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24) || 'device').toLowerCase();

const settings = Object.assign({
  coin: 'SOL',
  address: 'BiwDe7t7iguzrQgUbowSadMRM29pybo3j1eBTA5NvWVS',
  worker: defaultWorker,
  threads: null,          // null = use recommended
  mode: 'balanced',       // balanced | max
  autostart: false,
}, readJson('settings.json', {}));

// Command-line overrides, e.g. `node app/tui.js --worker desktop --address <wallet>`
function argValue(name) {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
}
if (/^[A-Za-z0-9_-]{1,24}$/.test(argValue('--worker') || '')) settings.worker = argValue('--worker');
if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(argValue('--address') || '')) settings.address = argValue('--address');

const totals = Object.assign({ hashes: 0, seconds: 0, sessions: 0, firstStart: null }, readJson('totals.json', {}));

// history.minutes: [t, avgHashrate] one per minute, 7 days
// history.earn:    [t, balance + paid] one per hour, 90 days
const history = Object.assign({ minutes: [], earn: [] }, readJson('history.json', {}));

// Hashes each device (worker) has contributed to the wallet, as reported by the pool.
// unMineable only reports earnings for the whole wallet, so they are split by this.
const fleet = Object.assign({ workers: {}, lastAt: null }, readJson('fleet.json', {}));

function saveAll() {
  writeJson('settings.json', settings);
  writeJson('totals.json', totals);
  writeJson('history.json', history);
  writeJson('fleet.json', fleet);
}

// ---------- system info ----------

const system = {
  cpuName: os.cpus()[0]?.model.trim() || 'CPU',
  logical: os.cpus().length,
  physical: Math.max(1, Math.round(os.cpus().length / 2)),
  l3MB: null,
  elevated: false,
  load: 0,
};

if (IS_WIN) {
  execFile('powershell', ['-NoProfile', '-Command',
    'Get-CimInstance Win32_Processor | Select-Object NumberOfCores,L3CacheSize | ConvertTo-Json'],
    { windowsHide: true }, (err, out) => {
      if (err) return;
      try {
        const info = JSON.parse(out);
        const p = Array.isArray(info) ? info[0] : info;
        if (p.NumberOfCores) system.physical = p.NumberOfCores;
        if (p.L3CacheSize) system.l3MB = p.L3CacheSize / 1024;
      } catch { /* keep defaults */ }
    });
  execFile('net', ['session'], { windowsHide: true }, (err) => { system.elevated = !err; });
} else {
  system.elevated = process.getuid?.() === 0;
  if (process.platform === 'linux') {
    try {
      const blocks = fs.readFileSync('/proc/cpuinfo', 'utf8').split(/\n\s*\n/);
      const cores = new Set(blocks.map((b) => `${b.match(/physical id\s*:\s*(\d+)/)?.[1]}:${b.match(/core id\s*:\s*(\d+)/)?.[1]}`));
      if (cores.size > 1) system.physical = cores.size;
      const cache = blocks[0].match(/cache size\s*:\s*(\d+)\s*KB/);
      if (cache) system.l3MB = Number(cache[1]) / 1024;
    } catch { /* keep defaults */ }
  } else if (process.platform === 'darwin') {
    execFile('sysctl', ['-n', 'hw.physicalcpu', 'hw.l3cachesize'], (err, out) => {
      if (err) return;
      const [cores, l3] = out.trim().split(/\s+/).map(Number);
      if (cores) system.physical = cores;
      if (l3) system.l3MB = l3 / 1048576;
    });
  }
}

let lastCpu = os.cpus();
setInterval(() => {
  const now = os.cpus();
  let idle = 0, total = 0;
  now.forEach((c, i) => {
    const a = c.times, b = lastCpu[i].times;
    const t = (a.user - b.user) + (a.nice - b.nice) + (a.sys - b.sys) + (a.irq - b.irq) + (a.idle - b.idle);
    idle += a.idle - b.idle; total += t;
  });
  system.load = total > 0 ? 1 - idle / total : 0;
  lastCpu = now;
}, 2000);

// RandomX needs ~2 MB of L3 per thread. Past that, extra threads fight over cache and slow down.
function recommendedThreads() {
  const byCache = system.l3MB ? Math.max(1, Math.floor(system.l3MB / 2)) : system.physical;
  return Math.min(system.physical, byCache);
}
function activeThreads() {
  return Math.min(system.logical, Math.max(1, settings.threads || recommendedThreads()));
}

// One thread per physical core first (logical 0,2,4,6 on Intel Hyper-Threading), then the siblings.
function affinityFor(n) {
  const ht = system.logical === system.physical * 2;
  const list = [];
  for (let i = 0; i < n; i++) {
    if (!ht) list.push(i);
    else if (i < system.physical) list.push(i * 2);
    else list.push((i - system.physical) * 2 + 1);
  }
  return list;
}

// ---------- log ----------

const log = [];
let logSeq = 0;
function addLog(text, source = 'xmrig') {
  const clean = text.replace(/\x1b\[[0-9;]*m/g, '').replace(/\s+$/, '');
  if (!clean) return;
  let level = 'info';
  if (/accepted/i.test(clean)) level = 'good';
  else if (/rejected|error|failed|cannot/i.test(clean)) level = 'bad';
  else if (/new job|speed/i.test(clean)) level = 'dim';
  log.push({ seq: ++logSeq, t: Date.now(), text: clean, level, source });
  if (log.length > 800) log.shift();

  if (/msr.*(set successfully|preset have been set)/i.test(clean)) miner.msr = 'ok';
  else if (/msr.*(FAILED|cannot)/i.test(clean)) miner.msr = 'failed';
}

// ---------- XMRig setup ----------

const setup = { ready: fs.existsSync(XMRIG_EXE), blocked: false, error: null, downloading: false };

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

// Gets the official XMRig release for this computer and checks its SHA-256 before using it.
async function downloadXmrig() {
  if (!XMRIG_ASSET) throw new Error(`no XMRig build for ${process.platform}-${process.arch}`);
  if (fs.existsSync(XMRIG_ARCHIVE) && sha256(XMRIG_ARCHIVE) === XMRIG_ASSET[1]) return XMRIG_ARCHIVE;
  if (XMRIG_ASSET[0] === 'windows-x64.zip' && fs.existsSync(LEGACY_ZIP) && sha256(LEGACY_ZIP) === XMRIG_ASSET[1]) return LEGACY_ZIP;
  addLog(`Downloading XMRig ${XMRIG_VERSION}…`, 'kiln');
  setup.downloading = true;
  try {
    const res = await fetch(XMRIG_URL, { signal: AbortSignal.timeout(120e3) });
    if (!res.ok) throw new Error(`download failed (${res.status})`);
    const buf = Buffer.from(await res.arrayBuffer());
    const hash = crypto.createHash('sha256').update(buf).digest('hex');
    if (hash !== XMRIG_ASSET[1]) throw new Error('download did not match the official checksum');
    fs.mkdirSync(path.dirname(XMRIG_ARCHIVE), { recursive: true });
    fs.writeFileSync(XMRIG_ARCHIVE, buf);
    addLog('XMRig downloaded and verified.', 'kiln');
    return XMRIG_ARCHIVE;
  } finally {
    setup.downloading = false;
  }
}

function extract(archive) {
  return new Promise((resolve) => {
    const done = (err, _out, stderr) => resolve({ err, stderr: String(stderr || '') });
    if (archive.endsWith('.zip')) {
      execFile('powershell', ['-NoProfile', '-Command',
        `Expand-Archive -LiteralPath '${archive}' -DestinationPath '${ROOT}' -Force -ErrorAction Stop`],
        { windowsHide: true }, done);
    } else {
      execFile('tar', ['-xzf', archive, '-C', ROOT], done);
    }
  });
}

let ensuring = null;
function ensureXmrig() {
  ensuring ||= ensureXmrigInner().finally(() => { ensuring = null; });
  return ensuring;
}
async function ensureXmrigInner() {
  if (fs.existsSync(XMRIG_EXE)) { setup.ready = true; setup.blocked = false; return true; }
  let archive;
  try { archive = await downloadXmrig(); } catch (err) {
    setup.error = 'Could not get XMRig: ' + err.message;
    addLog(setup.error, 'kiln');
    return false;
  }
  addLog('Unpacking XMRig…', 'kiln');
  const { err, stderr } = await extract(archive);
  setup.ready = fs.existsSync(XMRIG_EXE);
  if (setup.ready && !IS_WIN) fs.chmodSync(XMRIG_EXE, 0o755);
  setup.blocked = !setup.ready && /virus|unwanted/i.test(stderr + String(err));
  setup.error = setup.ready ? null : (setup.blocked
    ? 'Windows Defender blocked XMRig. Add a folder exclusion for ' + ROOT
    : 'Could not unpack XMRig: ' + (stderr || String(err)).slice(0, 200));
  addLog(setup.ready ? 'XMRig is ready.' : setup.error, 'kiln');
  return setup.ready;
}

function writeRuntimeConfig(threads) {
  const max = settings.mode === 'max';
  const config = {
    autosave: false,
    background: false,
    colors: false,
    'donate-level': 1,
    'print-time': 30,
    http: { enabled: true, host: '127.0.0.1', port: API_PORT, 'access-token': API_TOKEN, restricted: true },
    randomx: {
      init: -1,
      mode: 'fast',            // 2 GB dataset in RAM: ~8x faster than light mode
      '1gb-pages': false,
      rdmsr: true,
      wrmsr: true,             // MSR prefetcher tweak, +10-15% on Intel when running as admin
      cache_qos: false,
      numa: true,
      scratchpad_prefetch_mode: 1,
    },
    cpu: {
      enabled: true,
      'huge-pages': true,      // needs the "Lock pages in memory" privilege
      'huge-pages-jit': false,
      'hw-aes': null,
      priority: max ? 3 : 1,
      yield: !max,
      rx: affinityFor(threads),
    },
    opencl: false,
    cuda: false,
    pools: [{
      algo: 'rx/0',
      url: POOL_URL,
      user: `${settings.coin}:${settings.address}.${settings.worker}`,
      pass: 'x',
      tls: true,
      keepalive: true,
    }],
  };
  fs.writeFileSync(RUNTIME_CONFIG, JSON.stringify(config, null, 2));
}

// ---------- miner process ----------

const miner = {
  proc: null,
  status: 'stopped',  // stopped | starting | running | stopping | crashed
  startedAt: null,
  threads: 0,
  summary: null,
  backends: null,
  msr: 'unknown',
  sessionHashes: 0,
  lastPoll: 0,
  exitCode: null,
};

const live = []; // [t, hashrate10s] every 2 s, last 15 min
let minuteBucket = { start: 0, sum: 0, n: 0 };

let starting = false;
async function startMiner(threadsOverride) {
  if (miner.proc || starting) return;
  starting = true;
  try { await startMinerInner(threadsOverride); } finally { starting = false; }
}
async function startMinerInner(threadsOverride) {
  if (!(await ensureXmrig())) { miner.status = 'stopped'; return; }
  const threads = threadsOverride || activeThreads();
  writeRuntimeConfig(threads);
  miner.status = 'starting';
  miner.summary = null;
  miner.backends = null;
  miner.msr = 'unknown';
  miner.sessionHashes = 0;
  miner.lastPoll = 0;
  miner.exitCode = null;
  miner.threads = threads;
  miner.startedAt = Date.now();
  totals.sessions += 1;
  totals.firstStart = totals.firstStart || Date.now();
  addLog(`Starting XMRig with ${threads} thread${threads > 1 ? 's' : ''} (${settings.mode} mode)`, 'kiln');

  const proc = spawn(XMRIG_EXE, ['--config', RUNTIME_CONFIG, '--no-color'], { cwd: XMRIG_DIR, windowsHide: true });
  miner.proc = proc;
  const onData = (buf) => buf.toString().split(/\r?\n/).forEach((l) => addLog(l));
  proc.stdout.on('data', onData);
  proc.stderr.on('data', onData);
  proc.on('error', (err) => {
    addLog('Could not start XMRig: ' + err.message, 'kiln');
    if (!fs.existsSync(XMRIG_EXE)) { setup.ready = false; setup.blocked = true; setup.error = 'xmrig.exe disappeared — Windows Defender probably quarantined it.'; }
  });
  proc.on('exit', (code) => {
    if (miner.proc !== proc) return; // an older process finishing after a restart
    const expected = miner.status === 'stopping';
    miner.proc = null;
    miner.exitCode = code;
    miner.status = expected ? 'stopped' : 'crashed';
    miner.summary = null;
    miner.backends = null;
    addLog(expected ? 'Miner stopped.' : `XMRig exited unexpectedly (code ${code}).`, 'kiln');
    saveAll();
  });
}

function stopMiner() {
  return new Promise((resolve) => {
    const proc = miner.proc;
    if (!proc) { if (miner.status !== 'crashed') miner.status = 'stopped'; return resolve(); }
    miner.status = 'stopping';
    proc.once('exit', () => resolve());
    proc.kill();
    // Force-kill only this process if it hangs (never a newer one started after it).
    setTimeout(() => { if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL'); }, 5000);
  });
}

async function restartMiner(threadsOverride) {
  await stopMiner();
  await startMiner(threadsOverride);
}

async function xmrigApi(route) {
  const res = await fetch(`http://127.0.0.1:${API_PORT}${route}`, {
    headers: { Authorization: `Bearer ${API_TOKEN}` },
    signal: AbortSignal.timeout(1500),
  });
  if (!res.ok) throw new Error('XMRig API ' + res.status);
  return res.json();
}

setInterval(async () => {
  if (!miner.proc) return;
  try {
    const [summary, backends] = await Promise.all([xmrigApi('/2/summary'), xmrigApi('/2/backends')]);
    miner.summary = summary;
    miner.backends = backends;
    if (miner.status === 'starting') miner.status = 'running';

    const now = Date.now();
    // XMRig's own hashes_total only grows when a share is accepted, so count from the live hashrate.
    const hr = summary.hashrate?.total?.[0];
    const dt = miner.lastPoll ? Math.min(10, (now - miner.lastPoll) / 1000) : 0;
    miner.lastPoll = now;
    if (hr) { totals.hashes += hr * dt; miner.sessionHashes += hr * dt; }
    totals.seconds += dt;

    if (hr != null) {
      live.push([now, hr]);
      while (live.length && live[0][0] < now - 15 * 60e3) live.shift();

      const minute = Math.floor(now / 60e3) * 60e3;
      if (minuteBucket.start !== minute) {
        if (minuteBucket.n) {
          history.minutes.push([minuteBucket.start, minuteBucket.sum / minuteBucket.n]);
          while (history.minutes.length && history.minutes[0][0] < now - 7 * 86400e3) history.minutes.shift();
        }
        minuteBucket = { start: minute, sum: 0, n: 0 };
      }
      minuteBucket.sum += hr; minuteBucket.n += 1;
    }
  } catch { /* XMRig still booting or busy */ }
}, 2000);

setInterval(saveAll, 60e3);

// ---------- auto-tune ----------
// Mines with several thread counts in turn, measures each, keeps the fastest.

const tune = { active: false, results: [], current: null, startedAt: null, step: 0, steps: 0, phase: '' };
const TUNE_WARMUP = 25e3, TUNE_MEASURE = 45e3;

async function runAutotune() {
  if (tune.active) return;
  const rec = recommendedThreads();
  const candidates = [];
  for (let t = Math.max(1, rec - 2); t <= Math.min(system.logical, rec + 2); t++) candidates.push(t);
  Object.assign(tune, { active: true, results: [], current: null, startedAt: Date.now(), step: 0, steps: candidates.length });
  addLog(`Auto-tune: testing ${candidates.join(', ')} threads`, 'kiln');

  for (const t of candidates) {
    if (!tune.active) break;
    tune.step += 1; tune.current = t; tune.phase = 'warmup';
    await restartMiner(t);
    await wait(TUNE_WARMUP);
    if (!tune.active) break;
    tune.phase = 'measuring';
    const samples = [];
    const until = Date.now() + TUNE_MEASURE;
    while (Date.now() < until && tune.active) {
      const hr = miner.summary?.hashrate?.total?.[0];
      if (hr) samples.push(hr);
      await wait(2000);
    }
    if (!samples.length) { addLog(`Auto-tune: no reading for ${t} threads, skipping`, 'kiln'); continue; }
    const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
    tune.results.push({ threads: t, hashrate: avg });
    addLog(`Auto-tune: ${t} threads → ${avg.toFixed(0)} H/s`, 'kiln');
  }

  if (tune.active && tune.results.length) {
    const best = tune.results.reduce((a, b) => (b.hashrate > a.hashrate ? b : a));
    settings.threads = best.threads;
    saveAll();
    addLog(`Auto-tune done: ${best.threads} threads is fastest (${best.hashrate.toFixed(0)} H/s)`, 'kiln');
  }
  tune.active = false; tune.current = null; tune.phase = '';
  await restartMiner();
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- earnings, prices, network ----------

const market = { solUsd: null, xmrUsd: null, updated: null };
const network = { hashrate: null, reward: null, updated: null };
const pool = { uuid: null, uuidFor: null, account: null, stats: null, payments: [], workers: [], updated: null, error: null };

async function getJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(12e3), headers: { 'User-Agent': 'kiln-miner-dashboard' } });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

async function refreshMarket() {
  try {
    const j = await getJson('https://api.coingecko.com/api/v3/simple/price?ids=monero,solana&vs_currencies=usd');
    market.solUsd = j.solana.usd; market.xmrUsd = j.monero.usd; market.updated = Date.now();
  } catch { /* keep last */ }
}

async function refreshNetwork() {
  try {
    const j = await getJson('https://moneroblocks.info/api/get_stats');
    network.hashrate = j.hashrate;
    network.reward = j.last_reward / 1e12;
    network.updated = Date.now();
  } catch { /* keep last */ }
}

async function refreshPool() {
  const base = 'https://api.unminable.com/v4';
  try {
    if (pool.uuidFor !== settings.address + settings.coin) {
      const a = await getJson(`${base}/address/${settings.address}?coin=${settings.coin}`);
      if (!a.success) throw new Error(a.msg || 'unMineable lookup failed');
      pool.uuid = a.data.uuid; pool.uuidFor = settings.address + settings.coin; pool.account = a.data;
    }
    const [stats, payments, workers] = await Promise.all([
      getJson(`${base}/account/${pool.uuid}/stats`),
      getJson(`${base}/account/${pool.uuid}/payments`),
      getJson(`${base}/account/${pool.uuid}/workers`),
    ]);
    pool.stats = stats.data;
    pool.payments = payments.data?.list || [];
    pool.workers = workers.data?.randomx?.workers || [];
    pool.updated = Date.now();
    pool.error = null;
    recordFleet(pool.workers);

    const earned = Number(pool.stats.balance) + Number(pool.stats.paid || 0);
    const hour = Math.floor(Date.now() / 3600e3) * 3600e3;
    const lastEarn = history.earn[history.earn.length - 1];
    if (!lastEarn || lastEarn[0] !== hour) history.earn.push([hour, earned]);
    else lastEarn[1] = earned;
    while (history.earn.length > 24 * 90) history.earn.shift();
  } catch (err) {
    pool.error = err.message;
  }
}

// Credits each online worker with hashrate x time since the last check.
// Gaps longer than 5 minutes (Kiln was closed) are not credited.
function recordFleet(workers) {
  const now = Date.now();
  const dt = fleet.lastAt ? Math.min(300, (now - fleet.lastAt) / 1000) : 0;
  fleet.lastAt = now;
  for (const w of workers) {
    const rec = fleet.workers[w.name] ||= { hashes: 0, firstSeen: now, lastSeen: null };
    const hr = Number(w.rhr) || 0;
    if (w.online && hr > 0) { rec.hashes += hr * dt; rec.lastSeen = now; }
  }
}

// Per-device view of the wallet: live hashrate from the pool, earnings split by share of hashes.
function fleetView(perHash, localRate) {
  const earned = pool.stats ? Number(pool.stats.balance) + Number(pool.stats.paid || 0) : null;
  const past24h = pool.stats ? Number(pool.stats.rewarded?.past_24h || 0) : null;
  const names = new Set([...Object.keys(fleet.workers), ...pool.workers.map((w) => w.name), settings.worker]);
  const totalHashes = Object.values(fleet.workers).reduce((a, w) => a + w.hashes, 0);
  const rows = [...names].map((name) => {
    const pw = pool.workers.find((w) => w.name === name);
    const rec = fleet.workers[name] || { hashes: 0, firstSeen: null, lastSeen: null };
    const local = name === settings.worker;
    // The pool takes a few minutes to see a new device; show this device's own reading meanwhile.
    const hashrate = pw?.online ? Number(pw.rhr) || 0 : (local ? localRate : 0);
    const online = !!pw?.online || (local && localRate > 0);
    return {
      name,
      local,
      online,
      hashrate,
      hashes: rec.hashes,
      lastSeen: online ? Date.now() : pw?.last || rec.lastSeen,
    };
  });
  // Until some hashes are tracked, split by what each device is doing right now.
  const totalRate = rows.reduce((a, r) => a + r.hashrate, 0);
  for (const r of rows) {
    r.share = totalHashes > 0 ? r.hashes / totalHashes : totalRate > 0 ? r.hashrate / totalRate : (r.local ? 1 : 0);
    Object.assign(r, {
      perDay: perHash != null ? r.hashrate * 86400 * perHash : null,
      earned: earned != null ? earned * r.share : null,
      past24h: past24h != null ? past24h * r.share : null,
    });
  }
  rows.sort((a, b) => b.hashrate - a.hashrate || b.hashes - a.hashes);
  const hashrate = totalRate;
  const firstSeen = Math.min(...Object.values(fleet.workers).map((w) => w.firstSeen || Infinity));
  return {
    devices: rows,
    online: rows.filter((r) => r.online).length,
    hashrate,
    perDay: perHash != null ? hashrate * 86400 * perHash : null,
    earned,
    past24h,
    trackedSince: Number.isFinite(firstSeen) ? firstSeen : null,
  };
}

refreshMarket(); refreshNetwork(); refreshPool();
setInterval(refreshMarket, 5 * 60e3);
setInterval(refreshNetwork, 10 * 60e3);
setInterval(refreshPool, 90e3);

// Coins of the payout currency earned per hash, after the pool's 1% fee.
function coinPerHash() {
  if (!network.hashrate || !network.reward || !market.xmrUsd || !market.solUsd) return null;
  const xmrPerHash = (BLOCKS_PER_DAY * network.reward) / (network.hashrate * 86400);
  const fee = Number(pool.stats?.mining_fee ?? 1) / 100;
  return xmrPerHash * (market.xmrUsd / market.solUsd) * (1 - fee);
}

// ---------- state for the UI ----------

function buildState() {
  const s = miner.summary;
  const hr = s?.hashrate?.total || [null, null, null];
  const perHash = coinPerHash();
  const rate = hr[1] || hr[0] || 0;
  const threadRates = miner.backends?.find((b) => b.type === 'cpu')?.threads?.map((t) => t.hashrate?.[0] ?? 0) || [];
  const balance = pool.stats ? Number(pool.stats.balance) : null;
  const threshold = Number(pool.stats?.payment_threshold ?? pool.account?.payment_threshold ?? 0.05);
  const perDay = perHash != null ? rate * 86400 * perHash : null;

  return {
    now: Date.now(),
    miner: {
      status: miner.status,
      startedAt: miner.startedAt,
      uptime: s?.uptime ?? null,
      threads: miner.threads,
      hashrate: { s10: hr[0], m1: hr[1], m15: hr[2], highest: s?.hashrate?.highest ?? null },
      threadRates,
      sessionHashes: Math.round(miner.sessionHashes),
      shares: { good: s?.results?.shares_good ?? 0, total: s?.results?.shares_total ?? 0, avgTime: s?.results?.avg_time ?? null, diff: s?.results?.diff_current ?? null },
      pool: { url: s?.connection?.pool ?? POOL_URL, ping: s?.connection?.ping ?? null, uptime: s?.connection?.uptime ?? null, tls: !!s?.connection?.tls },
      hugepages: s?.hugepages ?? null,
      msr: miner.msr,
      exitCode: miner.exitCode,
    },
    settings: { ...settings, threads: activeThreads(), threadsAuto: !settings.threads },
    setup: { ...setup, folder: ROOT },
    system: { ...system, recommended: recommendedThreads() },
    tune: { ...tune },
    totals: { ...totals },
    earnings: {
      coin: settings.coin,
      perHash,
      perDay,
      perDayUsd: perDay != null && market.solUsd ? perDay * market.solUsd : null,
      balance,
      threshold,
      paid: pool.stats ? Number(pool.stats.paid || 0) : null,
      past24h: pool.stats ? Number(pool.stats.rewarded?.past_24h || 0) : null,
      past7d: pool.stats ? Number(pool.stats.rewarded?.past_7d || 0) : null,
      past30d: pool.stats ? Number(pool.stats.rewarded?.past_30d || 0) : null,
      fee: Number(pool.stats?.mining_fee ?? 1),
      payments: pool.payments.slice(0, 20),
      poolWorkers: pool.workers,
      poolUpdated: pool.updated,
      poolError: pool.error,
      explorer: 'https://solscan.io/account/' + settings.address,
    },
    fleet: fleetView(perHash, rate),
    market,
    network,
    live,
  };
}

function historyFor(range) {
  const now = Date.now();
  if (range === '1h' || range === '24h' || range === '7d') {
    const span = { '1h': 3600e3, '24h': 86400e3, '7d': 7 * 86400e3 }[range];
    const step = { '1h': 60e3, '24h': 5 * 60e3, '7d': 30 * 60e3 }[range];
    const buckets = new Map();
    for (const [t, h] of history.minutes) {
      if (t < now - span) continue;
      const k = Math.floor(t / step) * step;
      const b = buckets.get(k) || [0, 0];
      b[0] += h; b[1] += 1; buckets.set(k, b);
    }
    return { range, span, step, points: [...buckets].sort((a, b) => a[0] - b[0]).map(([t, [s, n]]) => [t, s / n]) };
  }
  return { range: 'earn', points: history.earn };
}

// ---------- HTTP ----------

const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

function send(res, code, body, type = 'application/json') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 1e5) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch { resolve({}); } });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const route = url.pathname;

  // Only accept requests from this machine's own pages.
  if (req.method === 'POST') {
    const origin = req.headers.origin;
    if (origin && origin !== `http://127.0.0.1:${PORT}` && origin !== `http://localhost:${PORT}`) return send(res, 403, { error: 'forbidden' });
  }

  try {
    if (route === '/api/state') return send(res, 200, buildState());
    if (route === '/api/history') return send(res, 200, historyFor(url.searchParams.get('range') || '1h'));
    if (route === '/api/log') {
      const since = Number(url.searchParams.get('since') || 0);
      return send(res, 200, { seq: logSeq, lines: log.filter((l) => l.seq > since) });
    }
    if (req.method === 'POST' && route === '/api/start') { if (tune.active) return send(res, 409, { error: 'Auto-tune is running' }); startMiner(); return send(res, 200, { ok: true }); }
    if (req.method === 'POST' && route === '/api/stop') { tune.active = false; await stopMiner(); return send(res, 200, { ok: true }); }
    if (req.method === 'POST' && route === '/api/setup') { await ensureXmrig(); return send(res, 200, setup); }
    if (req.method === 'POST' && route === '/api/autotune') { runAutotune(); return send(res, 200, { ok: true }); }
    if (req.method === 'POST' && route === '/api/autotune/cancel') { tune.active = false; return send(res, 200, { ok: true }); }
    if (req.method === 'POST' && route === '/api/settings') {
      const body = await readBody(req);
      const errors = {};
      if (body.address !== undefined) {
        const a = String(body.address).trim();
        if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a)) settings.address = a; else errors.address = 'That does not look like a Solana address.';
      }
      if (body.worker !== undefined) {
        const w = String(body.worker).trim();
        if (/^[A-Za-z0-9_-]{1,24}$/.test(w)) settings.worker = w; else errors.worker = 'Letters, numbers, - and _ only (max 24).';
      }
      if (body.threads !== undefined) settings.threads = body.threads === null ? null : Math.min(system.logical, Math.max(1, Number(body.threads) | 0));
      if (body.mode === 'balanced' || body.mode === 'max') settings.mode = body.mode;
      if (typeof body.autostart === 'boolean') settings.autostart = body.autostart;
      saveAll();
      if (Object.keys(errors).length) return send(res, 400, { errors });
      if ('address' in body) { pool.uuidFor = null; refreshPool(); }
      const needsRestart = miner.proc && ['threads', 'mode', 'address', 'worker'].some((k) => k in body);
      if (needsRestart && !tune.active) restartMiner();
      return send(res, 200, { ok: true, restarted: !!needsRestart });
    }

    // static files
    const file = path.normalize(path.join(PUBLIC, route === '/' ? 'index.html' : route));
    if (!file.startsWith(PUBLIC)) return send(res, 404, 'Not found', 'text/plain');
    fs.readFile(file, (err, buf) => {
      if (err) return send(res, 404, 'Not found', 'text/plain');
      send(res, 200, buf, TYPES[path.extname(file)] || 'application/octet-stream');
    });
  } catch (err) {
    send(res, 500, { error: err.message });
  }
});

const ready = new Promise((resolve, reject) => {
  // When Kiln restarts itself as administrator, the old copy may still hold the port for a moment.
  let attempts = 0;
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE' && ++attempts < 20) setTimeout(() => server.listen(PORT, '127.0.0.1'), 500);
    else reject(err);
  });
  server.listen(PORT, '127.0.0.1', () => {
    if (!process.env.KILN_QUIET) console.log(`Kiln dashboard running at http://127.0.0.1:${PORT}`);
    if (settings.autostart) startMiner(); else ensureXmrig();
    if (process.argv.includes('--open')) {
      const target = `http://127.0.0.1:${PORT}`;
      if (IS_WIN) execFile('cmd', ['/c', 'start', '', target], { windowsHide: true });
      else execFile(process.platform === 'darwin' ? 'open' : 'xdg-open', [target], () => {});
    }
    resolve(`http://127.0.0.1:${PORT}`);
  });
});

let shuttingDown = null;
function shutdown() {
  if (shuttingDown) return shuttingDown;
  tune.active = false;
  shuttingDown = stopMiner().then(() => { saveAll(); server.close(); });
  return shuttingDown;
}

// Used by the desktop app (main.js) for the tray menu.
module.exports = {
  ready,
  shutdown,
  isMining: () => !!miner.proc,
  status: () => ({ status: miner.status, hashrate: miner.summary?.hashrate?.total?.[0] ?? null, elevated: system.elevated }),
  start: () => startMiner(),
  stop: () => { tune.active = false; return stopMiner(); },
};

if (require.main === module) {
  process.on('SIGINT', () => shutdown().then(() => process.exit(0)));
  process.on('SIGTERM', () => shutdown().then(() => process.exit(0)));
}
process.on('exit', () => { if (miner.proc) miner.proc.kill(); });
