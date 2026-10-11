import { pool } from "../src/db.js";

// additive-only — new columns for the human-readable building ID system (STATE-LGA-WARD-SEQ, see
// server/src/buildingId.ts). ward_id/building_seq are the permanent, never-recalculated source of truth;
// building_code is a denormalized rendering of them that can be cheaply regenerated if the display format
// (buildingIdConfig) ever changes, without touching the underlying sequence assignments.
async function main() {
  await pool.query(`
    ALTER TABLE states_list ADD COLUMN IF NOT EXISTS short_code CHAR(2);
    ALTER TABLE lgas_list ADD COLUMN IF NOT EXISTS short_code CHAR(2);
    ALTER TABLE wards_list ADD COLUMN IF NOT EXISTS ward_number SMALLINT;

    ALTER TABLE buildings ADD COLUMN IF NOT EXISTS ward_id BIGINT REFERENCES wards_list(id);
    ALTER TABLE buildings ADD COLUMN IF NOT EXISTS building_seq INTEGER;
    ALTER TABLE buildings ADD COLUMN IF NOT EXISTS building_code TEXT;

    CREATE TABLE IF NOT EXISTS ward_building_counters (
      ward_id BIGINT PRIMARY KEY REFERENCES wards_list(id),
      next_seq INTEGER NOT NULL DEFAULT 1
    );

    CREATE INDEX IF NOT EXISTS buildings_ward_id_idx ON buildings (ward_id);
    CREATE UNIQUE INDEX IF NOT EXISTS buildings_ward_seq_uidx ON buildings (ward_id, building_seq) WHERE ward_id IS NOT NULL;
  `);
  console.log("building-id schema ready");
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
