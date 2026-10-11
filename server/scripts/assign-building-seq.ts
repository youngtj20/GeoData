import { pool } from "../src/db.js";

// one-time backfill: assign a permanent per-ward sequence number to every building that already has a ward_id
// (run scripts/backfill-building-ward-id.ts first). Looped per-ward (9,308 of them), NOT batched by state —
// an earlier per-state version filtered on `ward_id IN (subquery)` AND `building_seq IS NULL`, which the planner
// could not turn into an index scan at this table size (49M rows) and fell back to a parallel sequential scan
// per state (confirmed via EXPLAIN), making it ~5x slower than the ward_id backfill it followed. A single exact
// `ward_id = $1` reliably uses buildings_ward_id_idx. Resumable via `building_seq IS NULL`.
async function main() {
  const { rows: wards } = await pool.query(`SELECT id, state_name FROM wards_list ORDER BY state_name, lga_name, ward_number`);
  const overallStart = Date.now();
  let totalAssigned = 0;
  let lastState = "";
  for (const ward of wards) {
    if (ward.state_name !== lastState) {
      lastState = ward.state_name;
      console.log(`-- ${lastState} (${totalAssigned} total so far, ${((Date.now() - overallStart) / 1000).toFixed(0)}s elapsed) --`);
    }
    const { rowCount } = await pool.query(
      `UPDATE buildings b
       SET building_seq = sub.rn
       FROM (
         SELECT id, ROW_NUMBER() OVER (ORDER BY id) AS rn
         FROM buildings
         WHERE ward_id = $1 AND building_seq IS NULL
       ) sub
       WHERE b.id = sub.id`,
      [ward.id]
    );
    totalAssigned += rowCount ?? 0;
  }
  console.log(`-- all wards processed — ${totalAssigned} total, ${((Date.now() - overallStart) / 1000).toFixed(0)}s elapsed --`);

  // seed the live counter table so new buildings (manual traces, future imports) continue right after the
  // highest sequence number already assigned in each ward
  const { rowCount: counterRows } = await pool.query(`
    INSERT INTO ward_building_counters (ward_id, next_seq)
    SELECT ward_id, MAX(building_seq) + 1 FROM buildings WHERE ward_id IS NOT NULL GROUP BY ward_id
    ON CONFLICT (ward_id) DO UPDATE SET next_seq = GREATEST(ward_building_counters.next_seq, EXCLUDED.next_seq)
  `);
  console.log(`Done. ${totalAssigned} buildings assigned a sequence number. ${counterRows} ward counters initialized.`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
