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

// ── Custom tooltip (FlowmapLayer onHover is async — can't use MapboxOverlay.getTooltip) ──

function _ensureTooltip() {
  if (!_tooltipEl) {
    _tooltipEl = document.createElement('div');
    _tooltipEl.style.cssText = [
      'position:fixed', 'pointer-events:none', 'z-index:1000',
      'display:none', 'font-size:13px', 'border-radius:6px',
      'padding:6px 10px', 'box-shadow:0 2px 8px rgba(0,0,0,0.25)',
      'line-height:1.4', 'max-width:240px',
    ].join(';');
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
  el.style.left   = `${rect.left + info.x + 14}px`;
  el.style.top    = `${rect.top  + info.y - 36}px`;
  el.style.background = _theme === 'dark' ? '#1a1a2e' : '#fff';
  el.style.color      = _theme === 'dark' ? '#e8e8f0' : '#1a1a1a';
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
  map.setStyle(buildStyle(theme));
  map.once('style.load', () => {
    _addBoundaryLayers();
    map.addControl(deckOverlay);
    onReady?.();
  });
}

// ── Flow map layer ────────────────────────────────────────────────────────────

export function updateLayers(flows, state, onArcClick) {
  if (!deckOverlay) return;

  if (!flows.length) {
    deckOverlay.setProps({ layers: [] });
    _hideTooltip();
    return;
  }

  // Build unique location nodes from enriched flow data
  const locMap = new Map();
  flows.forEach(f => {
    if (!locMap.has(f.home_name)) {
      locMap.set(f.home_name, { id: f.home_name, lat: f.home_lat, lon: f.home_lon, name: f.home_name });
    }
    if (!locMap.has(f.work_name)) {
      locMap.set(f.work_name, { id: f.work_name, lat: f.work_lat, lon: f.work_lon, name: f.work_name });
    }
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
    colorScheme: 'Oranges',
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
        const count = Number(obj.count).toLocaleString();
        _showTooltip(info, `<strong>${obj.origin?.id ?? ''} &rarr; ${obj.dest?.id ?? ''}</strong><br>${count} commuters`);
      } else if (obj.type === 'location') {
        _showTooltip(info, `<strong>${obj.name ?? obj.location?.id ?? ''}</strong>`);
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
  if (!map?.isStyleLoaded()) return;

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
    map.setPaintProperty(layers.fill, 'fill-color', 'rgba(0,0,0,0)');
    return;
  }

  const maxFlow = Math.max(...flows.map(d => Number(d.S000)), 1);
  const [r, g, b] = theme === 'dark' ? [255, 180, 60] : [255, 140, 0];

  const matchPairs = [];

  // Selected area: subtle highlight (it's the origin, not a destination)
  if (selectedArea) {
    const selFill = theme === 'dark' ? 'rgba(100,150,220,0.12)' : 'rgba(26,58,92,0.08)';
    matchPairs.push(selectedArea, selFill);
  }

  // Destination zones: orange choropleth proportional to flow volume
  flows.forEach(f => {
    const opacity = (0.06 + 0.60 * Math.sqrt(f.S000 / maxFlow)).toFixed(3);
    matchPairs.push(f.dest_name, `rgba(${r},${g},${b},${opacity})`);
  });

  const colorExpr = matchPairs.length
    ? ['match', ['get', 'name'], ...matchPairs, 'rgba(0,0,0,0)']
    : 'rgba(0,0,0,0)';

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

  const outlineColor     = _theme === 'dark' ? 'rgba(160,195,240,0.6)'  : 'rgba(40,70,110,0.25)';
  const outlineColorCity = _theme === 'dark' ? 'rgba(160,195,240,0.4)'  : 'rgba(40,70,110,0.18)';
  const selColor         = _theme === 'dark' ? '#7ab8f5'                : '#1a3a5c';

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
