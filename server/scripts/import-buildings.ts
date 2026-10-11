import Database from "better-sqlite3";
import { pool } from "../src/db.js";
import { extractWKB } from "./gpkg-utils.js";

const GPKG_PATH = process.argv[2];
const TABLE = "gis_osm_buildings_a_free";
// this layer's SRS is CRS84 (lon/lat order) — coordinate-for-coordinate identical to how PostGIS stores SRID 4326,
// so no ST_Transform is needed, just tag the SRID directly
const BATCH_SIZE = 2000;

async function insertBatch(rows: any[]) {
  if (!rows.length) return;
  const valuesSql: string[] = [];
  const params: any[] = [];
  let p = 1;
  for (const row of rows) {
    const osmId = row.osm_id != null ? BigInt(row.osm_id) : null;
    params.push(osmId !== null ? osmId.toString() : null, row.fclass ?? null, row.name ?? null, row.type ?? null);
    const wkb = extractWKB(row.geom as Buffer);
    params.push(wkb);
    valuesSql.push(`($${p++}, $${p++}, $${p++}, $${p++}, ST_SetSRID(ST_GeomFromWKB($${p++}), 4326))`);
  }
  const sql = `INSERT INTO buildings (osm_id, fclass, name, btype, geom) VALUES ${valuesSql.join(",")}`;
  await pool.query(sql, params);
}

async function main() {
  if (!GPKG_PATH) throw new Error("Usage: tsx import-buildings.ts <path-to-gpkg>");
  const db = new Database(GPKG_PATH, { readonly: true });
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM "${TABLE}"`).get() as any).n;
  console.log(`Importing ${total} buildings from ${GPKG_PATH}...`);

  const stmt = db.prepare(`SELECT osm_id, fclass, name, type, geom FROM "${TABLE}"`);
  let batch: any[] = [];
  let done = 0;
  const start = Date.now();
  for (const row of stmt.iterate() as IterableIterator<any>) {
    batch.push(row);
    if (batch.length >= BATCH_SIZE) {
      await insertBatch(batch);
      done += batch.length;
      batch = [];
      if (done % 200000 < BATCH_SIZE) {
        const secs = (Date.now() - start) / 1000;
        const rate = done / secs;
        const etaMin = ((total - done) / rate / 60).toFixed(1);
        console.log(`${done}/${total} (${(100 * done / total).toFixed(1)}%) — ${rate.toFixed(0)} rows/s — ETA ${etaMin}min`);
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
