import { pool } from "../src/db.js";

// additive-only — supports manually-traced buildings (source='manual') contributed through the map UI
async function main() {
  await pool.query(`
    ALTER TABLE buildings
      ADD COLUMN IF NOT EXISTS created_by BIGINT REFERENCES users(id),
      ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS address TEXT
  `);
  console.log("buildings audit + address columns ready");
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
