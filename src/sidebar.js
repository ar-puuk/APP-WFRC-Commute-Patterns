let _state = null;
let _onSelectionChange = null;
let _onAreaFly = null;

export function initSidebar({ cityNames, countyNames, state, onSelectionChange, onAreaFly }) {
  _state = state;
  _onSelectionChange = onSelectionChange;
  _onAreaFly = onAreaFly;

  const panel = document.getElementById('left-panel');
  panel.innerHTML = `
    <div class="sidebar-section">
      <label class="sidebar-label" for="area-search">For</label>
      <div class="search-wrapper">
        <input
          id="area-search"
          class="area-input"
          type="text"
          placeholder="Search city or county&hellip;"
          autocomplete="off"
          spellcheck="false"
          aria-label="Select area"
          aria-autocomplete="list"
          aria-controls="area-dropdown"
          aria-expanded="false"
        />
        <ul id="area-dropdown" class="area-dropdown" role="listbox" aria-label="Areas" hidden></ul>
      </div>
    </div>

    <div class="sidebar-section">
      <label class="sidebar-label">Show me</label>
      <div class="toggle-group" id="direction-toggle" role="group" aria-label="Flow direction">
        <button class="toggle-btn active" data-value="outflow">
          Where <span class="area-label-inline" id="area-label-out"></span> residents <strong>WORK</strong>
        </button>
        <button class="toggle-btn" data-value="inflow">
          Where <span class="area-label-inline" id="area-label-in"></span> workers <strong>LIVE</strong>
        </button>
      </div>
    </div>

    <div class="sidebar-section">
      <label class="sidebar-label">Map Display Zones</label>
      <div class="toggle-group" id="aggregation-toggle" role="group" aria-label="Aggregation level">
        <button class="toggle-btn active" data-value="city">City</button>
        <button class="toggle-btn" data-value="county">County</button>
      </div>
    </div>

    <hr class="sidebar-divider" />

    <div class="sidebar-section" id="stats-section">
      <div id="area-stats" class="stats-total"></div>
      <div id="area-breakdown" hidden></div>
      <div id="no-data-msg" class="no-data-msg" hidden>
        No commute data found for this area.
      </div>
    </div>

    <div class="sidebar-attribution">
      Data: <a href="https://lehd.ces.census.gov/data/lodes/" target="_blank" rel="noopener">US Census LEHD LODES8</a>
      &middot; <a href="https://www.census.gov/geographies/mapping-files/time-series/geo/tiger-line-file.html" target="_blank" rel="noopener">TIGER 2020</a><br>
      <a href="https://wfrc.org/" target="_blank" rel="noopener">Wasatch Front Regional Council</a>
    </div>
  `;

  _setAreaLabels(state.selectedArea);
  _initDropdown(cityNames, countyNames);


  document.getElementById('direction-toggle').addEventListener('click', e => {
    const btn = e.target.closest('[data-value]');
    if (!btn) return;
    _state.direction = btn.dataset.value;
    _setActiveToggle('direction-toggle', btn.dataset.value);
    _onSelectionChange();
  });

  document.getElementById('aggregation-toggle').addEventListener('click', e => {
    const btn = e.target.closest('[data-value]');
    if (!btn) return;
    _state.aggregation = btn.dataset.value;
    _setActiveToggle('aggregation-toggle', btn.dataset.value);
    _onSelectionChange();
  });

  _setActiveToggle('direction-toggle', state.direction);
  _setActiveToggle('aggregation-toggle', state.aggregation);

  document.getElementById('area-search').value = state.selectedArea;
}

export function updateSidebarStats(flows, total, appState) {
  const state    = appState;
  const statsEl  = document.getElementById('area-stats');
  const bdEl     = document.getElementById('area-breakdown');
  const noData   = document.getElementById('no-data-msg');

  if (!statsEl) return;

  const dirLabel = state.direction === 'outflow' ? 'Residing in' : 'Working in';
  statsEl.innerHTML = `
    <span style="font-size:12px;color:var(--sidebar-text-muted);">Commuters ${dirLabel}</span>
    <span style="font-size:12px;font-weight:600;color:var(--sidebar-text);">${state.selectedArea}</span>
    <span class="stats-count">${total.toLocaleString()}</span>
  `;

  if (!flows.length) {
    if (bdEl)   bdEl.hidden   = true;
    if (noData) noData.hidden = false;
    return;
  }

  if (noData) noData.hidden = true;

  // Compute breakdown totals across all flows (excluding self-flow)
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

  // Weighted-average straight-line commute distance (centroid to centroid)
  let distNumerator = 0, distDenominator = 0;
  flows.forEach(f => {
    if (f.home_lat == null || f.work_lat == null) return;
    const miles = _haversineMiles(f.home_lat, f.home_lon, f.work_lat, f.work_lon);
    const n = Number(f.S000);
    distNumerator   += miles * n;
    distDenominator += n;
  });
  const avgMiles = distDenominator > 0 ? distNumerator / distDenominator : null;

  const row = (label, count, sum) => {
    const pct = Math.round((count / sum) * 100);
    return `
      <div class="bd-row">
        <span class="bd-label">${label}</span>
        <div class="bd-bar-wrap"><div class="bd-bar" style="width:${pct}%"></div></div>
        <span class="bd-count">${Number(count).toLocaleString()}</span>
      </div>`;
  };

  if (bdEl) {
    bdEl.hidden = false;
    bdEl.innerHTML = `
      <div class="bd-group">
        <div class="bd-group-title">By Age</div>
        ${row('Under 30', bd.SA01, ageSum)}
        ${row('30 – 54',  bd.SA02, ageSum)}
        ${row('55 +',     bd.SA03, ageSum)}
      </div>
      <div class="bd-group">
        <div class="bd-group-title">By Earnings (monthly)</div>
        ${row('&le;$1,250', bd.SE01, earningsSum)}
        ${row('$1,251–3,333', bd.SE02, earningsSum)}
        ${row('&gt;$3,333', bd.SE03, earningsSum)}
      </div>
      <div class="bd-group">
        <div class="bd-group-title">By Industry</div>
        ${row('Goods',    bd.SI01, industrySum)}
        ${row('Trade',    bd.SI02, industrySum)}
        ${row('Services', bd.SI03, industrySum)}
      </div>
      ${avgMiles != null ? `
      <div class="bd-distance">
        <div class="bd-group-title">Avg. Commute Distance</div>
        <div class="bd-distance-value">${avgMiles.toFixed(1)}<span class="bd-distance-unit"> mi &nbsp;·&nbsp; straight-line</span></div>
      </div>` : ''}
    `;
  }
}

// ── Internal helpers ─────────────────────────────────────────────────────────

function _haversineMiles(lat1, lon1, lat2, lon2) {
  const R = 3958.8;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function _setAreaLabels(name) {
  const short = name.length > 18 ? name.slice(0, 16) + '…' : name;
  const outEl = document.getElementById('area-label-out');
  const inEl  = document.getElementById('area-label-in');
  if (outEl) outEl.textContent = short;
  if (inEl)  inEl.textContent  = short;
}

function _setActiveToggle(groupId, value) {
  const group = document.getElementById(groupId);
  if (!group) return;
  group.querySelectorAll('.toggle-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.value === value);
  });
}

function _selectArea(name) {
  _state.selectedArea = name;
  document.getElementById('area-search').value = name;
  _setAreaLabels(name);
  _onSelectionChange();
}

function _initDropdown(cityNames, countyNames) {
  const input    = document.getElementById('area-search');
  const dropdown = document.getElementById('area-dropdown');

  const allAreas = [
    ...countyNames.map(n => ({ label: n, type: 'county' })),
    ...cityNames.map(n => ({ label: n, type: 'city' })),
  ];

  let activeIdx = -1;

  function show(items) {
    if (!items.length) { hide(); return; }
    dropdown.innerHTML = items.slice(0, 50).map((a, i) => `
      <li class="dropdown-item" role="option" data-value="${a.label}" data-type="${a.type}"
          aria-selected="false" id="drop-item-${i}">
        <span class="item-label">${a.label}</span>
        <span class="item-type ${a.type}">${a.type}</span>
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
    _setAreaLabels(label);
    if (type !== _state.aggregation) {
      _state.aggregation = type;
      _setActiveToggle('aggregation-toggle', type);
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
    const items = dropdown.querySelectorAll('.dropdown-item');
    if (!items.length) return;
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
    const item = e.target.closest('.dropdown-item');
    if (item) selectItem(item.dataset.value, item.dataset.type);
  });

  document.addEventListener('click', e => {
    if (!e.target.closest('.search-wrapper')) hide();
  });
}

function _highlightItem(items, idx) {
  items.forEach((el, i) => {
    el.classList.toggle('highlighted', i === idx);
    el.setAttribute('aria-selected', i === idx ? 'true' : 'false');
  });
  items[idx]?.scrollIntoView({ block: 'nearest' });
}
