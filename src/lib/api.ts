import { loadGoogleMaps } from "./googleMaps";

// external backend — ward/LGA/state boundaries, geocode fallback, verifications log
export const API_BASE = (import.meta.env.VITE_API_BASE as string | undefined) || "https://l8b0fu-nyfsf4ffa-arcadawebapps3.vercel.app";
// local PostGIS-backed server — serves settlement blocks + OSM buildings imported from GRID3/Geofabrik extracts.
// Default follows whatever host the page itself was loaded from (localhost / 127.0.0.1 / a LAN IP) rather than a
// hardcoded "localhost" — admin login sets a cookie scoped to the API's host, and browsers treat "localhost" and
// "127.0.0.1" as different sites, so a mismatch here silently drops the session cookie on every request after login.
export const LOCAL_API_BASE = (import.meta.env.VITE_LOCAL_API_BASE as string | undefined) || `http://${window.location.hostname}:8787`;

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, { signal });
  if (!res.ok) {
    const body = await res.json().catch(() => ({} as any));
    throw new Error(body?.error || `Request failed (${res.status})`);
  }
  return res.json() as Promise<T>;
}

// same-origin-cookie variant for admin/auth calls — always sends/receives the httpOnly session cookie
async function authJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { credentials: "include", ...init });
  if (!res.ok) {
    const body = await res.json().catch(() => ({} as any));
    throw new Error(body?.error || `Request failed (${res.status})`);
  }
  return res.json() as Promise<T>;
}

export interface State {
  id: number;
  name: string;
  code: string;
}
export interface LGA {
  id: number;
  state_name: string;
  name: string;
  code: string;
}
export interface Ward {
  id: number;
  state_name: string;
  lga_name: string;
  name: string;
  code: string;
}
export interface Stats {
  states: number;
  lgas: number;
  wards: number;
  cached_geometries: number;
}
export interface Verification {
  id: number;
  address: string;
  lat: number | null;
  lon: number | null;
  state: string;
  lga: string;
  ward: string;
  note: string | null;
  created_at: string;
}
export interface GeocodeResult {
  display_name: string;
  lat: number;
  lon: number;
  type: string;
  category: string;
  importance: number;
  parts: { road: string | null; suburb: string | null; city: string | null; state: string | null; postcode: string | null };
  provider: string;
}
export interface ResolveResult {
  lat: number;
  lon: number;
  match: { ward: string; ward_raw: string; ward_code: string; lga: string; lga_raw: string; lga_code: string; state: string; state_code: string; source: string } | null;
  reconciled: boolean;
  address: { display_name: string; road: string | null; suburb: string | null; city: string | null; state: string | null; postcode: string | null } | null;
}
export interface BoundaryResponse {
  level: string;
  state: string;
  lga: string | null;
  ward: string | null;
  source: string | null;
  cached: boolean;
  count: number;
  geojson: GeoJSON.FeatureCollection;
  tried?: string[];
}

// ward/LGA/state name lists + boundary shapes now come from the local GRID3 v3+v1 merge, not the external API
export const fetchStates = (): Promise<State[]> => getJson(`${LOCAL_API_BASE}/api/states`);
export const fetchStats = (): Promise<Stats> => getJson(`${LOCAL_API_BASE}/api/stats`);
export const fetchLGAs = (state: string): Promise<LGA[]> => getJson(`${LOCAL_API_BASE}/api/lgas?state=${encodeURIComponent(state)}`);
export const fetchWards = (state: string, lga: string): Promise<Ward[]> =>
  getJson(`${LOCAL_API_BASE}/api/wards?state=${encodeURIComponent(state)}&lga=${encodeURIComponent(lga)}`);
export function fetchBoundaries(
  level: string,
  params: { state: string; lga?: string; ward?: string }
): Promise<BoundaryResponse> {
  const sp = new URLSearchParams({ level, state: params.state });
  if (params.lga) sp.set("lga", params.lga);
  if (params.ward) sp.set("ward", params.ward);
  return getJson(`${LOCAL_API_BASE}/api/boundaries?${sp.toString()}`);
}
// shared Geocoder instance — the Maps JS SDK owns rate limiting/billing under the same API key as the map itself
let geocoderPromise: Promise<google.maps.Geocoder> | null = null;
function getGeocoder(): Promise<google.maps.Geocoder> {
  if (!geocoderPromise) geocoderPromise = loadGoogleMaps().then((g) => new g.maps.Geocoder());
  return geocoderPromise;
}
function componentText(components: google.maps.GeocoderAddressComponent[], type: string): string | null {
  return components.find((c) => c.types.includes(type))?.long_name ?? null;
}
function toGeocodeResult(r: google.maps.GeocoderResult): GeocodeResult {
  const comps = r.address_components;
  return {
    display_name: r.formatted_address,
    lat: r.geometry.location.lat(),
    lon: r.geometry.location.lng(),
    type: r.types[0] || "place",
    category: r.types[0] || "place",
    importance: 0,
    parts: {
      road: componentText(comps, "route"),
      suburb: componentText(comps, "sublocality") || componentText(comps, "neighborhood"),
      city: componentText(comps, "locality") || componentText(comps, "administrative_area_level_2"),
      state: componentText(comps, "administrative_area_level_1"),
      postcode: componentText(comps, "postal_code"),
    },
    provider: "google",
  };
}
export async function geocode(q: string, signal?: AbortSignal): Promise<GeocodeResult[]> {
  const geocoder = await getGeocoder();
  if (signal?.aborted) return [];
  const res = await geocoder.geocode({ address: q, componentRestrictions: { country: "ng" }, region: "ng" });
  if (signal?.aborted) return [];
  return res.results.map(toGeocodeResult);
}
// best-guess address for a building with none on file yet — reverse geocodes via the same Maps API key as
// search. Purely a suggestion: nothing is saved until a user reviews and confirms it via updateBuildingAddress.
export async function reverseGeocode(lat: number, lon: number): Promise<string | null> {
  const geocoder = await getGeocoder();
  try {
    const res = await geocoder.geocode({ location: { lat, lng: lon } });
    return res.results[0]?.formatted_address ?? null;
  } catch {
    return null;
  }
}

export const resolvePoint = (lat: number, lon: number): Promise<ResolveResult> =>
  getJson(`${API_BASE}/api/resolve?lat=${lat}&lon=${lon}`);
export const fetchVerifications = (): Promise<Verification[]> => getJson(`${API_BASE}/api/verifications`);

export interface LocalFeatureCollectionResponse {
  type: "FeatureCollection";
  features: GeoJSON.Feature[];
  count: number; // features actually returned (may be capped)
  total: number; // true count before any cap was applied
  capped: boolean;
}
// every building inside a ward's exact polygon, from the local buildings table — replaces live Overpass calls
export async function fetchBuildingsWithinPolygon(polygon: GeoJSON.Geometry): Promise<LocalFeatureCollectionResponse> {
  const res = await fetch(`${LOCAL_API_BASE}/api/buildings/within`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ polygon }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body?.error || `Local buildings request failed (${res.status})`);
  }
  return res.json();
}
// buildings visible in a map viewport, from the local buildings table
export function fetchBuildingsInBounds(b: { south: number; west: number; north: number; east: number }): Promise<LocalFeatureCollectionResponse> {
  const sp = new URLSearchParams({ south: String(b.south), west: String(b.west), north: String(b.north), east: String(b.east) });
  return getJson(`${LOCAL_API_BASE}/api/buildings?${sp.toString()}`);
}
// server-side nearest-building lookup for an exact point — used as a fallback when a geocoded address doesn't
// match anything in the client's already-loaded (possibly capped, for oversized wards) building set, so search
// correctness doesn't depend on what happens to be loaded client-side
export interface NearestBuildingResponse {
  found: boolean;
  building?: GeoJSON.Feature;
  distance_m?: number;
}
export function fetchNearestBuilding(lat: number, lon: number, radiusM = 40): Promise<NearestBuildingResponse> {
  const sp = new URLSearchParams({ lat: String(lat), lon: String(lon), radius: String(radiusM) });
  return getJson(`${LOCAL_API_BASE}/api/buildings/nearest?${sp.toString()}`);
}
// direct lookup by the human-readable building_code (e.g. "LA-IK-10-0221") printed on a building ID card
export function fetchBuildingByCode(code: string): Promise<NearestBuildingResponse> {
  return getJson(`${LOCAL_API_BASE}/api/buildings/by-code/${encodeURIComponent(code)}`);
}
// GRID3 settlement density blocks visible in a map viewport (admin-toggleable layer)
export function fetchSettlementBlocksInBounds(b: { south: number; west: number; north: number; east: number }): Promise<GeoJSON.FeatureCollection> {
  const sp = new URLSearchParams({ south: String(b.south), west: String(b.west), north: String(b.north), east: String(b.east) });
  return getJson(`${LOCAL_API_BASE}/api/settlement-blocks?${sp.toString()}`);
}

export type LandmarkCategory = "school" | "mosque" | "church" | "market" | "health_facility";
export interface LandmarksResponse {
  type: "FeatureCollection";
  features: GeoJSON.Feature[];
  count: number;
  capped: boolean;
  // true when features are grid-cell cluster points (properties: cluster, count, category) rather than individual
  // landmarks — the server switches to this below a zoom threshold so low-zoom/wide-area views stay cheap to
  // fetch and render instead of shipping thousands of raw points
  clustered: boolean;
}
// GRID3 points of interest — schools/mosques/churches/markets/health facilities, filterable public map layer
export function fetchLandmarksInBounds(
  b: { south: number; west: number; north: number; east: number },
  categories: LandmarkCategory[],
  zoom: number
): Promise<LandmarksResponse> {
  const sp = new URLSearchParams({
    south: String(b.south), west: String(b.west), north: String(b.north), east: String(b.east),
    categories: categories.join(","),
    zoom: String(Math.round(zoom)),
  });
  return getJson(`${LOCAL_API_BASE}/api/landmarks?${sp.toString()}`);
}

// a landmark is a survey point, not a footprint — look up the actual building polygon it sits in/near (on click,
// never in bulk) so it can be shown as a real building outline instead of just a dot
export async function fetchLandmarkBuilding(landmarkId: string | number): Promise<GeoJSON.Feature | null> {
  const res: { found: boolean; building?: GeoJSON.Feature } = await getJson(`${LOCAL_API_BASE}/api/landmarks/${landmarkId}/building`);
  return res.found ? res.building! : null;
}
// ---- admin auth ----

export interface AuthUser {
  id: number;
  username: string;
  permissions: string[];
}
export interface Permission {
  key: string;
  label: string;
  description: string;
}
export interface AdminUser {
  id: number;
  username: string;
  created_at: string;
  permissions: string[];
}
export interface MapSettings {
  provider: "google" | "mapbox" | "osm";
  show_wards: boolean;
  show_buildings: boolean;
  show_settlements: boolean;
}

export const login = (username: string, password: string): Promise<{ ok: true }> =>
  authJson(`${LOCAL_API_BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
export const logout = (): Promise<{ ok: true }> => authJson(`${LOCAL_API_BASE}/api/auth/logout`, { method: "POST" });
export const fetchMe = (): Promise<AuthUser> => authJson(`${LOCAL_API_BASE}/api/auth/me`);

export const fetchPermissionCatalog = (): Promise<Permission[]> => authJson(`${LOCAL_API_BASE}/api/admin/permissions`);
export const fetchAdminUsers = (): Promise<AdminUser[]> => authJson(`${LOCAL_API_BASE}/api/admin/users`);
export const createAdminUser = (username: string, password: string, permissions: string[]): Promise<{ id: number; username: string }> =>
  authJson(`${LOCAL_API_BASE}/api/admin/users`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password, permissions }),
  });
export const updateUserPermissions = (userId: number, permissions: string[]): Promise<{ ok: true }> =>
  authJson(`${LOCAL_API_BASE}/api/admin/users/${userId}/permissions`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ permissions }),
  });
export const deleteAdminUser = (userId: number): Promise<{ ok: true }> =>
  authJson(`${LOCAL_API_BASE}/api/admin/users/${userId}`, { method: "DELETE" });

// ---- admin: 3rd-party API clients (credentials for POST /api/v1/verify-address) ----

export interface ApiClient {
  id: number;
  name: string;
  active: boolean;
  created_at: string;
  last_used_at: string | null;
}
export const fetchApiClients = (): Promise<ApiClient[]> => authJson(`${LOCAL_API_BASE}/api/admin/api-clients`);
// the returned apiKey is shown exactly once — the server never stores or returns the raw key again after this call
export const createApiClient = (name: string): Promise<ApiClient & { apiKey: string }> =>
  authJson(`${LOCAL_API_BASE}/api/admin/api-clients`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
export const setApiClientActive = (id: number, active: boolean): Promise<ApiClient> =>
  authJson(`${LOCAL_API_BASE}/api/admin/api-clients/${id}/active`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ active }),
  });
export const deleteApiClient = (id: number): Promise<{ ok: true }> =>
  authJson(`${LOCAL_API_BASE}/api/admin/api-clients/${id}`, { method: "DELETE" });

export const fetchMapSettings = (): Promise<MapSettings> => getJson(`${LOCAL_API_BASE}/api/map-settings`);
export const updateMapSettings = (patch: Partial<MapSettings>): Promise<MapSettings> =>
  authJson(`${LOCAL_API_BASE}/api/admin/map-settings`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });

// trace a building footprint missing from the imported OSM/Google Open Buildings data — requires the
// add_buildings permission; saved permanently with source='manual' and an audit trail (who/when)
export function createBuilding(polygon: GeoJSON.Geometry, name?: string, address?: string): Promise<GeoJSON.Feature> {
  return authJson(`${LOCAL_API_BASE}/api/admin/buildings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ polygon, name, address }),
  });
}

// confirm/correct the address for any building — permanently attached to its building_code, with an audit
// trail (who/when) server-side. Requires login, same trust model as tracing a missing building.
export function updateBuildingAddress(buildingId: number | string, address: string): Promise<{ ok: true; address: string | null }> {
  return authJson(`${LOCAL_API_BASE}/api/admin/buildings/${buildingId}/address`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address }),
  });
}

export async function submitVerification(payload: {
  address: string;
  lat: number | null;
  lon: number | null;
  state: string;
  lga: string;
  ward: string;
  note?: string;
}): Promise<any> {
  const res = await fetch(`${API_BASE}/api/verifications`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Submit failed (${res.status})`);
  }
  return res.json();
}
