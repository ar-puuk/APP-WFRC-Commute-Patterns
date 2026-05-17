import maplibregl from 'maplibre-gl';
import { MapboxOverlay } from '@deck.gl/mapbox';
import { FlowmapLayer } from '@flowmap.gl/layers';

// ── Base map tile styles ─────────────────────────────────────────────────────

const ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a> contributors ' +
  '&copy; <a href="https://carto.com/attributions" target="_blank">CARTO</a>';

// Carto raster tiles — free, no API key, subdomain load-balanced
const TILE_URLS = {
  light: [
    'https://a.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}@2x.png',
    'https://b.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}@2x.png',
    'https://c.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}@2x.png',
    'https://d.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}@2x.png',
  ],
  dark: [
    'https://a.basemaps.cartocdn.com/rastertiles/dark_all/{z}/{x}/{y}@2x.png',
    'https://b.basemaps.cartocdn.com/rastertiles/dark_all/{z}/{x}/{y}@2x.png',
    'https://c.basemaps.cartocdn.com/rastertiles/dark_all/{z}/{x}/{y}@2x.png',
    'https://d.basemaps.cartocdn.com/rastertiles/dark_all/{z}/{x}/{y}@2x.png',
  ],
};

function buildStyle(theme) {
  return {
    version: 8,
    glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
    sources: {
      basemap: {
        type: 'raster',
        tiles: TILE_URLS[theme],
        tileSize: 256,
        attribution: ATTRIBUTION,
      },
    },
    layers: [{ id: 'basemap', type: 'raster', source: 'basemap' }],
  };
}

const INITIAL_VIEW = { center: [-111.89, 40.60], zoom: 8 };

// ── Module state ─────────────────────────────────────────────────────────────
let map         = null;
let deckOverlay = null;
let _theme      = 'light';
let _boundaries = { county: null, city: null };
// Stored so it can be replayed after boundary layers are added asynchronously
let _pendingChoropleth = null;
let _tooltipEl  = null;
let _flowVisible     = true;
let _polygonsVisible = true;
// Cached for replay when toggling visibility
let _lastFlowArgs = null;
let _selfFlowCount = 0;

// ── Custom tooltip (FlowmapLayer onHover is async — can't use MapboxOverlay.getTooltip) ──

function _ensureTooltip() {
  if (!_tooltipEl) {
    _tooltipEl = document.createElement('div');
    _tooltipEl.className = 'map-tooltip';
    document.body.appendChild(_tooltipEl);
  }
  return _tooltipEl;
}

function _showTooltip(info, html) {
  const el = _ensureTooltip();
  const container = map?.getContainer();
  if (!container) return;
  const rect = container.getBoundingClientRect();
  el.innerHTML = html;
  el.style.display = 'block';
  el.style.left = `${rect.left + info.x + 16}px`;
  el.style.top  = `${rect.top  + info.y - 12}px`;
}

function _hideTooltip() {
  if (_tooltipEl) _tooltipEl.style.display = 'none';
}

// ── Initialization ───────────────────────────────────────────────────────────

export function initMap(containerId, theme = 'light') {
  _theme = theme;

  map = new maplibregl.Map({
    container: containerId,
    style: buildStyle(theme),
    ...INITIAL_VIEW,
    maxZoom: 14,
    minZoom: 5,
    attributionControl: false,
  });

  deckOverlay = new MapboxOverlay({
    interleaved: false,
    layers: [],
  });

  map.on('load', () => {
    _addBoundaryLayers();
    map.addControl(deckOverlay);
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right');
  });

  return { map, deckOverlay };
}

// ── Theme switch ─────────────────────────────────────────────────────────────

export function switchTheme(theme, onReady) {
  if (!map) return;
  _theme = theme;
  _hideTooltip();

  // Swap tile URLs in-place — avoids setStyle() which destroys all sources/layers
  // and makes style.load-based layer restoration unreliable.
  map.getSource('basemap')?.setTiles(TILE_URLS[theme]);

  // Update boundary outline/selection colors for the new theme
  const outlineColor     = theme === 'dark' ? 'rgba(80,210,230,0.5)'  : 'rgba(0,100,120,0.30)';
  const outlineColorCity = theme === 'dark' ? 'rgba(80,210,230,0.35)' : 'rgba(0,100,120,0.22)';
  const selColor         = theme === 'dark' ? '#50d2e6'               : '#007888';
  if (map.getLayer('county-outline'))  map.setPaintProperty('county-outline',  'line-color', outlineColor);
  if (map.getLayer('county-selected')) map.setPaintProperty('county-selected', 'line-color', selColor);
  if (map.getLayer('city-outline'))    map.setPaintProperty('city-outline',    'line-color', outlineColorCity);
  if (map.getLayer('city-selected'))   map.setPaintProperty('city-selected',   'line-color', selColor);

  // Re-render choropleth and flow layer with the new theme immediately
  if (_pendingChoropleth) {
    const { flows, selectedArea, aggregation } = _pendingChoropleth;
    updateChoropleth(flows, selectedArea, aggregation, theme);
  }
  if (_lastFlowArgs) updateLayers(..._lastFlowArgs);

  // Full re-query so charts etc. also reflect the new theme
  onReady?.();
}

// ── Flow map layer ────────────────────────────────────────────────────────────

export function setFlowVisible(v) {
  _flowVisible = v;
  if (_lastFlowArgs) updateLayers(..._lastFlowArgs);
}

export function setPolygonsVisible(v) {
  _polygonsVisible = v;
  if (!v) {
    ['county-fill','county-outline','county-selected','city-fill','city-outline','city-selected'].forEach(id => {
      if (map?.getLayer(id)) map.setLayoutProperty(id, 'visibility', 'none');
    });
  } else if (_pendingChoropleth) {
    const { flows, selectedArea, aggregation, theme } = _pendingChoropleth;
    updateChoropleth(flows, selectedArea, aggregation, theme);
  }
}

export function setSelfFlow(count) {
  _selfFlowCount = count ?? 0;
}

export function updateLayers(flows, state, onArcClick, total = 0) {
  if (!deckOverlay) return;
  _lastFlowArgs = [flows, state, onArcClick, total];

  if (!flows.length || !_flowVisible) {
    deckOverlay.setProps({ layers: [] });
    _hideTooltip();
    return;
  }

  const locMap = new Map();
  const flowTotals = new Map();   // "home||work" → dest_total
  flows.forEach(f => {
    if (!locMap.has(f.home_name)) locMap.set(f.home_name, { id: f.home_name, lat: f.home_lat, lon: f.home_lon, name: f.home_name });
    if (!locMap.has(f.work_name)) locMap.set(f.work_name, { id: f.work_name, lat: f.work_lat, lon: f.work_lon, name: f.work_name });
    flowTotals.set(`${f.home_name}||${f.work_name}`, Number(f.dest_total ?? 0));
  });

  const flowLayer = new FlowmapLayer({
    id: 'commute-flows',
    data: {
      locations: Array.from(locMap.values()),
      flows: flows.map(f => ({ origin: f.home_name, dest: f.work_name, count: Number(f.S000) })),
    },
    getLocationId:    loc  => loc.id,
    getLocationLat:   loc  => loc.lat,
    getLocationLon:   loc  => loc.lon,
    getLocationName:  loc  => loc.name,
    getFlowOriginId:  flow => flow.origin,
    getFlowDestId:    flow => flow.dest,
    getFlowMagnitude: flow => flow.count,
    darkMode: state.theme === 'dark',
    flowLinesRenderingMode: 'animated-straight',
    clusteringEnabled: false,
    locationTotalsEnabled: true,
    locationLabelsEnabled: false,
    fadeEnabled: true,
    adaptiveScalesEnabled: true,
    flowLineThicknessScale: 1.5,
    pickable: true,
    onHover: (info) => {
      const obj = info?.object;
      if (!obj || !info.picked) { _hideTooltip(); return; }
      if (obj.type === 'flow') {
        const count     = Number(obj.count);
        const originId  = obj.origin?.id ?? '';
        const destId    = obj.dest?.id   ?? '';
        const destTotal = flowTotals.get(`${originId}||${destId}`) ?? 0;
        const isOutflow = state.direction === 'outflow';

        const selPct = total     > 0 ? (count / total     * 100).toFixed(1) : null;
        const dstPct = destTotal > 0 ? (count / destTotal * 100).toFixed(1) : null;

        const row = (pct, label) =>
          `<div class="ft-row"><span class="ft-pct">${pct}%</span><span class="ft-label">${label}</span></div>`;

        const selRow = selPct ? row(selPct, isOutflow
          ? `of <strong>${originId}</strong> residents`
          : `of workers in <strong>${destId}</strong>`) : '';
        const dstRow = dstPct ? row(dstPct, isOutflow
          ? `of workers in <strong>${destId}</strong>`
          : `of <strong>${originId}</strong> residents`) : '';

        _showTooltip(info, `
          <div class="ft-route">${originId} <span class="ft-arrow">→</span> ${destId}</div>
          <div class="ft-count">${count.toLocaleString()}<span class="ft-unit">commuters</span></div>
          ${selRow || dstRow ? `<div class="ft-divider"></div>${selRow}${dstRow}` : ''}
        `);
      } else if (obj.type === 'location') {
        const locId = obj.name ?? obj.location?.id ?? '';
        if (locId === state.selectedArea && _selfFlowCount > 0) {
          _showTooltip(info, `
            <div class="ft-route">${locId}</div>
            <div class="ft-count">${Number(_selfFlowCount).toLocaleString()}<span class="ft-unit">live &amp; work here</span></div>
          `);
        } else {
          _showTooltip(info, `<div class="ft-route">${locId}</div>`);
        }
      } else {
        _hideTooltip();
      }
    },
    onClick: (info) => {
      _hideTooltip();
      if (!onArcClick) return;
      const obj = info?.object;
      if (!obj) return;
      if (obj.type === 'flow') {
        const destId = obj.dest?.id;
        if (destId) onArcClick({ dest_name: destId });
      } else if (obj.type === 'location') {
        const locId = obj.location?.id;
        if (locId) onArcClick({ dest_name: locId });
      }
    },
  });

  deckOverlay.setProps({ layers: [flowLayer] });
}

// ── Polygon choropleth ────────────────────────────────────────────────────────

/**
 * Load boundary GeoJSON files and register them as MapLibre sources.
 * Returns true if both files loaded, false if either was missing (graceful).
 */
export async function loadBoundaries(base, theme) {
  _theme = theme;
  try {
    const [countyGj, cityGj] = await Promise.all([
      fetch(`${base}data/county_boundaries.geojson`).then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      }),
      fetch(`${base}data/city_boundaries.geojson`).then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      }),
    ]);
    _boundaries = { county: countyGj, city: cityGj };

    // If map style is already loaded, add layers now
    if (map?.isStyleLoaded()) _addBoundaryLayers();
    return true;
  } catch (e) {
    console.info('Boundary files not available — polygon layer disabled. Run: uv run scripts/process_data.py --boundaries');
    return false;
  }
}

/**
 * Update choropleth fill colours to reflect the current flow data.
 * Called after each data refresh.
 */
export function updateChoropleth(flows, selectedArea, aggregation, theme) {
  _pendingChoropleth = { flows, selectedArea, aggregation, theme };
  if (!map) return;
  // Note: isStyleLoaded() can return false inside the load event callback itself,
  // so we rely on getLayer() below to bail out when layers aren't ready yet.

  const isCounty = aggregation === 'county';
  const layers = {
    fill:    isCounty ? 'county-fill'     : 'city-fill',
    outline: isCounty ? 'county-outline'  : 'city-outline',
    sel:     isCounty ? 'county-selected' : 'city-selected',
    offFill: isCounty ? 'city-fill'       : 'county-fill',
    offOut:  isCounty ? 'city-outline'    : 'county-outline',
    offSel:  isCounty ? 'city-selected'   : 'county-selected',
  };

  if (!map.getLayer(layers.fill)) return;

  // If polygons hidden, keep everything invisible
  if (!_polygonsVisible) {
    ['county-fill','county-outline','county-selected','city-fill','city-outline','city-selected'].forEach(id => {
      if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', 'none');
    });
    return;
  }

  // Toggle layer visibility
  map.setLayoutProperty(layers.fill,    'visibility', 'visible');
  map.setLayoutProperty(layers.outline, 'visibility', 'visible');
  map.setLayoutProperty(layers.sel,     'visibility', 'visible');
  if (map.getLayer(layers.offFill)) map.setLayoutProperty(layers.offFill, 'visibility', 'none');
  if (map.getLayer(layers.offOut))  map.setLayoutProperty(layers.offOut,  'visibility', 'none');
  if (map.getLayer(layers.offSel))  map.setLayoutProperty(layers.offSel,  'visibility', 'none');

  // Highlight selected area with a distinct outline
  map.setFilter(layers.sel, ['==', ['get', 'name'], selectedArea ?? '']);

  if (!flows.length) {
    map.setPaintProperty(layers.fill, 'fill-color', ['rgba', 0, 0, 0, 0]);
    return;
  }

  const maxFlow = Math.max(...flows.map(d => Number(d.S000)), 1);

  const matchPairs = [];

  // Selected area: subtle teal highlight (it's the origin, not a destination)
  if (selectedArea) {
    const selColor = theme === 'dark'
      ? ['rgba', 40, 130, 155, 0.28]
      : ['rgba',  0, 120, 140, 0.14];
    matchPairs.push(selectedArea, selColor);
  }

  // Destination zones: teal choropleth proportional to flow volume.
  // Light mode: alpha ramp (dark teal, transparent→opaque on white bg).
  // Dark mode: luminosity ramp (dark→bright teal at fixed opacity) — inverted so
  // high-flow zones read as bright against the dark basemap.
  flows.forEach(f => {
    const t = Math.sqrt(Number(f.S000) / maxFlow);
    // Both themes scale opacity AND color for maximum clarity.
    // Light: dark teal, opacity 0.08→0.80 (transparent→opaque on white bg).
    // Dark:  luminosity 0.30→0.88 opacity + dark→bright teal (low blends into dark bg, high glows).
    const rgba = theme === 'dark'
      ? ['rgba', Math.round(20 + t * 80), Math.round(70 + t * 150), Math.round(90 + t * 150),
          parseFloat((0.30 + 0.58 * t).toFixed(3))]
      : ['rgba', 0, 120, 140, parseFloat((0.08 + 0.72 * t).toFixed(3))];
    matchPairs.push(f.dest_name, rgba);
  });

  // match expression: ['match', input, label, output, ..., fallback]
  // outputs are ['rgba', r, g, b, a] sub-expressions — the only reliable color form in MapLibre
  const colorExpr = matchPairs.length
    ? ['match', ['get', 'name'], ...matchPairs, ['rgba', 0, 0, 0, 0]]
    : ['rgba', 0, 0, 0, 0];

  map.setPaintProperty(layers.fill, 'fill-color', colorExpr);
}

// ── Fly / fit ─────────────────────────────────────────────────────────────────

export function flyToArea(lat, lon, zoom = 10) {
  map?.flyTo({ center: [lon, lat], zoom, duration: 1000 });
}

export function fitToFlows(flows) {
  if (!map || !flows.length) return;
  const lons = flows.flatMap(d => [d.home_lon, d.work_lon]).filter(Boolean);
  const lats = flows.flatMap(d => [d.home_lat, d.work_lat]).filter(Boolean);
  if (!lons.length) return;
  map.fitBounds(
    [[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]],
    { padding: 60, duration: 800, maxZoom: 11 }
  );
}

// ── Internal: add boundary layers after style load ────────────────────────────

function _addBoundaryLayers() {
  if (!map || !_boundaries.county || !_boundaries.city) return;

  const outlineColor     = _theme === 'dark' ? 'rgba(80,210,230,0.5)'   : 'rgba(0,100,120,0.30)';
  const outlineColorCity = _theme === 'dark' ? 'rgba(80,210,230,0.35)'  : 'rgba(0,100,120,0.22)';
  const selColor         = _theme === 'dark' ? '#50d2e6'                : '#007888';

  // Add (or replace) GeoJSON sources
  if (map.getSource('county-zones')) {
    map.getSource('county-zones').setData(_boundaries.county);
  } else {
    map.addSource('county-zones', { type: 'geojson', data: _boundaries.county });
  }
  if (map.getSource('city-zones')) {
    map.getSource('city-zones').setData(_boundaries.city);
  } else {
    map.addSource('city-zones', { type: 'geojson', data: _boundaries.city });
  }

  // County layers — add if missing, then always sync paint to current theme
  if (!map.getLayer('county-fill')) {
    map.addLayer({ id: 'county-fill',     type: 'fill', source: 'county-zones', paint: { 'fill-color': 'rgba(0,0,0,0)' } });
    map.addLayer({ id: 'county-outline',  type: 'line', source: 'county-zones', paint: { 'line-color': outlineColor,     'line-width': 1   } });
    map.addLayer({ id: 'county-selected', type: 'line', source: 'county-zones', filter: ['==', ['get', 'name'], ''], paint: { 'line-color': selColor, 'line-width': 2.5 } });
  } else {
    map.setPaintProperty('county-outline',  'line-color', outlineColor);
    map.setPaintProperty('county-selected', 'line-color', selColor);
  }

  // City layers — add if missing, then always sync paint to current theme
  if (!map.getLayer('city-fill')) {
    map.addLayer({ id: 'city-fill',     type: 'fill', source: 'city-zones', layout: { visibility: 'none' }, paint: { 'fill-color': 'rgba(0,0,0,0)' } });
    map.addLayer({ id: 'city-outline',  type: 'line', source: 'city-zones', layout: { visibility: 'none' }, paint: { 'line-color': outlineColorCity, 'line-width': 0.5 } });
    map.addLayer({ id: 'city-selected', type: 'line', source: 'city-zones', layout: { visibility: 'none' }, filter: ['==', ['get', 'name'], ''], paint: { 'line-color': selColor, 'line-width': 2.5 } });
  } else {
    map.setPaintProperty('city-outline',  'line-color', outlineColorCity);
    map.setPaintProperty('city-selected', 'line-color', selColor);
  }

  // Replay choropleth using the CURRENT theme (not the stored one)
  if (_pendingChoropleth) {
    const { flows, selectedArea, aggregation } = _pendingChoropleth;
    updateChoropleth(flows, selectedArea, aggregation, _theme);
  }
}
