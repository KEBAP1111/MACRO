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

// CORS proxies — tried in order. CNN & FRED block direct browser requests.
// Multiple proxies for resilience; silently falls through on failure.
const CORS_PROXIES = [
  (url) => `https://corsproxy.io/?${encodeURIComponent(url)}`,
  (url) => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
  (url) => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`,
  (url) => `https://cors.eu.org/${url}`,
  (url) => `https://proxy.cors.sh/${url}`,
  (url) => `https://thingproxy.freeboard.io/fetch/${url}`,
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
    if (raw) return JSON.parse(raw);
  } catch (e) {}
  return {
    fng:    { value: null, prev: null, week: null, rating: null, series: [], updated: null },
    vix:    { value: null, prev: null, series: [], updated: null },
    unrate: { value: null, prev: null, series: [], updated: null },
    wti:    { value: null, prev: null, series: [], updated: null },
    dxy:    { value: null, prev: null, series: [], updated: null },
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

async function fetchViaProxies(url) {
  // Try direct first (works in some browsers / for CORS-enabled endpoints)
  try {
    const r = await fetchWithTimeout(url, 5000);
    if (r.ok) return await r.json();
  } catch (e) {}
  // Try each proxy
  for (const wrap of CORS_PROXIES) {
    try {
      const proxied = wrap(url);
      const r = await fetchWithTimeout(proxied, 9000);
      if (!r.ok) continue;
      const text = await r.text();
      try { return JSON.parse(text); } catch { /* not JSON */ }
    } catch (e) {}
  }
  throw new Error('All proxies failed');
}

/* ============ DATA FETCHERS ============ */

// --- FRED ---
async function fetchFRED(seriesId, limit = 260) {
  const url = `https://api.stlouisfed.org/fred/series/observations?series_id=${seriesId}&api_key=${FRED_KEY}&file_type=json&sort_order=desc&limit=${limit}`;
  const data = await fetchViaProxies(url);
  if (!data || !data.observations) throw new Error('bad FRED payload');
  // Filter out "." placeholders FRED uses for missing data
  const clean = data.observations
    .filter(o => o.value && o.value !== '.')
    .map(o => ({ date: o.date, value: parseFloat(o.value) }))
    .reverse(); // ascending by date
  return clean;
}

// --- Finnhub WTI ---
async function fetchWTI() {
  // Use Finnhub commodity quote for WTI oil futures (CL=F via alt symbol)
  // Try a quote endpoint first
  const symbols = ['CL=F']; // fallback ladder
  for (const sym of symbols) {
    try {
      const url = `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(sym)}&token=${FINNHUB_KEY}`;
      const r = await fetchWithTimeout(url, 7000);
      if (!r.ok) continue;
      const q = await r.json();
      if (q && typeof q.c === 'number' && q.c > 0) {
        return { current: q.c, previous: q.pc, raw: q };
      }
    } catch (e) {}
  }
  // Fallback: try FRED DCOILWTICO (WTI price)
  const f = await fetchFRED('DCOILWTICO', 260);
  if (f.length >= 2) {
    return {
      current: f[f.length - 1].value,
      previous: f[f.length - 2].value,
      series: f,
    };
  }
  throw new Error('wti fail');
}

async function fetchWTIHistory() {
  // Prefer FRED for consistent daily series
  const f = await fetchFRED('DCOILWTICO', 260);
  return f;
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

function renderAll() {
  renderFNG();
  renderMetric('vix', 2, 0, 40, true);
  renderMetric('unrate', 1, 0, 10, true);
  renderMetric('wti', 2, 0, 150, false);
  renderMetric('dxy', 4, 0.80, 1.30, false);

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
  if (state.dxy.value != null) document.getElementById('dxyBadge').textContent = fmtNum(state.dxy.value, 4);
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
  renderChart('dxy', state.dxy.series, '#3e7a8c', { badgeId: 'dxyBadge', badgeFmt: (v) => fmtNum(v, 4) });
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
      const s = await fetchFRED(FRED.vix, 260);
      if (!s.length) throw new Error('empty vix');
      state.vix.series = s;
      state.vix.value = s[s.length - 1].value;
      state.vix.prev = s.length > 1 ? s[s.length - 2].value : null;
      state.vix.updated = Date.now();
    }),
    job('unrate', async () => {
      const s = await fetchFRED(FRED.unrate, 65);
      if (!s.length) throw new Error('empty unrate');
      state.unrate.series = s;
      state.unrate.value = s[s.length - 1].value;
      state.unrate.prev = s.length > 1 ? s[s.length - 2].value : null;
      state.unrate.updated = Date.now();
    }),
    job('wti', async () => {
      const r = await fetchWTI();
      state.wti.value = r.current;
      state.wti.prev = r.previous;
      // Also fetch history for chart
      try {
        const h = await fetchWTIHistory();
        if (h && h.length) {
          // Weekly sampling for chart clarity
          const weekly = h.filter((_, i) => i % 5 === 0);
          state.wti.series = weekly.length ? weekly : h;
        }
      } catch (e) {}
      state.wti.updated = Date.now();
    }),
    job('dxy', async () => {
      const s = await fetchFRED(FRED.dxy, 260);
      if (!s.length) throw new Error('empty dxy');
      state.dxy.series = s;
      state.dxy.value = s[s.length - 1].value;
      state.dxy.prev = s.length > 1 ? s[s.length - 2].value : null;
      state.dxy.updated = Date.now();
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
