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
    'https://a.basemaps.cartocdn.com/rastertiles/light_all/{z}/{x}/{y}@2x.png',
    'https://b.basemaps.cartocdn.com/rastertiles/light_all/{z}/{x}/{y}@2x.png',
    'https://c.basemaps.cartocdn.com/rastertiles/light_all/{z}/{x}/{y}@2x.png',
    'https://d.basemaps.cartocdn.com/rastertiles/light_all/{z}/{x}/{y}@2x.png',
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

// ── Custom control helpers ────────────────────────────────────────────────────
const _SVG_HOME  = `<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>`;
const _SVG_NORTH = `<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="3 11 22 2 13 21 11 13 3 11"/></svg>`;

function _mapBtn(title, svgHtml, onClick) {
  const btn = document.createElement('button');
  btn.type  = 'button';
  btn.title = title;
  btn.setAttribute('aria-label', title);
  btn.style.cssText = 'display:flex;align-items:center;justify-content:center;width:29px;height:29px;padding:0;cursor:pointer;';
  btn.innerHTML = svgHtml;
  btn.addEventListener('click', onClick);
  return btn;
}

function _makeCtrlGroup(...btns) {
  const el = document.createElement('div');
  el.className = 'maplibregl-ctrl maplibregl-ctrl-group';
  btns.forEach(b => el.appendChild(b));
  return { onAdd: () => el, onRemove: () => el.remove() };
}

// ── Color schemes (choropleth) ────────────────────────────────────────────────
// SCHEME_TEAL mirrors flowmap.gl's built-in schemeTeal exactly.
// SCHEME_ORANGE uses ColorBrewer Oranges (7-class) — same source as
// flowmap.gl's COLOR_SCHEMES['Oranges'] = asScheme(schemeOranges).
// For the MapLibre choropleth we reverse manually for dark mode.
// FlowmapLayer uses the named strings 'Teal' / 'Oranges' directly so it
// handles the dark-mode reversal itself (array path skips that step).
const SCHEME_TEAL   = ['#d1eeea','#a8dbd9','#85c4c9','#68abb8','#4f90a6','#3b738f','#2a5674'];
const SCHEME_ORANGE = ['#feedde','#fdd0a2','#fdae6b','#fd8d3c','#f16913','#d94801','#8c2d04'];

// Linear interpolation through an RGB hex color array (mirrors D3 interpolateRgbBasis
// but without the dependency; sufficient for the 7-stop choropleth ramp).
function _lerpScheme(scheme, t) {
  t = Math.max(0, Math.min(1, t));
  const n = scheme.length - 1;
  const i = Math.min(Math.floor(t * n), n - 1);
  const f = t * n - i;
  const hex = h => [parseInt(h.slice(1,3),16), parseInt(h.slice(3,5),16), parseInt(h.slice(5,7),16)];
  const [r1,g1,b1] = hex(scheme[i]);
  const [r2,g2,b2] = hex(scheme[i+1]);
  return [Math.round(r1+f*(r2-r1)), Math.round(g1+f*(g2-g1)), Math.round(b1+f*(b2-b1))];
}

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
let _direction    = 'outflow';
let _selfFlowCount    = 0;
let _selfOutTotal     = 0;   // total commuters who reside in selected area
let _selfInTotal      = 0;   // total workers employed in selected area

// ── Donut SVG helper ─────────────────────────────────────────────────────────

function _donutSvg(pct, strokeColor, size = 66) {
  const r   = size * 0.38;
  const cx  = size / 2;
  const cy  = size / 2;
  const C   = 2 * Math.PI * r;
  const arc = ((Math.min(Math.max(pct, 0), 100) / 100) * C).toFixed(2);
  const fs  = Math.round(size * 0.195);
  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" style="display:block">
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke-width="5.5"
      style="stroke:var(--rule-strong)"/>
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke-width="5.5"
      stroke-linecap="round"
      stroke-dasharray="${arc} ${C.toFixed(2)}"
      transform="rotate(-90 ${cx} ${cy})"
      style="stroke:${strokeColor}"/>
    <text x="${cx}" y="${cy}" text-anchor="middle" dominant-baseline="middle"
      font-size="${fs}" font-weight="700"
      style="fill:var(--ink);font-family:'Inter',sans-serif">${pct}%</text>
  </svg>`;
}

// ── Custom tooltip (FlowmapLayer onHover is async — can't use MapboxOverlay.getTooltip) ──

function _ensureTooltip() {
  if (!_tooltipEl) {
    _tooltipEl = document.createElement('div');
    _tooltipEl.className = 'map-tooltip';
    document.body.appendChild(_tooltipEl);
  }
  return _tooltipEl;
}

function _showTooltip(info, html, extraClass = '') {
  const el = _ensureTooltip();
  const container = map?.getContainer();
  if (!container) return;
  const rect = container.getBoundingClientRect();
  el.className = extraClass ? `map-tooltip ${extraClass}` : 'map-tooltip';
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

    // Zoom + compass (clicking compass resets bearing; visualizePitch tilts needle)
    map.addControl(new maplibregl.NavigationControl({ showCompass: true, visualizePitch: true }), 'top-right');

    // Reset tilt & north + reset to WFRC region
    map.addControl(_makeCtrlGroup(
      _mapBtn('Reset tilt & north', _SVG_NORTH, () => map.easeTo({ pitch: 0, bearing: 0, duration: 300 })),
      _mapBtn('Reset view',         _SVG_HOME,  () => map.flyTo({ ...INITIAL_VIEW, pitch: 0, bearing: 0 })),
    ), 'top-right');

    // Geolocate
    map.addControl(new maplibregl.GeolocateControl({
      positionOptions:  { enableHighAccuracy: true },
      trackUserLocation: false,
    }), 'top-right');

    // Fullscreen
    map.addControl(new maplibregl.FullscreenControl(), 'top-right');

    // Scale bar
    map.addControl(new maplibregl.ScaleControl({ maxWidth: 110, unit: 'imperial' }), 'bottom-left');

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

  // Update boundary outlines to neutral gray (selection color handled by updateChoropleth)
  const outlineColor     = theme === 'dark' ? 'rgba(232,229,220,0.15)' : 'rgba(18,23,38,0.18)';
  const outlineColorCity = theme === 'dark' ? 'rgba(232,229,220,0.10)' : 'rgba(18,23,38,0.12)';
  if (map.getLayer('county-outline')) map.setPaintProperty('county-outline', 'line-color', outlineColor);
  if (map.getLayer('city-outline'))   map.setPaintProperty('city-outline',   'line-color', outlineColorCity);

  // Re-render choropleth (passes direction → updates selected outline color too)
  if (_pendingChoropleth) {
    const { flows, selectedArea, aggregation, direction } = _pendingChoropleth;
    updateChoropleth(flows, selectedArea, aggregation, theme, direction);
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
    const { flows, selectedArea, aggregation, theme, direction } = _pendingChoropleth;
    updateChoropleth(flows, selectedArea, aggregation, theme, direction);
  }
}

export function setSelfFlow(count, outTotal = 0, inTotal = 0) {
  _selfFlowCount = count    ?? 0;
  _selfOutTotal  = outTotal ?? 0;
  _selfInTotal   = inTotal  ?? 0;
}

export function updateLayers(flows, state, onArcClick, total = 0) {
  if (!deckOverlay) return;
  _lastFlowArgs = [flows, state, onArcClick, total];
  _direction    = state.direction;

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

  // Named schemes: flowmap.gl looks these up in its own COLOR_SCHEMES map and
  // reverses them automatically when darkMode=true — arrays skip that step.
  const colorScheme = state.direction === 'outflow' ? 'Oranges' : 'Teal';

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
    colorScheme,
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

        const selPct = total     > 0 ? parseFloat((count / total     * 100).toFixed(1)) : null;
        const dstPct = destTotal > 0 ? parseFloat((count / destTotal * 100).toFixed(1)) : null;

        const selDonut = selPct != null ? _donutSvg(selPct, 'var(--inflow)')   : '';
        const dstDonut = dstPct != null ? _donutSvg(dstPct, 'var(--outflow)') : '';

        // "commuters" = workers who reside in that city; "workforce" = workers employed in that city
        const selLabel = isOutflow
          ? `of <strong>${originId}</strong>'s<br>commuters`
          : `of <strong>${destId}</strong>'s<br>workforce`;
        const dstLabel = isOutflow
          ? `of <strong>${destId}</strong>'s<br>workforce`
          : `of <strong>${originId}</strong>'s<br>commuters`;

        const donuts = (selDonut || dstDonut) ? `
          <div class="ft-divider"></div>
          <div class="ft-donuts">
            ${selDonut ? `<div class="ft-donut-wrap">${selDonut}<div class="ft-donut-label">${selLabel}</div></div>` : ''}
            ${dstDonut ? `<div class="ft-donut-wrap">${dstDonut}<div class="ft-donut-label">${dstLabel}</div></div>` : ''}
          </div>` : '';

        _showTooltip(info, `
          <div class="ft-route">${originId} <span class="ft-arrow">→</span> ${destId}</div>
          <div class="ft-count">${count.toLocaleString()}<span class="ft-unit">commuters</span></div>
          ${donuts}
        `);
      } else if (obj.type === 'location') {
        const locId = obj.name ?? obj.location?.id ?? '';
        if (locId === state.selectedArea && _selfFlowCount > 0) {
          const outPct = _selfOutTotal > 0 ? parseFloat((_selfFlowCount / _selfOutTotal * 100).toFixed(1)) : null;
          const inPct  = _selfInTotal  > 0 ? parseFloat((_selfFlowCount / _selfInTotal  * 100).toFixed(1)) : null;
          const outDonut = outPct != null ? _donutSvg(outPct, 'var(--inflow)')   : '';
          const inDonut  = inPct  != null ? _donutSvg(inPct,  'var(--outflow)') : '';
          _showTooltip(info, `
            <div class="ft-route">${locId}</div>
            <div class="ft-count">${Number(_selfFlowCount).toLocaleString()}<span class="ft-unit">live &amp; work here</span></div>
            ${(outDonut || inDonut) ? `
            <div class="ft-divider"></div>
            <div class="ft-donuts">
              ${outDonut ? `<div class="ft-donut-wrap">${outDonut}<div class="ft-donut-label">of <strong>${locId}</strong>'s<br>commuters</div></div>` : ''}
              ${inDonut  ? `<div class="ft-donut-wrap">${inDonut}<div class="ft-donut-label">of <strong>${locId}</strong>'s<br>workforce</div></div>` : ''}
            </div>` : ''}
          `);
        } else {
          const cta = state.direction === 'outflow'
            ? `Where do <strong>${locId}</strong> residents work?`
            : `Where do <strong>${locId}</strong> workers live?`;
          _showTooltip(info, `<div class="ft-cta">${cta}</div>`, 'map-tooltip--cta');
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
export function updateChoropleth(flows, selectedArea, aggregation, theme, direction = 'outflow') {
  _pendingChoropleth = { flows, selectedArea, aggregation, theme, direction };
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

  // Direction-aware selected-area outline
  const isOutflow    = direction === 'outflow';
  const selLineColor = isOutflow
    ? (theme === 'dark' ? '#e4895a' : '#cc683a')
    : (theme === 'dark' ? '#5aa6a7' : '#1e6f6f');
  map.setFilter(layers.sel, ['==', ['get', 'name'], selectedArea ?? '']);
  if (map.getLayer(layers.sel)) map.setPaintProperty(layers.sel, 'line-color', selLineColor);

  if (!flows.length) {
    map.setPaintProperty(layers.fill, 'fill-color', ['rgba', 0, 0, 0, 0]);
    return;
  }

  const maxFlow = Math.max(...flows.map(d => Number(d.S000)), 1);

  // Pick scheme and reverse for dark mode (mirrors flowmap.gl's internal reversal).
  // Light: lightest color = lowest flow (barely visible on white bg).
  // Dark:  lightest color = highest flow (glows bright on dark bg).
  const baseScheme = isOutflow ? SCHEME_ORANGE : SCHEME_TEAL;
  const scheme     = theme === 'dark' ? [...baseScheme].reverse() : baseScheme;

  const matchPairs = [];

  // Selected area: pin to the lightest stop (step 0) so the origin reads as background.
  if (selectedArea) {
    const [r,g,b] = _lerpScheme(scheme, 0);
    matchPairs.push(selectedArea, ['rgba', r, g, b, theme === 'dark' ? 0.22 : 0.45]);
  }

  // Zone fills: cube-root power scale (exponent 1/3) matching flowmap.gl's createFlowColorScale.
  // Gives more visual separation at the low end than sqrt (1/2) or linear.
  flows.forEach(f => {
    const t     = Math.cbrt(Number(f.S000) / maxFlow);
    const [r,g,b] = _lerpScheme(scheme, t);
    // Alpha: dark mode ramps from near-invisible to fully opaque; light mode similar but shallower.
    const alpha = theme === 'dark'
      ? parseFloat((0.15 + 0.75 * t).toFixed(3))
      : parseFloat((0.12 + 0.72 * t).toFixed(3));
    matchPairs.push(f.dest_name, ['rgba', r, g, b, alpha]);
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

// ── Zoom / reset helpers (wired from main.js) ─────────────────────────────────

export function zoomIn()    { map?.zoomIn(); }
export function zoomOut()   { map?.zoomOut(); }
export function resetView() { map?.flyTo({ ...INITIAL_VIEW, duration: 800 }); }

function _addBoundaryLayers() {
  if (!map || !_boundaries.county || !_boundaries.city) return;

  const outlineColor     = _theme === 'dark' ? 'rgba(232,229,220,0.15)' : 'rgba(18,23,38,0.18)';
  const outlineColorCity = _theme === 'dark' ? 'rgba(232,229,220,0.10)' : 'rgba(18,23,38,0.12)';
  const selColor         = _theme === 'dark' ? '#5aa6a7'                : '#1e6f6f'; // placeholder; updateChoropleth will set direction-aware color

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
    const { flows, selectedArea, aggregation, direction } = _pendingChoropleth;
    updateChoropleth(flows, selectedArea, aggregation, _theme, direction);
  }
}
