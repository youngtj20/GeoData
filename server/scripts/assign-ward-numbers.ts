import { pool } from "../src/db.js";

// ward_number only needs to be unique within an LGA (max observed: 36, in Lagos/Alimosho — comfortably under
// the 2-digit display width). Assigned once, alphabetically by ward name, and never recalculated afterward.
async function main() {
  const { rows: lgas } = await pool.query(`SELECT DISTINCT state_name, lga_name FROM wards_list ORDER BY state_name, lga_name`);
  let total = 0;
  for (const { state_name, lga_name } of lgas) {
    const { rows: wards } = await pool.query(
      `SELECT id FROM wards_list WHERE state_name = $1 AND lga_name = $2 ORDER BY name`,
      [state_name, lga_name]
    );
    for (let i = 0; i < wards.length; i++) {
      await pool.query(`UPDATE wards_list SET ward_number = $1 WHERE id = $2`, [i + 1, wards[i].id]);
      total++;
    }
  }
  console.log(`Assigned ward numbers to ${total} wards across ${lgas.length} LGAs`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
