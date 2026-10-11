import Database from "better-sqlite3";
import { pool } from "../src/db.js";
import { extractWKB } from "./gpkg-utils.js";

// All five GRID3 POI datasets share "wardname/lganame/statename" + a point SHAPE column, except health
// facilities which uses bare "ward/lga/state". State names already match states_list verbatim (e.g. "Fct"),
// no normalization needed — confirmed against the existing ward-boundaries import's canonicalState() cases.
interface DatasetConfig {
  category: "school" | "mosque" | "church" | "market" | "health_facility";
  file: string;
  table: string;
  nameField: string;
  wardField: string;
  lgaField: string;
  stateField: string;
  attrFields: string[];
}

const DATASETS: DatasetConfig[] = [
  {
    category: "school",
    file: "Schools_in_Nigeria_1211859349866710217.gpkg",
    table: "grid3_nga_poi_school",
    nameField: "name",
    wardField: "wardname",
    lgaField: "lganame",
    stateField: "statename",
    attrFields: ["student_ct", "teacher_ct", "education", "management", "subtype", "category", "poi_type"],
  },
  {
    category: "mosque",
    file: "Mosques_in_Nigeria_5487234674841886425.gpkg",
    table: "grid3_nga_poi_mosque",
    nameField: "name",
    wardField: "wardname",
    lgaField: "lganame",
    stateField: "statename",
    attrFields: ["poi_type"],
  },
  {
    category: "church",
    file: "Churches_in_Nigeria_271933049119180301.gpkg",
    table: "fc_poi_church",
    nameField: "name",
    wardField: "wardname",
    lgaField: "lganame",
    stateField: "statename",
    attrFields: ["poi_type"],
  },
  {
    category: "market",
    file: "Markets_in_Nigeria_2081832659178024247.gpkg",
    table: "grid3_nga_poi_market",
    nameField: "market_nam",
    wardField: "wardname",
    lgaField: "lganame",
    stateField: "statename",
    attrFields: ["mrkt_frqcy", "mrkt_type", "mrkt_gds_o", "prdct_desc", "mrkt_days", "set_type", "mrkt_setnm"],
  },
  {
    category: "health_facility",
    file: "GRID3_NGA_health_facilities_v2_0_7728521772236428111.gpkg",
    table: "GRID3_NGA_health_facilities_v2_0",
    nameField: "facility_name",
    wardField: "ward",
    lgaField: "lga",
    stateField: "state",
    attrFields: ["ownership", "ownership_type", "facility_level", "facility_level_option"],
  },
];

const DOWNLOADS_DIR = process.argv[2] || "C:/Users/talk2/Downloads";
const BATCH_SIZE = 2000;

async function insertBatch(category: string, rows: any[]) {
  if (!rows.length) return;
  const valuesSql: string[] = [];
  const params: any[] = [];
  let p = 1;
  for (const row of rows) {
    const wkb = extractWKB(row.geom as Buffer);
    params.push(category, row.name ?? null, row.state_name ?? null, row.lga_name ?? null, row.ward_name ?? null, JSON.stringify(row.attrs ?? {}), wkb);
    valuesSql.push(`($${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, ST_SetSRID(ST_GeomFromWKB($${p++}), 4326))`);
  }
  const sql = `INSERT INTO landmarks (category, name, state_name, lga_name, ward_name, attrs, geom) VALUES ${valuesSql.join(",")}`;
  await pool.query(sql, params);
}

async function importDataset(cfg: DatasetConfig) {
  const path = `${DOWNLOADS_DIR}/${cfg.file}`;
  const db = new Database(path, { readonly: true });
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM "${cfg.table}"`).get() as any).n;
  console.log(`\n=== ${cfg.category}: importing ${total} rows from ${cfg.file} ===`);

  const cols = ["SHAPE", cfg.nameField, cfg.wardField, cfg.lgaField, cfg.stateField, ...cfg.attrFields];
  const selectCols = [...new Set(cols)].map((c) => `"${c}"`).join(", ");
  const stmt = db.prepare(`SELECT ${selectCols} FROM "${cfg.table}"`);

  let batch: any[] = [];
  let done = 0;
  const start = Date.now();
  for (const raw of stmt.iterate() as IterableIterator<any>) {
    if (!raw.SHAPE) { done++; continue; } // skip rows with no geometry
    const attrs: Record<string, any> = {};
    for (const f of cfg.attrFields) if (raw[f] != null) attrs[f] = raw[f];
    batch.push({
      geom: raw.SHAPE,
      name: raw[cfg.nameField] ?? null,
      ward_name: raw[cfg.wardField] ?? null,
      lga_name: raw[cfg.lgaField] ?? null,
      state_name: raw[cfg.stateField] ?? null,
      attrs,
    });
    if (batch.length >= BATCH_SIZE) {
      await insertBatch(cfg.category, batch);
      done += batch.length;
      batch = [];
    }
  }
  await insertBatch(cfg.category, batch);
  done += batch.length;
  db.close();
  console.log(`${cfg.category}: done — ${done}/${total} rows in ${((Date.now() - start) / 1000).toFixed(1)}s`);
}

async function main() {
  for (const cfg of DATASETS) {
    await importDataset(cfg);
  }
  const { rows } = await pool.query(`SELECT category, COUNT(*) FROM landmarks GROUP BY category ORDER BY category`);
  console.log("\nFinal counts:", rows);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
