import { pool } from "../src/db.js";

// additive-only migration — never drops/recreates `buildings` (that table holds 19M+ already-imported
// OSM rows; setup-schema.ts's DROP-and-CREATE pattern is exactly what wiped it out once before)
async function main() {
  await pool.query(`
    ALTER TABLE buildings ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'osm';
    ALTER TABLE buildings ADD COLUMN IF NOT EXISTS area_in_meters DOUBLE PRECISION;
    ALTER TABLE buildings ADD COLUMN IF NOT EXISTS confidence DOUBLE PRECISION;
  `);
  console.log("buildings table extended (source, area_in_meters, confidence).");
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
