import Database from "better-sqlite3";
import { pool } from "../src/db.js";
import { extractWKB } from "./gpkg-utils.js";

const GPKG_PATH = process.argv[2];
const TABLE = process.argv[3]; // e.g. nga_buildings_part1
const MIN_CONFIDENCE = 0.7; // Google's own "high confidence" guidance
const BATCH_SIZE = 2000;

async function ensureStagingTable() {
  // additive/idempotent — this table is a scratch area for conflation, safe to truncate+reload per part
  await pool.query(`
    CREATE TABLE IF NOT EXISTS google_buildings_staging (
      id BIGSERIAL PRIMARY KEY,
      area_in_meters DOUBLE PRECISION,
      confidence DOUBLE PRECISION,
      geom GEOMETRY(MultiPolygon, 4326)
    );
  `);
}

async function insertBatch(rows: { area_in_meters: number; confidence: number; wkb: Buffer }[]) {
  if (!rows.length) return;
  const valuesSql: string[] = [];
  const params: any[] = [];
  let p = 1;
  for (const r of rows) {
    params.push(r.area_in_meters, r.confidence, r.wkb);
    valuesSql.push(`($${p++}, $${p++}, ST_SetSRID(ST_GeomFromWKB($${p++}), 4326))`);
  }
  await pool.query(`INSERT INTO google_buildings_staging (area_in_meters, confidence, geom) VALUES ${valuesSql.join(",")}`, params);
}

async function main() {
  if (!GPKG_PATH || !TABLE) throw new Error("Usage: tsx import-google-buildings-staging.ts <path.gpkg> <layer_table_name>");
  await ensureStagingTable();

  const db = new Database(GPKG_PATH, { readonly: true });
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM "${TABLE}"`).get() as any).n;
  console.log(`Importing ${TABLE}: ${total} candidate buildings (confidence >= ${MIN_CONFIDENCE} kept)...`);

  const stmt = db.prepare(`SELECT area_in_meters, confidence, geometry FROM "${TABLE}"`);
  let batch: { area_in_meters: number; confidence: number; wkb: Buffer }[] = [];
  let scanned = 0, kept = 0;
  const start = Date.now();
  for (const row of stmt.iterate() as IterableIterator<any>) {
    scanned++;
    if (row.confidence >= MIN_CONFIDENCE) {
      batch.push({ area_in_meters: row.area_in_meters, confidence: row.confidence, wkb: extractWKB(row.geometry as Buffer) });
      kept++;
    }
    if (batch.length >= BATCH_SIZE) { await insertBatch(batch); batch = []; }
    if (scanned % 500000 < 1) {
      const secs = (Date.now() - start) / 1000;
      console.log(`${scanned}/${total} scanned (${(100 * scanned / total).toFixed(1)}%), ${kept} kept — ${(scanned / secs).toFixed(0)} rows/s`);
    }
  }
  await insertBatch(batch);
  console.log(`Done with ${TABLE}. Scanned ${scanned}, kept ${kept} (${(100 * kept / scanned).toFixed(1)}%) in ${((Date.now() - start) / 1000).toFixed(1)}s.`);

  db.close();
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
