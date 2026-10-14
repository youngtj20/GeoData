import { pool } from "../src/db.js";

const IOU_THRESHOLD = 0.3;

// same approach as conflate-google-buildings.ts: per-state (independent, non-overlapping — safe to process
// one at a time and monitor progress), insert staged Microsoft buildings that don't already overlap an
// existing building (OSM, already-conflated Google, or a Microsoft building inserted for a neighboring state
// in an earlier iteration) above the IoU threshold
async function main() {
  const { rows: states } = await pool.query(`SELECT state FROM state_boundaries ORDER BY state`);
  let totalInserted = 0;
  for (const { state } of states) {
    const start = Date.now();
    const res = await pool.query(
      // ST_MakeValid both sides of the IoU comparison — Microsoft's footprints include at least one
      // self-intersecting polygon (hit a GEOS "side location conflict" TopologyException on the raw geom
      // during ST_Intersection/ST_Union without this). Also applied to the geometry actually inserted, so a
      // repaired-but-still-correct polygon ends up in `buildings` rather than a raw invalid one.
      `INSERT INTO buildings (source, geom, area_in_meters, confidence)
       SELECT 'microsoft', ST_Multi(ST_CollectionExtract(ST_MakeValid(g.geom), 3)), g.area_in_meters, g.confidence
       FROM microsoft_buildings_staging g
       JOIN state_boundaries sb ON sb.state = $1 AND ST_Intersects(g.geom, sb.geom)
       WHERE NOT EXISTS (
         SELECT 1 FROM buildings b
         WHERE b.geom && g.geom
           AND ST_Area(ST_Intersection(ST_MakeValid(b.geom), ST_MakeValid(g.geom)))
               / NULLIF(ST_Area(ST_Union(ST_MakeValid(b.geom), ST_MakeValid(g.geom))), 0) > $2
       )`,
      [state, IOU_THRESHOLD]
    );
    totalInserted += res.rowCount ?? 0;
    console.log(`${state}: +${res.rowCount} new microsoft buildings (${((Date.now() - start) / 1000).toFixed(1)}s)`);
  }
  console.log(`Done. Total Microsoft buildings added: ${totalInserted}`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
