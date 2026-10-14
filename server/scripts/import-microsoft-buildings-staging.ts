import zlib from "node:zlib";
import { pool } from "../src/db.js";

// Microsoft's Global ML Building Footprints — unlike the GRID3/Google imports (.gpkg files, loaded from a
// local path you already downloaded), this one is fetched live: a manifest CSV lists one gzipped,
// line-delimited-GeoJSON file per quadkey tile. Despite the ".csv.gz" extension, each decompressed line is a
// full GeoJSON Feature, not a CSV row (confirmed by downloading and inspecting a sample tile directly — don't
// trust the file extension here).
const MANIFEST_URL = "https://bfppub.blob.core.windows.net/$web/2026-08-13/dataset-links.csv";
const REGION = "Nigeria";
const BATCH_SIZE = 2000;

interface TileRef {
  quadkey: string;
  url: string;
}

async function fetchNigeriaTiles(): Promise<TileRef[]> {
  const res = await fetch(MANIFEST_URL);
  if (!res.ok) throw new Error(`manifest fetch failed: ${res.status}`);
  const text = await res.text();
  const tiles: TileRef[] = [];
  // manifest rows for Nigeria are plain (no embedded commas in Location/QuadKey/Url for this region — verified
  // by inspection), so a straight split is fine; a general CSV parser isn't needed for this single-region pull
  for (const line of text.split("\n")) {
    if (!line.startsWith(`${REGION},`)) continue;
    const parts = line.split(",");
    tiles.push({ quadkey: parts[1], url: parts[2] });
  }
  return tiles;
}

async function ensureStagingTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS microsoft_buildings_staging (
      id BIGSERIAL PRIMARY KEY,
      height DOUBLE PRECISION,
      confidence DOUBLE PRECISION,
      area_in_meters DOUBLE PRECISION,
      geom GEOMETRY(MultiPolygon, 4326)
    );
  `);
}

interface StagedRow {
  height: number;
  confidence: number;
  geojson: string;
}

async function insertBatch(rows: StagedRow[]): Promise<number> {
  if (!rows.length) return 0;
  const valuesSql: string[] = [];
  const params: any[] = [];
  let p = 1;
  for (const r of rows) {
    const gi = p + 2;
    const g = `ST_Multi(ST_SetSRID(ST_GeomFromGeoJSON($${gi}), 4326))`;
    valuesSql.push(`($${p}, $${p + 1}, ST_Area(${g}::geography), ${g})`);
    params.push(r.height, r.confidence, r.geojson);
    p += 3;
  }
  const res = await pool.query(
    `INSERT INTO microsoft_buildings_staging (height, confidence, area_in_meters, geom) VALUES ${valuesSql.join(",")}`,
    params
  );
  return res.rowCount ?? 0;
}

async function processTile(tile: TileRef): Promise<{ scanned: number; inserted: number; skipped: number }> {
  const res = await fetch(tile.url);
  if (!res.ok) throw new Error(`tile fetch failed (${res.status}): ${tile.url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const text = zlib.gunzipSync(buf).toString("utf-8");

  let batch: StagedRow[] = [];
  let scanned = 0, inserted = 0, skipped = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    scanned++;
    let feature: any;
    try {
      feature = JSON.parse(line);
    } catch {
      skipped++;
      continue;
    }
    const geom = feature?.geometry;
    if (!geom || (geom.type !== "Polygon" && geom.type !== "MultiPolygon")) {
      skipped++;
      continue;
    }
    batch.push({
      height: feature.properties?.height ?? -1,
      confidence: feature.properties?.confidence ?? -1,
      geojson: JSON.stringify(geom),
    });
    if (batch.length >= BATCH_SIZE) {
      inserted += await insertBatch(batch);
      batch = [];
    }
  }
  inserted += await insertBatch(batch);
  return { scanned, inserted, skipped };
}

async function main() {
  await ensureStagingTable();
  let tiles = await fetchNigeriaTiles();
  const limit = Number(process.argv[2]);
  if (Number.isInteger(limit) && limit > 0) tiles = tiles.slice(0, limit); // for a quick validation run
  console.log(`${tiles.length} Nigeria tiles to import.`);

  let totalScanned = 0, totalInserted = 0, totalSkipped = 0;
  const start = Date.now();
  for (let i = 0; i < tiles.length; i++) {
    const tile = tiles[i];
    const { scanned, inserted, skipped } = await processTile(tile);
    totalScanned += scanned;
    totalInserted += inserted;
    totalSkipped += skipped;
    const secs = (Date.now() - start) / 1000;
    console.log(
      `[${i + 1}/${tiles.length}] quadkey=${tile.quadkey} scanned=${scanned} inserted=${inserted} skipped=${skipped} ` +
      `— totals: ${totalInserted} inserted, ${totalScanned} scanned — ${secs.toFixed(0)}s elapsed`
    );
  }
  console.log(`Done. ${totalInserted} rows staged (${totalSkipped} malformed/non-polygon rows skipped) in ${((Date.now() - start) / 1000).toFixed(0)}s.`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
