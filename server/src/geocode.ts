// server-side Google Geocoding fallback — only reached when nothing in our own buildings/landmarks data is a
// close enough match. Deliberately a *separate* env var from VITE_GOOGLE_MAPS_API_KEY: that one is a browser key
// restricted by HTTP referrer, which can't also be used unrestricted from a server (and shouldn't be — a key
// usable server-side needs IP/API restriction instead, so it stays a distinct credential with its own quota).

export type GoogleLocationType = "ROOFTOP" | "RANGE_INTERPOLATED" | "GEOMETRIC_CENTER" | "APPROXIMATE";

export interface GeocodeHit {
  lat: number;
  lon: number;
  locationType: GoogleLocationType;
  formattedAddress: string;
}

export async function googleGeocode(
  query: string,
  opts: { state?: string | null; lga?: string | null } = {}
): Promise<GeocodeHit | null> {
  const apiKey = process.env.GOOGLE_GEOCODING_API_KEY;
  if (!apiKey) return null; // fallback silently disabled when no key is configured — local dev still works

  // folding state/lga into the query string (rather than Google's structured `components` filter, which rejects
  // unrecognized admin-area names outright) lets it still work when the caller's state/lga spelling doesn't
  // exactly match Google's own admin boundary names
  const address = [query, opts.lga, opts.state, "Nigeria"].filter(Boolean).join(", ");
  const url = new URL("https://maps.googleapis.com/maps/api/geocode/json");
  url.searchParams.set("address", address);
  url.searchParams.set("region", "ng");
  url.searchParams.set("components", "country:NG");
  url.searchParams.set("key", apiKey);

  const res = await fetch(url);
  if (!res.ok) return null;
  const data: any = await res.json();
  if (data.status !== "OK" || !data.results?.length) return null;

  const r = data.results[0];
  return {
    lat: r.geometry.location.lat,
    lon: r.geometry.location.lng,
    locationType: r.geometry.location_type,
    formattedAddress: r.formatted_address,
  };
}
