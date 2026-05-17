import './styles/main.css';
import './styles/sidebar.css';
import { initDB, reloadYear, queryFlows, queryTotal } from './db.js';
import { initMap, updateLayers, switchTheme, flyToArea, fitToFlows } from './map.js';
import { initSidebar, updateSidebarStats } from './sidebar.js';

// ── Global app state ─────────────────────────────────────────────────────────
const state = {
  theme:            'light',
  aggregation:      'city',
  direction:        'outflow',
  selectedArea:     'Salt Lake City',
  selectedAreaType: 'city',
  year:             null,   // set during boot from manifest + URL param
  loading:          false,
};

let cityMeta   = {};
let countyMeta = {};

// ── Boot ─────────────────────────────────────────────────────────────────────
async function main() {
  setProgress(5);

  const base = import.meta.env.BASE_URL ?? '/';

  // 1. Load manifest to discover available years
  const manifest = await fetch(`${base}data/manifest.json`).then(r => r.json());
  const availableYears = manifest.years.map(Number).sort((a, b) => b - a); // newest first

  // 2. Resolve year from URL param or manifest default
  const urlYear = _getUrlYear(availableYears, manifest.default);
  state.year = urlYear;
  _setUrlYear(urlYear);

  // Show resolved year in header subtitle immediately
  const yearEl = document.getElementById('data-year');
  if (yearEl) yearEl.textContent = state.year;

  // 3. Load year-specific metadata + init DuckDB in parallel
  const [cityMetaArr, countyMetaArr] = await Promise.all([
    fetch(`${base}data/${state.year}/city_meta.json`).then(r => r.json()),
    fetch(`${base}data/${state.year}/county_meta.json`).then(r => r.json()),
  ]);
  cityMeta   = Object.fromEntries(cityMetaArr.map(d => [d.name, d]));
  countyMeta = Object.fromEntries(countyMetaArr.map(d => [d.name, d]));

  setProgress(15);

  await initDB(state.year, pct => setProgress(15 + pct * 0.7));

  setProgress(88);

  initMap('map', state.theme);

  setProgress(92);

  const cityNames   = cityMetaArr.map(d => d.name).sort();
  const countyNames = countyMetaArr.map(d => d.name).sort();

  initSidebar({
    cityNames,
    countyNames,
    state,
    onSelectionChange: () => refreshVisualization(),
    onAreaFly: (lat, lon) => flyToArea(lat, lon),
  });

  // 4. Wire year selector
  _initYearSelect(availableYears, base);

  // 5. Wire theme toggle
  document.getElementById('theme-toggle').addEventListener('click', () => {
    state.theme = state.theme === 'light' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', state.theme);
    switchTheme(state.theme, () => refreshVisualization());
  });

  setProgress(96);
  await refreshVisualization();

  document.querySelector('.sidebar-loading')?.remove();
  setProgress(100);
}

// ── Year selector ─────────────────────────────────────────────────────────────
let _changingYear = false;

function _initYearSelect(availableYears, base) {
  const sel = document.getElementById('year-select');
  if (!sel) return;

  sel.innerHTML = availableYears.map(y =>
    `<option value="${y}"${y === state.year ? ' selected' : ''}>${y}</option>`
  ).join('');

  // Hide if only one year (nothing to switch)
  if (availableYears.length <= 1) {
    sel.closest('.year-select-wrap')?.classList.add('year-select-hidden');
  }

  sel.addEventListener('change', () => _changeYear(parseInt(sel.value), base));
}

async function _changeYear(newYear, base) {
  if (_changingYear || state.loading || newYear === state.year) return;
  _changingYear = true;

  const sel = document.getElementById('year-select');
  if (sel) sel.disabled = true;

  try {
    setProgress(5);

    const [cityMetaArr, countyMetaArr] = await Promise.all([
      fetch(`${base}data/${newYear}/city_meta.json`).then(r => r.json()),
      fetch(`${base}data/${newYear}/county_meta.json`).then(r => r.json()),
    ]);

    cityMeta   = Object.fromEntries(cityMetaArr.map(d => [d.name, d]));
    countyMeta = Object.fromEntries(countyMetaArr.map(d => [d.name, d]));

    setProgress(20);

    await reloadYear(newYear, pct => setProgress(20 + pct * 0.6));

    setProgress(85);

    state.year = newYear;
    _setUrlYear(newYear);

    // Update header subtitle year
    const yearEl = document.getElementById('data-year');
    if (yearEl) yearEl.textContent = newYear;

    // Validate selected area still exists in new year; reset if not
    const srcMeta = state.selectedAreaType === 'city' ? cityMeta : countyMeta;
    if (!srcMeta[state.selectedArea]) {
      state.selectedArea     = 'Salt Lake City';
      state.selectedAreaType = 'city';
    }

    // Re-init sidebar dropdown with new year's city/county names
    initSidebar({
      cityNames:   cityMetaArr.map(d => d.name).sort(),
      countyNames: countyMetaArr.map(d => d.name).sort(),
      state,
      onSelectionChange: () => refreshVisualization(),
      onAreaFly: (lat, lon) => flyToArea(lat, lon),
    });

    await refreshVisualization();
    setProgress(100);

  } finally {
    _changingYear = false;
    if (sel) sel.disabled = false;
  }
}

// ── Refresh visualization ─────────────────────────────────────────────────────
async function refreshVisualization() {
  if (state.loading) return;
  state.loading = true;

  try {
    const [flows, total] = await Promise.all([
      queryFlows(state.selectedArea, state.selectedAreaType, state.direction, state.aggregation),
      queryTotal(state.selectedArea, state.selectedAreaType, state.direction),
    ]);

    const srcMeta = state.selectedAreaType === 'city' ? cityMeta : countyMeta;
    const dstMeta = state.aggregation       === 'city' ? cityMeta : countyMeta;

    const src = srcMeta[state.selectedArea];

    const enriched = flows
      .map(f => {
        const dst = dstMeta[f.dest_name];
        return state.direction === 'outflow'
          ? {
              ...f,
              home_name: state.selectedArea,
              work_name: f.dest_name,
              home_lat: src?.lat,  home_lon: src?.lon,
              work_lat: dst?.lat,  work_lon: dst?.lon,
            }
          : {
              ...f,
              home_name: f.dest_name,
              work_name: state.selectedArea,
              home_lat: dst?.lat,  home_lon: dst?.lon,
              work_lat: src?.lat,  work_lon: src?.lon,
            };
      })
      .filter(f => f.home_lat != null && f.work_lat != null);

    updateLayers(enriched, state, arcClickHandler);
    updateSidebarStats(flows, total, state, dstMeta);

    if (enriched.length) fitToFlows(enriched);

  } finally {
    state.loading = false;
  }
}

// ── Arc click → set destination as new selection ──────────────────────────────
function arcClickHandler(flow) {
  const newArea = flow.dest_name ?? (state.direction === 'outflow' ? flow.work_name : flow.home_name);
  if (!newArea || newArea === state.selectedArea) return;

  state.selectedArea     = newArea;
  state.selectedAreaType = state.aggregation;

  const dstMeta = state.aggregation === 'city' ? cityMeta : countyMeta;
  const m = dstMeta[newArea];
  if (m?.lat) flyToArea(m.lat, m.lon);

  const input = document.getElementById('area-search');
  if (input) input.value = newArea;

  const outEl = document.getElementById('area-label-out');
  const inEl  = document.getElementById('area-label-in');
  if (outEl) outEl.textContent = newArea;
  if (inEl)  inEl.textContent  = newArea;

  refreshVisualization();
}

// ── URL year param ─────────────────────────────────────────────────────────────
function _getUrlYear(availableYears, defaultYear) {
  const params = new URLSearchParams(window.location.search);
  const urlYear = parseInt(params.get('year'));
  return (urlYear && availableYears.includes(urlYear)) ? urlYear : defaultYear;
}

function _setUrlYear(year) {
  const url = new URL(window.location.href);
  url.searchParams.set('year', year);
  history.replaceState(null, '', url);
}

// ── Progress bar ──────────────────────────────────────────────────────────────
function setProgress(pct) {
  const bar = document.getElementById('load-progress');
  if (bar) bar.style.width = `${pct}%`;
}

main().catch(err => {
  console.error('WFRC app failed to initialize:', err);
  const sidebar = document.getElementById('sidebar');
  if (sidebar) {
    sidebar.innerHTML = `
      <div class="sidebar-error">
        <p><strong>Failed to load data.</strong></p>
        <p>${err.message}</p>
        <p>Run <code>uv run scripts/process_data.py</code> to generate the data files.</p>
      </div>
    `;
  }
});
