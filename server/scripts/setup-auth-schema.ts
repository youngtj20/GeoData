import { pool } from "../src/db.js";

// additive-only — this script owns users/permissions/user_permissions/map_settings exclusively and never
// touches settlement_blocks/buildings/ward_boundaries/etc (see the note in setup-schema.ts for why that matters)
const PERMISSIONS: { key: string; label: string; description: string }[] = [
  { key: "manage_users", label: "Manage users", description: "Create accounts and assign permissions to other users" },
  { key: "change_map_provider", label: "Change map provider", description: "Switch the public map between Google Maps, Mapbox, and OSM" },
  { key: "toggle_layer_wards", label: "Toggle ward/LGA layer", description: "Show or hide ward and LGA boundary outlines on the public map" },
  { key: "toggle_layer_buildings", label: "Toggle buildings layer", description: "Show or hide building footprints on the public map" },
  { key: "toggle_layer_settlements", label: "Toggle settlement blocks layer", description: "Show or hide GRID3 settlement density blocks on the public map" },
];
// add_buildings was removed from here — tracing a building now only requires being logged in (requireAuth),
// not a specific granted permission; see the cleanup DELETE below for existing installs

async function main() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id BIGSERIAL PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS permissions (
      id BIGSERIAL PRIMARY KEY,
      key TEXT NOT NULL UNIQUE,
      label TEXT NOT NULL,
      description TEXT
    );

    CREATE TABLE IF NOT EXISTS user_permissions (
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      permission_id BIGINT NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
      PRIMARY KEY (user_id, permission_id)
    );

    -- single-row global config: what the public map currently shows for everyone
    CREATE TABLE IF NOT EXISTS map_settings (
      id INT PRIMARY KEY DEFAULT 1,
      provider TEXT NOT NULL DEFAULT 'google' CHECK (provider IN ('google','mapbox','osm')),
      show_wards BOOLEAN NOT NULL DEFAULT true,
      show_buildings BOOLEAN NOT NULL DEFAULT true,
      show_settlements BOOLEAN NOT NULL DEFAULT false,
      updated_by BIGINT REFERENCES users(id),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT single_row CHECK (id = 1)
    );
    INSERT INTO map_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
  `);

  for (const p of PERMISSIONS) {
    await pool.query(
      `INSERT INTO permissions (key, label, description) VALUES ($1,$2,$3)
       ON CONFLICT (key) DO UPDATE SET label = EXCLUDED.label, description = EXCLUDED.description`,
      [p.key, p.label, p.description]
    );
  }
  // drop permissions that used to exist but were removed from PERMISSIONS above (user_permissions rows for it
  // cascade-delete automatically via the FK) — keeps the admin UI free of dead, no-longer-meaningful toggles
  const activeKeys = PERMISSIONS.map((p) => p.key);
  await pool.query(`DELETE FROM permissions WHERE key != ALL($1::text[])`, [activeKeys]);

  console.log("Auth schema ready:", PERMISSIONS.map((p) => p.key).join(", "));
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
