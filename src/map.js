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

// ── Initial map view (centered on Wasatch Front) ─────────────────────────────
const INITIAL_VIEW = { center: [-111.89, 40.60], zoom: 8 };

// ── Module state ─────────────────────────────────────────────────────────────
let map = null;
let deckOverlay = null;

/**
 * Initialize MapLibre map and attach the deck.gl overlay.
 *
 * @param {string} containerId
 * @param {'light'|'dark'} theme
 * @returns {{ map, deckOverlay }}
 */
export function initMap(containerId, theme = 'light') {
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
      const from = object.home_name;
      const to   = object.work_name;
      const count = Number(object.S000).toLocaleString();
      return {
        html: `<strong>${from} &rarr; ${to}</strong><br>${count} commuters`,
        style: {
          backgroundColor: theme === 'dark' ? '#1a1a2e' : '#fff',
          color: theme === 'dark' ? '#e8e8f0' : '#1a1a1a',
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
    map.addControl(deckOverlay);
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right');
  });

  return { map, deckOverlay };
}

/**
 * Switch the base map tile style for light/dark mode.
 * Re-attaches the deck.gl overlay after MapLibre reloads the WebGL context.
 *
 * @param {'light'|'dark'} theme
 * @param {function} onReady - called once the style has reloaded
 */
export function switchTheme(theme, onReady) {
  if (!map) return;
  map.setStyle(buildStyle(theme));
  map.once('style.load', () => {
    map.addControl(deckOverlay);
    onReady?.();
  });
}

/**
 * Update the deck.gl ArcLayer with new flow data.
 *
 * @param {Array} flows  - enriched flow records (with home_lat, home_lon, work_lat, work_lon)
 * @param {object} state - app state (theme, direction, etc.)
 * @param {function} onArcClick - called with a flow record when user clicks an arc
 */
export function updateLayers(flows, state, onArcClick) {
  if (!deckOverlay) return;

  if (!flows.length) {
    deckOverlay.setProps({ layers: [] });
    return;
  }

  const maxFlow = Math.max(...flows.map(d => d.S000), 1);

  // Orange color from reference app; slightly warmer in dark mode
  const baseRgb = state.theme === 'dark' ? [255, 180, 60] : [255, 140, 0];

  const arcLayer = new ArcLayer({
    id: 'commute-arcs',
    data: flows,
    getSourcePosition: d => [d.home_lon, d.home_lat],
    getTargetPosition: d => [d.work_lon, d.work_lat],
    // Source (origin) fades out; target (destination) is more opaque → shows direction
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

/**
 * Fly the map to a specific lat/lon.
 */
export function flyToArea(lat, lon, zoom = 10) {
  map?.flyTo({ center: [lon, lat], zoom, duration: 1000 });
}

/**
 * Fit the map to show all arc endpoints.
 *
 * @param {Array} flows - enriched flows with lat/lon
 */
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
