/* ============ CONFIG ============ */
const FRED_KEY = 'd7l0aapr01qiqbd006sgd7l0aapr01qiqbd006t0';
const FINNHUB_KEY = '11e6a114597109caf62a4703b0c49a8d';

const STORAGE_KEY = 'macro-dashboard-v1';
const THEME_KEY = 'macro-theme';

// FRED series
const FRED = {
  vix:    'VIXCLS',
  unrate: 'UNRATE',
  dxy:    'DEXUSEU',   // USD/EUR as DXY proxy
};

// CORS proxies — tried in order. Personal Cloudflare Worker is primary (100% reliable).
// Public proxies kept as fallback in case the Worker is temporarily unavailable.
const CORS_PROXIES = [
  // Personal Cloudflare Worker — fast, reliable, unlimited for personal use
  { wrap: (url) => `https://late-morning-be0b.sjk3018.workers.dev/?url=${encodeURIComponent(url)}`, unwrap: 'direct' },
  // Public proxy fallbacks
  { wrap: (url) => `https://api.allorigins.win/get?url=${encodeURIComponent(url)}`, unwrap: 'allorigins' },
  { wrap: (url) => `https://corsproxy.io/?url=${encodeURIComponent(url)}`, unwrap: 'direct' },
  { wrap: (url) => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`, unwrap: 'direct' },
];

// CNN Fear & Greed data endpoint — the one powering their page.
const CNN_FNG_URL = 'https://production.dataviz.cnn.io/index/fearandgreed/graphdata';

/* ============ STATE ============ */
let state = loadState();
let charts = {};
window.charts = charts;

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const s = JSON.parse(raw);
      // Migration: ensure spx exists for users with older saved state
      if (!s.spx) {
        s.spx = { value: null, prev: null, ma200: null, deviation: null, series: [], ma200Series: [], updated: null };
      }
      return s;
    }
  } catch (e) {}
  return {
    fng:    { value: null, prev: null, week: null, rating: null, series: [], updated: null },
    vix:    { value: null, prev: null, series: [], updated: null },
    unrate: { value: null, prev: null, series: [], updated: null },
    wti:    { value: null, prev: null, series: [], updated: null },
    dxy:    { value: null, prev: null, series: [], updated: null },
    spx:    { value: null, prev: null, ma200: null, deviation: null, series: [], ma200Series: [], updated: null },
    lastRefresh: null,
  };
}
function saveState() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) {}
}

/* ============ THEME ============ */
function initTheme() {
  const saved = localStorage.getItem(THEME_KEY);
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const dark = saved ? saved === 'dark' : prefersDark;
  document.body.classList.toggle('dark', dark);
}
document.getElementById('themeBtn').addEventListener('click', () => {
  const isDark = document.body.classList.toggle('dark');
  localStorage.setItem(THEME_KEY, isDark ? 'dark' : 'light');
  // Re-render charts with new colors
  Object.values(charts).forEach(c => c && c.update());
});

/* ============ TABS ============ */
const tabs = document.querySelectorAll('.tab');
const indicator = document.querySelector('.tab-indicator');

function activateTab(name, animate = true) {
  tabs.forEach(t => {
    const active = t.dataset.tab === name;
    t.classList.toggle('active', active);
    if (active) positionIndicator(t);
  });
  document.querySelectorAll('.page').forEach(p => {
    p.classList.toggle('active', p.id === `page-${name}`);
  });
  if (name === 'charts') setTimeout(renderAllCharts, 50);
}
function positionIndicator(tab) {
  const rect = tab.getBoundingClientRect();
  const parent = tab.parentElement.getBoundingClientRect();
  indicator.style.left = (rect.left - parent.left) + 'px';
  indicator.style.width = rect.width + 'px';
}
tabs.forEach(t => t.addEventListener('click', () => activateTab(t.dataset.tab)));
window.addEventListener('resize', () => {
  const active = document.querySelector('.tab.active');
  if (active) positionIndicator(active);
});

/* ============ UTIL ============ */
function fmtNum(v, dec = 2) {
  if (v == null || isNaN(v)) return '—';
  return Number(v).toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec });
}
function fmtPct(v, dec = 2) {
  if (v == null || isNaN(v)) return '—';
  const sign = v > 0 ? '+' : '';
  return `${sign}${v.toFixed(dec)}%`;
}
function changeClass(v) {
  if (v == null || isNaN(v)) return 'flat';
  if (v > 0.01) return 'up';
  if (v < -0.01) return 'down';
  return 'flat';
}
function setChange(el, curr, prev, isBad = false) {
  if (curr == null || prev == null) { el.textContent = '—'; el.className = 'change flat'; return; }
  const diff = curr - prev;
  const pct = (diff / prev) * 100;
  // Direction for arrow (numeric)
  let dir = 'flat';
  if (pct > 0.01) dir = 'up';
  else if (pct < -0.01) dir = 'down';
  // Color from investor perspective
  // Default: up=green, down=red. isBad inverts so VIX/unemployment rise is red.
  let color = dir;
  if (isBad) color = dir === 'up' ? 'down' : (dir === 'down' ? 'up' : 'flat');
  el.className = `change dir-${dir} color-${color}`;
  el.textContent = `${fmtPct(pct)} (${diff > 0 ? '+' : ''}${fmtNum(diff, 2)})`;
}
function setStatus(id, status) {
  const el = document.getElementById(`status-${id}`);
  if (el) el.className = `status-dot ${status}`;
}
function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => t.classList.remove('show'), 2500);
}

async function fetchWithTimeout(url, ms = 8000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctrl.signal, cache: 'no-store' });
    return r;
  } finally { clearTimeout(timer); }
}

async function fetchViaProxies(url, options = {}) {
  const { textMode = false } = options;
  // Try direct first (works for CORS-enabled endpoints like Stooq, Yahoo)
  try {
    const r = await fetchWithTimeout(url, 5000);
    if (r.ok) return textMode ? await r.text() : await r.json();
  } catch (e) {}
  // Try each proxy with its specific unwrap logic
  for (const { wrap, unwrap } of CORS_PROXIES) {
    try {
      const proxied = wrap(url);
      const r = await fetchWithTimeout(proxied, 12000);
      if (!r.ok) continue;
      const text = await r.text();
      if (unwrap === 'allorigins') {
        // allorigins /get returns {contents: "raw body", status: {...}}
        try {
          const envelope = JSON.parse(text);
          if (envelope && envelope.contents) {
            if (textMode) return envelope.contents;
            try { return JSON.parse(envelope.contents); } catch {}
          }
        } catch {}
      } else {
        // direct: body is the raw response
        if (textMode) return text;
        try { return JSON.parse(text); } catch {}
      }
    } catch (e) {}
  }
  throw new Error('All proxies failed');
}

/* ============ DATA FETCHERS ============ */

// --- Yahoo Finance: CORS-friendly, no API key, reliable ---
// Chart endpoint returns OHLC data for any symbol
async function fetchYahoo(symbol, range = '1y', interval = '1d') {
  // Yahoo Finance query1 endpoint supports CORS
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}`;
  let data;
  try {
    // Try direct first — Yahoo allows CORS
    const r = await fetchWithTimeout(url, 8000);
    if (r.ok) data = await r.json();
  } catch (e) {}
  // Fallback: try via proxies if direct fails
  if (!data) {
    data = await fetchViaProxies(url);
  }
  if (!data || !data.chart || !data.chart.result || !data.chart.result[0]) {
    throw new Error('bad yahoo payload');
  }
  const result = data.chart.result[0];
  const timestamps = result.timestamp || [];
  const closes = (result.indicators && result.indicators.quote && result.indicators.quote[0] && result.indicators.quote[0].close) || [];
  const series = [];
  for (let i = 0; i < timestamps.length; i++) {
    const c = closes[i];
    if (c != null && !isNaN(c)) {
      series.push({
        date: new Date(timestamps[i] * 1000).toISOString().slice(0, 10),
        value: +c.toFixed(4),
      });
    }
  }
  if (!series.length) throw new Error('yahoo no data');
  return series;
}

// --- Stooq: CORS-friendly fallback, no API key ---
async function fetchStooq(symbol, days = 260) {
  const url = `https://stooq.com/q/d/l/?s=${symbol}&i=d`;
  const text = await fetchViaProxies(url, { textMode: true });
  if (!text || typeof text !== 'string') throw new Error('bad stooq text');
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) throw new Error('stooq empty');
  const header = lines[0].toLowerCase();
  if (!header.includes('date') || !header.includes('close')) throw new Error('stooq bad header');
  const cols = header.split(',');
  const iDate = cols.indexOf('date');
  const iClose = cols.indexOf('close');
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(',');
    const d = parts[iDate];
    const c = parseFloat(parts[iClose]);
    if (d && !isNaN(c)) rows.push({ date: d, value: c });
  }
  if (!rows.length) throw new Error('stooq no data');
  return rows.slice(-days);
}

// --- FRED (needs proxy) ---
async function fetchFRED(seriesId, limit = 260) {
  const url = `https://api.stlouisfed.org/fred/series/observations?series_id=${seriesId}&api_key=${FRED_KEY}&file_type=json&sort_order=desc&limit=${limit}`;
  const data = await fetchViaProxies(url);
  if (!data || !data.observations) throw new Error('bad FRED payload');
  const clean = data.observations
    .filter(o => o.value && o.value !== '.')
    .map(o => ({ date: o.date, value: parseFloat(o.value) }))
    .reverse();
  return clean;
}

// Multi-source fetcher: Yahoo → Stooq → FRED
async function fetchMultiSource(yahooSymbol, stooqSymbol, fredSeriesId) {
  const errors = [];
  try {
    const s = await fetchYahoo(yahooSymbol);
    if (s && s.length > 1) return { source: 'yahoo', data: s };
  } catch (e) { errors.push('yahoo: ' + e.message); }
  try {
    const s = await fetchStooq(stooqSymbol);
    if (s && s.length > 1) return { source: 'stooq', data: s };
  } catch (e) { errors.push('stooq: ' + e.message); }
  try {
    const s = await fetchFRED(fredSeriesId);
    if (s && s.length > 1) return { source: 'fred', data: s };
  } catch (e) { errors.push('fred: ' + e.message); }
  throw new Error('all sources failed: ' + errors.join(' | '));
}

// --- CNN Fear & Greed ---
async function fetchFNG() {
  const data = await fetchViaProxies(CNN_FNG_URL);
  if (!data || !data.fear_and_greed) throw new Error('bad fng payload');
  const fg = data.fear_and_greed;
  const hist = (data.fear_and_greed_historical && data.fear_and_greed_historical.data) || [];
  const series = hist
    .filter(pt => pt && pt.x != null && pt.y != null)
    .map(pt => ({
      date: new Date(pt.x).toISOString().slice(0, 10),
      value: Math.round(pt.y),
    }));

  // Helper to extract a possibly-nested score number
  const pick = (v) => {
    if (v == null) return null;
    if (typeof v === 'number') return Math.round(v);
    if (typeof v === 'object' && typeof v.score === 'number') return Math.round(v.score);
    return null;
  };

  return {
    value: pick(fg.score),
    rating: fg.rating || null,
    prev: pick(fg.previous_close) ?? pick(fg.previous_1_day),
    week: pick(fg.previous_1_week),
    series,
  };
}

/* ============ UI RENDER — PAGE 1 ============ */

function renderFNG() {
  const s = state.fng;
  const v = s.value;
  const hasValue = v != null && !isNaN(v);

  document.getElementById('fngValue').textContent = hasValue ? v : '—';
  document.getElementById('fngRating').textContent = s.rating ? translateRating(s.rating) : (hasValue ? ratingFromScore(v) : '—');
  document.getElementById('fngPrev').textContent = s.prev != null ? `전일 ${s.prev}` : '전일 —';
  document.getElementById('fngWeek').textContent = s.week != null ? `1주 ${s.week}` : '1주 —';

  // Arc stroke-dashoffset: 100 = empty, 0 = full (pathLength=100 means simple mapping)
  const arc = document.getElementById('fngArc');
  const needle = document.getElementById('fngNeedle');
  if (hasValue) {
    const pct = Math.max(0, Math.min(100, v));
    arc.style.strokeDashoffset = 100 - pct;
    // Needle angle: -90deg (left) at 0, 0deg (up) at 50, +90deg (right) at 100
    const angle = -90 + (pct / 100) * 180;
    needle.setAttribute('transform', `translate(100 100) rotate(${angle})`);
  }
}

function translateRating(r) {
  if (!r) return '—';
  const m = {
    'extreme fear': '극단적 공포',
    'fear': '공포',
    'neutral': '중립',
    'greed': '탐욕',
    'extreme greed': '극단적 탐욕',
  };
  return m[r.toLowerCase()] || r;
}
function ratingFromScore(v) {
  if (v < 25) return '극단적 공포';
  if (v < 45) return '공포';
  if (v < 55) return '중립';
  if (v < 75) return '탐욕';
  return '극단적 탐욕';
}

function renderMetric(id, valueDec, barMin, barMax, badIfUp = false, unitSuffix = '') {
  const s = state[id];
  const v = s.value;
  document.getElementById(`${id}Value`).textContent = v != null ? fmtNum(v, valueDec) : '—';
  setChange(document.getElementById(`${id}Change`), v, s.prev, badIfUp);
  const bar = document.getElementById(`${id}Bar`);
  if (v != null) {
    const pct = Math.max(0, Math.min(100, ((v - barMin) / (barMax - barMin)) * 100));
    bar.style.setProperty('--p', pct.toFixed(1));
  } else {
    bar.style.setProperty('--p', 0);
  }
}

// Calculate simple moving average (SMA) — returns array of {date, value} aligned with input
function calcSMA(series, period) {
  const out = [];
  for (let i = 0; i < series.length; i++) {
    if (i < period - 1) {
      out.push({ date: series[i].date, value: null });
    } else {
      let sum = 0;
      for (let j = i - period + 1; j <= i; j++) sum += series[j].value;
      out.push({ date: series[i].date, value: sum / period });
    }
  }
  return out;
}

// Determine zone based on deviation %
// >= +5%: strong, +2~+5%: normal, 0~+2%: watch, -2~0%: warning, < -2%: danger
function spxZone(deviationPct) {
  if (deviationPct == null || isNaN(deviationPct)) return 'normal';
  if (deviationPct >= 5)  return 'strong';
  if (deviationPct >= 2)  return 'normal';
  if (deviationPct >= 0)  return 'watch';
  if (deviationPct >= -2) return 'warning';
  return 'danger';
}
function spxZoneLabel(zone) {
  return ({
    strong:  '강한 상승 추세',
    normal:  '안정 추세',
    watch:   '주의 — 200일선 근접',
    warning: '경고 — 200일선 하향',
    danger:  '위험 — 추세 전환 신호',
  })[zone] || '—';
}

function renderSPX() {
  const s = state.spx;
  const card = document.getElementById('spxCard');
  const v = s.value;
  const ma = s.ma200;
  const dev = s.deviation;

  document.getElementById('spxValue').textContent  = v  != null ? fmtNum(v, 2) : '—';
  document.getElementById('spxMa200').textContent  = ma != null ? fmtNum(ma, 2) : '—';
  document.getElementById('spxDeviation').textContent = dev != null
    ? `${dev > 0 ? '+' : ''}${dev.toFixed(2)}%`
    : '—';

  // Daily change
  const changeEl = document.getElementById('spxChange');
  if (v != null && s.prev != null) {
    const diff = v - s.prev;
    const pct = (diff / s.prev) * 100;
    const sign = diff >= 0 ? '+' : '';
    changeEl.textContent = `${sign}${pct.toFixed(2)}%`;
    changeEl.style.color = diff >= 0 ? 'var(--up)' : 'var(--down)';
  } else {
    changeEl.textContent = '—';
    changeEl.style.color = '';
  }

  // Zone (color state)
  const zone = spxZone(dev);
  card.setAttribute('data-zone', zone);
  document.getElementById('spxStatus').textContent = spxZoneLabel(zone);

  // Position marker: clamp deviation to ±10% range, map to 0-100%
  const marker = document.getElementById('spxPositionMarker');
  if (dev != null) {
    const clamped = Math.max(-10, Math.min(10, dev));
    const leftPct = ((clamped + 10) / 20) * 100;
    marker.style.left = leftPct + '%';
  } else {
    marker.style.left = '50%';
  }
}

function renderAll() {
  renderFNG();
  renderMetric('vix', 2, 0, 40, true);
  renderMetric('unrate', 1, 0, 10, true);
  renderMetric('wti', 2, 0, 150, false);
  // DXY: Stooq gives actual DXY (~95-110), FRED fallback gives USD/EUR (~0.8-1.3)
  // Detect which and render accordingly
  const dxyVal = state.dxy.value;
  if (dxyVal != null && dxyVal > 5) {
    // Real DXY index
    renderMetric('dxy', 2, 90, 120, false);
  } else {
    // USD/EUR rate
    renderMetric('dxy', 4, 0.80, 1.30, false);
  }
  renderSPX();

  // Last updated
  if (state.lastRefresh) {
    const d = new Date(state.lastRefresh);
    document.getElementById('lastUpdated').textContent =
      `마지막 업데이트: ${d.toLocaleString('ko-KR', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}`;
  }
}

/* ============ CHARTS ============ */

function chartColors() {
  const isDark = document.body.classList.contains('dark');
  const css = getComputedStyle(document.body);
  return {
    ink: css.getPropertyValue('--ink').trim(),
    ink3: css.getPropertyValue('--ink-3').trim(),
    line: isDark ? 'rgba(238,232,220,.08)' : 'rgba(24,22,26,.08)',
    accent: css.getPropertyValue('--accent').trim(),
    up: css.getPropertyValue('--up').trim(),
    down: css.getPropertyValue('--down').trim(),
  };
}

function baseLineOpts(colors, fillColor, isBar = false) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { intersect: false, mode: 'index' },
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: colors.ink,
        titleColor: '#fff', bodyColor: '#fff',
        padding: 10, cornerRadius: 8,
        titleFont: { family: 'JetBrains Mono', size: 11 },
        bodyFont: { family: 'Inter Tight', size: 12, weight: '600' },
        displayColors: false,
      },
    },
    scales: {
      x: {
        grid: { display: false },
        ticks: {
          color: colors.ink3, font: { family: 'JetBrains Mono', size: 10 },
          maxRotation: 0, autoSkip: true, maxTicksLimit: 5,
        },
        border: { display: false },
      },
      y: {
        grid: { color: colors.line, drawTicks: false },
        ticks: {
          color: colors.ink3, font: { family: 'JetBrains Mono', size: 10 },
          padding: 6, maxTicksLimit: 5,
        },
        border: { display: false },
      },
    },
  };
}

function makeLineDataset(label, series, color) {
  return {
    label,
    data: series.map(p => ({ x: p.date, y: p.value })),
    borderColor: color,
    backgroundColor: color + '20',
    borderWidth: 2,
    fill: true,
    tension: 0.25,
    pointRadius: 0,
    pointHoverRadius: 4,
    pointHoverBackgroundColor: color,
    pointHoverBorderColor: '#fff',
    pointHoverBorderWidth: 2,
  };
}

function updateChartBadges() {
  if (state.fng.series && state.fng.series.length) {
    const lastFng = state.fng.series[state.fng.series.length - 1].value;
    document.getElementById('fngBadge').textContent = `${lastFng} · ${ratingFromScore(lastFng)}`;
  } else if (state.fng.value != null) {
    document.getElementById('fngBadge').textContent = `${state.fng.value} · ${ratingFromScore(state.fng.value)}`;
  }
  if (state.vix.value != null) document.getElementById('vixBadge').textContent = fmtNum(state.vix.value, 2);
  if (state.unrate.value != null) document.getElementById('unrateBadge').textContent = fmtNum(state.unrate.value, 1) + '%';
  if (state.wti.value != null) document.getElementById('wtiBadge').textContent = '$' + fmtNum(state.wti.value, 2);
  if (state.dxy.value != null) {
    const dec = state.dxy.value > 5 ? 2 : 4;
    document.getElementById('dxyBadge').textContent = fmtNum(state.dxy.value, dec);
  }
  if (state.spx.deviation != null) {
    const dev = state.spx.deviation;
    const sign = dev >= 0 ? '+' : '';
    document.getElementById('spxBadge').textContent = `MA200 ${sign}${dev.toFixed(2)}%`;
  }
}

function destroyChart(id) {
  if (charts[id]) { charts[id].destroy(); charts[id] = null; }
}

function chartReady() {
  return typeof window.Chart !== 'undefined';
}

function waitForChart() {
  return new Promise((resolve) => {
    if (chartReady()) return resolve(true);
    const onReady = () => { document.removeEventListener('chart-ready', onReady); resolve(chartReady()); };
    document.addEventListener('chart-ready', onReady);
    // Safety timeout — resolve false after 6s
    setTimeout(() => resolve(chartReady()), 6000);
  });
}

function renderChart(id, series, color, opts = {}) {
  destroyChart(id);
  const el = document.getElementById(`chart-${id}`);
  if (!el || !series || series.length === 0) return;
  const colors = chartColors();
  charts[id] = new Chart(el, {
    type: opts.bar ? 'bar' : 'line',
    data: {
      labels: series.map(p => p.date),
      datasets: opts.bar
        ? [{
            label: id,
            data: series.map(p => p.value),
            backgroundColor: series.map(p => color),
            borderWidth: 0,
            borderRadius: 3,
          }]
        : [makeLineDataset(id, series, color)],
    },
    options: baseLineOpts(colors, color, opts.bar),
  });
  // Set badge with latest value
  if (opts.badgeId && series.length) {
    const last = series[series.length - 1].value;
    const badge = document.getElementById(opts.badgeId);
    if (badge) badge.textContent = opts.badgeFmt ? opts.badgeFmt(last) : fmtNum(last, 2);
  }
}

async function renderAllCharts() {
  // Update badges immediately regardless of Chart.js availability
  updateChartBadges();
  const ready = await waitForChart();
  if (!ready) return; // Chart.js didn't load — fail silently, badges still visible
  const colors = chartColors();

  // F&G — bar chart colored by sentiment zone
  if (state.fng.series && state.fng.series.length) {
    destroyChart('fng');
    const el = document.getElementById('chart-fng');
    const pts = state.fng.series;
    const barColors = pts.map(p => {
      if (p.value < 25) return '#d94c4c';
      if (p.value < 45) return '#e89854';
      if (p.value < 55) return '#bfa14a';
      if (p.value < 75) return '#7fb562';
      return '#2d8a4e';
    });
    charts.fng = new Chart(el, {
      type: 'bar',
      data: {
        labels: pts.map(p => p.date),
        datasets: [{
          data: pts.map(p => p.value),
          backgroundColor: barColors,
          borderWidth: 0,
          borderRadius: 1,
        }],
      },
      options: Object.assign(baseLineOpts(colors), {
        scales: {
          x: { grid: { display: false }, ticks: { color: colors.ink3, font: { family: 'JetBrains Mono', size: 10 }, maxRotation: 0, autoSkip: true, maxTicksLimit: 5 }, border: { display: false } },
          y: { min: 0, max: 100, grid: { color: colors.line }, ticks: { color: colors.ink3, font: { family: 'JetBrains Mono', size: 10 }, maxTicksLimit: 5, padding: 6 }, border: { display: false } },
        },
      }),
    });
    const lastFng = pts[pts.length - 1].value;
    document.getElementById('fngBadge').textContent = `${lastFng} · ${ratingFromScore(lastFng)}`;
  }

  renderChart('vix', state.vix.series, colors.accent, { badgeId: 'vixBadge' });
  renderChart('unrate', state.unrate.series, colors.ink, { badgeId: 'unrateBadge', badgeFmt: (v) => fmtNum(v, 1) + '%' });
  renderChart('wti', state.wti.series, '#c87a2a', { badgeId: 'wtiBadge', badgeFmt: (v) => '$' + fmtNum(v, 2) });
  renderChart('dxy', state.dxy.series, '#3e7a8c', {
    badgeId: 'dxyBadge',
    badgeFmt: (v) => fmtNum(v, v > 5 ? 2 : 4),
  });

  // S&P 500 + MA200 dual-line chart with breach highlighting
  renderSPXChart(colors);
}

function renderSPXChart(colors) {
  destroyChart('spx');
  const el = document.getElementById('chart-spx');
  if (!el) return;
  const series = state.spx.series;
  const ma200 = state.spx.ma200Series;
  if (!series || !series.length) return;

  // Plugin to fill area between price line and MA200 line:
  // - green tint when price > MA200
  // - red tint when price < MA200
  const breachFillPlugin = {
    id: 'breachFill',
    beforeDatasetsDraw(chart) {
      const { ctx, chartArea, scales } = chart;
      if (!chartArea) return;
      const priceData = chart.data.datasets[0].data;
      const maData = chart.data.datasets[1].data;
      const xScale = scales.x;
      const yScale = scales.y;
      ctx.save();
      // Build segments and fill
      for (let i = 1; i < priceData.length; i++) {
        const p0 = priceData[i - 1], p1 = priceData[i];
        const m0 = maData[i - 1], m1 = maData[i];
        if (p0 == null || p1 == null || m0 == null || m1 == null) continue;
        const x0 = xScale.getPixelForValue(i - 1);
        const x1 = xScale.getPixelForValue(i);
        const yp0 = yScale.getPixelForValue(p0);
        const yp1 = yScale.getPixelForValue(p1);
        const ym0 = yScale.getPixelForValue(m0);
        const ym1 = yScale.getPixelForValue(m1);
        const aboveStart = p0 >= m0;
        const aboveEnd = p1 >= m1;
        // Choose color based on average position
        const above = (aboveStart && aboveEnd) || (aboveStart && !aboveEnd) || (!aboveStart && aboveEnd);
        const fillUp = (aboveStart && aboveEnd);
        const fillDown = (!aboveStart && !aboveEnd);
        if (fillUp) {
          ctx.fillStyle = 'rgba(95, 184, 131, 0.18)';
        } else if (fillDown) {
          ctx.fillStyle = 'rgba(229, 115, 115, 0.28)';
        } else {
          // Crossover segment — neutral
          ctx.fillStyle = 'rgba(150, 150, 150, 0.10)';
        }
        ctx.beginPath();
        ctx.moveTo(x0, yp0);
        ctx.lineTo(x1, yp1);
        ctx.lineTo(x1, ym1);
        ctx.lineTo(x0, ym0);
        ctx.closePath();
        ctx.fill();
      }
      ctx.restore();
    },
  };

  charts.spx = new Chart(el, {
    type: 'line',
    data: {
      labels: series.map(p => p.date),
      datasets: [
        {
          label: 'S&P 500',
          data: series.map(p => p.value),
          borderColor: colors.ink,
          borderWidth: 1.8,
          pointRadius: 0,
          pointHoverRadius: 4,
          pointHoverBackgroundColor: colors.ink,
          pointHoverBorderColor: '#fff',
          pointHoverBorderWidth: 2,
          tension: 0.15,
          fill: false,
          order: 1,
        },
        {
          label: 'MA200',
          data: ma200.map(p => p.value),
          borderColor: '#c87a2a',
          borderWidth: 1.5,
          borderDash: [4, 3],
          pointRadius: 0,
          pointHoverRadius: 0,
          tension: 0,
          fill: false,
          order: 2,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { intersect: false, mode: 'index' },
      plugins: {
        legend: {
          display: true,
          position: 'top',
          align: 'end',
          labels: {
            color: colors.ink3,
            font: { family: 'Inter Tight', size: 11, weight: '500' },
            boxWidth: 12,
            boxHeight: 2,
            padding: 12,
            usePointStyle: false,
          },
        },
        tooltip: {
          backgroundColor: colors.ink,
          titleColor: '#fff', bodyColor: '#fff',
          padding: 10, cornerRadius: 8,
          titleFont: { family: 'JetBrains Mono', size: 11 },
          bodyFont: { family: 'Inter Tight', size: 12, weight: '600' },
          displayColors: true,
          callbacks: {
            label: (ctx) => `${ctx.dataset.label}: ${fmtNum(ctx.parsed.y, 2)}`,
          },
        },
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: {
            color: colors.ink3,
            font: { family: 'JetBrains Mono', size: 10 },
            maxRotation: 0, autoSkip: true, maxTicksLimit: 5,
          },
          border: { display: false },
        },
        y: {
          grid: { color: colors.line },
          ticks: {
            color: colors.ink3,
            font: { family: 'JetBrains Mono', size: 10 },
            maxTicksLimit: 6, padding: 6,
          },
          border: { display: false },
        },
      },
    },
    plugins: [breachFillPlugin],
  });

  // Badge: deviation %
  const badge = document.getElementById('spxBadge');
  if (badge && state.spx.deviation != null) {
    const dev = state.spx.deviation;
    const sign = dev >= 0 ? '+' : '';
    badge.textContent = `MA200 ${sign}${dev.toFixed(2)}%`;
    badge.style.color = dev >= 0 ? 'var(--up)' : 'var(--down)';
  }
}

/* ============ REFRESH ============ */

async function refreshAll(isInitial = false) {
  const btn = document.getElementById('refreshBtn');
  btn.classList.add('loading');

  const jobs = [
    job('fng', async () => {
      const d = await fetchFNG();
      state.fng.value = d.value;
      state.fng.rating = d.rating;
      state.fng.prev = d.prev;
      state.fng.week = d.week;
      if (d.series && d.series.length > 10) state.fng.series = d.series;
      state.fng.updated = Date.now();
    }),
    job('vix', async () => {
      // Yahoo: ^VIX → Stooq: ^vix → FRED: VIXCLS
      const { data: s } = await fetchMultiSource('^VIX', '^vix', FRED.vix);
      if (!s.length) throw new Error('empty vix');
      state.vix.series = s;
      state.vix.value = s[s.length - 1].value;
      state.vix.prev = s.length > 1 ? s[s.length - 2].value : null;
      state.vix.updated = Date.now();
    }),
    job('unrate', async () => {
      // Unemployment rate (monthly) — FRED only
      // Fallback: hardcoded recent value if FRED proxy fails (updates monthly anyway)
      try {
        const s = await fetchFRED(FRED.unrate, 65);
        if (!s.length) throw new Error('empty unrate');
        state.unrate.series = s;
        state.unrate.value = s[s.length - 1].value;
        state.unrate.prev = s.length > 1 ? s[s.length - 2].value : null;
        state.unrate.updated = Date.now();
      } catch (e) {
        // Hardcoded recent US unemployment rate (BLS monthly release)
        // Source: https://www.bls.gov/news.release/empsit.nr0.htm
        // Update this list when new BLS data releases (first Friday of each month)
        const hardcoded = [
          { date: '2025-10-01', value: 4.2 },
          { date: '2025-11-01', value: 4.5 },
          { date: '2025-12-01', value: 4.4 },
          { date: '2026-01-01', value: 4.3 },
          { date: '2026-02-01', value: 4.4 },
          { date: '2026-03-01', value: 4.3 },
        ];
        state.unrate.series = hardcoded;
        state.unrate.value = hardcoded[hardcoded.length - 1].value;
        state.unrate.prev = hardcoded[hardcoded.length - 2].value;
        state.unrate.updated = Date.now();
        state.unrate.fallback = true;
      }
    }),
    job('wti', async () => {
      // Yahoo: CL=F → Stooq: cl.f → FRED: DCOILWTICO
      const { data: s } = await fetchMultiSource('CL=F', 'cl.f', 'DCOILWTICO');
      if (!s.length) throw new Error('empty wti');
      state.wti.value = s[s.length - 1].value;
      state.wti.prev = s.length > 1 ? s[s.length - 2].value : null;
      // Weekly sampling for chart clarity
      const weekly = s.filter((_, i) => i % 5 === 0);
      state.wti.series = weekly.length ? weekly : s;
      state.wti.updated = Date.now();
    }),
    job('dxy', async () => {
      // Yahoo: DX-Y.NYB (real DXY) → Stooq: ^dxy → FRED: DEXUSEU (USD/EUR fallback)
      const { data: s, source } = await fetchMultiSource('DX-Y.NYB', '^dxy', FRED.dxy);
      if (!s.length) throw new Error('empty dxy');
      state.dxy.series = s;
      state.dxy.value = s[s.length - 1].value;
      state.dxy.prev = s.length > 1 ? s[s.length - 2].value : null;
      state.dxy.source = source;
      state.dxy.updated = Date.now();
    }),
    job('spx', async () => {
      // S&P 500 — Yahoo: ^GSPC. Need ~250 trading days (≈ 1 year) to compute MA200 well.
      // Fetch 18 months to ensure first MA200 value is at least ~6 months old.
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/%5EGSPC?range=18mo&interval=1d`;
      let data;
      try {
        const r = await fetchWithTimeout(url, 8000);
        if (r.ok) data = await r.json();
      } catch (e) {}
      if (!data) data = await fetchViaProxies(url);
      if (!data || !data.chart || !data.chart.result || !data.chart.result[0]) throw new Error('bad spx payload');
      const result = data.chart.result[0];
      const timestamps = result.timestamp || [];
      const closes = (result.indicators?.quote?.[0]?.close) || [];
      const series = [];
      for (let i = 0; i < timestamps.length; i++) {
        const c = closes[i];
        if (c != null && !isNaN(c)) {
          series.push({
            date: new Date(timestamps[i] * 1000).toISOString().slice(0, 10),
            value: +c.toFixed(2),
          });
        }
      }
      if (series.length < 200) throw new Error('spx insufficient data for MA200');

      // Compute MA200
      const maFull = calcSMA(series, 200);

      // Trim to last ~1 year for chart clarity (keep last 252 trading days)
      const trimFrom = Math.max(0, series.length - 252);
      const seriesTrim = series.slice(trimFrom);
      const maTrim = maFull.slice(trimFrom);

      const lastValue = series[series.length - 1].value;
      const prevValue = series.length > 1 ? series[series.length - 2].value : null;
      const lastMA = maFull[maFull.length - 1].value;
      const deviation = lastMA != null ? ((lastValue - lastMA) / lastMA) * 100 : null;

      state.spx.series = seriesTrim;
      state.spx.ma200Series = maTrim;
      state.spx.value = lastValue;
      state.spx.prev = prevValue;
      state.spx.ma200 = lastMA != null ? +lastMA.toFixed(2) : null;
      state.spx.deviation = deviation != null ? +deviation.toFixed(2) : null;
      state.spx.updated = Date.now();
    }),
  ];

  const results = await Promise.allSettled(jobs);
  state.lastRefresh = Date.now();
  saveState();
  renderAll();
  if (document.getElementById('page-charts').classList.contains('active')) {
    renderAllCharts();
  }

  btn.classList.remove('loading');
  const failed = results.filter(r => r.status === 'rejected').length;
  if (!isInitial) {
    if (failed === 0) showToast('모든 지표 업데이트 완료');
    else if (failed === results.length) showToast('네트워크 오류 · 저장된 값 표시');
    else showToast(`${results.length - failed}/${results.length} 업데이트`);
  }
}

function job(id, fn) {
  // Set pending state; on finish, mark ok or err silently
  setStatus(id, '');
  return (async () => {
    try {
      await fn();
      setStatus(id, 'ok');
    } catch (e) {
      // Silent fail — use cached value
      setStatus(id, state[id].value != null ? 'stale' : 'err');
      throw e;
    }
  })();
}

/* ============ INIT ============ */
document.getElementById('refreshBtn').addEventListener('click', () => refreshAll(false));

initTheme();
renderAll();
// Position tab indicator once fonts/layout ready
requestAnimationFrame(() => {
  const active = document.querySelector('.tab.active');
  if (active) positionIndicator(active);
});

// Initial fetch — silent
refreshAll(true);

// Register service worker for PWA install
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}
