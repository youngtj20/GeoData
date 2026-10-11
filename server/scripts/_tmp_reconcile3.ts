import { pool } from "../src/db.js";
async function main() {
  const r = await pool.query(`
    SELECT
      (SELECT COUNT(*) FROM buildings) AS total,
      (SELECT COUNT(*) FROM buildings WHERE ward_id IS NOT NULL) AS with_ward,
      (SELECT COUNT(*) FROM buildings WHERE building_seq IS NOT NULL) AS with_seq
  `);
  console.log(r.rows[0]);
  const idx = await pool.query(`SELECT indexrelid::regclass::text AS name, indisvalid FROM pg_index WHERE indexrelid = 'buildings_ward_seq_uidx'::regclass`);
  console.log("unique index:", idx.rows);
  await pool.end();
}
main();
