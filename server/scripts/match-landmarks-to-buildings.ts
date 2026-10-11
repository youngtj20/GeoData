import { pool } from "../src/db.js";

// one-time batch job: for every landmark, find the building footprint it sits in (or is nearest to within ~55m)
// and store it directly on the row. This replaces computing the spatial join live per-request — tested at 442ms
// for a single batch of 2000 rows processed together (the per-row cost is ~0.2ms once amortized over a batch;
// doing this one row at a time via separate round-trips would take vastly longer across 225k landmarks).
const BATCH_SIZE = 2000;

async function main() {
  await pool.query(`
    ALTER TABLE landmarks
      ADD COLUMN IF NOT EXISTS matched_building_geom geometry(MultiPolygon, 4326),
      ADD COLUMN IF NOT EXISTS matched_building_id TEXT
  `);

  const { rows: idRows } = await pool.query(`SELECT MIN(id) AS min, MAX(id) AS max FROM landmarks`);
  const minId = Number(idRows[0].min);
  const maxId = Number(idRows[0].max);
  console.log(`Matching landmarks ${minId}..${maxId} to buildings in batches of ${BATCH_SIZE}...`);

  let matched = 0;
  let processed = 0;
  const start = Date.now();
  for (let lo = minId; lo <= maxId; lo += BATCH_SIZE) {
    const hi = lo + BATCH_SIZE - 1;
    const { rowCount } = await pool.query(
      `UPDATE landmarks l
       SET matched_building_geom = sub.geom, matched_building_id = sub.bid
       FROM (
         SELECT l2.id, ST_Multi(b.geom) AS geom,
                CASE WHEN b.source = 'osm' THEN b.osm_type || '/' || b.osm_id ELSE b.source || '/' || b.id END AS bid
         FROM landmarks l2
         LEFT JOIN LATERAL (
           SELECT * FROM buildings bb
           WHERE bb.geom && ST_Expand(l2.geom, 0.0005)
           ORDER BY ST_Contains(bb.geom, l2.geom) DESC, ST_Distance(bb.geom::geography, l2.geom::geography) ASC
           LIMIT 1
         ) b ON true
         WHERE l2.id BETWEEN $1 AND $2
       ) sub
       WHERE l.id = sub.id AND sub.geom IS NOT NULL`,
      [lo, hi]
    );
    matched += rowCount ?? 0;
    processed += BATCH_SIZE;
    if (processed % 20000 < BATCH_SIZE) {
      const secs = (Date.now() - start) / 1000;
      console.log(`  id ${lo}..${hi} — ${matched} matched so far — ${secs.toFixed(1)}s elapsed`);
    }
  }

  const { rows: countRows } = await pool.query(`SELECT COUNT(*) FROM landmarks WHERE matched_building_geom IS NOT NULL`);
  console.log(`Done in ${((Date.now() - start) / 1000).toFixed(1)}s — ${countRows[0].count} landmarks now have a matched building.`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
