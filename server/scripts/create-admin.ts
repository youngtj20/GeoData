import bcrypt from "bcryptjs";
import { pool } from "../src/db.js";

// bootstraps the first admin account, with every permission — run once (re-running just resets the password)
const username = process.argv[2] || "admin";
const password = process.argv[3] || "admin123";

async function main() {
  const hash = await bcrypt.hash(password, 10);
  const { rows } = await pool.query(
    `INSERT INTO users (username, password_hash) VALUES ($1, $2)
     ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash
     RETURNING id`,
    [username, hash]
  );
  const userId = rows[0].id;
  await pool.query(
    `INSERT INTO user_permissions (user_id, permission_id)
     SELECT $1, id FROM permissions
     ON CONFLICT DO NOTHING`,
    [userId]
  );
  console.log(`Admin ready — username: ${username}, password: ${password} (change this after first login).`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
