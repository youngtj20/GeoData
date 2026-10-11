import { setOptions, importLibrary } from "@googlemaps/js-api-loader";

const apiKey = import.meta.env.VITE_GOOGLE_MAPS_API_KEY as string | undefined;

let loadPromise: Promise<typeof google> | null = null;

// single shared loader — MapView and the geocoder both need the same script instance
export function loadGoogleMaps(): Promise<typeof google> {
  if (!apiKey) {
    return Promise.reject(new Error("Missing VITE_GOOGLE_MAPS_API_KEY — set it in .env.local"));
  }
  if (!loadPromise) {
    setOptions({ key: apiKey, v: "weekly" });
    loadPromise = Promise.all([importLibrary("maps"), importLibrary("geocoding")]).then(() => google);
  }
  return loadPromise;
}
