import { pool } from "../src/db.js";

// additive-only — backs the case-insensitive exact-match lookup in GET /api/buildings/by-code/:code.
// A functional index on upper(building_code) (not a plain index on building_code) is required because the
// query compares upper(building_code) = upper($1); a plain btree index wouldn't match that expression.
async function main() {
  await pool.query(`CREATE INDEX IF NOT EXISTS buildings_building_code_upper_idx ON buildings (upper(building_code));`);
  console.log("buildings_building_code_upper_idx ready");
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
