import * as duckdb from '@duckdb/duckdb-wasm';

let conn = null;

/**
 * Initialize DuckDB-WASM using jsDelivr CDN bundles.
 * selectBundle auto-picks the MVP (non-SAB) bundle on GitHub Pages
 * since SharedArrayBuffer requires COOP/COEP headers that GH Pages can't set.
 */
export async function initDB(onProgress) {
  const bundle = await duckdb.selectBundle(duckdb.getJsDelivrBundles());

  const workerUrl = URL.createObjectURL(
    new Blob([`importScripts("${bundle.mainWorker}");`], { type: 'text/javascript' })
  );

  const logger = new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING);
  const worker = new Worker(workerUrl);
  const db = new duckdb.AsyncDuckDB(logger, worker);
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
  URL.revokeObjectURL(workerUrl);

  onProgress?.(10);

  // Fetch Parquet files as ArrayBuffers and register in-memory
  const base = import.meta.env.BASE_URL ?? '/';
  const [cityBuf, countyBuf] = await Promise.all([
    fetch(`${base}data/city_flows.parquet`).then(r => {
      if (!r.ok) throw new Error(`city_flows.parquet: ${r.status}`);
      return r.arrayBuffer();
    }),
    fetch(`${base}data/county_flows.parquet`).then(r => {
      if (!r.ok) throw new Error(`county_flows.parquet: ${r.status}`);
      return r.arrayBuffer();
    }),
  ]);

  onProgress?.(70);

  await db.registerFileBuffer('city_flows.parquet', new Uint8Array(cityBuf));
  await db.registerFileBuffer('county_flows.parquet', new Uint8Array(countyBuf));

  conn = await db.connect();

  // city_flows has: home_name, work_name, home_county, work_county, S000, …
  // All 4 combinations of areaType × aggregation are served from city_flows alone.
  await conn.query(`
    CREATE VIEW city_flows AS SELECT * FROM read_parquet('city_flows.parquet');
  `);

  onProgress?.(100);
  return db;
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
 *
 * @param {string} area       - selected area name
 * @param {'city'|'county'}   areaType    - type of the selected area
 * @param {'outflow'|'inflow'} direction
 * @param {'city'|'county'}   aggregation - destination granularity
 */
export async function queryFlows(area, areaType, direction, aggregation) {
  if (!conn) throw new Error('DB not initialized');

  const safe = area.replace(/'/g, "''");

  // Which column filters the selected area (the "from" side)
  const filterCol = direction === 'outflow'
    ? (areaType === 'city' ? 'home_name'   : 'home_county')
    : (areaType === 'city' ? 'work_name'   : 'work_county');

  // Which column represents the destination (the "to" side, grouped)
  const destCol = direction === 'outflow'
    ? (aggregation === 'city' ? 'work_name'   : 'work_county')
    : (aggregation === 'city' ? 'home_name'   : 'home_county');

  // Exclude self only when filter and dest are the same column type
  // (city→city or county→county) to avoid zero-length arcs.
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

  const result = await conn.query(sql);
  return result.toArray().map(r => r.toJSON());
}

/**
 * Total commuter count for the selected area (all destinations, including self).
 *
 * @param {string} area
 * @param {'city'|'county'}   areaType
 * @param {'outflow'|'inflow'} direction
 */
export async function queryTotal(area, areaType, direction) {
  if (!conn) return 0;

  const filterCol = direction === 'outflow'
    ? (areaType === 'city' ? 'home_name'   : 'home_county')
    : (areaType === 'city' ? 'work_name'   : 'work_county');
  const safe = area.replace(/'/g, "''");

  const result = await conn.query(
    `SELECT COALESCE(SUM(S000), 0) AS total FROM city_flows WHERE ${filterCol} = '${safe}'`
  );
  return Number(result.toArray()[0].toJSON().total);
}
