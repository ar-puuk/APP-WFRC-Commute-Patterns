import * as duckdb from '@duckdb/duckdb-wasm';

let _db   = null;
let _conn = null;

/**
 * Initialize DuckDB-WASM and load Parquet files for the given year.
 * selectBundle auto-picks the MVP (non-SAB) bundle on GitHub Pages
 * since SharedArrayBuffer requires COOP/COEP headers that GH Pages can't set.
 */
export async function initDB(year, onProgress) {
  const bundle = await duckdb.selectBundle(duckdb.getJsDelivrBundles());

  const workerUrl = URL.createObjectURL(
    new Blob([`importScripts("${bundle.mainWorker}");`], { type: 'text/javascript' })
  );

  const logger = new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING);
  const worker = new Worker(workerUrl);
  _db = new duckdb.AsyncDuckDB(logger, worker);
  await _db.instantiate(bundle.mainModule, bundle.pthreadWorker);
  URL.revokeObjectURL(workerUrl);

  onProgress?.(10);

  _conn = await _db.connect();
  await _loadYearFiles(year, onProgress);

  return _db;
}

/**
 * Swap out the loaded Parquet files for a different year without
 * reinitializing the DuckDB engine or worker.
 */
export async function reloadYear(year, onProgress) {
  if (!_db || !_conn) throw new Error('DB not initialized');
  await _loadYearFiles(year, onProgress);
}

// ── Internal ─────────────────────────────────────────────────────────────────

async function _loadYearFiles(year, onProgress) {
  const base = import.meta.env.BASE_URL ?? '/';

  const cityBuf = await fetch(`${base}data/${year}/city_flows.parquet`).then(r => {
    if (!r.ok) throw new Error(`data/${year}/city_flows.parquet: ${r.status}`);
    return r.arrayBuffer();
  });

  onProgress?.(70);

  // Use year-stamped filename so re-registration across year switches never
  // conflicts (registerFileBuffer throws if the name is already taken).
  const cityFile = `city_flows_${year}.parquet`;
  try { await _db.dropFile(cityFile); } catch {}
  await _db.registerFileBuffer(cityFile, new Uint8Array(cityBuf));

  // CREATE OR REPLACE avoids a separate DROP VIEW that could fail silently
  // and leave the view pointing at the previous year's data.
  await _conn.query(
    `CREATE OR REPLACE VIEW city_flows AS SELECT * FROM read_parquet('${cityFile}');`
  );

  onProgress?.(100);
}

/**
 * Query destination flows for a selected area.
 *
 * All four combinations work via city_flows (which carries both name and county columns):
 *   city   → city   : WHERE home_name   = X  GROUP BY work_name
 *   city   → county : WHERE home_name   = X  GROUP BY work_county
 *   county → city   : WHERE home_county = X  GROUP BY work_name
 *   county → county : WHERE home_county = X  GROUP BY work_county
 * Inflow queries swap home/work columns throughout.
 *
 * Returns rows with a single `dest_name` field (the grouped destination)
 * plus S000 and the breakdown columns.
 */
export async function queryFlows(area, areaType, direction, aggregation) {
  if (!_conn) throw new Error('DB not initialized');

  const safe = area.replace(/'/g, "''");

  const filterCol = direction === 'outflow'
    ? (areaType === 'city' ? 'home_name'   : 'home_county')
    : (areaType === 'city' ? 'work_name'   : 'work_county');

  const destCol = direction === 'outflow'
    ? (aggregation === 'city' ? 'work_name'   : 'work_county')
    : (aggregation === 'city' ? 'home_name'   : 'home_county');

  const selfClause = (areaType === aggregation)
    ? `AND ${destCol} != '${safe}'`
    : '';

  const sql = `
    SELECT
      ${destCol}  AS dest_name,
      SUM(S000)   AS S000,
      SUM(SA01)   AS SA01, SUM(SA02) AS SA02, SUM(SA03) AS SA03,
      SUM(SE01)   AS SE01, SUM(SE02) AS SE02, SUM(SE03) AS SE03,
      SUM(SI01)   AS SI01, SUM(SI02) AS SI02, SUM(SI03) AS SI03
    FROM city_flows
    WHERE ${filterCol} = '${safe}'
    ${selfClause}
    GROUP BY ${destCol}
    ORDER BY S000 DESC
  `;

  const result = await _conn.query(sql);
  return result.toArray().map(r => r.toJSON());
}

/**
 * Total commuter count for the selected area (all destinations, including self).
 */
export async function queryTotal(area, areaType, direction) {
  if (!_conn) return 0;

  const filterCol = direction === 'outflow'
    ? (areaType === 'city' ? 'home_name'   : 'home_county')
    : (areaType === 'city' ? 'work_name'   : 'work_county');
  const safe = area.replace(/'/g, "''");

  const result = await _conn.query(
    `SELECT COALESCE(SUM(S000), 0) AS total FROM city_flows WHERE ${filterCol} = '${safe}'`
  );
  return Number(result.toArray()[0].toJSON().total);
}
