import './styles/main.css';
import './styles/sidebar.css';
import './styles/charts.css';
import './styles/toolbar.css';
import { initDB, reloadYear, queryFlows, queryTotal } from './db.js';
import { initMap, updateLayers, switchTheme, flyToArea, fitToFlows, loadBoundaries, updateChoropleth } from './map.js';
import { initSidebar, updateSidebarStats } from './sidebar.js';
import { initCharts, updateCharts, exportBarPng, exportBarCsv, exportSankeyPng, exportSankeyCsv } from './charts.js';

// ── Global app state ─────────────────────────────────────────────────────────
const state = {
  theme:            'light',
  aggregation:      'city',
  direction:        'outflow',
  selectedArea:     'Salt Lake City',
  selectedAreaType: 'city',
  year:             null,
  minFlow:          0,
  loading:          false,
};

let cityMeta   = {};
let countyMeta = {};

// Cached results for re-rendering without re-querying
let _lastEnrichedFlows = [];
let _lastTotal         = 0;

// ── Boot ─────────────────────────────────────────────────────────────────────
async function main() {
  setProgress(5);

  const base = import.meta.env.BASE_URL ?? '/';

  // 1. Load manifest
  const manifest = await fetch(`${base}data/manifest.json`).then(r => r.json());
  const availableYears = manifest.years.map(Number).sort((a, b) => b - a);

  // 2. Resolve year from URL or default
  const urlYear = _getUrlYear(availableYears, manifest.default);
  state.year = urlYear;
  _setUrlYear(urlYear);

  const yearEl = document.getElementById('data-year');
  if (yearEl) yearEl.textContent = state.year;

  // 3. Load year-specific metadata
  const [cityMetaArr, countyMetaArr] = await Promise.all([
    fetch(`${base}data/${state.year}/city_meta.json`).then(r => r.json()),
    fetch(`${base}data/${state.year}/county_meta.json`).then(r => r.json()),
  ]);
  cityMeta   = Object.fromEntries(cityMetaArr.map(d => [d.name, d]));
  countyMeta = Object.fromEntries(countyMetaArr.map(d => [d.name, d]));

  setProgress(15);

  // 4. Init DuckDB (heavyweight — give it most of the progress bar)
  await initDB(state.year, pct => setProgress(15 + pct * 0.65));

  setProgress(83);

  // 5. Init map
  initMap('map', state.theme);

  // 6. Load boundary files in background (optional — graceful if missing)
  loadBoundaries(base, state.theme);

  setProgress(88);

  // 7. Build sidebar
  const cityNames   = cityMetaArr.map(d => d.name).sort();
  const countyNames = countyMetaArr.map(d => d.name).sort();

  initSidebar({
    cityNames, countyNames, state,
    onSelectionChange: () => refreshVisualization(),
    onAreaFly: (lat, lon) => flyToArea(lat, lon),
  });

  // 8. Init charts (right panel)
  initCharts((areaName, areaType) => {
    state.selectedArea     = areaName;
    state.selectedAreaType = areaType;
    _updateSidebarAreaLabels(areaName);
    const m = (areaType === 'city' ? cityMeta : countyMeta)[areaName];
    if (m?.lat) flyToArea(m.lat, m.lon);
    refreshVisualization();
  });

  // 9. Wire export buttons
  document.getElementById('export-bar-png')?.addEventListener('click', () => exportBarPng());
  document.getElementById('export-bar-csv')?.addEventListener('click', () => exportBarCsv());
  document.getElementById('export-sankey-png')?.addEventListener('click', () => exportSankeyPng());
  document.getElementById('export-sankey-csv')?.addEventListener('click', () => exportSankeyCsv());

  // 10. Wire year selector
  _initYearSelect(availableYears, base);

  // 11. Wire filter toolbar
  _initFilterToolbar();

  // 12. Wire theme toggle
  document.getElementById('theme-toggle').addEventListener('click', () => {
    state.theme = state.theme === 'light' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', state.theme);
    switchTheme(state.theme, () => refreshVisualization());
  });

  setProgress(94);
  await refreshVisualization();

  document.querySelector('.sidebar-loading')?.remove();
  setProgress(100);
}

// ── Filter toolbar ────────────────────────────────────────────────────────────
function _initFilterToolbar() {
  const filterBtn     = document.getElementById('tb-filter');
  const filterPopover = document.getElementById('filter-popover');
  const numInput      = document.getElementById('min-flow-input');

  if (!filterBtn || !filterPopover || !numInput) return;

  filterBtn.addEventListener('click', e => {
    e.stopPropagation();
    const open = filterPopover.hidden;
    filterPopover.hidden = !open;
    filterBtn.classList.toggle('active', open);
    filterBtn.setAttribute('aria-expanded', String(open));
  });

  document.addEventListener('click', e => {
    if (!e.target.closest('#map-toolbar')) {
      filterPopover.hidden = true;
      filterBtn.classList.remove('active');
      filterBtn.setAttribute('aria-expanded', 'false');
    }
  });

  let _debounce;
  numInput.addEventListener('input', () => {
    const val = Math.max(0, parseInt(numInput.value) || 0);
    state.minFlow = val;
    clearTimeout(_debounce);
    _debounce = setTimeout(() => _applyFilter(), 250);
  });
}

// ── Year selector ─────────────────────────────────────────────────────────────
let _changingYear = false;

function _initYearSelect(availableYears, base) {
  const sel = document.getElementById('year-select');
  if (!sel) return;

  sel.innerHTML = availableYears.map(y =>
    `<option value="${y}"${y === state.year ? ' selected' : ''}>${y}</option>`
  ).join('');

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

    const yearEl = document.getElementById('data-year');
    if (yearEl) yearEl.textContent = newYear;

    const srcMeta = state.selectedAreaType === 'city' ? cityMeta : countyMeta;
    if (!srcMeta[state.selectedArea]) {
      state.selectedArea     = 'Salt Lake City';
      state.selectedAreaType = 'city';
    }

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
          ? { ...f, home_name: state.selectedArea, work_name: f.dest_name,  home_lat: src?.lat, home_lon: src?.lon, work_lat: dst?.lat, work_lon: dst?.lon }
          : { ...f, home_name: f.dest_name,        work_name: state.selectedArea, home_lat: dst?.lat, home_lon: dst?.lon, work_lat: src?.lat, work_lon: src?.lon };
      })
      .filter(f => f.home_lat != null && f.work_lat != null);

    _lastEnrichedFlows = enriched;
    _lastTotal         = total;

    _applyFilter();

    if (enriched.length) fitToFlows(enriched);

  } finally {
    state.loading = false;
  }
}

function _applyFilter() {
  const filtered = state.minFlow > 0
    ? _lastEnrichedFlows.filter(f => Number(f.S000) >= state.minFlow)
    : _lastEnrichedFlows;

  updateLayers(filtered, state, arcClickHandler);
  updateCharts(filtered, _lastTotal, state);
  updateChoropleth(filtered, state.selectedArea, state.aggregation, state.theme);
  updateSidebarStats(filtered, _lastTotal, state);
}

// ── Arc click → select destination as new area ────────────────────────────────
function arcClickHandler(flow) {
  const newArea = flow.dest_name ?? (state.direction === 'outflow' ? flow.work_name : flow.home_name);
  if (!newArea || newArea === state.selectedArea) return;

  state.selectedArea     = newArea;
  state.selectedAreaType = state.aggregation;

  const m = (state.aggregation === 'city' ? cityMeta : countyMeta)[newArea];
  if (m?.lat) flyToArea(m.lat, m.lon);

  _updateSidebarAreaLabels(newArea);
  refreshVisualization();
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function _updateSidebarAreaLabels(areaName) {
  const input = document.getElementById('area-search');
  if (input) input.value = areaName;
  const short = areaName.length > 18 ? areaName.slice(0, 16) + '…' : areaName;
  const outEl = document.getElementById('area-label-out');
  const inEl  = document.getElementById('area-label-in');
  if (outEl) outEl.textContent = short;
  if (inEl)  inEl.textContent  = short;
}

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

function setProgress(pct) {
  const bar = document.getElementById('load-progress');
  if (bar) bar.style.width = `${pct}%`;
}

// ── Boot ──────────────────────────────────────────────────────────────────────
main().catch(err => {
  console.error('WFRC app failed to initialize:', err);
  const panel = document.getElementById('left-panel');
  if (panel) {
    panel.innerHTML = `
      <div class="sidebar-error">
        <p><strong>Failed to load data.</strong></p>
        <p>${err.message}</p>
        <p>Run <code>uv run scripts/process_data.py</code> to generate the data files.</p>
      </div>
    `;
  }
});
