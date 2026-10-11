import Database from "better-sqlite3";
import { pool } from "../src/db.js";
import { extractWKB } from "./gpkg-utils.js";

const V3_PATH = process.argv[2];
const V1_PATH = process.argv[3];
const V3_TABLE = "main_GRID3_NGA_operational_wards_v3_0";
const V1_TABLE = "grid3_nga_boundary_vaccwards";
const BATCH_SIZE = 500;

// v3 uses a couple of raw state labels that don't match v1's canonical naming — normalize to v1's convention
// (prettyState() in the frontend expects "Fct", not "FCT, Abuja")
const STATE_NAME_OVERRIDES: Record<string, string> = { "FCT, Abuja": "Fct" };
const norm = (s: string | null | undefined) => (s || "").trim().toLowerCase().replace(/\s+/g, " ");
const canonicalState = (raw: string) => STATE_NAME_OVERRIDES[raw] ?? raw;

interface WardRow {
  state: string;
  lga: string;
  ward: string;
  statecode: string | null;
  lgacode: string | null;
  wardcode: string | null;
  urban: string | null;
  source_version: "v3" | "v1";
  wkb: Buffer;
}

async function insertBatch(rows: WardRow[]) {
  if (!rows.length) return;
  const cols = ["state", "lga", "ward", "statecode", "lgacode", "wardcode", "urban", "source_version"];
  const valuesSql: string[] = [];
  const params: any[] = [];
  let p = 1;
  for (const r of rows) {
    const placeholders = cols.map(() => `$${p++}`);
    params.push(r.state, r.lga, r.ward, r.statecode, r.lgacode, r.wardcode, r.urban, r.source_version);
    valuesSql.push(`(${placeholders.join(",")}, ST_SetSRID(ST_GeomFromWKB($${p++}), 4326))`);
    params.push(r.wkb);
  }
  await pool.query(`INSERT INTO ward_boundaries (${cols.join(",")}, geom) VALUES ${valuesSql.join(",")}`, params);
}

// this script owns these tables exclusively — safe to re-run without touching settlement_blocks/buildings
async function setupTables() {
  await pool.query(`
    DROP TABLE IF EXISTS ward_boundaries;
    CREATE TABLE ward_boundaries (
      id BIGSERIAL PRIMARY KEY,
      state TEXT NOT NULL,
      lga TEXT NOT NULL,
      ward TEXT NOT NULL,
      statecode TEXT,
      lgacode TEXT,
      wardcode TEXT,
      urban TEXT,
      source_version TEXT NOT NULL,
      geom GEOMETRY(MultiPolygon, 4326)
    );

    DROP TABLE IF EXISTS lga_boundaries;
    CREATE TABLE lga_boundaries (
      id BIGSERIAL PRIMARY KEY,
      state TEXT NOT NULL,
      lga TEXT NOT NULL,
      lgacode TEXT,
      geom GEOMETRY(MultiPolygon, 4326)
    );

    DROP TABLE IF EXISTS state_boundaries;
    CREATE TABLE state_boundaries (
      id BIGSERIAL PRIMARY KEY,
      state TEXT NOT NULL,
      statecode TEXT,
      geom GEOMETRY(MultiPolygon, 4326)
    );

    DROP TABLE IF EXISTS states_list;
    CREATE TABLE states_list (id BIGSERIAL PRIMARY KEY, name TEXT UNIQUE, code TEXT);

    DROP TABLE IF EXISTS lgas_list;
    CREATE TABLE lgas_list (id BIGSERIAL PRIMARY KEY, state_name TEXT, name TEXT, code TEXT);

    DROP TABLE IF EXISTS wards_list;
    CREATE TABLE wards_list (id BIGSERIAL PRIMARY KEY, state_name TEXT, lga_name TEXT, name TEXT, code TEXT);
  `);
}

async function main() {
  if (!V3_PATH || !V1_PATH) throw new Error("Usage: tsx import-ward-boundaries.ts <v3.gpkg> <v1.gpkg>");
  await setupTables();

  const v1db = new Database(V1_PATH, { readonly: true });
  const v1Raw = v1db.prepare(
    `SELECT wardname, wardcode, lganame, lgacode, statename, statecode, urban, SHAPE FROM "${V1_TABLE}"`
  ).all() as any[];
  v1db.close();
  console.log(`Loaded ${v1Raw.length} v1 wards into memory for lookups.`);

  const wardCodeByKey = new Map<string, string>();
  const lgaCodeByKey = new Map<string, string>();
  for (const r of v1Raw) {
    const sK = norm(r.statename);
    const lK = `${sK}|${norm(r.lganame)}`;
    const wK = `${lK}|${norm(r.wardname)}`;
    if (!wardCodeByKey.has(wK)) wardCodeByKey.set(wK, r.wardcode);
    if (!lgaCodeByKey.has(lK)) lgaCodeByKey.set(lK, r.lgacode);
  }

  const v3db = new Database(V3_PATH, { readonly: true });
  const v3RawStates = (v3db.prepare(`SELECT DISTINCT state FROM "${V3_TABLE}"`).all() as any[]).map((r) => r.state);
  const v3CanonicalStatesNorm = new Set(v3RawStates.map((s) => norm(canonicalState(s))));
  console.log(`v3 covers ${v3CanonicalStatesNorm.size} states:`, [...v3CanonicalStatesNorm].join(", "));

  // pass 1: v3 wards (primary source for the states it covers), with codes recovered from v1 where possible
  let batch: WardRow[] = [];
  let v3Count = 0, v3WithWardCode = 0, v3WithLgaCode = 0, v3Skipped = 0;
  const v3Stmt = v3db.prepare(`SELECT state, lga, ward, ward_v1_grid3, SHAPE FROM "${V3_TABLE}"`);
  for (const row of v3Stmt.iterate() as IterableIterator<any>) {
    if (!row.SHAPE) { v3Skipped++; continue; }
    const state = canonicalState(row.state);
    const sK = norm(state);
    const lK = `${sK}|${norm(row.lga)}`;
    // ward_v1_grid3 copies v1's wardname verbatim (including its own inconsistent "Ward" suffixing in some
    // rows, e.g. "Eziama Ward") — match it as-is rather than trying to normalize the suffix away
    const hintWard = row.ward_v1_grid3 ? String(row.ward_v1_grid3) : "";
    const wardCode =
      (hintWard && wardCodeByKey.get(`${lK}|${norm(hintWard)}`)) ||
      wardCodeByKey.get(`${lK}|${norm(row.ward)}`) ||
      null;
    const lgaCode = lgaCodeByKey.get(lK) ?? null;
    if (wardCode) v3WithWardCode++;
    if (lgaCode) v3WithLgaCode++;
    batch.push({
      state, lga: row.lga, ward: row.ward,
      statecode: null, lgacode: lgaCode, wardcode: wardCode, urban: null,
      source_version: "v3", wkb: extractWKB(row.SHAPE as Buffer),
    });
    v3Count++;
    if (batch.length >= BATCH_SIZE) { await insertBatch(batch); batch = []; }
  }
  await insertBatch(batch);
  v3db.close();
  console.log(`Inserted ${v3Count} v3 wards (${v3WithWardCode} with recovered ward codes, ${v3WithLgaCode} with LGA codes). Skipped ${v3Skipped} with no geometry.`);

  // pass 2: v1 wards, but only for states v3 doesn't cover at all
  batch = [];
  let v1Count = 0;
  const v1db2 = new Database(V1_PATH, { readonly: true });
  const v1Stmt = v1db2.prepare(
    `SELECT wardname, wardcode, lganame, lgacode, statename, statecode, urban, SHAPE FROM "${V1_TABLE}"`
  );
  let v1Skipped = 0;
  for (const row of v1Stmt.iterate() as IterableIterator<any>) {
    if (v3CanonicalStatesNorm.has(norm(row.statename))) continue; // v3 already covers this state
    if (!row.SHAPE) { v1Skipped++; continue; } // a handful of v1 rows have no geometry at all
    batch.push({
      state: row.statename, lga: row.lganame, ward: row.wardname,
      statecode: row.statecode, lgacode: row.lgacode, wardcode: row.wardcode, urban: row.urban,
      source_version: "v1", wkb: extractWKB(row.SHAPE as Buffer),
    });
    v1Count++;
    if (batch.length >= BATCH_SIZE) { await insertBatch(batch); batch = []; }
  }
  await insertBatch(batch);
  v1db2.close();
  console.log(`Inserted ${v1Count} v1 fallback wards (states not covered by v3). Skipped ${v1Skipped} with no geometry.`);

  console.log("Precomputing LGA and state boundary unions...");
  await pool.query(`
    INSERT INTO lga_boundaries (state, lga, lgacode, geom)
    SELECT state, lga, MAX(lgacode), ST_Multi(ST_Union(geom))
    FROM ward_boundaries GROUP BY state, lga;
  `);
  await pool.query(`
    INSERT INTO state_boundaries (state, statecode, geom)
    SELECT state, MAX(statecode), ST_Multi(ST_Union(geom))
    FROM ward_boundaries GROUP BY state;
  `);

  console.log("Building states/lgas/wards name lists...");
  await pool.query(`
    INSERT INTO states_list (name, code)
    SELECT state, MAX(statecode) FROM ward_boundaries GROUP BY state ORDER BY state;
  `);
  await pool.query(`
    INSERT INTO lgas_list (state_name, name, code)
    SELECT state, lga, MAX(lgacode) FROM ward_boundaries GROUP BY state, lga ORDER BY state, lga;
  `);
  await pool.query(`
    INSERT INTO wards_list (state_name, lga_name, name, code)
    SELECT state, lga, ward, MAX(wardcode) FROM ward_boundaries GROUP BY state, lga, ward ORDER BY state, lga, ward;
  `);

  const counts = await pool.query(`
    SELECT
      (SELECT COUNT(*) FROM ward_boundaries) AS wards,
      (SELECT COUNT(*) FROM lga_boundaries) AS lgas,
      (SELECT COUNT(*) FROM state_boundaries) AS states;
  `);
  console.log("Done:", counts.rows[0]);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
