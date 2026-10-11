import { pool } from "../src/db.js";

// additive-only — lets any building (not just manually-traced ones) have a human-confirmed address attached,
// separate from who/when the building row itself was created
async function main() {
  await pool.query(`
    ALTER TABLE buildings
      ADD COLUMN IF NOT EXISTS address_updated_by BIGINT REFERENCES users(id),
      ADD COLUMN IF NOT EXISTS address_updated_at TIMESTAMPTZ
  `);
  console.log("building address audit columns ready");
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
