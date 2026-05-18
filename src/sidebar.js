// ── Module state ──────────────────────────────────────────────────────────────
let _state              = null;
let _onSelectionChange  = null;
let _onAreaFly          = null;

// ── Public API ────────────────────────────────────────────────────────────────

export function initSidebar({ cityNames, countyNames, state, onSelectionChange, onAreaFly }) {
  _state             = state;
  _onSelectionChange = onSelectionChange;
  _onAreaFly         = onAreaFly;

  const panel = document.getElementById('left-panel');
  if (!panel) return;

  const isOutflow = state.direction === 'outflow';

  panel.innerHTML = `
    <!-- SUBJECT -->
    <div class="rail-section tight">
      <div class="eyebrow">Subject Area</div>
      <div class="search-wrap">
        <input
          id="area-search"
          class="search-input"
          type="text"
          placeholder="Search city or county&hellip;"
          autocomplete="off"
          spellcheck="false"
          aria-label="Select area"
          aria-autocomplete="list"
          aria-controls="area-dropdown"
          aria-expanded="false"
          value="${_escHtml(state.selectedArea)}"
        />
        <ul id="area-dropdown" class="search-dropdown" role="listbox" aria-label="Areas" hidden></ul>
      </div>
      <div class="search-context">
        <span class="pip"></span>
        <span id="search-context-text">${_aggregationLabel(state.aggregation)} view &middot; ${state.year}</span>
      </div>
    </div>

    <!-- DIRECTION -->
    <div class="rail-section tight">
      <div class="eyebrow">Direction</div>
      <div class="seg tall" id="direction-toggle" role="group" aria-label="Flow direction">
        <button data-value="outflow" class="${state.direction === 'outflow' ? 'active' : ''}">
          <span class="seg-line em">Where</span>
          <span class="seg-line">residents <strong>WORK</strong></span>
        </button>
        <button data-value="inflow" class="${state.direction === 'inflow' ? 'active' : ''}">
          <span class="seg-line em">Where</span>
          <span class="seg-line">workers <strong>LIVE</strong></span>
        </button>
      </div>
    </div>

    <!-- AGGREGATION -->
    <div class="rail-section tight">
      <div class="eyebrow">Map Zones</div>
      <div class="seg" id="aggregation-toggle" role="group" aria-label="Aggregation level">
        <button data-value="city" class="${state.aggregation === 'city' ? 'active' : ''}">City</button>
        <button data-value="county" class="${state.aggregation === 'county' ? 'active' : ''}">County</button>
      </div>
    </div>

    <div class="rail-rule"></div>

    <!-- KPI BLOCK -->
    <div class="rail-section">
      <div class="kpi-eyebrow">
        <span class="eyebrow-faint" id="kpi-direction-label">${isOutflow ? 'OUTBOUND COMMUTERS' : 'INBOUND COMMUTERS'}</span>
        <span class="eyebrow-faint" id="kpi-year">${state.year}</span>
      </div>
      <div class="kpi-value" id="kpi-value">&mdash;</div>
      <div class="kpi-caption" id="kpi-caption">Select an area to view commute data.</div>
    </div>

    <div class="rail-rule"></div>

    <!-- DEMOGRAPHIC PROFILE -->
    <div class="rail-section">
      <div class="eyebrow">Demographic Profile</div>
      <div class="demo-tabs" id="demo-tabs" role="tablist">
        <button class="active" data-tab="age" role="tab" aria-selected="true">Age</button>
        <button data-tab="earnings" role="tab" aria-selected="false">Earnings</button>
        <button data-tab="industry" role="tab" aria-selected="false">Industry</button>
      </div>
      <div id="demo-rows-age"></div>
      <div id="demo-rows-earnings" hidden></div>
      <div id="demo-rows-industry" hidden></div>
    </div>

    <div class="rail-rule"></div>

    <!-- REACH -->
    <div class="rail-section">
      <div class="eyebrow">Commute Reach</div>
      <div class="reach-block">
        <div class="reach-value">
          <span id="reach-avg-val">&mdash;</span><span class="unit">mi avg</span>
        </div>
        <div class="reach-meta" id="reach-meta">Straight-line centroid distance.</div>
      </div>
    </div>

    <div class="rail-rule"></div>

    <!-- ATTRIBUTION -->
    <div class="sidebar-attribution">
      Data: <a href="https://lehd.ces.census.gov/data/lodes/" target="_blank" rel="noopener">US Census LEHD LODES8</a>
      &middot; <a href="https://www.census.gov/geographies/mapping-files/time-series/geo/tiger-line-file.html" target="_blank" rel="noopener">TIGER 2020</a><br>
      <a href="https://wfrc.org/" target="_blank" rel="noopener">Wasatch Front Regional Council</a>
    </div>
  `;

  // Wire direction toggle
  document.getElementById('direction-toggle').addEventListener('click', e => {
    const btn = e.target.closest('[data-value]');
    if (!btn) return;
    _state.direction = btn.dataset.value;
    _setActiveToggle('direction-toggle', btn.dataset.value);
    _updateKpiDirectionLabel(btn.dataset.value);
    _onSelectionChange();
  });

  // Wire aggregation toggle
  document.getElementById('aggregation-toggle').addEventListener('click', e => {
    const btn = e.target.closest('[data-value]');
    if (!btn) return;
    _state.aggregation = btn.dataset.value;
    _setActiveToggle('aggregation-toggle', btn.dataset.value);
    _updateSearchContext();
    _onSelectionChange();
  });

  // Wire demo tab switching
  document.getElementById('demo-tabs').addEventListener('click', e => {
    const btn = e.target.closest('[data-tab]');
    if (!btn) return;
    const tab = btn.dataset.tab;
    document.querySelectorAll('#demo-tabs button').forEach(b => {
      b.classList.toggle('active', b.dataset.tab === tab);
      b.setAttribute('aria-selected', b.dataset.tab === tab ? 'true' : 'false');
    });
    ['age', 'earnings', 'industry'].forEach(t => {
      const el = document.getElementById(`demo-rows-${t}`);
      if (el) el.hidden = t !== tab;
    });
  });

  // Wire search dropdown
  _initDropdown(cityNames, countyNames);
}

export function updateSidebarStats(flows, total, appState) {
  const state = appState;

  // ── KPI value ──────────────────────────────────────────────────────────────
  const kpiValue = document.getElementById('kpi-value');
  if (kpiValue) kpiValue.textContent = total > 0 ? total.toLocaleString() : '—';

  const kpiCaption = document.getElementById('kpi-caption');
  if (kpiCaption) {
    const verb = state.direction === 'outflow'
      ? `Commuters leaving from ${state.selectedArea}.`
      : `Workers commuting into ${state.selectedArea}.`;
    kpiCaption.textContent = verb;
  }

  const kpiDirLabel = document.getElementById('kpi-direction-label');
  if (kpiDirLabel) {
    kpiDirLabel.textContent = state.direction === 'outflow'
      ? 'OUTBOUND COMMUTERS'
      : 'INBOUND COMMUTERS';
  }

  const kpiYear = document.getElementById('kpi-year');
  if (kpiYear) kpiYear.textContent = state.year;

  // Update search context year
  _updateSearchContext();

  if (!flows.length) {
    _clearDemoRows();
    const reachEl = document.getElementById('reach-avg-val');
    if (reachEl) reachEl.textContent = '—';
    const reachMeta = document.getElementById('reach-meta');
    if (reachMeta) reachMeta.textContent = 'No flow data for this area.';
    return;
  }

  // ── Breakdown totals ───────────────────────────────────────────────────────
  const bd = flows.reduce((acc, f) => ({
    SA01: acc.SA01 + Number(f.SA01 || 0),
    SA02: acc.SA02 + Number(f.SA02 || 0),
    SA03: acc.SA03 + Number(f.SA03 || 0),
    SE01: acc.SE01 + Number(f.SE01 || 0),
    SE02: acc.SE02 + Number(f.SE02 || 0),
    SE03: acc.SE03 + Number(f.SE03 || 0),
    SI01: acc.SI01 + Number(f.SI01 || 0),
    SI02: acc.SI02 + Number(f.SI02 || 0),
    SI03: acc.SI03 + Number(f.SI03 || 0),
  }), { SA01: 0, SA02: 0, SA03: 0, SE01: 0, SE02: 0, SE03: 0, SI01: 0, SI02: 0, SI03: 0 });

  const ageSum      = bd.SA01 + bd.SA02 + bd.SA03 || 1;
  const earningsSum = bd.SE01 + bd.SE02 + bd.SE03 || 1;
  const industrySum = bd.SI01 + bd.SI02 + bd.SI03 || 1;
  const dirClass    = state.direction === 'inflow' ? 'inflow' : '';

  // ── Age rows ───────────────────────────────────────────────────────────────
  const ageEl = document.getElementById('demo-rows-age');
  if (ageEl) {
    ageEl.innerHTML = _bdRow('Under 30', bd.SA01, ageSum, dirClass)
      + _bdRow('30 – 54', bd.SA02, ageSum, dirClass)
      + _bdRow('55 +', bd.SA03, ageSum, dirClass);
  }

  // ── Earnings rows ──────────────────────────────────────────────────────────
  const earningsEl = document.getElementById('demo-rows-earnings');
  if (earningsEl) {
    earningsEl.innerHTML = _bdRow('&le;$1,250/mo', bd.SE01, earningsSum, dirClass)
      + _bdRow('$1,251–3,333', bd.SE02, earningsSum, dirClass)
      + _bdRow('&gt;$3,333/mo', bd.SE03, earningsSum, dirClass);
  }

  // ── Industry rows ──────────────────────────────────────────────────────────
  const industryEl = document.getElementById('demo-rows-industry');
  if (industryEl) {
    industryEl.innerHTML = _bdRow('Goods', bd.SI01, industrySum, dirClass)
      + _bdRow('Trade', bd.SI02, industrySum, dirClass)
      + _bdRow('Services', bd.SI03, industrySum, dirClass);
  }

  // ── Reach ──────────────────────────────────────────────────────────────────
  let distNumerator = 0, distDenominator = 0;
  flows.forEach(f => {
    if (f.home_lat == null || f.work_lat == null) return;
    const miles = _haversineMiles(f.home_lat, f.home_lon, f.work_lat, f.work_lon);
    const n = Number(f.S000);
    distNumerator   += miles * n;
    distDenominator += n;
  });
  const avgMiles = distDenominator > 0 ? distNumerator / distDenominator : null;

  const reachValEl = document.getElementById('reach-avg-val');
  if (reachValEl) reachValEl.textContent = avgMiles != null ? avgMiles.toFixed(1) : '—';

  const reachMetaEl = document.getElementById('reach-meta');
  if (reachMetaEl) {
    reachMetaEl.textContent = avgMiles != null
      ? `Weighted straight-line distance across ${flows.length.toLocaleString()} flow${flows.length !== 1 ? 's' : ''}.`
      : 'Straight-line centroid distance.';
  }
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function _bdRow(label, count, sum, dirClass) {
  const pct = sum > 0 ? Math.round((count / sum) * 100) : 0;
  return `
    <div class="bd-row${dirClass ? ' ' + dirClass : ''}">
      <span class="bd-label">${label}</span>
      <div class="bd-bar"><span style="width:${pct}%"></span></div>
      <div>
        <div class="bd-count">${Number(count).toLocaleString()}</div>
        <div class="bd-pct">${pct}%</div>
      </div>
    </div>
  `;
}

function _clearDemoRows() {
  ['demo-rows-age', 'demo-rows-earnings', 'demo-rows-industry'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = '';
  });
}

function _haversineMiles(lat1, lon1, lat2, lon2) {
  const R    = 3958.8;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a    = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180)
    * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function _aggregationLabel(agg) {
  return agg === 'county' ? 'County' : 'City';
}

function _escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function _updateSearchContext() {
  const el = document.getElementById('search-context-text');
  if (el && _state) {
    el.textContent = `${_aggregationLabel(_state.aggregation)} view · ${_state.year}`;
  }
}

function _updateKpiDirectionLabel(direction) {
  const el = document.getElementById('kpi-direction-label');
  if (el) {
    el.textContent = direction === 'outflow' ? 'OUTBOUND COMMUTERS' : 'INBOUND COMMUTERS';
  }
}

/**
 * Set active state on a toggle group. Supports both:
 *   - .seg button[data-value]  (new segmented controls)
 *   - .toggle-btn[data-value]  (backward-compat class)
 */
function _setActiveToggle(groupId, value) {
  const group = document.getElementById(groupId);
  if (!group) return;
  group.querySelectorAll('[data-value]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.value === value);
  });
}

function _initDropdown(cityNames, countyNames) {
  const input    = document.getElementById('area-search');
  const dropdown = document.getElementById('area-dropdown');
  if (!input || !dropdown) return;

  const allAreas = [
    ...countyNames.map(n => ({ label: n, type: 'county' })),
    ...cityNames.map(n => ({ label: n, type: 'city' })),
  ];

  let activeIdx = -1;

  function show(items) {
    if (!items.length) { hide(); return; }
    dropdown.innerHTML = items.slice(0, 50).map((a, i) => `
      <li role="option" data-value="${_escHtml(a.label)}" data-type="${a.type}"
          aria-selected="false" id="drop-item-${i}">
        <span>${_escHtml(a.label)}</span>
        <span class="row-type">${a.type}</span>
      </li>
    `).join('');
    dropdown.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    activeIdx = -1;
  }

  function hide() {
    dropdown.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    activeIdx = -1;
  }

  function selectItem(label, type) {
    _state.selectedArea     = label;
    _state.selectedAreaType = type;
    input.value = label;
    if (type !== _state.aggregation) {
      _state.aggregation = type;
      _setActiveToggle('aggregation-toggle', type);
      _updateSearchContext();
    }
    hide();
    _onAreaFly?.(label, type);
    _onSelectionChange();
  }

  input.addEventListener('input', () => {
    const q = input.value.trim().toLowerCase();
    show(q ? allAreas.filter(a => a.label.toLowerCase().includes(q)) : allAreas.slice(0, 30));
  });

  input.addEventListener('focus', () => {
    const q = input.value.trim().toLowerCase();
    show(q ? allAreas.filter(a => a.label.toLowerCase().includes(q)) : allAreas.slice(0, 30));
  });

  input.addEventListener('keydown', e => {
    const items = dropdown.querySelectorAll('li');
    if (dropdown.hidden || !items.length) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const q = input.value.trim().toLowerCase();
        show(q ? allAreas.filter(a => a.label.toLowerCase().includes(q)) : allAreas.slice(0, 30));
      }
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      activeIdx = Math.min(activeIdx + 1, items.length - 1);
      _highlightItem(items, activeIdx);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      activeIdx = Math.max(activeIdx - 1, 0);
      _highlightItem(items, activeIdx);
    } else if (e.key === 'Enter') {
      if (activeIdx >= 0 && items[activeIdx]) {
        e.preventDefault();
        const el = items[activeIdx];
        selectItem(el.dataset.value, el.dataset.type);
      }
    } else if (e.key === 'Escape') {
      hide();
      input.blur();
    }
  });

  dropdown.addEventListener('click', e => {
    const item = e.target.closest('li');
    if (item) selectItem(item.dataset.value, item.dataset.type);
  });

  document.addEventListener('click', e => {
    if (!e.target.closest('.search-wrap')) hide();
  });
}

function _highlightItem(items, idx) {
  items.forEach((el, i) => {
    el.classList.toggle('hl', i === idx);
    el.setAttribute('aria-selected', i === idx ? 'true' : 'false');
  });
  items[idx]?.scrollIntoView({ block: 'nearest' });
}
