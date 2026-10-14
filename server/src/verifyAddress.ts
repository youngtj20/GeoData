import { pool } from "./db.js";
import { googleGeocode } from "./geocode.js";

export interface VerifyAddressInput {
  requestRef: string;
  firstName?: string | null;
  lastName?: string | null;
  middleName?: string | null;
  dateOfBirth?: string | null;
  email?: string | null;
  phoneNumber?: string | null;
  addressDescriptive?: string | null;
  landmark?: string | null;
  state?: string | null;
  lga?: string | null;
  // explicit coordinate fields, for callers that send them separately rather than embedded in addressDescriptive
  latitude?: number | null;
  longitude?: number | null;
}

export interface VerifyAddressResult {
  requestRef: string;
  status: "issued" | "failed";
  buildingID: string | null;
  latitude: number | null;
  longitude: number | null;
  state: string | null;
  lga: string | null;
  ward: string | null;
  accuracy: number;
}

// generous national bounding box — just enough to reject obviously-wrong/zero/swapped coordinates before they
// ever reach a spatial query, not a precise border check
const NG_BOUNDS = { minLat: 4.0, maxLat: 14.0, minLon: 2.5, maxLon: 15.0 };
function inNigeria(lat: number, lon: number): boolean {
  return Number.isFinite(lat) && Number.isFinite(lon) &&
    lat >= NG_BOUNDS.minLat && lat <= NG_BOUNDS.maxLat && lon >= NG_BOUNDS.minLon && lon <= NG_BOUNDS.maxLon;
}

// some 3rd parties stuff a raw coordinate pair into the free-text address field instead of (or alongside)
// structured lat/lon fields — e.g. "6.4501, 3.2901" — catch that before falling through to text/geocoder matching
function extractInlineCoordinate(text: string | null | undefined): { lat: number; lon: number } | null {
  if (!text) return null;
  const m = text.match(/(-?\d{1,2}\.\d+)\s*[,/]\s*(-?\d{1,3}\.\d+)/);
  if (!m) return null;
  const lat = Number(m[1]);
  const lon = Number(m[2]);
  return inNigeria(lat, lon) ? { lat, lon } : null;
}

function buildingExternalId(b: { source: string; osm_type?: string | null; osm_id?: number | string | null; id: number | string; building_code?: string | null }): string {
  if (b.building_code) return b.building_code;
  return b.source === "osm" ? `${b.osm_type}/${b.osm_id}` : `${b.source}/${b.id}`;
}

// linear decay: full confidence at distance 0, floor confidence at the search radius (beyond which the match
// wouldn't have been returned at all)
function distanceAccuracy(distanceM: number, radiusM: number, floor: number, ceiling = 100): number {
  const t = Math.max(0, Math.min(1, distanceM / radiusM));
  return Math.round(ceiling - t * (ceiling - floor));
}

interface BuildingRow {
  id: number;
  source: string;
  osm_type: string | null;
  osm_id: number | null;
  building_code: string | null;
  ward_id: number | null;
  centroid_lat: number;
  centroid_lon: number;
  distance_m?: number;
  sim?: number;
}

// a geocoded point having a building footprint nearby isn't, on its own, proof of a plausible address — Google
// will happily return a ROOFTOP-precision point for a spot in open bush next to an isolated structure. This
// checks whether the point actually falls inside a GRID3-mapped settlement extent (an inhabited area), as an
// extra plausibility signal for the geocoder-fallback path specifically (stages 1-3 are already grounded in
// either caller-provided coordinates or our own on-file data, so don't need this check).
async function isInSettlement(lat: number, lon: number): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT 1 FROM settlement_blocks
     WHERE geom && ST_Expand(ST_SetSRID(ST_MakePoint($1, $2), 4326), 0.001)
       AND ST_Contains(geom, ST_SetSRID(ST_MakePoint($1, $2), 4326))
     LIMIT 1`,
    [lon, lat]
  );
  return rows.length > 0;
}

async function nearestBuilding(lat: number, lon: number, radiusM: number): Promise<BuildingRow | null> {
  const expandDeg = Math.min(radiusM / 111_000, 0.01) * 2; // bbox pre-filter, refined by the exact distance check below
  const { rows } = await pool.query(
    `SELECT id, source, osm_type, osm_id, building_code, ward_id,
            ST_Y(ST_Centroid(geom)) AS centroid_lat, ST_X(ST_Centroid(geom)) AS centroid_lon,
            ST_Distance(geom::geography, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography) AS distance_m
     FROM buildings
     WHERE geom && ST_Expand(ST_SetSRID(ST_MakePoint($1, $2), 4326), $3)
     ORDER BY geom <-> ST_SetSRID(ST_MakePoint($1, $2), 4326)
     LIMIT 1`,
    [lon, lat, expandDeg]
  );
  if (!rows.length || Number(rows[0].distance_m) > radiusM) return null;
  return rows[0];
}

// resolves state/lga free text to the set of ward ids it could refer to — exact match first, trigram-fuzzy
// fallback for spelling/casing drift, index-assisted via the wards_list_*_trgm_idx indexes
async function resolveWardIds(state?: string | null, lga?: string | null): Promise<number[] | null> {
  if (!state) return null;
  const { rows } = await pool.query(
    `SELECT id FROM wards_list
     WHERE (lower(state_name) = lower($1) OR lower(state_name) % lower($1))
       AND ($2::text IS NULL OR lower(lga_name) = lower($2) OR lower(lga_name) % lower($2))`,
    [state, lga ?? null]
  );
  return rows.map((r) => Number(r.id));
}

// the authoritative state/LGA/ward for whichever building actually matched — not the caller's claimed state/lga,
// so the response can be used to confirm (or catch a mismatch in) what the caller submitted
async function resolveWardDetails(wardId: number | null): Promise<{ state: string | null; lga: string | null; ward: string | null }> {
  if (wardId == null) return { state: null, lga: null, ward: null };
  const { rows } = await pool.query(`SELECT state_name, lga_name, name FROM wards_list WHERE id = $1`, [wardId]);
  if (!rows.length) return { state: null, lga: null, ward: null };
  return { state: rows[0].state_name, lga: rows[0].lga_name, ward: rows[0].name };
}

// fuzzy match against the human-confirmed/imported free-text address on buildings, scoped to the resolved
// state/lga when available. `%` (not a raw similarity() > threshold filter) is what lets Postgres use
// buildings_address_trgm_idx instead of a sequential scan when wardIds is null (no state given).
async function matchByAddressText(addressQuery: string, wardIds: number[] | null): Promise<BuildingRow | null> {
  const { rows } = await pool.query(
    `SELECT id, source, osm_type, osm_id, building_code, ward_id,
            ST_Y(ST_Centroid(geom)) AS centroid_lat, ST_X(ST_Centroid(geom)) AS centroid_lon,
            similarity(lower(address), lower($1)) AS sim
     FROM buildings
     WHERE address IS NOT NULL
       AND lower(address) % lower($1)
       AND ($2::bigint[] IS NULL OR ward_id = ANY($2))
     ORDER BY sim DESC
     LIMIT 1`,
    [addressQuery, wardIds]
  );
  return rows[0] ?? null;
}

// landmark-descriptive input ("behind Zenith Bank, opposite X market") — fuzzy match against GRID3 landmark
// names, then find the building footprint nearest the landmark's point. Note: landmarks.matched_building_id is
// a precomputed display convenience for the public map (a composite "source/osm_id" string, not a buildings.id
// FK) — simplest and safest here is the same live spatial join /api/landmarks/:id/building already does,
// rather than parsing that string back into an id.
async function matchByLandmark(
  landmarkQuery: string,
  state?: string | null,
  lga?: string | null
): Promise<{ building: BuildingRow; sim: number } | null> {
  const { rows } = await pool.query(
    `SELECT id, ST_Y(geom) AS lat, ST_X(geom) AS lon, similarity(lower(name), lower($1)) AS sim
     FROM landmarks
     WHERE name IS NOT NULL
       AND lower(name) % lower($1)
       AND ($2::text IS NULL OR lower(state_name) = lower($2) OR lower(state_name) % lower($2))
       AND ($3::text IS NULL OR lower(lga_name) = lower($3) OR lower(lga_name) % lower($3))
     ORDER BY sim DESC
     LIMIT 1`,
    [landmarkQuery, state ?? null, lga ?? null]
  );
  if (!rows.length) return null;
  const lm = rows[0];
  const nb = await nearestBuilding(Number(lm.lat), Number(lm.lon), 80);
  return nb ? { building: nb, sim: Number(lm.sim) } : null;
}

// assembles the full "issued" response for a matched building, including the ward/lga/state it actually
// belongs to — resolved from the match, not echoed back from whatever the caller claimed
async function issuedResult(requestRef: string, building: BuildingRow, accuracy: number): Promise<VerifyAddressResult> {
  const { state, lga, ward } = await resolveWardDetails(building.ward_id);
  return {
    requestRef, status: "issued", buildingID: buildingExternalId(building),
    latitude: Number(building.centroid_lat), longitude: Number(building.centroid_lon),
    state, lga, ward, accuracy,
  };
}

function failedResult(requestRef: string): VerifyAddressResult {
  return { requestRef, status: "failed", buildingID: null, latitude: null, longitude: null, state: null, lga: null, ward: null, accuracy: 0 };
}

async function loadExistingResult(requestRef: string): Promise<VerifyAddressResult | null> {
  const { rows } = await pool.query(
    `SELECT status, building_code, result_latitude, result_longitude, result_state, result_lga, result_ward, accuracy
     FROM verification_requests WHERE request_ref = $1`,
    [requestRef]
  );
  if (!rows.length) return null;
  const r = rows[0];
  return {
    requestRef,
    status: r.status,
    buildingID: r.building_code,
    latitude: r.result_latitude != null ? Number(r.result_latitude) : null,
    longitude: r.result_longitude != null ? Number(r.result_longitude) : null,
    state: r.result_state,
    lga: r.result_lga,
    ward: r.result_ward,
    accuracy: Number(r.accuracy),
  };
}

// the whole point of keying verification_requests on request_ref: a 3rd party retrying the same request (network
// timeout, at-least-once delivery) gets back the exact result already issued, rather than a second (possibly
// different, e.g. after a geocoder result changes) answer — and never pays for a second geocoder call either
export async function verifyAddress(input: VerifyAddressInput, apiClientId: number): Promise<VerifyAddressResult> {
  const existing = await loadExistingResult(input.requestRef);
  if (existing) return existing;

  let result: VerifyAddressResult = failedResult(input.requestRef);
  let matchMethod: string | null = null;

  // 1. coordinate given (explicit fields, or embedded in the free-text address) — the most reliable signal,
  // since it's a direct point lookup rather than a text/geocoder guess
  const explicitCoord =
    input.latitude != null && input.longitude != null && inNigeria(input.latitude, input.longitude)
      ? { lat: input.latitude, lon: input.longitude }
      : null;
  const coord = explicitCoord ?? extractInlineCoordinate(input.addressDescriptive);
  if (coord) {
    const b = await nearestBuilding(coord.lat, coord.lon, 60);
    if (b) {
      result = await issuedResult(input.requestRef, b, distanceAccuracy(Number(b.distance_m), 60, 55));
      matchMethod = "coordinate";
    }
  }

  // 2 & 3. structured/descriptive address text — first against buildings.address directly, then against
  // landmark names (the dedicated `landmark` field when given, otherwise addressDescriptive doubles as the
  // landmark query — covers "opposite the market" style input folded into one free-text field)
  if (result.status === "failed" && (input.addressDescriptive || input.landmark)) {
    const wardIds = await resolveWardIds(input.state, input.lga);

    if (input.addressDescriptive) {
      const addrMatch = await matchByAddressText(input.addressDescriptive, wardIds);
      if (addrMatch) {
        result = await issuedResult(input.requestRef, addrMatch, Math.min(97, Math.round(Number(addrMatch.sim) * 100))); // 100 reserved for exact-coordinate hits
        matchMethod = "address_text";
      }
    }

    if (result.status === "failed") {
      const landmarkQuery = input.landmark || input.addressDescriptive;
      if (landmarkQuery) {
        const lmMatch = await matchByLandmark(landmarkQuery, input.state, input.lga);
        if (lmMatch) {
          result = await issuedResult(input.requestRef, lmMatch.building, Math.max(50, Math.round(lmMatch.sim * 80))); // landmark-name match is inherently less precise than a direct address string
          matchMethod = "landmark";
        }
      }
    }
  }

  // 4. external geocoder fallback — only reached once our own data has nothing close; still requires an actual
  // building footprint near the geocoded point before returning "issued" (a geocode hit alone isn't proof a
  // building exists there)
  if (result.status === "failed" && (input.addressDescriptive || input.landmark)) {
    const geo = await googleGeocode(input.addressDescriptive || input.landmark || "", { state: input.state, lga: input.lga });
    if (geo) {
      const { radius, cap } = {
        ROOFTOP: { radius: 50, cap: 90 },
        RANGE_INTERPOLATED: { radius: 80, cap: 75 },
        GEOMETRIC_CENTER: { radius: 120, cap: 60 },
        APPROXIMATE: { radius: 180, cap: 45 },
      }[geo.locationType];
      const b = await nearestBuilding(geo.lat, geo.lon, radius);
      if (b) {
        // a nearby footprint alone isn't proof of a plausible address — if the geocoded point falls outside
        // every mapped settlement extent (i.e. it's not in a recognized inhabited area), cap confidence at the
        // same floor used elsewhere for "weakest acceptable" matches, regardless of how precise Google's own
        // signal was
        const settled = await isInSettlement(geo.lat, geo.lon);
        const settlementCeiling = settled ? 100 : 55;
        result = await issuedResult(input.requestRef, b, Math.min(cap, settlementCeiling, distanceAccuracy(Number(b.distance_m), radius, 40, cap)));
        matchMethod = "geocoder_fallback";
      }
    }
  }

  await pool.query(
    `INSERT INTO verification_requests
       (request_ref, api_client_id, first_name, last_name, middle_name, date_of_birth, email, phone_number,
        address_descriptive, landmark, state, lga, input_latitude, input_longitude,
        status, building_code, result_latitude, result_longitude, result_state, result_lga, result_ward, accuracy, match_method, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23, now())
     ON CONFLICT (request_ref) DO NOTHING`,
    [
      input.requestRef, apiClientId, input.firstName ?? null, input.lastName ?? null, input.middleName ?? null,
      input.dateOfBirth ?? null, input.email ?? null, input.phoneNumber ?? null,
      input.addressDescriptive ?? null, input.landmark ?? null, input.state ?? null, input.lga ?? null,
      input.latitude ?? null, input.longitude ?? null,
      result.status, result.buildingID, result.latitude, result.longitude, result.state, result.lga, result.ward,
      result.accuracy, matchMethod,
    ]
  );

  return result;
}
