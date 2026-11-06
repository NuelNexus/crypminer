'use strict';

const $ = (id) => document.getElementById(id);
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

let state = null;
let stateAt = 0;
let range = '1h';
let historyData = null;
let logSeq = 0;
let logLines = [];
let hover = null;

// ---------- formatting ----------

const nf0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

function fmtHash(h) {
  if (h == null) return { v: '—', u: 'H/s' };
  if (h >= 1e6) return { v: (h / 1e6).toFixed(2), u: 'MH/s' };
  if (h >= 1e4) return { v: (h / 1e3).toFixed(2), u: 'kH/s' };
  return { v: nf0.format(h), u: 'H/s' };
}
const hashText = (h) => { const f = fmtHash(h); return f.v === '—' ? '—' : `${f.v} ${f.u}`; };

function fmtCount(n) {
  if (!n) return '0';
  const units = ['', 'k', 'M', 'G', 'T', 'P'];
  let i = 0;
  while (n >= 1000 && i < units.length - 1) { n /= 1000; i++; }
  return (i ? n.toFixed(n < 10 ? 2 : 1) : nf0.format(n)) + units[i];
}

function fmtDur(sec) {
  if (sec == null || !isFinite(sec)) return '—';
  sec = Math.max(0, Math.floor(sec));
  const d = Math.floor(sec / 86400), h = Math.floor(sec % 86400 / 3600), m = Math.floor(sec % 3600 / 60), s = sec % 60;
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s}s`;
  return `${s}s`;
}

const coin = (x, dp = 6) => (x == null || isNaN(x) ? '—' : Number(x).toFixed(dp));
const usd = (x, dp = 2) => (x == null || isNaN(x) ? '—' : '$' + Number(x).toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp }));
const clock = (t) => new Date(t).toLocaleTimeString('en-GB', { hour12: false });

// ---------- API ----------

async function api(path, body) {
  const res = await fetch(path, body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error('Request failed'), { data: json });
  return json;
}

async function pollState() {
  try {
    state = await api('/api/state');
    stateAt = performance.now();
    render();
  } catch {
    $('statusLabel').textContent = 'Dashboard offline';
    $('status').dataset.state = 'crashed';
    $('statusMeta').textContent = 'is the Kiln window still open?';
  }
}

async function pollLog() {
  try {
    const r = await api('/api/log?since=' + logSeq);
    if (r.seq < logSeq) { logLines = []; } // server restarted
    logSeq = r.seq;
    if (r.lines.length) { logLines.push(...r.lines); logLines = logLines.slice(-800); renderLog(); }
  } catch { /* offline */ }
}

async function loadHistory() {
  try { historyData = await api('/api/history?range=' + range); drawHistory(); } catch { /* offline */ }
}

// ---------- rendering ----------

function render() {
  const s = state, m = s.miner, e = s.earnings;
  const running = m.status === 'running' || m.status === 'starting';

  // status
  const st = $('status');
  const labels = { running: 'Mining', starting: 'Starting', stopping: 'Stopping', stopped: 'Idle', crashed: 'Stopped unexpectedly' };
  st.dataset.state = s.tune.active ? 'tuning' : m.status;
  $('statusLabel').textContent = s.tune.active ? `Auto-tuning · ${s.tune.step}/${s.tune.steps}` : labels[m.status];
  $('statusMeta').textContent = m.status === 'running' && m.uptime != null ? fmtDur(m.uptime) : (m.status === 'starting' ? 'building dataset' : '');

  const tg = $('toggle');
  tg.dataset.action = running || m.status === 'stopping' ? 'stop' : 'start';
  $('toggleLabel').textContent = tg.dataset.action === 'stop' ? 'Stop' : 'Start mining';
  tg.disabled = m.status === 'stopping' || (!s.setup.ready && s.setup.blocked && tg.dataset.action === 'start' && false);

  $('routeLine').textContent = `XMRig → unMineable → ${e.coin} · ${s.settings.worker}`;

  // setup notice
  const needSetup = !s.setup.ready && (s.setup.blocked || s.setup.error);
  $('setupNotice').hidden = !needSetup;
  if (needSetup) {
    $('setupFolder').textContent = s.setup.folder;
    $('setupTitle').textContent = s.setup.blocked ? 'Windows Defender is blocking XMRig' : 'XMRig is not set up yet';
    if (!s.setup.blocked) $('setupText').textContent = s.setup.error || '';
  }

  // hashrate
  const hr = fmtHash(m.hashrate.s10);
  $('hrValue').textContent = running ? hr.v : '0';
  $('hrUnit').textContent = hr.u;
  $('hr60').textContent = hashText(m.hashrate.m1);
  $('hr15').textContent = hashText(m.hashrate.m15);
  $('hrPeak').textContent = hashText(m.hashrate.highest);
  $('hrThreads').textContent = running ? `${m.threads} of ${s.system.logical}` : `${s.settings.threads} of ${s.system.logical}`;

  // earnings
  $('earnCoin').textContent = e.coin;
  $('poolBalance').textContent = e.balance == null ? '—' : `${coin(e.balance, 6)} ${e.coin}`;
  $('threshold').textContent = `${coin(e.threshold, 2)} ${e.coin}`;
  $('thresholdText').textContent = `${coin(e.threshold, 2)} ${e.coin}`;
  const pct = e.balance != null && e.threshold ? Math.min(1, e.balance / e.threshold) : 0;
  $('rulerFill').style.width = (pct * 100).toFixed(2) + '%';
  $('payoutPct').textContent = (pct * 100).toFixed(pct < 0.1 ? 2 : 1) + '% of payout';
  if (e.perDay && running) {
    const days = Math.max(0, (e.threshold - (e.balance || 0)) / e.perDay);
    $('payoutEta').textContent = days < 1 ? `≈ ${fmtDur(days * 86400)} to payout` : `≈ ${nf1.format(days)} days to payout at this speed`;
  } else {
    $('payoutEta').textContent = running ? 'estimating…' : 'paused';
  }
  $('perDay').textContent = e.perDay == null ? '—' : `${coin(e.perDay, 6)} ${e.coin}`;
  $('perDayUsd').textContent = e.perDayUsd == null ? '' : `${usd(e.perDayUsd, 3)} / day · ${usd(e.perDayUsd * 30, 2)} / month`;
  $('past24').textContent = e.past24h == null ? '—' : `${coin(e.past24h, 6)}`;
  $('past7').textContent = e.past7d == null ? '—' : `${coin(e.past7d, 6)}`;
  $('paid').textContent = e.paid == null ? '—' : `${coin(e.paid, 4)} ${e.coin}`;

  // metric strip
  const sh = m.shares;
  const rejected = sh.total - sh.good;
  $('shares').innerHTML = running || sh.total ? `${sh.good}<span class="${rejected ? 'bad' : ''}" style="color:var(--ink-4)">/${sh.total}</span>` : '—';
  $('sharesNote').textContent = rejected ? `${rejected} rejected` : (sh.avgTime ? `one every ${fmtDur(sh.avgTime)}` : 'accepted / sent');
  $('ping').textContent = m.pool.ping && running ? `${m.pool.ping} ms` : '—';
  $('poolHost').textContent = (m.pool.url || '').replace(/:\d+$/, '') + (m.pool.tls ? ' · TLS' : '');
  $('cpuLoad').textContent = Math.round(s.system.load * 100) + '%';
  $('cpuName').textContent = s.system.cpuName.replace(/\(R\)|\(TM\)|CPU|@.*$/g, '').replace(/\s+/g, ' ').trim();
  $('session').textContent = running && m.uptime != null ? fmtDur(m.uptime) : '—';
  $('sessionHashes').textContent = `${fmtCount(m.sessionHashes)} hashes`;
  $('lifetime').textContent = fmtDur(s.totals.seconds);
  $('lifetimeHashes').textContent = `${fmtCount(s.totals.hashes)} hashes · ${s.totals.sessions} runs`;
  $('solPrice').textContent = usd(s.market.solUsd, 2);
  $('xmrPrice').textContent = s.market.xmrUsd ? `XMR ${usd(s.market.xmrUsd, 2)}` : '—';

  renderTuning();
  renderPayments();
  drawStrip();
  $('historyEmpty').hidden = !!(historyData && historyData.points.length > 1);
}

function affinityFor(n, sys) {
  const ht = sys.logical === sys.physical * 2, list = [];
  for (let i = 0; i < n; i++) list.push(!ht ? i : i < sys.physical ? i * 2 : (i - sys.physical) * 2 + 1);
  return list;
}

let pendingThreads = null;
function renderTuning() {
  const s = state, sys = s.system, m = s.miner;
  const threads = pendingThreads ?? s.settings.threads;
  $('thrValue').textContent = threads;
  $('thrDown').disabled = threads <= 1 || s.tune.active;
  $('thrUp').disabled = threads >= sys.logical || s.tune.active;
  $('cpuSpec').textContent = `${sys.physical} cores · ${sys.logical} threads${sys.l3MB ? ` · ${sys.l3MB} MB L3` : ''}`;
  $('threadsHelp').textContent = threads > sys.recommended
    ? `More than ${sys.recommended} usually makes RandomX slower: each thread needs 2 MB of L3 cache.`
    : threads === sys.recommended ? `${sys.recommended} is the best fit for your cache. One thread per physical core.` : `Using ${threads} of ${sys.recommended} recommended. Lower = cooler and quieter.`;

  // core map
  const map = $('coremap');
  const perCore = sys.logical / sys.physical;
  if (map.childElementCount !== sys.physical) {
    map.innerHTML = '';
    for (let c = 0; c < sys.physical; c++) {
      const core = document.createElement('div');
      core.className = 'core';
      for (let k = 0; k < perCore; k++) {
        const id = perCore === 2 ? c * 2 + k : c * perCore + k;
        core.insertAdjacentHTML('beforeend', `<div class="lcpu" data-id="${id}"><div class="bar"></div><span class="id">${id}</span></div>`);
      }
      map.appendChild(core);
    }
  }
  const live = m.status === 'running';
  const aff = affinityFor(live ? m.threads : threads, sys);
  const rates = m.threadRates || [];
  const maxRate = Math.max(1, ...rates);
  map.querySelectorAll('.lcpu').forEach((el) => {
    const id = Number(el.dataset.id);
    const idx = aff.indexOf(id);
    el.classList.toggle('on', idx >= 0);
    el.classList.toggle('live', live && idx >= 0);
    const r = live && idx >= 0 ? rates[idx] || 0 : 0;
    el.querySelector('.bar').style.height = (idx >= 0 ? (live ? Math.max(6, (r / maxRate) * 100) : 100) : 0) + '%';
    el.querySelector('.bar').style.opacity = live ? 1 : 0.35;
    el.title = idx >= 0 ? `CPU ${id}: ${live ? hashText(r) : 'will mine'}` : `CPU ${id}: free`;
  });

  // mode
  document.querySelectorAll('#modeSeg button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === s.settings.mode)));
  $('modeHelp').textContent = s.settings.mode === 'max'
    ? 'High priority, no yielding. A few % faster, but the laptop gets sluggish and hot.'
    : 'Low priority, gives the CPU back to apps you use. Recommended on a laptop.';

  // auto-tune
  const t = s.tune;
  $('tuneBtn').textContent = t.active ? 'Cancel' : 'Run auto-tune';
  $('tuneHelp').textContent = t.active
    ? `Testing ${t.current} thread${t.current > 1 ? 's' : ''} — ${t.phase === 'warmup' ? 'warming up' : 'measuring'} (${t.step} of ${t.steps}). Mining continues the whole time.`
    : 'Mines with different thread counts for about a minute each and keeps the fastest.';
  const best = t.results.length ? t.results.reduce((a, b) => (b.hashrate > a.hashrate ? b : a)) : null;
  $('tuneResults').innerHTML = t.results.map((r) => `<span class="${r === best && !t.active ? 'best' : ''}">${r.threads}t · ${nf0.format(r.hashrate)} H/s</span>`).join('')
    + (t.active && t.current ? `<span class="now">${t.current}t · …</span>` : '');

  // optimisation checklist
  const hp = m.hugepages;
  const items = [
    { ok: true, what: 'RandomX fast mode', why: '2 GB dataset kept in RAM instead of recomputed', gain: '≈8× vs light' },
    { ok: true, what: 'Threads pinned to physical cores', why: 'Stops threads sharing a core when they don\'t need to', gain: '' },
    { ok: threads <= sys.recommended, what: threads <= sys.recommended ? 'Thread count fits L3 cache' : 'Too many threads for L3 cache', why: `${sys.l3MB || '?'} MB L3 ÷ 2 MB per thread = ${sys.recommended} threads`, gain: '' },
    !live ? { ok: null, what: 'Huge pages', why: 'Checked when mining starts', gain: 'up to +50%' }
      : hp && hp[1] > 0 && hp[0] === hp[1] ? { ok: true, what: 'Huge pages enabled', why: `${hp[0]}/${hp[1]} pages`, gain: '' }
      : { ok: false, what: `Huge pages off${hp ? ` (${hp[0]}/${hp[1]})` : ''}`, why: sys.elevated ? 'Privilege granted — sign out of Windows and back in, then restart mining' : 'Restart Kiln as administrator once, then sign out of Windows and back in', gain: 'up to +50%' },
    !live || m.msr === 'unknown' ? { ok: null, what: 'MSR prefetcher tweak', why: sys.elevated ? 'Checked when mining starts' : 'Needs administrator rights', gain: '+10–15%' }
      : m.msr === 'ok' ? { ok: true, what: 'MSR prefetcher tweak applied', why: 'Intel preset set by XMRig', gain: '' }
      : { ok: false, what: 'MSR prefetcher tweak not applied', why: 'Restart Kiln as administrator to apply it', gain: '+10–15%' },
  ];
  const icon = (ok) => ok === true
    ? '<svg class="ic ok" viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>'
    : ok === false ? '<svg class="ic no" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5M12 16.5v.01"/></svg>'
    : '<svg class="ic" viewBox="0 0 24 24" style="color:var(--ink-4)"><circle cx="12" cy="12" r="9"/></svg>';
  $('elevateRow').hidden = sys.elevated;
  $('elevateBtn').hidden = !window.kiln;
  $('elevateText').textContent = window.kiln
    ? 'Huge pages and the MSR tweak need administrator rights. Kiln restarts and keeps mining.'
    : 'Huge pages and the MSR tweak need administrator rights. Open the Kiln app as administrator.';
  $('checks').innerHTML = items.map((i) => `<li>${icon(i.ok)}<span><span class="what">${i.what}</span><span class="why">${i.why}</span></span><span class="gain">${i.ok === true ? '' : i.gain}</span></li>`).join('');
}

function renderPayments() {
  const e = state.earnings;
  $('explorerLink').href = e.explorer;
  $('paymentsBody').innerHTML = e.payments.map((p) => {
    const t = p.timestamp || p.date || p.created_at;
    const date = t ? new Date(typeof t === 'number' && t < 1e12 ? t * 1000 : t).toLocaleDateString() : '—';
    const status = p.tx ? `<a class="head-link" href="https://solscan.io/tx/${encodeURIComponent(p.tx)}" target="_blank" rel="noreferrer">sent ↗</a>` : (p.status || 'pending');
    return `<tr><td>${date}</td><td class="num">${coin(p.amount, 6)}</td><td>${status}</td></tr>`;
  }).join('');
  $('paymentsEmpty').hidden = e.payments.length > 0;
  $('poolUpdated').textContent = e.poolError
    ? `unMineable unreachable: ${e.poolError}`
    : e.poolUpdated ? `Pool data updated ${clock(e.poolUpdated)} · ${e.fee}% pool fee · unMineable updates balances every few hours` : 'Loading pool data…';
}

// ---------- earned counter (runs every frame) ----------

function tickEarned() {
  requestAnimationFrame(tickEarned);
  if (!state) return;
  const e = state.earnings, m = state.miner;
  let value = 0;
  if (e.perHash != null) {
    value = state.totals.hashes * e.perHash;
    const rate = m.status === 'running' ? (m.hashrate.s10 || 0) : 0;
    value += rate * e.perHash * Math.min(4, (performance.now() - stateAt) / 1000);
  }
  const str = value.toFixed(9);
  const cut = str.length - 4;
  const el = $('earnValue');
  const html = `${str.slice(0, cut)}<span class="tail">${str.slice(cut)}</span>`;
  if (el.innerHTML !== html) el.innerHTML = html;
  const usdVal = state.market.solUsd ? value * state.market.solUsd : 0;
  $('earnUsd').textContent = '$' + usdVal.toFixed(usdVal < 1 ? 5 : 2);
}

// ---------- charts ----------

function setupCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}

function niceMax(v) {
  if (v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 2, 4, 6, 8, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

function drawSeries(canvas, pts, opts) {
  const { ctx, w, h } = setupCanvas(canvas);
  const padL = opts.padL ?? 0, padR = opts.padR ?? 56, padT = 10, padB = opts.padB ?? 6;
  const iw = w - padL - padR, ih = h - padT - padB;
  const ymax = niceMax(Math.max(opts.minY || 0, ...pts.map((p) => p[1])) * 1.12);
  const x = (t) => padL + ((t - opts.x0) / (opts.x1 - opts.x0)) * iw;
  const y = (v) => padT + ih - (v / ymax) * ih;

  // grid
  ctx.font = '400 11px "Geist Mono", monospace';
  ctx.textBaseline = 'middle';
  for (let i = 0; i <= 4; i++) {
    const v = (ymax / 4) * i, yy = Math.round(y(v)) + 0.5;
    ctx.strokeStyle = i === 0 ? css('--rule-strong') : css('--rule');
    ctx.lineWidth = 1;
    ctx.setLineDash([]);
    ctx.beginPath(); ctx.moveTo(padL, yy); ctx.lineTo(padL + iw, yy); ctx.stroke();
    if (i > 0) { ctx.fillStyle = css('--ink-3'); ctx.fillText(opts.yFmt(v), padL + iw + 10, yy); }
  }
  ctx.setLineDash([]);

  if (opts.xTicks) {
    ctx.fillStyle = css('--ink-4'); ctx.textBaseline = 'top'; ctx.textAlign = 'center';
    for (const [t, label] of opts.xTicks) {
      const xx = x(t);
      if (xx < padL + 20 || xx > padL + iw - 20) continue;
      ctx.fillText(label, xx, padT + ih + 8);
    }
    ctx.textAlign = 'left';
  }

  if (pts.length < 2) return { x, y, pts };

  // area
  const grad = ctx.createLinearGradient(0, padT, 0, padT + ih);
  grad.addColorStop(0, 'rgba(17,20,19,0.10)');
  grad.addColorStop(1, 'rgba(17,20,19,0)');
  ctx.beginPath();
  ctx.moveTo(x(pts[0][0]), y(0));
  pts.forEach((p) => ctx.lineTo(x(p[0]), y(p[1])));
  ctx.lineTo(x(pts[pts.length - 1][0]), y(0));
  ctx.closePath();
  ctx.fillStyle = grad; ctx.fill();

  // line
  ctx.beginPath();
  pts.forEach((p, i) => (i ? ctx.lineTo(x(p[0]), y(p[1])) : ctx.moveTo(x(p[0]), y(p[1]))));
  ctx.strokeStyle = css('--ink'); ctx.lineWidth = 1.6; ctx.lineJoin = 'round'; ctx.stroke();

  // live head
  if (opts.liveHead) {
    const last = pts[pts.length - 1];
    const lx = x(last[0]), ly = y(last[1]);
    ctx.fillStyle = css('--signal');
    ctx.beginPath(); ctx.arc(lx, ly, 3.5, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = 'rgba(255,77,18,0.25)'; ctx.lineWidth = 6;
    ctx.beginPath(); ctx.arc(lx, ly, 6, 0, Math.PI * 2); ctx.stroke();
  }

  // hover
  if (opts.hoverIdx != null && pts[opts.hoverIdx]) {
    const p = pts[opts.hoverIdx], hx = x(p[0]), hy = y(p[1]);
    ctx.strokeStyle = css('--ink-3'); ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(Math.round(hx) + 0.5, padT); ctx.lineTo(Math.round(hx) + 0.5, padT + ih); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = css('--paper'); ctx.strokeStyle = css('--ink'); ctx.lineWidth = 1.6;
    ctx.beginPath(); ctx.arc(hx, hy, 4, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  }
  return { x, y, pts };
}

function drawStrip() {
  if (!state) return;
  const now = state.now;
  const live = state.miner.status === 'running';
  drawSeries($('stripChart'), state.live, {
    x0: now - 15 * 60e3, x1: now,
    yFmt: (v) => fmtCount(v),
    minY: 100,
    liveHead: live,
  });
}

let historyGeom = null;
function drawHistory() {
  if (!historyData) return;
  const canvas = $('historyChart');
  const pts = historyData.points;
  const now = Date.now();
  const isEarn = historyData.range === 'earn';
  const x0 = isEarn ? (pts[0]?.[0] ?? now - 86400e3) : now - historyData.span;
  const x1 = isEarn ? Math.max(now, (pts[pts.length - 1]?.[0] ?? now)) : now;

  const ticks = [];
  const span = x1 - x0;
  const step = span <= 2 * 3600e3 ? 15 * 60e3 : span <= 2 * 86400e3 ? 4 * 3600e3 : 86400e3;
  for (let t = Math.ceil(x0 / step) * step; t <= x1; t += step) {
    const d = new Date(t);
    ticks.push([t, step >= 86400e3 ? d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })]);
  }

  historyGeom = drawSeries(canvas, pts, {
    x0, x1, padB: 26, xTicks: ticks,
    yFmt: isEarn ? (v) => v.toFixed(v < 0.001 ? 6 : 4) : (v) => fmtCount(v),
    minY: isEarn ? 1e-6 : 100,
    hoverIdx: hover,
  });
  $('historyEmpty').hidden = pts.length > 1;
  $('historyEmpty').textContent = isEarn ? 'Earnings appear here once unMineable credits your first share.' : 'Start mining to collect history.';
}

$('historyChart').addEventListener('mousemove', (ev) => {
  if (!historyGeom || !historyData?.points.length) return;
  const rect = ev.currentTarget.getBoundingClientRect();
  const mx = ev.clientX - rect.left;
  let best = 0, bd = Infinity;
  historyData.points.forEach((p, i) => { const d = Math.abs(historyGeom.x(p[0]) - mx); if (d < bd) { bd = d; best = i; } });
  hover = best;
  drawHistory();
  const p = historyData.points[best];
  const tip = $('tooltip');
  const isEarn = historyData.range === 'earn';
  tip.innerHTML = `${isEarn ? coin(p[1], 8) + ' ' + state.earnings.coin : hashText(p[1])}<small>${new Date(p[0]).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</small>`;
  tip.style.left = historyGeom.x(p[0]) + 'px';
  tip.style.top = historyGeom.y(p[1]) + 'px';
  tip.hidden = false;
});
$('historyChart').addEventListener('mouseleave', () => { hover = null; $('tooltip').hidden = true; drawHistory(); });

// ---------- log ----------

function renderLog() {
  const el = $('log');
  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 30;
  const hide = $('hideJobs').checked;
  const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  el.innerHTML = logLines
    .filter((l) => !(hide && l.level === 'dim'))
    .map((l) => {
      const text = l.text.replace(/^\[\d{4}-\d\d-\d\d [\d:.]+\]\s*/, '');
      const cls = l.source === 'kiln' ? 'kiln' : l.level;
      return `<span class="t">${clock(l.t)}</span><span class="${cls}">${esc(text)}</span>`;
    }).join('\n') || '<span class="dim">Nothing yet. Press Start mining.</span>';
  if (atBottom) el.scrollTop = el.scrollHeight;
}
$('hideJobs').addEventListener('change', renderLog);

// ---------- controls ----------

$('toggle').addEventListener('click', async () => {
  const btn = $('toggle');
  btn.disabled = true;
  try { await api(btn.dataset.action === 'stop' ? '/api/stop' : '/api/start', {}); } catch { /* shown via state */ }
  btn.disabled = false;
  pollState();
});

$('recheck').addEventListener('click', async () => {
  $('recheck').disabled = true;
  $('recheck').textContent = 'Checking…';
  try { await api('/api/setup', {}); } catch { /* */ }
  $('recheck').disabled = false;
  $('recheck').textContent = 'Check again';
  pollState();
});

let threadTimer = null;
function nudgeThreads(d) {
  const sys = state.system;
  pendingThreads = Math.min(sys.logical, Math.max(1, (pendingThreads ?? state.settings.threads) + d));
  renderTuning();
  clearTimeout(threadTimer);
  threadTimer = setTimeout(async () => {
    try { await api('/api/settings', { threads: pendingThreads }); } catch { /* */ }
    pendingThreads = null;
    pollState();
  }, 700);
}
$('thrDown').addEventListener('click', () => nudgeThreads(-1));
$('thrUp').addEventListener('click', () => nudgeThreads(1));

$('modeSeg').addEventListener('click', async (ev) => {
  const b = ev.target.closest('button');
  if (!b || b.dataset.mode === state.settings.mode) return;
  await api('/api/settings', { mode: b.dataset.mode }).catch(() => {});
  pollState();
});

$('tuneBtn').addEventListener('click', async () => {
  await api(state.tune.active ? '/api/autotune/cancel' : '/api/autotune', {}).catch(() => {});
  pollState();
});

$('rangeSeg').addEventListener('click', (ev) => {
  const b = ev.target.closest('button');
  if (!b) return;
  range = b.dataset.range;
  document.querySelectorAll('#rangeSeg button').forEach((x) => x.setAttribute('aria-selected', String(x === b)));
  hover = null;
  loadHistory();
});

// settings dialog
const dlg = $('settingsDialog');
$('openSettings').addEventListener('click', () => {
  $('sAddress').value = state?.settings.address || '';
  $('sWorker').value = state?.settings.worker || '';
  $('sAutostart').checked = !!state?.settings.autostart;
  dlg.querySelectorAll('.err').forEach((e) => (e.textContent = ''));
  dlg.showModal();
});
$('settingsForm').addEventListener('submit', async (ev) => {
  if (ev.submitter?.value !== 'save') return;
  ev.preventDefault();
  try {
    await api('/api/settings', { address: $('sAddress').value, worker: $('sWorker').value, autostart: $('sAutostart').checked });
    dlg.close();
    pollState();
  } catch (err) {
    const errors = err.data?.errors || {};
    dlg.querySelectorAll('.err').forEach((e) => (e.textContent = errors[e.dataset.err] || ''));
  }
});

window.addEventListener('resize', () => { drawStrip(); drawHistory(); });

// ---------- desktop app ----------

if (window.kiln) {
  document.documentElement.classList.add('is-app');
  $('elevateBtn').addEventListener('click', async () => {
    $('elevateBtn').disabled = true;
    $('elevateBtn').textContent = 'Waiting for Windows…';
    try { await window.kiln.elevate(); } catch { /* declined */ }
    setTimeout(() => { $('elevateBtn').disabled = false; $('elevateBtn').textContent = 'Restart as admin'; }, 4000);
  });
}

// ---------- boot ----------

pollState(); pollLog(); loadHistory();
setInterval(pollState, 2000);
setInterval(pollLog, 2000);
setInterval(loadHistory, 30000);
document.fonts?.ready.then(() => { drawStrip(); drawHistory(); });
requestAnimationFrame(tickEarned);
