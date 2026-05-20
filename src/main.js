import './styles/main.css';
import './styles/sidebar.css';
import './styles/charts.css';
import './styles/toolbar.css';
import { initDB, reloadYear, queryFlows, queryTotal, querySelfFlow } from './db.js';
import { initMap, updateLayers, switchTheme, flyToArea, loadBoundaries, updateChoropleth, setFlowVisible, setPolygonsVisible, setSelfFlow, initPolygonInteraction, loadInfoOnlyPlaces } from './map.js';
import { initSidebar, updateSidebarStats, setInfoOnlyPlaces } from './sidebar.js';
import { initCharts, updateCharts, exportBarPng, exportBarCsv, exportSankeyPng, exportSankeyCsv, exportDemoPng, exportDemoCsv, exportReachPng, exportReachCsv, exportIndustryPng, exportIndustryCsv, exportTransportCsv, exportTravelTimeCsv, resizeCharts } from './charts.js';

// ── Global app state ─────────────────────────────────────────────────────────
const state = {
  theme:            'light',
  aggregation:      'city',
  direction:        'inflow',
  selectedArea:     'Salt Lake City',
  selectedAreaType: 'city',
  year:             null,
  minFlow:          50,
  loading:          false,
};

let cityMeta   = {};
let countyMeta = {};

// ACS commute data: keyed by FIPS (7-digit for places, 5-digit for counties)
let _acsCity   = {};
let _acsCounty = {};

// Cached results for re-rendering without re-querying
let _lastOutflows  = [];
let _lastInflows   = [];
let _lastTotalOut  = 0;
let _lastTotalIn   = 0;
let _lastSelfCount = 0;

// Track last flew state so we don't re-fly on direction/theme/filter changes
let _lastFlewArea        = null;
let _lastFlewAggregation = null;

// Available years — stored at module level so scrubber can update on year change
let _availableYears = [];

// ── Haversine helper ──────────────────────────────────────────────────────────
function _haversineMiles(lat1, lon1, lat2, lon2) {
  const R = 3958.8;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180)
    * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function _distanceToZoom(avgMiles) {
  // At zoom 8, ~230 miles visible; each level halves that.
  // Constant 46 ≈ 2× the avg WFRC commute, giving good regional context.
  const zoom = 8 + Math.log2(46 / Math.max(avgMiles, 1));
  return Math.min(Math.max(zoom, 7.5), 11.5);
}

// ── ACS loader ───────────────────────────────────────────────────────────────
async function _loadAcs(base, year) {
  const load = async (path) => {
    try {
      const r = await fetch(path);
      if (!r.ok) return {};
      const text = await r.text();
      // Guard against SPA fallback returning index.html for missing paths
      if (!text.trim().startsWith('{')) return {};
      return JSON.parse(text);
    } catch { return {}; }
  };
  [_acsCity, _acsCounty] = await Promise.all([
    load(`${base}data/acs/${year}/acs_city.json`),
    load(`${base}data/acs/${year}/acs_county.json`),
  ]);
}

// ── Boot ─────────────────────────────────────────────────────────────────────
async function main() {
  setProgress(5);

  const base = import.meta.env.BASE_URL ?? '/';

  // 1. Load manifest
  const manifest = await fetch(`${base}data/manifest.json`).then(r => r.json());
  const availableYears = manifest.years.map(Number).sort((a, b) => b - a);
  _availableYears = availableYears;

  // 2. Resolve year from URL or default
  const urlYear = _getUrlYear(availableYears, manifest.default);
  state.year = urlYear;

  // 3. Load year-specific metadata + ACS data
  const [cityMetaArr, countyMetaArr] = await Promise.all([
    fetch(`${base}data/${state.year}/city_meta.json`).then(r => r.json()),
    fetch(`${base}data/${state.year}/county_meta.json`).then(r => r.json()),
    _loadAcs(base, state.year),
  ]);
  cityMeta   = Object.fromEntries(cityMetaArr.map(d => [d.name, d]));
  countyMeta = Object.fromEntries(countyMetaArr.map(d => [d.name, d]));

  setProgress(15);

  // 4. Init DuckDB (heavyweight — give it most of the progress bar)
  await initDB(state.year, pct => setProgress(15 + pct * 0.65));

  setProgress(83);

  // 5. Init map
  initMap('map', state.theme);

  initPolygonInteraction((name) => {
    if (name === state.selectedArea) return;
    state.selectedArea     = name;
    state.selectedAreaType = state.aggregation;
    _updateSidebarAreaLabels(name);
    refreshVisualization();
  });

  // 6. Load boundary files in background (optional — graceful if missing)
  loadBoundaries(base, state.theme);

  // 6b. Load custom place info for info-only display (graceful if missing)
  fetch(`${base}data/custom_places.geojson`)
    .then(r => r.ok ? r.json() : null)
    .then(gj => {
      if (!gj) return;
      const cityNames = Object.keys(cityMeta);
      const infoOnly  = gj.features.filter(f => !cityNames.includes(f.properties?.name));
      if (!infoOnly.length) return;
      loadInfoOnlyPlaces(infoOnly);
      setInfoOnlyPlaces(infoOnly);
    })
    .catch(() => {});

  setProgress(88);

  // 7. Apply URL params (area/dir/agg) now that metadata is available
  _applyUrlParams(cityMeta, countyMeta);

  // 8. Build sidebar
  const cityNames   = cityMetaArr.map(d => d.name).filter(n => !n.toLowerCase().includes('unincorporated')).sort();
  const countyNames = countyMetaArr.map(d => d.name).sort();

  initSidebar({
    cityNames, countyNames, state,
    onSelectionChange: () => refreshVisualization(),
    onAreaFly: () => {},
  });

  // 9. Init charts (right panel)
  initCharts((areaName, areaType) => {
    state.selectedArea     = areaName;
    state.selectedAreaType = areaType;
    _updateSidebarAreaLabels(areaName);
    refreshVisualization();
  });

  // 9. Wire export buttons
  document.getElementById('export-bar-png')?.addEventListener('click', () => exportBarPng());
  document.getElementById('export-bar-csv')?.addEventListener('click', () => exportBarCsv());
  document.getElementById('export-sankey-png')?.addEventListener('click', () => exportSankeyPng());
  document.getElementById('export-sankey-csv')?.addEventListener('click', () => exportSankeyCsv());
  document.getElementById('export-demo-png')?.addEventListener('click', () => exportDemoPng());
  document.getElementById('export-demo-csv')?.addEventListener('click', () => exportDemoCsv());
  document.getElementById('export-reach-png')?.addEventListener('click', () => exportReachPng());
  document.getElementById('export-reach-csv')?.addEventListener('click', () => exportReachCsv());
  document.getElementById('export-industry-png')?.addEventListener('click', () => exportIndustryPng());
  document.getElementById('export-industry-csv')?.addEventListener('click', () => exportIndustryCsv());
  document.getElementById('export-transport-csv')?.addEventListener('click', () => exportTransportCsv());
  document.getElementById('export-traveltime-csv')?.addEventListener('click', () => exportTravelTimeCsv());

  // 10. Wire year scrubber
  _initYearSelect(availableYears, base);

  // 11. Wire layer toggle toolbar + resize
  _initLayerToolbar();
  _initRightPanelResize();

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

// ── Right panel resize handle ─────────────────────────────────────────────────
function _initRightPanelResize() {
  const handle = document.getElementById('right-resize-handle');
  if (!handle) return;

  handle.addEventListener('mousedown', e => {
    e.preventDefault();
    const startX     = e.clientX;
    const startWidth = parseInt(
      getComputedStyle(document.documentElement).getPropertyValue('--right-rail-width'), 10
    ) || 432;

    handle.classList.add('dragging');
    document.body.style.cursor    = 'col-resize';
    document.body.style.userSelect = 'none';

    const onMove = ev => {
      const delta    = startX - ev.clientX;   // drag left = wider
      const newWidth = Math.min(Math.max(startWidth + delta, 300), 900);
      document.documentElement.style.setProperty('--right-rail-width', `${newWidth}px`);
    };

    const onUp = () => {
      handle.classList.remove('dragging');
      document.body.style.cursor    = '';
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup',   onUp);
      resizeCharts();
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup',   onUp);
  });
}

// ── Layer toggle toolbar ──────────────────────────────────────────────────────
function _initLayerToolbar() {
  const flowsBtn     = document.getElementById('tb-flows');
  const zonesBtn     = document.getElementById('tb-zones');
  const minFlowInput = document.getElementById('min-flow-input');
  const mfVal        = document.getElementById('mf-val');

  if (!flowsBtn || !zonesBtn) return;

  let flowVisible  = true;
  let zonesVisible = true;

  flowsBtn.addEventListener('click', () => {
    flowVisible = !flowVisible;
    flowsBtn.classList.toggle('active', flowVisible);
    flowsBtn.setAttribute('aria-pressed', String(flowVisible));
    setFlowVisible(flowVisible);
  });

  zonesBtn.addEventListener('click', () => {
    zonesVisible = !zonesVisible;
    zonesBtn.classList.toggle('active', zonesVisible);
    zonesBtn.setAttribute('aria-pressed', String(zonesVisible));
    setPolygonsVisible(zonesVisible);
  });

  if (minFlowInput) {
    minFlowInput.addEventListener('input', () => {
      const val = parseInt(minFlowInput.value);
      if (!isNaN(val) && val >= 0) {
        state.minFlow = val;
        if (mfVal) mfVal.textContent = val;
        _applyFilter();
      }
    });
  }
}

// ── Year scrubber ─────────────────────────────────────────────────────────────
let _changingYear = false;

function _initYearSelect(availableYears, base) {
  // Populate hidden select for screen reader fallback
  const sel = document.getElementById('year-select');
  if (sel) {
    sel.innerHTML = availableYears.map(y =>
      `<option value="${y}"${y === state.year ? ' selected' : ''}>${y}</option>`
    ).join('');
    sel.addEventListener('change', () => _changeYear(parseInt(sel.value), base));
  }

  // Build tick scrubber
  _buildScrubberTicks(availableYears, base);
  _updateScrubber(state.year, availableYears);
}

function _buildScrubberTicks(availableYears, base) {
  const track = document.getElementById('ys-track');
  if (!track) return;
  // Remove existing ticks (but keep .ys-axis and .ys-fill)
  track.querySelectorAll('.ys-tick').forEach(t => t.remove());

  const sorted     = [...availableYears].sort((a, b) => a - b);
  const minYear    = sorted[0];
  const maxYear    = sorted[sorted.length - 1];
  const majorYears = new Set([2005, 2010, 2015, 2020]);

  sorted.forEach(year => {
    const tick = document.createElement('button');
    tick.type  = 'button';
    tick.className = 'ys-tick';
    tick.dataset.year = year;
    tick.setAttribute('aria-label', `Select year ${year}`);

    if (majorYears.has(year)) tick.classList.add('major');

    if (year === minYear || year === maxYear) {
      tick.classList.add('endcap');
      const cap = document.createElement('span');
      cap.className   = 'ys-tick-cap';
      cap.textContent = year;
      tick.appendChild(cap);
    }

    tick.addEventListener('click', () => _changeYear(year, base));
    track.appendChild(tick);
  });
}

function _updateScrubber(year, availableYears) {
  const sorted = [...availableYears].sort((a, b) => a - b);
  const idx    = sorted.indexOf(year);
  const pct    = sorted.length > 1 ? (idx / (sorted.length - 1)) * 100 : 0;

  const fill = document.getElementById('ys-fill');
  if (fill) fill.style.width = `${pct}%`;

  const display = document.getElementById('ys-year-display');
  if (display) display.textContent = year;

  const sel = document.getElementById('year-select');
  if (sel) sel.value = year;

  document.querySelectorAll('.ys-tick').forEach(t => {
    t.classList.toggle('active', parseInt(t.dataset.year) === year);
  });
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
      _loadAcs(base, newYear),
    ]);
    cityMeta   = Object.fromEntries(cityMetaArr.map(d => [d.name, d]));
    countyMeta = Object.fromEntries(countyMetaArr.map(d => [d.name, d]));

    setProgress(20);
    await reloadYear(newYear, pct => setProgress(20 + pct * 0.6));
    setProgress(85);

    state.year = newYear;
    _updateScrubber(newYear, _availableYears);

    const srcMeta = state.selectedAreaType === 'city' ? cityMeta : countyMeta;
    if (!srcMeta[state.selectedArea]) {
      state.selectedArea     = 'Salt Lake City';
      state.selectedAreaType = 'city';
    }

    initSidebar({
      cityNames:   cityMetaArr.map(d => d.name).filter(n => !n.toLowerCase().includes('unincorporated')).sort(),
      countyNames: countyMetaArr.map(d => d.name).sort(),
      state,
      onSelectionChange: () => refreshVisualization(),
      onAreaFly: () => {},
    });

    await refreshVisualization();
    setProgress(100);

  } catch (err) {
    console.error('Year switch failed:', err);
    setProgress(0);
  } finally {
    _changingYear = false;
    if (sel) sel.disabled = false;
  }
}

// ── Refresh visualization ─────────────────────────────────────────────────────
async function refreshVisualization() {
  _syncUrl();
  if (state.loading) return;
  state.loading = true;

  try {
    const [outflows, inflows, totalOut, totalIn, selfCount] = await Promise.all([
      queryFlows(state.selectedArea, state.selectedAreaType, 'outflow', state.aggregation),
      queryFlows(state.selectedArea, state.selectedAreaType, 'inflow',  state.aggregation),
      queryTotal(state.selectedArea, state.selectedAreaType, 'outflow'),
      queryTotal(state.selectedArea, state.selectedAreaType, 'inflow'),
      querySelfFlow(state.selectedArea, state.selectedAreaType),
    ]);

    const srcMeta = state.selectedAreaType === 'city' ? cityMeta : countyMeta;
    const dstMeta = state.aggregation       === 'city' ? cityMeta : countyMeta;
    const src = srcMeta[state.selectedArea];

    const enrichedOut = outflows
      .map(f => {
        const dst = dstMeta[f.dest_name];
        return { ...f, home_name: state.selectedArea, work_name: f.dest_name,
                       home_lat: src?.lat, home_lon: src?.lon, work_lat: dst?.lat, work_lon: dst?.lon };
      })
      .filter(f => f.home_lat != null && f.work_lat != null);

    const enrichedIn = inflows
      .map(f => {
        const dst = dstMeta[f.dest_name];
        return { ...f, home_name: f.dest_name, work_name: state.selectedArea,
                       home_lat: dst?.lat, home_lon: dst?.lon, work_lat: src?.lat, work_lon: src?.lon };
      })
      .filter(f => f.home_lat != null && f.work_lat != null);

    _lastOutflows  = enrichedOut;
    _lastInflows   = enrichedIn;
    _lastTotalOut  = totalOut;
    _lastTotalIn   = totalIn;
    _lastSelfCount = selfCount;

    setSelfFlow(selfCount, totalOut, totalIn);

    // Fly only when the selected area or aggregation level changes
    const areaChanged = state.selectedArea !== _lastFlewArea
                     || state.aggregation  !== _lastFlewAggregation;
    if (src?.lat && areaChanged) {
      let zoom;
      if (state.aggregation === 'county') {
        zoom = 8;
      } else {
        let distNum = 0, distDen = 0;
        enrichedOut.forEach(f => {
          const n = Number(f.S000);
          distNum += _haversineMiles(f.home_lat, f.home_lon, f.work_lat, f.work_lon) * n;
          distDen += n;
        });
        const avgMiles = distDen > 0 ? distNum / distDen : 20;
        zoom = _distanceToZoom(avgMiles);
      }
      flyToArea(src.lat, src.lon, zoom);
      _lastFlewArea        = state.selectedArea;
      _lastFlewAggregation = state.aggregation;
    }

    _applyFilter();

  } finally {
    state.loading = false;
  }
}

function _applyFilter() {
  const dirFlows = state.direction === 'outflow' ? _lastOutflows : _lastInflows;
  const total    = state.direction === 'outflow' ? _lastTotalOut : _lastTotalIn;

  const filtered = state.aggregation === 'county'
    ? dirFlows
    : dirFlows.filter(f => Number(f.S000) >= state.minFlow);

  // Resolve ACS entry for the currently selected area
  let acsEntry = null;
  if (state.selectedAreaType === 'city') {
    const fips = cityMeta[state.selectedArea]?.place_fips;
    if (fips) acsEntry = _acsCity[fips] ?? null;
  } else {
    const fips = countyMeta[state.selectedArea]?.county_fips;
    if (fips) acsEntry = _acsCounty[fips] ?? null;
  }

  updateLayers(filtered, state, arcClickHandler, total);
  // Charts always show both directions unfiltered — top N by volume handles their own slicing
  updateCharts(_lastOutflows, _lastInflows, _lastTotalOut, _lastTotalIn, _lastSelfCount, state, acsEntry);
  updateChoropleth(dirFlows, state.selectedArea, state.aggregation, state.theme, state.direction);
  updateSidebarStats(dirFlows, state);
  _updateDataline(total, state);
  _updateLegend(filtered, state.direction, state.theme);
}

// ── Dataline map overlay update ───────────────────────────────────────────────
function _updateDataline(total, appState) {
  const dl      = document.getElementById('map-dataline');
  const dlLabel = document.getElementById('dl-label');
  const dlValue = document.getElementById('dl-value');
  const dlFrom  = document.getElementById('dl-from');
  const dlArrow = document.getElementById('dl-arrow');
  if (!dlLabel || !dlValue || !dlFrom) return;

  const isOut = appState.direction === 'outflow';
  dlLabel.textContent = isOut ? 'RESIDENTS COMMUTING OUT' : 'WORKERS COMMUTING IN';
  dlValue.textContent = total > 0 ? total.toLocaleString() : '—';
  dlFrom.textContent  = `${isOut ? 'From' : 'To'} ${appState.selectedArea} · ${appState.year}`;
  dlArrow.textContent = isOut ? '↗' : '↘';
  if (dl) dl.classList.toggle('inflow', !isOut);
}

// ── Flow legend ───────────────────────────────────────────────────────────────
// Color arrays match @flowmap.gl/data COLOR_SCHEMES exactly.
// With adaptiveScalesEnabled=true, flowmap.gl maps the visible flow range to
// the full scheme — so scheme[0] = minVal and scheme[last] = maxVal.
const _LEGEND_ORANGES = ['#fff5eb','#fee6ce','#fdd0a2','#fdae6b','#fd8d3c','#f16913','#d94801','#a63603','#7f2704'];
const _LEGEND_GREEN   = ['#d0eeec','#a2dbd8','#74c8c3','#46b5ae','#2e9898','#1e6f6f','#0f4040'];

function _updateLegend(flows, direction, theme) {
  const el = document.getElementById('map-legend');
  if (!el) return;

  const counts = flows.map(f => Number(f.S000)).filter(n => n > 0);
  if (!counts.length) { el.innerHTML = ''; return; }

  const minVal = Math.min(...counts);
  const maxVal = Math.max(...counts);

  function fmtN(n) {
    if (n >= 10000) return `${Math.round(n / 1000)}k`;
    if (n >= 1000)  return `${parseFloat((n / 1000).toFixed(1))}k`;
    return n.toLocaleString();
  }

  const scheme = direction === 'inflow' ? _LEGEND_GREEN : _LEGEND_ORANGES;
  const colors = theme === 'dark' ? [...scheme].reverse() : scheme;
  const gradient = `linear-gradient(to right, ${colors.join(',')})`;

  const label = direction === 'inflow' ? 'Inflow' : 'Outflow';

  el.innerHTML = `
    <div class="lg-label">${label} · commuters</div>
    <div class="lg-gradient-bar" style="background:${gradient}"></div>
    <div class="lg-gradient-labels">
      <span>${fmtN(minVal)}</span>
      <span>${fmtN(maxVal)}</span>
    </div>`;
}

// ── Arc click → select destination as new area ────────────────────────────────
function arcClickHandler(flow) {
  const newArea = flow.dest_name ?? (state.direction === 'outflow' ? flow.work_name : flow.home_name);
  if (!newArea || newArea === state.selectedArea) return;

  state.selectedArea     = newArea;
  state.selectedAreaType = state.aggregation;

  _updateSidebarAreaLabels(newArea);
  refreshVisualization();
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function _updateSidebarAreaLabels(areaName) {
  const input = document.getElementById('area-search');
  if (input) input.value = areaName;
  // area-label-out and area-label-in no longer exist in new HTML; safe no-ops
  const outEl = document.getElementById('area-label-out');
  const inEl  = document.getElementById('area-label-in');
  const short = areaName.length > 18 ? areaName.slice(0, 16) + '…' : areaName;
  if (outEl) outEl.textContent = short;
  if (inEl)  inEl.textContent  = short;
}

function _getUrlYear(availableYears, defaultYear) {
  const params  = new URLSearchParams(window.location.search);
  const urlYear = parseInt(params.get('year'));
  return (urlYear && availableYears.includes(urlYear)) ? urlYear : defaultYear;
}

function _applyUrlParams(cm, ctm) {
  const p = new URLSearchParams(window.location.search);
  const agg = p.get('agg');
  if (agg === 'city' || agg === 'county') state.aggregation = agg;
  const area = p.get('area');
  if (area) {
    const meta = state.aggregation === 'county' ? ctm : cm;
    if (meta[area]) {
      state.selectedArea     = area;
      state.selectedAreaType = state.aggregation;
    }
  }
  const dir = p.get('dir');
  if (dir === 'outflow' || dir === 'inflow') state.direction = dir;
}

function _syncUrl() {
  const url = new URL(window.location.href);
  url.searchParams.set('year', state.year);
  url.searchParams.set('area', state.selectedArea);
  url.searchParams.set('dir',  state.direction);
  url.searchParams.set('agg',  state.aggregation);
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
