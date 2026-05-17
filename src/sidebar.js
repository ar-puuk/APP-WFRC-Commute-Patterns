/**
 * Sidebar UI — searchable area dropdown, direction/aggregation toggles,
 * stats block, and Top 10 list.
 */

let _state = null;
let _onSelectionChange = null;
let _onAreaFly = null;

/**
 * Render the full sidebar and wire up all controls.
 *
 * @param {object} opts
 * @param {string[]}  opts.cityNames
 * @param {string[]}  opts.countyNames
 * @param {object}    opts.state
 * @param {function}  opts.onSelectionChange
 * @param {function}  opts.onAreaFly          - called with (lat, lon) to fly the map
 */
export function initSidebar({ cityNames, countyNames, state, onSelectionChange, onAreaFly }) {
  _state = state;
  _onSelectionChange = onSelectionChange;
  _onAreaFly = onAreaFly;

  const sidebar = document.getElementById('sidebar');
  sidebar.innerHTML = `
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
      <div id="top-ten-wrap" hidden>
        <div id="top-ten-title" class="top-ten-title"></div>
        <ol id="top-ten-list" class="top-ten-list"></ol>
      </div>
      <div id="no-data-msg" class="no-data-msg" hidden>
        No commute data found for this area.
      </div>
    </div>

    <div class="sidebar-legend">
      <div class="legend-title">Commuter volume</div>
      <div class="legend-bar">
        <span class="legend-label">Fewer</span>
        <div class="legend-gradient"></div>
        <span class="legend-label">More</span>
      </div>
    </div>
  `;

  // Populate area label spans
  _setAreaLabels(state.selectedArea);

  // Wire up searchable dropdown
  _initDropdown(cityNames, countyNames);

  // Wire direction toggle
  document.getElementById('direction-toggle').addEventListener('click', e => {
    const btn = e.target.closest('[data-value]');
    if (!btn) return;
    _state.direction = btn.dataset.value;
    _setActiveToggle('direction-toggle', btn.dataset.value);
    _onSelectionChange();
  });

  // Wire aggregation toggle
  document.getElementById('aggregation-toggle').addEventListener('click', e => {
    const btn = e.target.closest('[data-value]');
    if (!btn) return;
    _state.aggregation = btn.dataset.value;
    _setActiveToggle('aggregation-toggle', btn.dataset.value);
    _onSelectionChange();
  });

  // Sync toggle UI to initial state
  _setActiveToggle('direction-toggle', state.direction);
  _setActiveToggle('aggregation-toggle', state.aggregation);

  document.getElementById('area-search').value = state.selectedArea;
}

/**
 * Update the stats panel and Top 10 list after a query returns.
 *
 * @param {Array}  flows     - query results with dest_name and S000
 * @param {number} total     - total S000 for the selected area
 * @param {object} appState  - current app state (direction, aggregation, selectedArea, etc.)
 * @param {object} dstMeta   - destination metadata lookup {name → {lat, lon}}
 */
export function updateSidebarStats(flows, total, appState, dstMeta) {
  const state = appState;
  const statsEl  = document.getElementById('area-stats');
  const topWrap  = document.getElementById('top-ten-wrap');
  const noData   = document.getElementById('no-data-msg');
  const topTitle = document.getElementById('top-ten-title');
  const topList  = document.getElementById('top-ten-list');

  const dirLabel  = state.direction === 'outflow' ? 'Residing in' : 'Working in';
  const destLabel = state.direction === 'outflow'
    ? (state.aggregation === 'city' ? 'Cities' : 'Counties') + ' Where Residents Work'
    : (state.aggregation === 'city' ? 'Cities' : 'Counties') + ' Where Workers Live';

  statsEl.innerHTML =
    `<strong>Commuters ${dirLabel} ${state.selectedArea}: ${total.toLocaleString()}</strong>`;

  if (!flows.length) {
    topWrap.hidden = true;
    noData.hidden = false;
    return;
  }

  noData.hidden = true;
  topWrap.hidden = false;
  topTitle.innerHTML = `<strong>Top Ten ${destLabel}</strong>`;

  const top10 = flows.slice(0, 10);

  topList.innerHTML = top10.map((d, i) => {
    const dest = d.dest_name;
    const pct  = total > 0 ? Math.round((d.S000 / total) * 100) : 0;
    return `
      <li class="top-ten-item" data-area="${dest}" tabindex="0" role="button"
          aria-label="${dest}: ${Number(d.S000).toLocaleString()} commuters">
        <span class="rank">${i + 1}</span>
        <span class="area-name">${dest}</span>
        <span class="count-col">
          <span class="count">${Number(d.S000).toLocaleString()}</span>
          <span class="pct">${pct}%</span>
        </span>
      </li>
    `;
  }).join('');

  // Click/Enter on Top 10 item → select it as new area
  topList.querySelectorAll('.top-ten-item').forEach(item => {
    const activate = () => {
      const areaName = item.dataset.area;
      // The destination type matches the current aggregation level
      _state.selectedAreaType = state.aggregation;
      _selectArea(areaName);
      const meta = dstMeta?.[areaName];
      if (meta?.lat) _onAreaFly?.(meta.lat, meta.lon);
    };
    item.addEventListener('click', activate);
    item.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') activate(); });
  });
}

// ── Internal helpers ─────────────────────────────────────────────────────────

function _setAreaLabels(name) {
  const short = name.length > 20 ? name.slice(0, 18) + '…' : name;
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

  // Counties appear first in the combined list with a type tag
  const allAreas = [
    ...countyNames.map(n => ({ label: n, type: 'county' })),
    ...cityNames.map(n => ({ label: n, type: 'city' })),
  ];

  let activeIdx = -1;

  function show(items) {
    if (!items.length) {
      hide();
      return;
    }
    dropdown.innerHTML = items.slice(0, 50).map((a, i) => `
      <li
        class="dropdown-item"
        role="option"
        data-value="${a.label}"
        data-type="${a.type}"
        aria-selected="false"
        id="drop-item-${i}"
      >
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

    // Auto-switch aggregation to match the selected geography type
    // (user can always override it manually after)
    if (type !== _state.aggregation) {
      _state.aggregation = type;
      _setActiveToggle('aggregation-toggle', type);
    }

    hide();
    _onSelectionChange();
  }

  input.addEventListener('input', () => {
    const q = input.value.trim().toLowerCase();
    if (!q) {
      show(allAreas.slice(0, 30));
      return;
    }
    const matches = allAreas.filter(a => a.label.toLowerCase().includes(q));
    show(matches);
  });

  input.addEventListener('focus', () => {
    const q = input.value.trim().toLowerCase();
    const items = q
      ? allAreas.filter(a => a.label.toLowerCase().includes(q))
      : allAreas.slice(0, 30);
    show(items);
  });

  // Keyboard navigation within dropdown
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
    if (!item) return;
    selectItem(item.dataset.value, item.dataset.type);
  });

  // Close dropdown when clicking elsewhere
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
