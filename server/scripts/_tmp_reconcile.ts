import { pool } from "../src/db.js";
async function main() {
  const total = await pool.query(`SELECT COUNT(*) FROM buildings`);
  const withWard = await pool.query(`SELECT COUNT(*) FROM buildings WHERE ward_id IS NOT NULL`);
  const withSeq = await pool.query(`SELECT COUNT(*) FROM buildings WHERE building_seq IS NOT NULL`);
  const wardNoSeq = await pool.query(`SELECT COUNT(*) FROM buildings WHERE ward_id IS NOT NULL AND building_seq IS NULL`);
  console.log({ total: total.rows[0].count, withWard: withWard.rows[0].count, withSeq: withSeq.rows[0].count, wardButNoSeq: wardNoSeq.rows[0].count });
  // check for duplicate (ward_id, building_seq) pairs — would indicate a real bug
  const dupes = await pool.query(`
    SELECT ward_id, building_seq, COUNT(*) FROM buildings WHERE ward_id IS NOT NULL GROUP BY ward_id, building_seq HAVING COUNT(*) > 1 LIMIT 5
  `);
  console.log("duplicate (ward_id, building_seq) pairs:", dupes.rows);
  await pool.end();
}
main();
