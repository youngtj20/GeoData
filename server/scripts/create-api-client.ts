import { pool } from "../src/db.js";
import { generateApiKey, hashApiKey } from "../src/apiKeyAuth.js";

// CLI fallback for minting a key outside the admin UI (e.g. first bootstrap, before any admin user has the
// manage_api_clients permission) — day-to-day issuance should go through Admin > API clients in the app instead.
const name = process.argv[2];
if (!name) {
  console.error("Usage: tsx scripts/create-api-client.ts <client-name>");
  process.exit(1);
}

async function main() {
  const rawKey = generateApiKey();
  await pool.query(
    `INSERT INTO api_clients (name, key_hash, active, created_at) VALUES ($1, $2, true, now())`,
    [name, hashApiKey(rawKey)]
  );
  console.log(`API key for "${name}" (store this now — it cannot be shown again):\n${rawKey}`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
