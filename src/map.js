import maplibregl from 'maplibre-gl';
import { MapboxOverlay } from '@deck.gl/mapbox';
import { ArcLayer } from '@deck.gl/layers';

// ── Base map tile styles ─────────────────────────────────────────────────────

const ATTRIBUTION =
  '&copy; <a href="https://stadiamaps.com/" target="_blank">Stadia Maps</a> ' +
  '&copy; <a href="https://openmaptiles.org/" target="_blank">OpenMapTiles</a> ' +
  '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a>';

const TILE_URLS = {
  light: 'https://tiles.stadiamaps.com/tiles/alidade_smooth/{z}/{x}/{y}@2x.png',
  dark:  'https://tiles.stadiamaps.com/tiles/alidade_smooth_dark/{z}/{x}/{y}@2x.png',
};

function buildStyle(theme) {
  return {
    version: 8,
    glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
    sources: {
      basemap: {
        type: 'raster',
        tiles: [TILE_URLS[theme]],
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
    getTooltip: ({ object }) => {
      if (!object) return null;
      const count = Number(object.S000).toLocaleString();
      return {
        html: `<strong>${object.home_name} &rarr; ${object.work_name}</strong><br>${count} commuters`,
        style: {
          backgroundColor: _theme === 'dark' ? '#1a1a2e' : '#fff',
          color: _theme === 'dark' ? '#e8e8f0' : '#1a1a1a',
          fontSize: '13px',
          borderRadius: '6px',
          padding: '6px 10px',
          boxShadow: '0 2px 6px rgba(0,0,0,0.25)',
          pointerEvents: 'none',
        },
      };
    },
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

// ── Arc layer ────────────────────────────────────────────────────────────────

export function updateLayers(flows, state, onArcClick) {
  if (!deckOverlay) return;

  if (!flows.length) {
    deckOverlay.setProps({ layers: [] });
    return;
  }

  const maxFlow = Math.max(...flows.map(d => Number(d.S000)), 1);
  const baseRgb = state.theme === 'dark' ? [255, 180, 60] : [255, 140, 0];

  const arcLayer = new ArcLayer({
    id: 'commute-arcs',
    data: flows,
    getSourcePosition: d => [d.home_lon, d.home_lat],
    getTargetPosition: d => [d.work_lon, d.work_lat],
    getSourceColor: d => [...baseRgb, 20 + Math.floor((d.S000 / maxFlow) * 140)],
    getTargetColor: d => [...baseRgb, 60 + Math.floor((d.S000 / maxFlow) * 195)],
    getWidth: d => 1 + Math.sqrt(d.S000 / maxFlow) * 12,
    widthMinPixels: 1,
    widthMaxPixels: 20,
    greatCircle: true,
    numSegments: 64,
    pickable: true,
    onClick: ({ object }) => object && onArcClick?.(object),
    updateTriggers: {
      getSourceColor: [state.theme, maxFlow],
      getTargetColor: [state.theme, maxFlow],
      getWidth: [maxFlow],
    },
  });

  deckOverlay.setProps({ layers: [arcLayer] });
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

  const outlineColor = _theme === 'dark'
    ? 'rgba(130,165,210,0.35)'
    : 'rgba(40,70,110,0.22)';
  const outlineColorCity = _theme === 'dark'
    ? 'rgba(130,165,210,0.2)'
    : 'rgba(40,70,110,0.15)';
  const selColor = _theme === 'dark' ? '#6a9fd8' : '#1a3a5c';

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

  // County layers (default visible)
  if (!map.getLayer('county-fill')) {
    map.addLayer({ id: 'county-fill',    type: 'fill', source: 'county-zones', paint: { 'fill-color': 'rgba(0,0,0,0)' } });
    map.addLayer({ id: 'county-outline', type: 'line', source: 'county-zones', paint: { 'line-color': outlineColor, 'line-width': 1 } });
    map.addLayer({ id: 'county-selected', type: 'line', source: 'county-zones', filter: ['==', ['get', 'name'], ''], paint: { 'line-color': selColor, 'line-width': 2.5 } });
  }

  // City layers (hidden until city aggregation is active)
  if (!map.getLayer('city-fill')) {
    map.addLayer({ id: 'city-fill',    type: 'fill', source: 'city-zones', layout: { visibility: 'none' }, paint: { 'fill-color': 'rgba(0,0,0,0)' } });
    map.addLayer({ id: 'city-outline', type: 'line', source: 'city-zones', layout: { visibility: 'none' }, paint: { 'line-color': outlineColorCity, 'line-width': 0.5 } });
    map.addLayer({ id: 'city-selected', type: 'line', source: 'city-zones', layout: { visibility: 'none' }, filter: ['==', ['get', 'name'], ''], paint: { 'line-color': selColor, 'line-width': 2.5 } });
  }

  // Replay any choropleth that was computed before layers existed
  if (_pendingChoropleth) {
    const { flows, selectedArea, aggregation, theme } = _pendingChoropleth;
    updateChoropleth(flows, selectedArea, aggregation, theme);
  }
}
