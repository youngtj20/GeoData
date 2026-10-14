import { pool } from "../src/db.js";

// additive-only — owns pg_trgm indexes + api_clients/verification_requests exclusively, same rule as every
// other setup-*-schema.ts script (never touches buildings/landmarks/ward_boundaries DDL beyond adding indexes)
async function main() {
  await pool.query(`CREATE EXTENSION IF NOT EXISTS pg_trgm;`);

  // GIN trigram indexes back the `%` similarity operator used by the address/landmark fuzzy matcher — without
  // these, a scope-less query (no state/lga given) would be a sequential scan over 19M+ buildings
  await pool.query(`
    CREATE INDEX IF NOT EXISTS buildings_address_trgm_idx ON buildings USING GIN (lower(address) gin_trgm_ops);
    CREATE INDEX IF NOT EXISTS landmarks_name_trgm_idx ON landmarks USING GIN (lower(name) gin_trgm_ops);
    CREATE INDEX IF NOT EXISTS wards_list_state_name_trgm_idx ON wards_list USING GIN (lower(state_name) gin_trgm_ops);
    CREATE INDEX IF NOT EXISTS wards_list_lga_name_trgm_idx ON wards_list USING GIN (lower(lga_name) gin_trgm_ops);
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS api_clients (
      id BIGSERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      key_hash TEXT NOT NULL UNIQUE,
      active BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_used_at TIMESTAMPTZ
    );
  `);

  // one row per requestRef (unique) — the endpoint is idempotent on this, and this doubles as the compliance/
  // audit trail a 3rd-party identity-verification integration (NIMC-style) needs
  await pool.query(`
    CREATE TABLE IF NOT EXISTS verification_requests (
      id BIGSERIAL PRIMARY KEY,
      request_ref TEXT NOT NULL UNIQUE,
      api_client_id BIGINT REFERENCES api_clients(id),
      first_name TEXT,
      last_name TEXT,
      middle_name TEXT,
      date_of_birth DATE,
      email TEXT,
      phone_number TEXT,
      address_descriptive TEXT,
      landmark TEXT,
      state TEXT,
      lga TEXT,
      input_latitude DOUBLE PRECISION,
      input_longitude DOUBLE PRECISION,
      status TEXT NOT NULL CHECK (status IN ('issued','failed')),
      building_code TEXT,
      result_latitude DOUBLE PRECISION,
      result_longitude DOUBLE PRECISION,
      result_state TEXT,
      result_lga TEXT,
      result_ward TEXT,
      accuracy DOUBLE PRECISION,
      match_method TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    -- upgrade path for installs where the table already existed before these columns were added
    ALTER TABLE verification_requests
      ADD COLUMN IF NOT EXISTS date_of_birth DATE,
      ADD COLUMN IF NOT EXISTS email TEXT,
      ADD COLUMN IF NOT EXISTS landmark TEXT,
      ADD COLUMN IF NOT EXISTS result_state TEXT,
      ADD COLUMN IF NOT EXISTS result_lga TEXT,
      ADD COLUMN IF NOT EXISTS result_ward TEXT;
    CREATE INDEX IF NOT EXISTS verification_requests_api_client_idx ON verification_requests (api_client_id);
  `);

  console.log("verification schema ready (pg_trgm indexes, api_clients, verification_requests)");
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
