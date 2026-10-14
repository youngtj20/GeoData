import zlib from "node:zlib";
import readline from "node:readline";
import { Readable } from "node:stream";
import { pool } from "../src/db.js";

// Microsoft's Global ML Building Footprints — unlike the GRID3/Google imports (.gpkg files, loaded from a
// local path you already downloaded), this one is fetched live: a manifest CSV lists one gzipped,
// line-delimited-GeoJSON file per quadkey tile. Despite the ".csv.gz" extension, each decompressed line is a
// full GeoJSON Feature, not a CSV row (confirmed by downloading and inspecting a sample tile directly — don't
// trust the file extension here).
const MANIFEST_URL = "https://bfppub.blob.core.windows.net/$web/2026-08-13/dataset-links.csv";
const REGION = "Nigeria";
const BATCH_SIZE = 2000;

// the first run (before this file tracked `quadkey` per row) staged these 89 tiles successfully before a
// larger tile further down the list overflowed Node's max string length — see the streaming fix below. Those
// rows are already in the table with quadkey = NULL, so they can't be found by the normal
// "already staged" query; list them explicitly so a re-run doesn't redownload/reprocess 13M+ rows.
const ALREADY_STAGED_WITHOUT_QUADKEY = new Set([
  "122202301", "122202303", "122202310", "122202311", "122202312", "122202313", "122202321", "122202322",
  "122202323", "122202330", "122202331", "122202332", "122202333", "122203200", "122203201", "122203202",
  "122203203", "122203210", "122203211", "122203212", "122203213", "122203220", "122203221", "122203222",
  "122203223", "122203230", "122203231", "122203232", "122203233", "122203302", "122203303", "122203310",
  "122203311", "122203312", "122203313", "122203320", "122203321", "122203322", "122203323", "122203330",
  "122203331", "122203332", "122203333", "122212200", "122212201", "122212202", "122212203", "122212210",
  "122212211", "122212212", "122212213", "122212220", "122212221", "122212222", "122212223", "122212230",
  "122212231", "122212232", "122212233", "122212302", "122212320", "122212322", "122220033", "122220101",
  "122220102", "122220103", "122220110", "122220111", "122220112", "122220113", "122220120", "122220121",
  "122220122", "122220123", "122220130", "122220131", "122220132", "122220133", "122220211", "122220213",
  "122220231", "122220300", "122220301", "122220302", "122220303", "122220310", "122220311", "122220312",
  "122220313",
]);

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
      quadkey TEXT,
      height DOUBLE PRECISION,
      confidence DOUBLE PRECISION,
      area_in_meters DOUBLE PRECISION,
      geom GEOMETRY(MultiPolygon, 4326)
    );
    ALTER TABLE microsoft_buildings_staging ADD COLUMN IF NOT EXISTS quadkey TEXT;
  `);
}

interface StagedRow {
  height: number;
  confidence: number;
  geojson: string;
}

async function insertBatch(quadkey: string, rows: StagedRow[]): Promise<number> {
  if (!rows.length) return 0;
  const valuesSql: string[] = [];
  const params: any[] = [];
  let p = 1;
  for (const r of rows) {
    const gi = p + 3;
    const g = `ST_Multi(ST_SetSRID(ST_GeomFromGeoJSON($${gi}), 4326))`;
    valuesSql.push(`($${p}, $${p + 1}, $${p + 2}, ST_Area(${g}::geography), ${g})`);
    params.push(quadkey, r.height, r.confidence, r.geojson);
    p += 4;
  }
  const res = await pool.query(
    `INSERT INTO microsoft_buildings_staging (quadkey, height, confidence, area_in_meters, geom) VALUES ${valuesSql.join(",")}`,
    params
  );
  return res.rowCount ?? 0;
}

// streams the decompressed tile line-by-line via readline, rather than materializing the whole decompressed
// payload as one JS string (zlib.gunzipSync(buf).toString() crashed on a large tile with
// "Cannot create a string longer than 0x1fffffe8 characters" — Node/V8's hard string-length ceiling,
// ~512MB of UTF-16 chars. readline reads the gunzip stream in chunks and only ever holds one line at a time.
async function processTile(tile: TileRef): Promise<{ scanned: number; inserted: number; skipped: number }> {
  const res = await fetch(tile.url);
  if (!res.ok) throw new Error(`tile fetch failed (${res.status}): ${tile.url}`);
  const buf = Buffer.from(await res.arrayBuffer());

  const gunzip = zlib.createGunzip();
  const rl = readline.createInterface({ input: Readable.from(buf).pipe(gunzip), crlfDelay: Infinity });

  let batch: StagedRow[] = [];
  let scanned = 0, inserted = 0, skipped = 0;
  for await (const line of rl) {
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
      inserted += await insertBatch(tile.quadkey, batch);
      batch = [];
    }
  }
  inserted += await insertBatch(tile.quadkey, batch);
  return { scanned, inserted, skipped };
}

async function main() {
  await ensureStagingTable();
  let tiles = await fetchNigeriaTiles();

  const limit = Number(process.argv[2]);
  if (Number.isInteger(limit) && limit > 0) tiles = tiles.slice(0, limit); // for a quick validation run

  const { rows: doneRows } = await pool.query(
    `SELECT DISTINCT quadkey FROM microsoft_buildings_staging WHERE quadkey IS NOT NULL`
  );
  const alreadyDone = new Set([...doneRows.map((r) => r.quadkey as string), ...ALREADY_STAGED_WITHOUT_QUADKEY]);
  const remaining = tiles.filter((t) => !alreadyDone.has(t.quadkey));
  console.log(`${tiles.length} Nigeria tiles total, ${alreadyDone.size} already staged, ${remaining.length} remaining.`);

  let totalScanned = 0, totalInserted = 0, totalSkipped = 0;
  const start = Date.now();
  for (let i = 0; i < remaining.length; i++) {
    const tile = remaining[i];
    const { scanned, inserted, skipped } = await processTile(tile);
    totalScanned += scanned;
    totalInserted += inserted;
    totalSkipped += skipped;
    const secs = (Date.now() - start) / 1000;
    console.log(
      `[${i + 1}/${remaining.length}] quadkey=${tile.quadkey} scanned=${scanned} inserted=${inserted} skipped=${skipped} ` +
      `— run totals: ${totalInserted} inserted, ${totalScanned} scanned — ${secs.toFixed(0)}s elapsed`
    );
  }
  console.log(`Done. ${totalInserted} rows staged this run (${totalSkipped} malformed/non-polygon rows skipped) in ${((Date.now() - start) / 1000).toFixed(0)}s.`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
