import { pool } from "../src/db.js";

// one-time backfill: assign every building's ward_id via a bulk spatial join, processed one state at a time
// (not row-by-row — tested at ~1.14M buildings/63s for Kwara, i.e. bulk UPDATE...FROM lets Postgres use the
// buildings_geom_idx GIST index per ward polygon rather than a slow per-row correlated subquery).
// Resumable: `b.ward_id IS NULL` means a interrupted run can just be restarted and will skip already-done rows.
async function main() {
  const { rows: states } = await pool.query(`SELECT DISTINCT state FROM state_boundaries ORDER BY state`);
  const overallStart = Date.now();
  let totalUpdated = 0;
  for (const { state } of states) {
    const start = Date.now();
    const { rowCount } = await pool.query(
      `UPDATE buildings b
       SET ward_id = wl.id
       FROM ward_boundaries wb
       JOIN wards_list wl ON wl.state_name = wb.state AND wl.lga_name = wb.lga AND wl.name = wb.ward
       WHERE wb.state = $1
         AND b.geom && wb.geom
         AND ST_Intersects(b.geom, wb.geom)
         AND b.ward_id IS NULL`,
      [state]
    );
    totalUpdated += rowCount ?? 0;
    const secs = (Date.now() - start) / 1000;
    console.log(`${state}: +${rowCount} buildings assigned a ward (${secs.toFixed(1)}s) — ${totalUpdated} total so far, ${((Date.now() - overallStart) / 1000).toFixed(0)}s elapsed`);
  }

  const { rows: remaining } = await pool.query(`SELECT COUNT(*) FROM buildings WHERE ward_id IS NULL`);
  console.log(`Done. ${totalUpdated} buildings assigned. ${remaining[0].count} still have no ward_id (outside any ward polygon, or a gap in ward coverage).`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
