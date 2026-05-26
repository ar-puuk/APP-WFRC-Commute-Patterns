# Custom Geography Zone Systems — Architecture Plan

## Overview

The app supports two independent geography choices:

- **Subject area** — the zone whose residents or workers are being analyzed (currently: a named city or county)
- **Display geography** — how destination flows are spatially aggregated and rendered (currently: city or county boundaries)

This plan extends both to support user-defined options: a drawn polygon for subject area, and a user-uploaded GIS file for display geography.

**Dependencies:** DuckDB spatial extension (for all spatial data I/O and PIP operations) + Turf.js (centroid computation only, for arc positioning). No other spatial or format libraries. If the DuckDB spatial extension proof-of-concept does not pass, this feature is not built.

---

## Validation Gate (Do This First)

Before any implementation, run a proof-of-concept in the current app's DuckDB WASM environment to confirm the spatial extension works end-to-end. All three steps must pass:

**Step 1 — Extension loads in the EH bundle on GitHub Pages:**
```js
await conn.query("INSTALL spatial; LOAD spatial;");
```

**Step 2 — ST_Read reads a browser-uploaded file via registerFileBuffer:**
```js
const buf = await uploadedFile.arrayBuffer();
await db.registerFileBuffer('test.gpkg', new Uint8Array(buf));
const result = await conn.query("SELECT * FROM ST_Read('test.gpkg') LIMIT 5;");
// Must return rows with a geometry column
```

**Step 3 — Spatial predicate works on the loaded geometry:**
```js
await conn.query(`
  SELECT zone_name, ST_Within(ST_Point(-111.89, 40.60), geom) AS inside
  FROM ST_Read('test.gpkg')
  LIMIT 10;
`);
```

Test with a real GeoPackage and a real Shapefile (zipped). If any step fails, this feature is not pursued.

---

## The Full Interaction Matrix

|  | **Display: City / County** | **Display: Custom upload** |
|---|---|---|
| **Subject: Named city or county** | ① Current behavior | ② New |
| **Subject: Drawn polygon** | ③ New | ④ New |

**Case ①** is untouched — uses the existing pre-processed `city_flows.parquet` pipeline and stays on the fast path.

**Cases ②③④** all require block-level OD data and the DuckDB spatial extension. The trigger is: any time the user either draws a polygon subject or uploads custom display zones, the app switches to block mode.

---

## Data Files Required

### Always committed to the repo

| File | Size | Description |
|---|---|---|
| `data/block_centroids.parquet` | ~500 KB | One row per WFRC census block: `geocode, lat, lon`. Year-invariant (Census 2020 blocks). Loaded eagerly on app start. |
| `data/city_boundaries.geojson` | 256 KB | Existing city polygons — also used as built-in display zone file in block mode |
| `data/county_boundaries.geojson` | 53 KB | Existing county polygons — same |
| `data/lehd/{year}/city_flows.parquet` | ~284 KB/year | Fast-path for case ① only |

### Loaded on demand (block mode)

| File | Size | Description |
|---|---|---|
| `data/lehd/{year}/block_od.parquet` | ~18–22 MB/year | Block-level OD pairs for WFRC region: `h_geocode, w_geocode, S000, SA01–03, SE01–03, SI01–03, d0_10, d10_25, d25_50, d50p` |

---

## Spatial Stack

| Operation | Tool | Reason |
|---|---|---|
| Read uploaded GIS file (any format) | DuckDB `ST_Read` via spatial extension | GDAL-backed, handles GeoPackage, Shapefile, GeoJSON, FlatGeobuf, KML, and more without any additional JS libraries |
| Point-in-polygon (blocks → zones) | DuckDB `ST_Within` | Runs inside DuckDB alongside the aggregation query — no JS ↔ DuckDB data transfer of 44K block points |
| Arc origin (drawn polygon centroid) | `turf.centroid(polygon)` | Synchronous, lightweight, no DuckDB round-trip needed for a single geometry |
| Arc endpoints (zone centroids) | `turf.centroid(zoneFeature)` | Same — read from already-loaded GeoJSON features in JS |

No other spatial or format libraries are used. If a user uploads a format that GDAL cannot read (confirmed via `ST_Drivers()`), the app shows a clear error message listing supported formats.

---

## Architecture: How All Four Cases Work

### Unified block-mode pipeline (cases ②③④)

All three new cases use the same DuckDB query. The only difference is the source of `subject_geom` and the display zone file.

```sql
-- Load spatial extension (once per session)
INSTALL spatial; LOAD spatial;

-- Load block OD (once per year selection in block mode)
CREATE OR REPLACE VIEW block_od AS
  SELECT * FROM read_parquet('block_od_2023.parquet');

-- Load block centroids (always available)
CREATE OR REPLACE VIEW block_centroids AS
  SELECT * FROM read_parquet('block_centroids.parquet');

-- Load display zones from uploaded file (or from built-in boundary file)
CREATE OR REPLACE TABLE display_zones AS
  SELECT zone_name, geom FROM ST_Read('uploaded.gpkg');
  -- or: SELECT name AS zone_name, geom FROM ST_Read('city_boundaries.geojson')

-- Load subject area geometry (drawn polygon as GeoJSON, or named place boundary)
CREATE OR REPLACE TABLE subject_area AS
  SELECT geom FROM ST_Read('subject.geojson');  -- single-feature GeoJSON

-- Full query: PIP + aggregation in one shot
SELECT
  dz.zone_name   AS dest_name,
  SUM(od.S000)   AS S000,
  SUM(od.SA01)   AS SA01,  SUM(od.SA02)  AS SA02,  SUM(od.SA03)  AS SA03,
  SUM(od.SE01)   AS SE01,  SUM(od.SE02)  AS SE02,  SUM(od.SE03)  AS SE03,
  SUM(od.SI01)   AS SI01,  SUM(od.SI02)  AS SI02,  SUM(od.SI03)  AS SI03,
  SUM(od.d0_10)  AS d0_10, SUM(od.d10_25) AS d10_25,
  SUM(od.d25_50) AS d25_50,SUM(od.d50p)  AS d50p
FROM block_od od
JOIN block_centroids bc_h ON bc_h.geocode = od.h_geocode
JOIN block_centroids bc_w ON bc_w.geocode = od.w_geocode
JOIN display_zones   dz   ON ST_Within(ST_Point(bc_w.lon, bc_w.lat), dz.geom)
JOIN subject_area    sa   ON ST_Within(ST_Point(bc_h.lon, bc_h.lat), sa.geom)
GROUP BY dz.zone_name
ORDER BY S000 DESC;
```

---

### Case-by-case breakdown

**Case ①: Named city/county subject + city/county display**
- Uses existing `city_flows.parquet` and current SQL query logic — unchanged
- Spatial extension not used, block data not loaded

**Case ②: Named city/county subject + custom upload display**
- `subject_area`: single-feature GeoJSON registered as buffer from `city_boundaries.geojson` for the selected named place
- `display_zones`: user-uploaded file registered via `registerFileBuffer`, read by `ST_Read`
- Triggers block mode load

**Case ③: Drawn polygon subject + city/county display**
- `subject_area`: user-drawn polygon serialized to GeoJSON, registered as buffer
- `display_zones`: built-in `city_boundaries.geojson` or `county_boundaries.geojson`, registered as buffer
- City/county boundaries are treated identically to user-uploaded zones — same `ST_Read` mechanism

**Case ④: Drawn polygon subject + custom upload display**
- `subject_area`: user-drawn polygon as GeoJSON buffer
- `display_zones`: user-uploaded file registered via `registerFileBuffer`
- Both sides resolved through `ST_Read`

**Key insight:** City and county boundaries are just the **built-in default zone files**. They go through the same `ST_Read` pipeline as user-uploaded files. The display geography mechanism is fully unified.

---

## Flow Arc Origin and Destination

- **Subject area (arc origin):** `turf.centroid(subjectPolygon)` — centroid of the drawn polygon or of the selected named-place boundary feature. Computed once in JS when the subject changes.
- **Display zones (arc destinations):** `turf.centroid(zoneFeature)` per zone — computed from the uploaded or built-in GeoJSON features already in JS memory.

Case ① continues to use pre-computed centroids from `city_meta.json` / `county_meta.json` as today.

---

## Block Mode UX

The app starts in fast mode (case ①). Block mode activates when the user:
1. Draws a polygon on the map, **or**
2. Uploads a custom zone file

On first activation for a given year, the app loads `block_od_{year}.parquet` (~18–22 MB) with a visible progress indicator. Subsequent queries within that year are instant.

**Year scrubber in block mode:** Switching years triggers a new block OD load. Two options (decide during implementation):
- Lock the year selector when block mode is active (simplest)
- Allow year switching with a reload indicator

**Exiting block mode:** Clear the drawn polygon and dismiss the uploaded zone file → reverts to case ① fast path, block OD unloaded from DuckDB.

**ACS charts:** ACS transport/travel-time panels use Census FIPS lookups — unavailable for custom display zones. Hide those panels when custom zones are active.

---

## Data Pipeline Changes (`scripts/process_data.py`)

The existing city/county aggregation pipeline is **unchanged**. New additions only:

**`export_block_od(od_wfrc, year_dir)`**
Writes `block_od_{year}.parquet` from the WFRC-filtered block-level OD dataframe (already computed mid-pipeline before city/county aggregation — currently discarded). Columns: `h_geocode, w_geocode, S000, SA01–03, SE01–03, SI01–03, d0_10, d10_25, d25_50, d50p`.

**`export_block_centroids(xwalk, output_path)`**
Writes `data/block_centroids.parquet` once from the LEHD crosswalk (`h_blk_lat/lon` already present). Year-invariant; only needs to run once.

**`manifest.json`**
Add a `block_od_years` key listing which years have block OD committed (e.g., recent years only to manage repo size).

No changes to `custom_places.py`, `fetch_acs.py`, or any existing aggregation functions.

---

## Frontend Changes

### New file: `src/draw.js` (~80 lines)
- Integrates `@mapbox/mapbox-gl-draw` for polygon drawing on the map
- Exposes `getDrawnPolygon()` → current GeoJSON feature or null
- Serializes drawn polygon to single-feature GeoJSON for `registerFileBuffer`
- Fires callback on polygon change → triggers block mode activation

### New file: `src/block_query.js` (~150 lines)
- `initBlockMode(year)` — loads `block_od_{year}.parquet` and `block_centroids.parquet` into DuckDB; installs and loads spatial extension
- `loadSubjectArea(geoJSON)` — registers single-feature GeoJSON buffer as `subject_area` table
- `loadDisplayZones(fileBuffer, filename)` — registers uploaded file buffer, runs `CREATE TABLE display_zones AS SELECT * FROM ST_Read(filename)`
- `loadBuiltinZones(geoJSON)` — same as above but from pre-committed boundary files
- `queryBlockFlows(direction)` — runs the unified PIP + aggregation query
- `getZoneCentroids()` — returns `{zone_name: [lon, lat]}` via `turf.centroid` on loaded zone features for arc rendering

### Modified: `src/db.js`
- Add `installSpatialExtension()` — `INSTALL spatial; LOAD spatial;` (called once on block mode entry)
- Add `loadBlockOD(year)` — registers and creates view for `block_od_{year}.parquet`
- Existing query functions (`queryFlows`, `querySelfFlow`, etc.) unchanged

### Modified: `src/map.js`
- Add `addUploadedZoneLayer(geoJSON)` / `removeUploadedZoneLayer()` — dynamic GeoJSON source for custom display zones
- Arc layer: accept computed `[lon, lat]` origin and per-zone destination centroids in block mode

### Modified: `src/sidebar.js`
- Add file upload control in the Map Zones section (alongside City/County toggle)
- Add drawn polygon status indicator ("Custom area — 847 blocks inside drawn polygon")
- Add custom zone status indicator ("Custom zones active — 47 zones loaded")
- Hide ACS chart panels when custom display zones are active
- Show supported format hint: "GeoPackage, Shapefile, GeoJSON, FlatGeobuf"

### Modified: `src/main.js`
- State additions: `state.drawnPolygon` (GeoJSON feature or null), `state.uploadedZones` (File or null), `state.blockMode` (boolean)
- `refreshVisualization()` branches: `state.blockMode` → `block_query.js` pipeline; otherwise → existing `db.js` path
- Year scrubber: disable or prompt reload when `state.blockMode` is true

---

## Summary: What Changes, What Doesn't

| Component | Status |
|---|---|
| `city_flows.parquet` pipeline | Unchanged |
| `city_meta.json`, `county_meta.json` | Unchanged |
| `city_boundaries.geojson`, `county_boundaries.geojson` | Unchanged (reused as built-in zone source files) |
| `db.js` existing query functions | Unchanged |
| `map.js` existing city/county layers | Unchanged |
| `sidebar.js` city/county toggle | Unchanged |
| `custom_places.py`, `fetch_acs.py` | Unchanged |
| `process_data.py` | Add `export_block_od()` and `export_block_centroids()` only |
| `src/draw.js` | New — MapLibre GL Draw integration |
| `src/block_query.js` | New — block mode pipeline (spatial extension + unified query) |
| `src/db.js` | Add `installSpatialExtension()` and `loadBlockOD()` |
| `src/map.js` | Add uploaded zone layer management |
| `src/sidebar.js` | Add upload control and draw indicator |
| `src/main.js` | Add block mode state and branch in `refreshVisualization()` |

---

## Effort Estimate (Contingent on POC Passing)

| Task | Days |
|---|---|
| Proof-of-concept validation (spatial extension + ST_Read + registerFileBuffer) | 0.5 |
| `process_data.py`: export block OD + centroids | 0.5 |
| `src/draw.js`: MapLibre GL Draw integration | 1.0 |
| `src/block_query.js`: block mode pipeline + unified SQL query | 2.0 |
| `src/db.js`: spatial extension init + block OD loading | 0.5 |
| `src/map.js`: uploaded zone layer + arc centroid updates | 1.0 |
| `src/sidebar.js` + `src/main.js`: state, UI controls, mode switching | 1.5 |
| Testing all 4 matrix cases end-to-end with real GIS files | 1.0 |
| **Total** | **~8 days** |

The 0.5-day POC is the decision gate. No other work begins until it passes.
