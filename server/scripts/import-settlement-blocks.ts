import Database from "better-sqlite3";
import { pool } from "../src/db.js";
import { extractWKB } from "./gpkg-utils.js";

const GPKG_PATH = process.argv[2];
const TABLE = "main_grid3_nga_settlement_extents_v4_1";
const SOURCE_SRID = 3857; // confirmed via ogrinfo — WGS_1984_Web_Mercator_Auxiliary_Sphere
const BATCH_SIZE = 1000;

const COLS = [
  "block_id", "country", "iso3", "block_area_sqm", "block_perimeter", "block_neighbor_count",
  "building_count", "building_area_min", "building_area_max", "building_area_sum",
  "building_area_median", "building_area_stdev", "building_area_percentage", "extent_type",
  "mgrs_code", "ndvi_mean", "evi_mean", "gbuilding_max_height", "gbuilding_mean_height",
  "blocks_per_settl_extent", "building_count_density_quantile_rank", "building_max_area_quantile_rank",
  "building_count_density", "bd_class", "ma_class", "composite_class",
];

async function insertBatch(rows: any[]) {
  if (!rows.length) return;
  const valuesSql: string[] = [];
  const params: any[] = [];
  let p = 1;
  for (const row of rows) {
    const placeholders = COLS.map(() => `$${p++}`);
    for (const c of COLS) params.push(row[c] ?? null);
    const wkb = extractWKB(row.SHAPE as Buffer);
    const geomPlaceholder = `ST_Transform(ST_SetSRID(ST_GeomFromWKB($${p++}), ${SOURCE_SRID}), 4326)`;
    params.push(wkb);
    valuesSql.push(`(${placeholders.join(",")}, ${geomPlaceholder})`);
  }
  const sql = `INSERT INTO settlement_blocks (${COLS.join(",")}, geom) VALUES ${valuesSql.join(",")}`;
  await pool.query(sql, params);
}

async function main() {
  if (!GPKG_PATH) throw new Error("Usage: tsx import-settlement-blocks.ts <path-to-gpkg>");
  const db = new Database(GPKG_PATH, { readonly: true });
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM "${TABLE}"`).get() as any).n;
  console.log(`Importing ${total} settlement blocks from ${GPKG_PATH}...`);

  const stmt = db.prepare(`SELECT * FROM "${TABLE}"`);
  let batch: any[] = [];
  let done = 0;
  const start = Date.now();
  for (const row of stmt.iterate() as IterableIterator<any>) {
    batch.push(row);
    if (batch.length >= BATCH_SIZE) {
      await insertBatch(batch);
      done += batch.length;
      batch = [];
      if (done % 50000 < BATCH_SIZE) {
        const secs = (Date.now() - start) / 1000;
        console.log(`${done}/${total} (${(100 * done / total).toFixed(1)}%) — ${(done / secs).toFixed(0)} rows/s`);
      }
    }
  }
  await insertBatch(batch);
  done += batch.length;
  console.log(`Done. Inserted ${done} rows in ${((Date.now() - start) / 1000).toFixed(1)}s.`);

  db.close();
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
