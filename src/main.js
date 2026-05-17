import './styles/main.css';
import './styles/sidebar.css';
import { initDB, queryFlows, queryTotal } from './db.js';
import { initMap, updateLayers, switchTheme, flyToArea, fitToFlows } from './map.js';
import { initSidebar, updateSidebarStats } from './sidebar.js';

// ── Global app state ─────────────────────────────────────────────────────────
const state = {
  theme:            'light',   // 'light' | 'dark'
  aggregation:      'city',    // 'city' | 'county'  — destination granularity
  direction:        'outflow', // 'outflow' | 'inflow'
  selectedArea:     'Salt Lake City',
  selectedAreaType: 'city',    // 'city' | 'county'  — type of selected area
  loading:          false,
};

let cityMeta   = {};  // name → {lat, lon, county, county_fips, place_fips}
let countyMeta = {};  // name → {lat, lon, county_fips}

// ── Boot ─────────────────────────────────────────────────────────────────────
async function main() {
  setProgress(5);

  const base = import.meta.env.BASE_URL ?? '/';
  const [cityMetaArr, countyMetaArr] = await Promise.all([
    fetch(`${base}data/city_meta.json`).then(r => r.json()),
    fetch(`${base}data/county_meta.json`).then(r => r.json()),
  ]);

  cityMeta   = Object.fromEntries(cityMetaArr.map(d => [d.name, d]));
  countyMeta = Object.fromEntries(countyMetaArr.map(d => [d.name, d]));

  setProgress(15);

  await initDB(pct => setProgress(15 + pct * 0.7));

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

// ── Refresh visualization ─────────────────────────────────────────────────────
async function refreshVisualization() {
  if (state.loading) return;
  state.loading = true;

  try {
    const [flows, total] = await Promise.all([
      queryFlows(state.selectedArea, state.selectedAreaType, state.direction, state.aggregation),
      queryTotal(state.selectedArea, state.selectedAreaType, state.direction),
    ]);

    // Origin metadata: based on what type of area is selected
    const srcMeta = state.selectedAreaType === 'city' ? cityMeta : countyMeta;
    // Destination metadata: based on the aggregation level chosen
    const dstMeta = state.aggregation === 'city' ? cityMeta : countyMeta;

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
  state.selectedAreaType = state.aggregation; // clicked destination is of the current agg type

  const dstMeta = state.aggregation === 'city' ? cityMeta : countyMeta;
  const m = dstMeta[newArea];
  if (m?.lat) flyToArea(m.lat, m.lon);

  const input = document.getElementById('area-search');
  if (input) input.value = newArea;

  // Sync the direction labels in the sidebar
  const outEl = document.getElementById('area-label-out');
  const inEl  = document.getElementById('area-label-in');
  if (outEl) outEl.textContent = newArea;
  if (inEl)  inEl.textContent  = newArea;

  refreshVisualization();
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
