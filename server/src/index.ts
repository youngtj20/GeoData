import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import bcrypt from "bcryptjs";
import { pool } from "./db.js";
import { attachUser, requireAuth, requirePermission, signToken, setSessionCookie, clearSessionCookie } from "./auth.js";
import { generateBuildingCode } from "./buildingId.js";
import { requireApiKey, generateApiKey, hashApiKey } from "./apiKeyAuth.js";
import { verifyAddress } from "./verifyAddress.js";

const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: "10mb" }));
app.use(cookieParser());
app.use(attachUser);

const BLOCKS_LIMIT = 5000;
const BUILDINGS_LIMIT = 8000; // bbox endpoint — a small viewport-sized fallback, this ceiling is fine
const WARD_BUILDINGS_LIMIT = 75000; // whole-ward endpoint — dense wards now routinely exceed 40k+ once Google Open Buildings is merged in

function parseBBox(q: express.Request["query"]) {
  const south = Number(q.south);
  const west = Number(q.west);
  const north = Number(q.north);
  const east = Number(q.east);
  if ([south, west, north, east].some((n) => Number.isNaN(n))) return null;
  return { south, west, north, east };
}

app.get("/api/health", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GRID3 settlement blocks — building-density stats per small block, within a map viewport
app.get("/api/settlement-blocks", async (req, res) => {
  const bbox = parseBBox(req.query);
  if (!bbox) return res.status(400).json({ error: "south, west, north, east query params required" });
  try {
    const { rows } = await pool.query(
      `SELECT
         id, block_id, building_count, building_area_sum, building_area_median,
         gbuilding_mean_height, bd_class, composite_class,
         ST_AsGeoJSON(geom) AS geojson
       FROM settlement_blocks
       WHERE geom && ST_MakeEnvelope($1, $2, $3, $4, 4326)
       LIMIT $5`,
      [bbox.west, bbox.south, bbox.east, bbox.north, BLOCKS_LIMIT]
    );
    const features = rows.map((r) => ({
      type: "Feature",
      properties: {
        id: r.id,
        block_id: r.block_id,
        building_count: r.building_count,
        building_area_sum: r.building_area_sum,
        building_area_median: r.building_area_median,
        gbuilding_mean_height: r.gbuilding_mean_height,
        bd_class: r.bd_class,
        composite_class: r.composite_class,
      },
      geometry: JSON.parse(r.geojson),
    }));
    res.json({ type: "FeatureCollection", features, count: features.length, capped: features.length === BLOCKS_LIMIT });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

function buildingFeature(r: any) {
  // OSM rows have a real osm_type/osm_id; Google-sourced rows don't (osm_id is NULL there), so they'd all
  // collide on the same "way/null" id without this — every Google building would share one identity,
  // breaking selection, the quick-pick list, and building-code generation
  const id = r.source === "osm" ? `${r.osm_type}/${r.osm_id}` : `${r.source}/${r.id}`;
  // prefer the human-readable building_code over the raw internal id (e.g. "way/1412017026") whenever one has
  // been assigned — falls back to the raw id only for the ~0.08% of buildings outside any known ward polygon
  const label = r.name || r.building_code || `Building ${id}`;
  return {
    type: "Feature",
    properties: { id: r.id, __id: id, label, building: r.fclass || "yes", osm_type: r.osm_type, osm_id: r.osm_id, type: r.btype, source: r.source, address: r.address ?? null, building_code: r.building_code ?? null },
    geometry: JSON.parse(r.geojson),
  };
}

// buildings within a bbox — fast path for viewport-driven exploration
app.get("/api/buildings", async (req, res) => {
  const bbox = parseBBox(req.query);
  if (!bbox) return res.status(400).json({ error: "south, west, north, east query params required" });
  try {
    const envelope = `ST_MakeEnvelope($1, $2, $3, $4, 4326)`;
    // nearest-to-viewport-center first (GiST KNN via <->, index-accelerated — not a full sort) so that when a
    // single dense micro-area exceeds the cap, the loaded subset radiates out from where the user is actually
    // looking rather than being an arbitrary, unordered slice
    const center = `ST_SetSRID(ST_MakePoint(($1 + $3) / 2.0, ($2 + $4) / 2.0), 4326)`;
    const [{ rows }, { rows: countRows }] = await Promise.all([
      pool.query(
        `SELECT id, source, osm_type, osm_id, fclass, name, btype, address, building_code, ST_AsGeoJSON(geom) AS geojson
         FROM buildings WHERE geom && ${envelope} ORDER BY geom <-> ${center} LIMIT $5`,
        [bbox.west, bbox.south, bbox.east, bbox.north, BUILDINGS_LIMIT]
      ),
      pool.query(`SELECT count(*) FROM buildings WHERE geom && ${envelope}`, [bbox.west, bbox.south, bbox.east, bbox.north]),
    ]);
    const features = rows.map(buildingFeature);
    const total = Number(countRows[0].count);
    res.json({ type: "FeatureCollection", features, count: features.length, total, capped: total > features.length });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// buildings within an arbitrary polygon (e.g. a ward's exact shape, fetched by the frontend from the boundaries API)
app.post("/api/buildings/within", async (req, res) => {
  const polygon = req.body?.polygon;
  if (!polygon || typeof polygon !== "object") return res.status(400).json({ error: "body must include a GeoJSON `polygon` (Polygon or MultiPolygon)" });
  try {
    const geomExpr = `ST_SetSRID(ST_GeomFromGeoJSON($1), 4326)`;
    // Capping an oversized ward at WARD_BUILDINGS_LIMIT needs the *kept* subset to have some coverage in every
    // part of the ward, not just a dense blob somewhere. A plain `ORDER BY ... LIMIT` (whether unordered/index-
    // traversal-order or ordered by distance from the centroid) fails this: unordered leaves "Load this area"
    // unable to find a findable gap, and centroid-distance ordering fills in a hard-edged *disk* around the
    // center and leaves genuinely-inside-the-ward areas near the edges at zero — which is exactly what broke
    // address search for buildings away from a large ward's center. Instead, chop the ward's bbox into a grid
    // and take up to `per_cell` buildings from each cell (GiST-index-assisted per cell) — every cell that has
    // buildings contributes some, so the initial load has baseline coverage everywhere, and "Load this area"
    // (a viewport-scoped /api/buildings call) still has real missing buildings to add in any cell that hit its
    // per-cell cap.
    const cellDeg = 0.006; // ~650m — fine enough to spread load evenly, coarse enough to keep cell count sane
    const gridQuery = `
      WITH bbox AS (
        SELECT ST_XMin(g) AS xmin, ST_XMax(g) AS xmax, ST_YMin(g) AS ymin, ST_YMax(g) AS ymax
        FROM (SELECT ${geomExpr} AS g) t
      ),
      params AS (
        SELECT xmin, ymin,
               ${cellDeg}::float8 AS cell,
               GREATEST(CEIL((xmax - xmin) / ${cellDeg})::int, 1) AS nx,
               GREATEST(CEIL((ymax - ymin) / ${cellDeg})::int, 1) AS ny
        FROM bbox
      ),
      budget AS (
        SELECT xmin, ymin, cell, nx, ny,
               GREATEST(LEAST($2 / (nx * ny), 3000), 20) AS per_cell
        FROM params
      )
      SELECT bf.id, bf.source, bf.osm_type, bf.osm_id, bf.fclass, bf.name, bf.btype, bf.address, bf.building_code, bf.geojson
      FROM budget p,
           generate_series(0, p.nx - 1) AS gx,
           generate_series(0, p.ny - 1) AS gy,
           LATERAL (
             SELECT id, source, osm_type, osm_id, fclass, name, btype, address, building_code, ST_AsGeoJSON(geom) AS geojson
             FROM buildings
             WHERE geom && ST_MakeEnvelope(p.xmin + gx * p.cell, p.ymin + gy * p.cell, p.xmin + (gx + 1) * p.cell, p.ymin + (gy + 1) * p.cell, 4326)
               AND ST_Intersects(geom, ${geomExpr})
             LIMIT p.per_cell
           ) bf
      LIMIT $2`;
    const [{ rows }, { rows: countRows }] = await Promise.all([
      pool.query(gridQuery, [JSON.stringify(polygon), WARD_BUILDINGS_LIMIT]),
      pool.query(`SELECT count(*) FROM buildings WHERE ST_Intersects(geom, ${geomExpr})`, [JSON.stringify(polygon)]),
    ]);
    const features = rows.map(buildingFeature);
    const total = Number(countRows[0].count);
    res.json({ type: "FeatureCollection", features, count: features.length, total, capped: total > features.length });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// direct nearest-building lookup for an arbitrary point (e.g. a geocoded search result) — the client's "auto-pick
// within 40m" only searches whatever's already loaded in the viewport/ward, which is necessarily a capped subset
// for oversized wards; that made address search silently fail for real buildings simply not in that subset yet.
// This endpoint is the server-side fallback so correctness never depends on what happens to be loaded client-side.
// Same ST_Expand bbox-prefilter pattern as /api/landmarks/:id/building — index-assisted, <20ms.
app.get("/api/buildings/nearest", async (req, res) => {
  const lat = Number(req.query.lat);
  const lon = Number(req.query.lon);
  const radiusM = req.query.radius != null ? Number(req.query.radius) : 40;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return res.status(400).json({ error: "lat and lon query params required" });
  if (!Number.isFinite(radiusM) || radiusM <= 0 || radiusM > 1000) return res.status(400).json({ error: "radius must be between 0 and 1000 meters" });
  try {
    const expandDeg = Math.min(radiusM / 111_000, 0.01) * 2; // generous bbox pre-filter, refined by the precise distance check below
    const { rows } = await pool.query(
      `SELECT id, source, osm_type, osm_id, fclass, name, btype, address, building_code, ST_AsGeoJSON(geom) AS geojson,
              ST_Distance(geom::geography, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography) AS distance_m
       FROM buildings
       WHERE geom && ST_Expand(ST_SetSRID(ST_MakePoint($1, $2), 4326), $3)
       ORDER BY geom <-> ST_SetSRID(ST_MakePoint($1, $2), 4326)
       LIMIT 1`,
      [lon, lat, expandDeg]
    );
    if (!rows.length || Number(rows[0].distance_m) > radiusM) return res.json({ found: false });
    const feature = buildingFeature(rows[0]);
    res.json({ found: true, building: feature, distance_m: Number(rows[0].distance_m) });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

const LANDMARK_CATEGORIES = new Set(["school", "mosque", "church", "market", "health_facility"]);
const LANDMARKS_LIMIT = 2000;
// below this zoom, individual points are clustered into grid cells instead of returned raw — at nationwide/city
// scale, raw points mean thousands of markers over the wire and thousands of DOM symbols to render (Google Maps'
// Data layer in particular seizes up the main thread well before that), so cap the viewport to a handful of
// cluster dots until the user is zoomed in far enough that the area naturally holds a small number of points
const LANDMARK_RAW_ZOOM_THRESHOLD = 15;
const LANDMARK_CLUSTER_CELL_DEG = 0.06; // ~6.6km grid cells — roughly LGA/neighborhood scale at this zoom band

// GRID3 points of interest (schools/mosques/churches/markets/health facilities) — public filterable map layer
app.get("/api/landmarks", async (req, res) => {
  const bbox = parseBBox(req.query);
  if (!bbox) return res.status(400).json({ error: "south, west, north, east query params required" });
  const categories = String(req.query.categories ?? "")
    .split(",")
    .map((c) => c.trim())
    .filter((c) => LANDMARK_CATEGORIES.has(c));
  if (!categories.length) return res.json({ type: "FeatureCollection", features: [], count: 0, capped: false, clustered: false });
  const zoom = Number(req.query.zoom ?? 20);
  try {
    const envelope = `ST_MakeEnvelope($1, $2, $3, $4, 4326)`;
    if (zoom < LANDMARK_RAW_ZOOM_THRESHOLD) {
      // LIMIT guards against a huge bbox paired with a dishonest/malformed zoom param — without it, a malicious or
      // buggy client could still force a worst-case response this endpoint is meant to prevent in the first place
      const { rows } = await pool.query(
        `SELECT category, COUNT(*) AS count, AVG(ST_X(geom)) AS lon, AVG(ST_Y(geom)) AS lat
         FROM landmarks
         WHERE category = ANY($5::text[]) AND geom && ${envelope}
         GROUP BY category, ST_SnapToGrid(geom, $6, $6)
         LIMIT 2000`,
        [bbox.west, bbox.south, bbox.east, bbox.north, categories, LANDMARK_CLUSTER_CELL_DEG]
      );
      const features = rows.map((r, i) => ({
        type: "Feature",
        properties: { cluster: true, id: `cluster-${i}`, category: r.category, count: Number(r.count) },
        geometry: { type: "Point", coordinates: [Number(r.lon), Number(r.lat)] },
      }));
      return res.json({ type: "FeatureCollection", features, count: features.length, capped: false, clustered: true });
    }
    // raw mode: fetch one extra row to detect truncation without a separate COUNT(*) query — exact totals aren't
    // worth the extra full-table scan for what is a supplementary visualization layer, not core verification data.
    // matched_building_geom/id are precomputed once (see scripts/match-landmarks-to-buildings.ts) — reading them
    // here is a plain column fetch, not a live spatial join, so it costs nothing extra per request.
    const { rows } = await pool.query(
      `SELECT id, category, name, state_name, lga_name, ward_name, attrs, ST_AsGeoJSON(geom) AS geojson,
              ST_AsGeoJSON(matched_building_geom) AS building_geojson, matched_building_id
       FROM landmarks WHERE category = ANY($5::text[]) AND geom && ${envelope} LIMIT $6`,
      [bbox.west, bbox.south, bbox.east, bbox.north, categories, LANDMARKS_LIMIT + 1]
    );
    const capped = rows.length > LANDMARKS_LIMIT;
    const trimmed = capped ? rows.slice(0, LANDMARKS_LIMIT) : rows;
    const features = trimmed.map((r) => ({
      type: "Feature",
      // attrs spread first — some datasets (schools) carry their own "category"/"name"-adjacent attribute keys
      // that must not shadow the canonical landmark fields below (e.g. school level "Primary" vs. landmark type "school")
      properties: {
        ...r.attrs, id: r.id, category: r.category, name: r.name, state: r.state_name, lga: r.lga_name, ward: r.ward_name,
        cluster: false, has_building: r.building_geojson != null, building_id: r.matched_building_id,
      },
      // render the real building footprint when we have one; fall back to the survey point otherwise
      geometry: r.building_geojson ? JSON.parse(r.building_geojson) : JSON.parse(r.geojson),
    }));
    res.json({ type: "FeatureCollection", features, count: features.length, capped, clustered: false });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// a landmark is a GRID3 survey point, not a building footprint — on demand (click), find the actual building
// polygon it sits in/near so it can be shown as a real footprint rather than just a dot. Bounded to a per-landmark
// lookup, never run in bulk across a viewport: ST_Expand(..., 0.0005) (~55m) lets Postgres use buildings_geom_idx
// for the candidate set before the precise ST_Contains/ST_Distance ordering — tested at <20ms cold, <1ms warm.
// A plain ST_DWithin(geography) join without this bbox pre-filter can't use the index and was observed to hang.
app.get("/api/landmarks/:id/building", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "invalid landmark id" });
  try {
    const { rows } = await pool.query(
      `SELECT b.id, b.source, b.osm_type, b.osm_id, b.fclass, b.name, b.btype, b.building_code, ST_AsGeoJSON(b.geom) AS geojson
       FROM landmarks l
       JOIN buildings b ON b.geom && ST_Expand(l.geom, 0.0005)
       WHERE l.id = $1
       ORDER BY ST_Contains(b.geom, l.geom) DESC, ST_Distance(b.geom::geography, l.geom::geography) ASC
       LIMIT 1`,
      [id]
    );
    if (!rows.length) return res.json({ found: false });
    const r = rows[0];
    const buildingId = r.source === "osm" ? `${r.osm_type}/${r.osm_id}` : `${r.source}/${r.id}`;
    res.json({
      found: true,
      building: {
        type: "Feature",
        properties: { __id: buildingId, label: r.name || r.building_code || `Building ${buildingId}`, source: r.source, building_code: r.building_code ?? null },
        geometry: JSON.parse(r.geojson),
      },
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// MAX_BUILDING_AREA_SQM guards against accidental giant traces (fat-fingered double-click chains, a whole block
// traced instead of one structure) — generous enough for a large warehouse/school complex, far below "a city block"
const MAX_BUILDING_AREA_SQM = 20000;
const MIN_BUILDING_AREA_SQM = 2;

// contribute a building footprint missing from the imported OSM/Google Open Buildings data — traced by hand on
// the map, so these live under source='manual' and carry an audit trail (who/when)
app.post("/api/admin/buildings", requireAuth, async (req, res) => {
  const polygon = req.body?.polygon;
  const name = typeof req.body?.name === "string" ? req.body.name.trim().slice(0, 200) : null;
  // free-text fallback for when the descriptive/postal address isn't resolvable from any map provider — stored
  // as-is rather than geocoded, since the whole point is this building doesn't show up on the map by address
  const address = typeof req.body?.address === "string" ? req.body.address.trim().slice(0, 300) : null;
  if (!polygon || typeof polygon !== "object" || !["Polygon", "MultiPolygon"].includes(polygon.type)) {
    return res.status(400).json({ error: "body must include a GeoJSON `polygon` (Polygon or MultiPolygon)" });
  }
  try {
    const geomExpr = `ST_Multi(ST_SetSRID(ST_GeomFromGeoJSON($1), 4326))`;
    const { rows: areaRows } = await pool.query(`SELECT ST_Area(${geomExpr}::geography) AS area`, [JSON.stringify(polygon)]);
    const area = Number(areaRows[0].area);
    if (!Number.isFinite(area) || area < MIN_BUILDING_AREA_SQM) {
      return res.status(400).json({ error: `Traced shape is too small (${area.toFixed(1)} m²) to be a building — check for a self-intersecting or collapsed outline` });
    }
    if (area > MAX_BUILDING_AREA_SQM) {
      return res.status(400).json({ error: `Traced shape is too large (${area.toFixed(0)} m²) — trace a single building, not a block or compound` });
    }
    // find which ward this building's centroid falls in, so it can get a real building_code — the same
    // STATE-LGA-WARD-SEQ scheme every imported building has (see server/src/buildingId.ts)
    const { rows: wardRows } = await pool.query(
      `SELECT wl.id, s.short_code AS state_short_code, l.short_code AS lga_short_code, wl.ward_number
       FROM ward_boundaries wb
       JOIN wards_list wl ON wl.state_name = wb.state AND wl.lga_name = wb.lga AND wl.name = wb.ward
       JOIN states_list s ON s.name = wl.state_name
       JOIN lgas_list l ON l.state_name = wl.state_name AND l.name = wl.lga_name
       WHERE ST_Contains(wb.geom, ST_Centroid(${geomExpr}))
       LIMIT 1`,
      [JSON.stringify(polygon)]
    );
    let wardId: number | null = null;
    let buildingCode: string | null = null;
    if (wardRows.length) {
      const w = wardRows[0];
      wardId = w.id;
      const { rows: seqRows } = await pool.query(
        `INSERT INTO ward_building_counters (ward_id, next_seq) VALUES ($1, 2)
         ON CONFLICT (ward_id) DO UPDATE SET next_seq = ward_building_counters.next_seq + 1
         RETURNING next_seq - 1 AS seq`,
        [wardId]
      );
      const buildingSeq = seqRows[0].seq;
      buildingCode = generateBuildingCode({
        stateShortCode: w.state_short_code,
        lgaShortCode: w.lga_short_code,
        wardNumber: w.ward_number,
        buildingSeq,
      });
      const { rows } = await pool.query(
        `INSERT INTO buildings (source, name, btype, geom, area_in_meters, created_by, created_at, address, ward_id, building_seq, building_code)
         VALUES ('manual', $2, 'manual', ${geomExpr}, $3, $4, now(), $5, $6, $7, $8)
         RETURNING id, ST_AsGeoJSON(geom) AS geojson`,
        [JSON.stringify(polygon), name, area, req.user!.id, address, wardId, buildingSeq, buildingCode]
      );
      const r = rows[0];
      return res.status(201).json({
        type: "Feature",
        properties: { __id: `manual/${r.id}`, label: name || buildingCode || `Building manual/${r.id}`, source: "manual", address, building_code: buildingCode },
        geometry: JSON.parse(r.geojson),
      });
    }
    // outside any known ward polygon (rare — a gap in ward coverage) — save it anyway, just without a building_code
    const { rows } = await pool.query(
      `INSERT INTO buildings (source, name, btype, geom, area_in_meters, created_by, created_at, address)
       VALUES ('manual', $2, 'manual', ${geomExpr}, $3, $4, now(), $5)
       RETURNING id, ST_AsGeoJSON(geom) AS geojson`,
      [JSON.stringify(polygon), name, area, req.user!.id, address]
    );
    const r = rows[0];
    res.status(201).json({
      type: "Feature",
      properties: { __id: `manual/${r.id}`, label: name || `Building manual/${r.id}`, source: "manual", address, building_code: null },
      geometry: JSON.parse(r.geojson),
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// confirm/correct the address for ANY building (not just manually-traced ones) — the permanent building_code
// identifies the structure; this is the human-verified address attached to it. Any logged-in user can submit
// one, same trust model as tracing a missing building footprint.
app.put("/api/admin/buildings/:id/address", requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "invalid building id" });
  const address = typeof req.body?.address === "string" ? req.body.address.trim().slice(0, 300) : null;
  try {
    const { rows } = await pool.query(
      `UPDATE buildings SET address = $1, address_updated_by = $2, address_updated_at = now()
       WHERE id = $3
       RETURNING id, address`,
      [address || null, req.user!.id, id]
    );
    if (!rows.length) return res.status(404).json({ error: "Building not found" });
    res.json({ ok: true, address: rows[0].address });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// state/LGA/ward name lists + polygon boundaries — merged from GRID3 v3 (primary, 24 states) with
// v1 filling in the 13 states v3 doesn't cover (see server/scripts/import-ward-boundaries.ts)
app.get("/api/stats", async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM states_list) AS states,
        (SELECT COUNT(*) FROM lgas_list) AS lgas,
        (SELECT COUNT(*) FROM wards_list) AS wards,
        (SELECT COUNT(*) FROM buildings) AS cached_geometries
    `);
    const r = rows[0];
    res.json({ states: Number(r.states), lgas: Number(r.lgas), wards: Number(r.wards), cached_geometries: Number(r.cached_geometries) });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/states", async (_req, res) => {
  try {
    const { rows } = await pool.query(`SELECT id, name, code FROM states_list ORDER BY name`);
    res.json(rows);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/lgas", async (req, res) => {
  const state = String(req.query.state ?? "");
  if (!state) return res.status(400).json({ error: "state query param required" });
  try {
    const { rows } = await pool.query(
      `SELECT id, state_name, name, code FROM lgas_list WHERE state_name = $1 ORDER BY name`,
      [state]
    );
    res.json(rows);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/wards", async (req, res) => {
  const state = String(req.query.state ?? "");
  const lga = String(req.query.lga ?? "");
  if (!state || !lga) return res.status(400).json({ error: "state and lga query params required" });
  try {
    const { rows } = await pool.query(
      `SELECT id, state_name, lga_name, name, code FROM wards_list WHERE state_name = $1 AND lga_name = $2 ORDER BY name`,
      [state, lga]
    );
    res.json(rows);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/boundaries", async (req, res) => {
  const level = String(req.query.level ?? "");
  const state = String(req.query.state ?? "");
  const lga = req.query.lga ? String(req.query.lga) : undefined;
  if (!state) return res.status(400).json({ error: "state query param required" });
  try {
    let rows: any[];
    let propsOf: (r: any) => Record<string, any>;
    if (level === "state") {
      ({ rows } = await pool.query(`SELECT state, ST_AsGeoJSON(geom) AS geojson FROM state_boundaries WHERE state = $1`, [state]));
      propsOf = (r) => ({ statename: r.state });
    } else if (level === "lgas") {
      ({ rows } = await pool.query(`SELECT lga, ST_AsGeoJSON(geom) AS geojson FROM lga_boundaries WHERE state = $1`, [state]));
      propsOf = (r) => ({ lganame: r.lga });
    } else if (level === "lga") {
      if (!lga) return res.status(400).json({ error: "lga query param required for level=lga" });
      ({ rows } = await pool.query(`SELECT lga, ST_AsGeoJSON(geom) AS geojson FROM lga_boundaries WHERE state = $1 AND lga = $2`, [state, lga]));
      propsOf = (r) => ({ lganame: r.lga });
    } else if (level === "ward") {
      if (!lga) return res.status(400).json({ error: "lga query param required for level=ward" });
      ({ rows } = await pool.query(`SELECT ward, wardcode, source_version, ST_AsGeoJSON(geom) AS geojson FROM ward_boundaries WHERE state = $1 AND lga = $2`, [state, lga]));
      propsOf = (r) => ({ wardname: r.ward, wardcode: r.wardcode, source: r.source_version });
    } else {
      return res.status(400).json({ error: "level must be one of: state, lgas, lga, ward" });
    }
    const features = rows.map((r) => ({ type: "Feature", properties: propsOf(r), geometry: JSON.parse(r.geojson) }));
    res.json({
      level, state, lga: lga ?? null, ward: null,
      source: "GRID3 NGA Operational Wards v3.0 (local) + v1 fallback for states v3 doesn't cover",
      cached: true, count: features.length,
      geojson: { type: "FeatureCollection", features },
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ---- 3rd-party verification API (API-key auth, separate from the admin session cookie above) ----

app.post("/api/v1/verify-address", requireApiKey, async (req, res) => {
  const body = req.body ?? {};
  const requestRef = typeof body.requestRef === "string" ? body.requestRef.trim() : "";
  if (!requestRef) return res.status(400).json({ error: "requestRef is required" });
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  const num = (v: unknown) => {
    const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
    return Number.isFinite(n) ? n : null;
  };
  try {
    const result = await verifyAddress(
      {
        requestRef,
        firstName: str(body.firstName),
        lastName: str(body.lastName),
        middleName: str(body.middleName),
        dateOfBirth: str(body.dateOfBirth),
        email: str(body.email),
        phoneNumber: str(body.phoneNumber),
        addressDescriptive: str(body.addressDescriptive),
        landmark: str(body.landmark),
        state: str(body.state),
        lga: str(body.lga),
        latitude: num(body.latitude),
        longitude: num(body.longitude),
      },
      req.apiClient!.id
    );
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ---- auth ----

app.post("/api/auth/login", async (req, res) => {
  const { username, password } = req.body ?? {};
  if (!username || !password) return res.status(400).json({ error: "username and password required" });
  try {
    const { rows } = await pool.query(`SELECT id, password_hash FROM users WHERE username = $1`, [username]);
    if (!rows.length || !(await bcrypt.compare(password, rows[0].password_hash))) {
      return res.status(401).json({ error: "Invalid username or password" });
    }
    setSessionCookie(res, signToken(rows[0].id));
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/auth/logout", (_req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

app.get("/api/auth/me", (req, res) => {
  if (!req.user) return res.status(401).json({ error: "Not logged in" });
  res.json({ id: req.user.id, username: req.user.username, permissions: req.user.permissions });
});

// ---- admin: user + permission management (requires manage_users) ----

app.get("/api/admin/permissions", requirePermission("manage_users"), async (_req, res) => {
  try {
    const { rows } = await pool.query(`SELECT key, label, description FROM permissions ORDER BY key`);
    res.json(rows);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/admin/users", requirePermission("manage_users"), async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT u.id, u.username, u.created_at, COALESCE(array_agg(p.key) FILTER (WHERE p.key IS NOT NULL), '{}') AS permissions
      FROM users u
      LEFT JOIN user_permissions up ON up.user_id = u.id
      LEFT JOIN permissions p ON p.id = up.permission_id
      GROUP BY u.id
      ORDER BY u.username
    `);
    res.json(rows);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/admin/users", requirePermission("manage_users"), async (req, res) => {
  const { username, password, permissions } = req.body ?? {};
  if (!username || !password) return res.status(400).json({ error: "username and password required" });
  try {
    const hash = await bcrypt.hash(password, 10);
    const { rows } = await pool.query(
      `INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING id`,
      [username, hash]
    );
    const userId = rows[0].id;
    if (Array.isArray(permissions) && permissions.length) {
      await pool.query(
        `INSERT INTO user_permissions (user_id, permission_id)
         SELECT $1, id FROM permissions WHERE key = ANY($2::text[])`,
        [userId, permissions]
      );
    }
    res.status(201).json({ id: userId, username });
  } catch (err: any) {
    if (err.code === "23505") return res.status(409).json({ error: "Username already exists" });
    res.status(500).json({ error: err.message });
  }
});

app.put("/api/admin/users/:id/permissions", requirePermission("manage_users"), async (req, res) => {
  const userId = Number(req.params.id);
  const { permissions } = req.body ?? {};
  if (!Number.isInteger(userId) || !Array.isArray(permissions)) {
    return res.status(400).json({ error: "permissions must be an array of permission keys" });
  }
  try {
    await pool.query("BEGIN");
    await pool.query(`DELETE FROM user_permissions WHERE user_id = $1`, [userId]);
    if (permissions.length) {
      await pool.query(
        `INSERT INTO user_permissions (user_id, permission_id)
         SELECT $1, id FROM permissions WHERE key = ANY($2::text[])`,
        [userId, permissions]
      );
    }
    await pool.query("COMMIT");
    res.json({ ok: true });
  } catch (err: any) {
    await pool.query("ROLLBACK");
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/admin/users/:id", requirePermission("manage_users"), async (req, res) => {
  const userId = Number(req.params.id);
  if (!Number.isInteger(userId)) return res.status(400).json({ error: "invalid user id" });
  if (req.user!.id === userId) return res.status(400).json({ error: "Cannot delete your own account" });
  try {
    await pool.query(`DELETE FROM users WHERE id = $1`, [userId]);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ---- admin: 3rd-party API client management (requires manage_api_clients) ----
// these are the credentials 3rd parties use against POST /api/v1/verify-address — a separate trust boundary
// from the users/permissions above, which govern the admin UI itself

app.get("/api/admin/api-clients", requirePermission("manage_api_clients"), async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, name, active, created_at, last_used_at FROM api_clients ORDER BY created_at DESC`
    );
    res.json(rows);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/admin/api-clients", requirePermission("manage_api_clients"), async (req, res) => {
  const name = typeof req.body?.name === "string" ? req.body.name.trim().slice(0, 200) : "";
  if (!name) return res.status(400).json({ error: "name is required" });
  try {
    const rawKey = generateApiKey();
    const { rows } = await pool.query(
      `INSERT INTO api_clients (name, key_hash, active, created_at) VALUES ($1, $2, true, now())
       RETURNING id, name, active, created_at, last_used_at`,
      [name, hashApiKey(rawKey)]
    );
    // apiKey is returned exactly once, right here — only its hash is ever persisted, so this response is the
    // only chance anyone (including us) gets to see the raw key again
    res.status(201).json({ ...rows[0], apiKey: rawKey });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.put("/api/admin/api-clients/:id/active", requirePermission("manage_api_clients"), async (req, res) => {
  const id = Number(req.params.id);
  const { active } = req.body ?? {};
  if (!Number.isInteger(id) || typeof active !== "boolean") return res.status(400).json({ error: "active (boolean) is required" });
  try {
    const { rows } = await pool.query(
      `UPDATE api_clients SET active = $1 WHERE id = $2 RETURNING id, name, active, created_at, last_used_at`,
      [active, id]
    );
    if (!rows.length) return res.status(404).json({ error: "API client not found" });
    res.json(rows[0]);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/admin/api-clients/:id", requirePermission("manage_api_clients"), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "invalid id" });
  try {
    await pool.query(`DELETE FROM api_clients WHERE id = $1`, [id]);
    res.json({ ok: true });
  } catch (err: any) {
    // a client with any verification_requests history can't be hard-deleted (FK restrict) — that history is the
    // compliance audit trail this API exists for, so losing it (or silently orphaning it) isn't acceptable;
    // revoking still blocks the key immediately while keeping the record that this client existed
    if (err.code === "23503") {
      return res.status(409).json({ error: "This client has existing verification history and can't be deleted — revoke it instead to block further use while preserving the audit trail." });
    }
    res.status(500).json({ error: err.message });
  }
});

// ---- map settings: public read (the live map uses this), admin-gated write ----

app.get("/api/map-settings", async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT provider, show_wards, show_buildings, show_settlements FROM map_settings WHERE id = 1`
    );
    res.json(rows[0]);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.put("/api/admin/map-settings", requireAuth, async (req, res) => {
  const { provider, show_wards, show_buildings, show_settlements } = req.body ?? {};
  const changingProvider = provider !== undefined;
  const changingLayers = show_wards !== undefined || show_buildings !== undefined || show_settlements !== undefined;
  if (changingProvider && !req.user!.permissions.includes("change_map_provider")) {
    return res.status(403).json({ error: "Missing permission: change_map_provider" });
  }
  const layerPerms: Record<string, string> = {
    show_wards: "toggle_layer_wards",
    show_buildings: "toggle_layer_buildings",
    show_settlements: "toggle_layer_settlements",
  };
  for (const [field, perm] of Object.entries(layerPerms)) {
    if (req.body?.[field] !== undefined && !req.user!.permissions.includes(perm)) {
      return res.status(403).json({ error: `Missing permission: ${perm}` });
    }
  }
  if (!changingProvider && !changingLayers) return res.status(400).json({ error: "No fields to update" });
  if (provider !== undefined && !["google", "mapbox", "osm"].includes(provider)) {
    return res.status(400).json({ error: "provider must be one of: google, mapbox, osm" });
  }
  try {
    const { rows } = await pool.query(
      `UPDATE map_settings SET
         provider = COALESCE($1, provider),
         show_wards = COALESCE($2, show_wards),
         show_buildings = COALESCE($3, show_buildings),
         show_settlements = COALESCE($4, show_settlements),
         updated_by = $5,
         updated_at = now()
       WHERE id = 1
       RETURNING provider, show_wards, show_buildings, show_settlements`,
      [provider ?? null, show_wards ?? null, show_buildings ?? null, show_settlements ?? null, req.user!.id]
    );
    res.json(rows[0]);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

const port = Number(process.env.PORT ?? 8787);
app.listen(port, () => console.log(`groundtruth-server listening on :${port}`));
