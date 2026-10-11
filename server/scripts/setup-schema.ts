import { pool } from "../src/db.js";

async function main() {
  await pool.query(`CREATE EXTENSION IF NOT EXISTS postgis;`);

  await pool.query(`
    DROP TABLE IF EXISTS settlement_blocks;
    CREATE TABLE settlement_blocks (
      id BIGSERIAL PRIMARY KEY,
      block_id TEXT,
      country TEXT,
      iso3 TEXT,
      block_area_sqm DOUBLE PRECISION,
      block_perimeter DOUBLE PRECISION,
      block_neighbor_count DOUBLE PRECISION,
      building_count INTEGER,
      building_area_min DOUBLE PRECISION,
      building_area_max DOUBLE PRECISION,
      building_area_sum REAL,
      building_area_median DOUBLE PRECISION,
      building_area_stdev DOUBLE PRECISION,
      building_area_percentage REAL,
      extent_type TEXT,
      mgrs_code TEXT,
      ndvi_mean DOUBLE PRECISION,
      evi_mean DOUBLE PRECISION,
      gbuilding_max_height DOUBLE PRECISION,
      gbuilding_mean_height DOUBLE PRECISION,
      blocks_per_settl_extent DOUBLE PRECISION,
      building_count_density_quantile_rank DOUBLE PRECISION,
      building_max_area_quantile_rank DOUBLE PRECISION,
      building_count_density DOUBLE PRECISION,
      bd_class TEXT,
      ma_class TEXT,
      composite_class TEXT,
      geom GEOMETRY(MultiPolygon, 4326)
    );
  `);

  await pool.query(`
    DROP TABLE IF EXISTS buildings;
    CREATE TABLE buildings (
      id BIGSERIAL PRIMARY KEY,
      osm_id BIGINT,
      osm_type TEXT NOT NULL DEFAULT 'way',
      fclass TEXT,
      name TEXT,
      btype TEXT,
      ward_id INTEGER,
      geom GEOMETRY(MultiPolygon, 4326)
    );
  `);

  // NOTE: ward/LGA/state boundary tables are NOT created here — see import-ward-boundaries.ts,
  // which owns its own tables exclusively. This file only ever touches settlement_blocks + buildings.
  // Do not add other datasets' DDL here — running this script drops and recreates everything above,
  // which previously wiped out an already-populated 19M-row table when re-run for an unrelated change.

  console.log("Schema ready.");
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
