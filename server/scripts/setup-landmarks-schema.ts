import { pool } from "../src/db.js";

// additive-only — owns the landmarks table exclusively, never touches settlement_blocks/buildings/
// ward_boundaries/etc (see the note in setup-schema.ts for why that matters)
async function main() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS landmarks (
      id BIGSERIAL PRIMARY KEY,
      category TEXT NOT NULL CHECK (category IN ('school','mosque','church','market','health_facility')),
      name TEXT,
      state_name TEXT,
      lga_name TEXT,
      ward_name TEXT,
      attrs JSONB,
      source TEXT NOT NULL DEFAULT 'GRID3',
      geom GEOMETRY(Point, 4326) NOT NULL
    );
    CREATE INDEX IF NOT EXISTS landmarks_geom_idx ON landmarks USING GIST (geom);
    CREATE INDEX IF NOT EXISTS landmarks_category_idx ON landmarks (category);
  `);
  console.log("landmarks table ready");
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
