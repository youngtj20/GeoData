import { pool } from "../src/db.js";

const IOU_THRESHOLD = 0.3;

// for each state (independent, non-overlapping — safe to process one at a time and monitor progress),
// insert staged Google buildings that don't already overlap an existing building (OSM, or a Google building
// inserted for a neighboring state in an earlier iteration) above the IoU threshold
async function main() {
  const { rows: states } = await pool.query(`SELECT state FROM state_boundaries ORDER BY state`);
  let totalInserted = 0;
  for (const { state } of states) {
    const start = Date.now();
    const res = await pool.query(
      `INSERT INTO buildings (source, geom, area_in_meters, confidence)
       SELECT 'google', g.geom, g.area_in_meters, g.confidence
       FROM google_buildings_staging g
       JOIN state_boundaries sb ON sb.state = $1 AND ST_Intersects(g.geom, sb.geom)
       WHERE NOT EXISTS (
         SELECT 1 FROM buildings b
         WHERE b.geom && g.geom
           AND ST_Area(ST_Intersection(b.geom, g.geom)) / NULLIF(ST_Area(ST_Union(b.geom, g.geom)), 0) > $2
       )`,
      [state, IOU_THRESHOLD]
    );
    totalInserted += res.rowCount ?? 0;
    console.log(`${state}: +${res.rowCount} new google buildings (${((Date.now() - start) / 1000).toFixed(1)}s)`);
  }
  console.log(`Done. Total Google buildings added: ${totalInserted}`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
