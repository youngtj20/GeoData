import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  MapPin,
  Search,
  LocateFixed,
  Layers,
  Database,
  ShieldCheck,
  Crosshair,
  RefreshCw,
  CircleCheck,
  TriangleAlert,
  LoaderCircle,
  Landmark,
  Copy,
  ExternalLink,
  ChevronDown,
  Sparkles,
  Building2,
  MousePointer2,
  ClipboardCheck,
  Navigation,
  PenLine,
  X,
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import MapView, { MIN_BUILDING_ZOOM, type MapBounds } from "./components/MapView";
import MapboxMapView from "./components/MapboxMapView";
import SearchBar from "./components/SearchBar";
import {
  fetchStates,
  fetchStats,
  fetchLGAs,
  fetchWards,
  fetchBoundaries,
  fetchBuildingsWithinPolygon,
  fetchBuildingsInBounds,
  fetchSettlementBlocksInBounds,
  fetchMapSettings,
  fetchLandmarksInBounds,
  resolvePoint,
  submitVerification,
  type State,
  type LGA,
  type Ward,
  type Stats,
  type GeocodeResult,
  type ResolveResult,
  type MapSettings,
  type LandmarkCategory,
  type LandmarksResponse,
  fetchLandmarkBuilding,
  createBuilding,
  reverseGeocode,
  updateBuildingAddress,
  fetchNearestBuilding,
} from "./lib/api";
import { LANDMARK_STYLES, LANDMARK_CATEGORY_ORDER } from "./lib/landmarkStyles";
import { useAuth } from "./lib/AuthContext";

// helpers
function prettyState(s: string) {
  return s === "Fct" ? "FCT — Abuja" : s;
}
function emptyFC(): GeoJSON.FeatureCollection {
  return { type: "FeatureCollection", features: [] };
}
function toDMS(v: number, isLat: boolean) {
  const dir = isLat ? (v >= 0 ? "N" : "S") : v >= 0 ? "E" : "W";
  const a = Math.abs(v);
  const d = Math.floor(a);
  const m = Math.floor((a - d) * 60);
  const s = ((a - d - m / 60) * 3600).toFixed(2);
  return `${d}°${m}′${s}″ ${dir}`;
}
function findFeatureByName(fc: GeoJSON.FeatureCollection | null, kind: "wards" | "lgas" | null, name: string): any | null {
  if (!fc || !name) return null;
  for (const f of fc.features as any[]) {
    const p = f.properties || {};
    const n = String((kind === "wards" ? p.wardname : p.lganame) ?? "");
    if (n === name) return f;
  }
  return null;
}
// within this many meters of a geocoded/clicked point, a building footprint auto-selects itself
const BUILDING_AUTO_PICK_RADIUS_M = 40;

function bboxOfGeometry(geom: GeoJSON.Geometry): { south: number; west: number; north: number; east: number } | null {
  let south = Infinity, west = Infinity, north = -Infinity, east = -Infinity;
  const visit = (coords: any) => {
    if (typeof coords[0] === "number") {
      const [lon, lat] = coords;
      if (lat < south) south = lat;
      if (lat > north) north = lat;
      if (lon < west) west = lon;
      if (lon > east) east = lon;
    } else {
      for (const c of coords) visit(c);
    }
  };
  visit((geom as any).coordinates);
  return Number.isFinite(south) ? { south, west, north, east } : null;
}
function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number) {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
function featureLatLon(f: any): { lat: number; lon: number } {
  const g = f.geometry;
  if (g.type === "Point") return { lon: g.coordinates[0], lat: g.coordinates[1] };
  const ring = (g.type === "MultiPolygon" ? g.coordinates[0][0] : g.coordinates[0]) as number[][];
  let sx = 0, sy = 0;
  for (const p of ring) { sx += p[0]; sy += p[1]; }
  return { lon: sx / ring.length, lat: sy / ring.length };
}
// short deterministic tag for a coordinate, used only when a picked point isn't tied to any building row at all
// (a raw map tap with no footprint underneath) — real buildings always carry a server-assigned building_code
// (STATE-LGA-WARD-SEQ, see server/src/buildingId.ts), persisted and stable, not computed here
function shortGeoHash(lat: number, lon: number) {
  const n = (Math.round((lat + 90) * 1e5) * 73856093) ^ (Math.round((lon + 180) * 1e5) * 19349663);
  return Math.abs(n).toString(36).toUpperCase().padStart(4, "0").slice(-4);
}

export default function App() {
  const [states, setStates] = useState<State[]>([]);
  const [lgas, setLgas] = useState<LGA[]>([]);
  const [wards, setWards] = useState<Ward[]>([]);
  const [selState, setSelState] = useState("");
  const [selLGA, setSelLGA] = useState("");
  const [selWard, setSelWard] = useState("");

  const [primary, setPrimary] = useState<GeoJSON.FeatureCollection | null>(null);
  const [primaryKind, setPrimaryKind] = useState<"wards" | "lgas" | null>(null);
  const [outline, setOutline] = useState<GeoJSON.FeatureCollection | null>(null);
  const [marker, setMarker] = useState<{ lat: number; lon: number; label: string } | null>(null);

  const [loading, setLoading] = useState(false);
  const [identifying, setIdentifying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [meta, setMeta] = useState<{ source: string | null; cached: boolean; count: number } | null>(null);
  const [resolveData, setResolveData] = useState<ResolveResult | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [stats, setStats] = useState<Stats | null>(null);
  const [mapSettings, setMapSettings] = useState<MapSettings | null>(null);
  const [settlementBlocks, setSettlementBlocks] = useState<GeoJSON.FeatureCollection | null>(null);

  // landmarks (schools/churches/mosques/markets/health facilities) — public, map-wide, ward-independent filter
  const [landmarks, setLandmarks] = useState<LandmarksResponse | null>(null);
  const [activeLandmarkCategories, setActiveLandmarkCategories] = useState<LandmarkCategory[]>([]);
  const landmarkCategoriesRef = useRef<LandmarkCategory[]>([]);
  landmarkCategoriesRef.current = activeLandmarkCategories;
  const landmarkViewportRef = useRef<{ bounds: MapBounds; zoom: number } | null>(null);
  // guards against rapid pan/zoom firing several requests whose responses can resolve out of order — only the
  // response matching the most recently kicked-off request is applied, stale ones are dropped
  const landmarkRequestIdRef = useRef(0);
  const MIN_LANDMARK_ZOOM = 12;
  const fetchLandmarksNow = () => {
    const vp = landmarkViewportRef.current;
    const categories = landmarkCategoriesRef.current;
    if (!vp || !categories.length || vp.zoom < MIN_LANDMARK_ZOOM) { setLandmarks(null); return; }
    const requestId = ++landmarkRequestIdRef.current;
    fetchLandmarksInBounds(vp.bounds, categories, vp.zoom)
      .then((res) => { if (requestId === landmarkRequestIdRef.current) setLandmarks(res); })
      .catch(() => { if (requestId === landmarkRequestIdRef.current) setLandmarks(null); });
  };
  const onLandmarkViewportChange = (bounds: MapBounds, zoom: number) => {
    landmarkViewportRef.current = { bounds, zoom };
    fetchLandmarksNow();
  };
  const toggleLandmarkCategory = (cat: LandmarkCategory) => {
    setActiveLandmarkCategories((prev) => (prev.includes(cat) ? prev.filter((c) => c !== cat) : [...prev, cat]));
  };
  // a landmark is a survey point, not a footprint — on click, look up and highlight the actual building it sits
  // in/near so it reads as a real building rather than just a dot (per-click lookup only, never bulk — see the
  // server-side comment on /api/landmarks/:id/building for why a bulk version isn't safe to run on every pan)
  const [landmarkBuilding, setLandmarkBuilding] = useState<GeoJSON.Feature | null>(null);
  const landmarkBuildingRequestIdRef = useRef(0);
  const onLandmarkClick = (landmarkId: string) => {
    const requestId = ++landmarkBuildingRequestIdRef.current;
    setLandmarkBuilding(null);
    fetchLandmarkBuilding(landmarkId)
      .then((building) => { if (requestId === landmarkBuildingRequestIdRef.current) setLandmarkBuilding(building); })
      .catch(() => { if (requestId === landmarkBuildingRequestIdRef.current) setLandmarkBuilding(null); });
  };
  useEffect(() => {
    fetchLandmarksNow();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeLandmarkCategories]);

  // trace-and-save a building footprint missing from the imported OSM/Google Open Buildings data — any logged-in
  // user can do this (no separate permission grant needed). Flow: drawMode (click to place vertices) ->
  // finishDrawKey increments to close the shape -> pendingBuildingGeom holds it for a name/address + save/discard
  // confirmation before it's POSTed and persisted.
  const { user } = useAuth();
  const [drawMode, setDrawMode] = useState(false);
  const [finishDrawKey, setFinishDrawKey] = useState(0);
  const [pendingBuildingGeom, setPendingBuildingGeom] = useState<GeoJSON.Geometry | null>(null);
  const [buildingName, setBuildingName] = useState("");
  const [buildingAddress, setBuildingAddress] = useState("");
  const [savingBuilding, setSavingBuilding] = useState(false);
  const [drawError, setDrawError] = useState<string | null>(null);

  const startDraw = () => {
    setDrawError(null);
    setPendingBuildingGeom(null);
    setBuildingName("");
    setBuildingAddress("");
    setDrawMode(true);
  };
  const cancelDraw = () => {
    setDrawMode(false);
    setPendingBuildingGeom(null);
    setBuildingName("");
    setBuildingAddress("");
    setDrawError(null);
  };
  const onPolygonDrawn = (geometry: GeoJSON.Geometry) => {
    setDrawMode(false);
    setPendingBuildingGeom(geometry);
  };
  const saveDrawnBuilding = async () => {
    if (!pendingBuildingGeom) return;
    setSavingBuilding(true);
    setDrawError(null);
    try {
      const feature = await createBuilding(pendingBuildingGeom, buildingName || undefined, buildingAddress || undefined);
      setBuildings((prev) => ({
        type: "FeatureCollection",
        features: [...((prev?.features as any[]) ?? []), feature],
      }));
      setPendingBuildingGeom(null);
      setBuildingName("");
      setBuildingAddress("");
    } catch (err: any) {
      setDrawError(err?.message || "Could not save this building");
    } finally {
      setSavingBuilding(false);
    }
  };

  const [fitKey, setFitKey] = useState(0);
  const [focusKey, setFocusKey] = useState(0);

  const [verifyAddr, setVerifyAddr] = useState("");
  const [verifyNote, setVerifyNote] = useState("");
  const [verifyMsg, setVerifyMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const [busyLGAs, setBusyLGAs] = useState(false);

  // building-in-ward selection — auto-enabled once a ward is chosen so the map stays browsable before that
  const [buildingMode, setBuildingMode] = useState(false);
  const [buildings, setBuildings] = useState<GeoJSON.FeatureCollection | null>(null);
  const [buildingPick, setBuildingPick] = useState<{ id: string; lat: number; lon: number; label: string; address?: string | null; buildingCode?: string | null; rawId?: number | null } | null>(null);
  const [buildingsLoading, setBuildingsLoading] = useState(false);
  const [buildingsError, setBuildingsError] = useState<string | null>(null);
  const [coordCopied, setCoordCopied] = useState<"" | "coord" | "dms" | "geojson" | "code">("");
  // set after a search/click resolve; consumed once the ward's buildings finish loading to auto-select the nearest footprint
  const [pendingBuildingAutoPick, setPendingBuildingAutoPick] = useState<{ lat: number; lon: number } | null>(null);

  // refs to avoid stale closures in effects that increment keys
  const selWardRef = useRef("");
  selWardRef.current = selWard;

  // initial load
  useEffect(() => {
    fetchStates().then(setStates).catch(() => {});
    fetchStats().then(setStats).catch(() => {});
    fetchMapSettings().then(setMapSettings).catch(() => {});
  }, []);

  // auto-select Lagos -> Ikeja on first states load (like original)
  const didAuto = useRef(false);
  useEffect(() => {
    if (!didAuto.current && states.length) {
      const hasLagos = states.some((s) => s.name === "Lagos");
      if (hasLagos) {
        didAuto.current = true;
        setSelState("Lagos");
        setSelLGA("Ikeja");
      }
    }
  }, [states]);

  // load LGA boundaries for a state
  const loadStateView = async (state: string) => {
    setLoading(true);
    setError(null);
    setMeta(null);
    setPrimary(null);
    setOutline(null);
    setPrimaryKind(null);
    try {
      const [lgaBounds, stateBounds] = await Promise.all([
        fetchBoundaries("lgas", { state }),
        fetchBoundaries("state", { state }),
      ]);
      if (lgaBounds.count === 0) {
        setError("LGA boundaries for this state are not in the loaded extract yet.");
        setMeta({ source: null, cached: false, count: 0, tried: lgaBounds.tried } as any);
        return;
      }
      setPrimary(lgaBounds.geojson as any);
      setPrimaryKind("lgas");
      setOutline(stateBounds.count ? (stateBounds.geojson as any) : emptyFC());
      setMeta({ source: lgaBounds.source, cached: lgaBounds.cached, count: lgaBounds.count });
      setFitKey((k) => k + 1);
    } catch (e: any) {
      setError(e?.message || "Failed to load boundaries");
    } finally {
      setLoading(false);
    }
  };

  const loadLGAView = async (state: string, lga: string) => {
    setLoading(true);
    setError(null);
    setMeta(null);
    setPrimary(null);
    setOutline(null);
    setPrimaryKind(null);
    try {
      const [wardBounds, lgaBounds] = await Promise.all([
        fetchBoundaries("ward", { state, lga }),
        fetchBoundaries("lga", { state, lga }),
      ]);
      if (wardBounds.count === 0) {
        setError("Ward boundaries for this LGA are not in the loaded extract yet.");
        setMeta({ source: null, cached: false, count: 0 } as any);
        if (lgaBounds.count) {
          setOutline(emptyFC());
          // still show LGA outline alone? keep it as outline and show message
          setOutline(lgaBounds.geojson as any);
          setFitKey((k) => k + 1);
        }
        return;
      }
      setPrimary(wardBounds.geojson as any);
      setPrimaryKind("wards");
      setOutline(lgaBounds.count ? (lgaBounds.geojson as any) : emptyFC());
      setMeta({ source: wardBounds.source, cached: wardBounds.cached, count: wardBounds.count });
      // focus or fit depending if ward selected
      if (selWardRef.current) setFocusKey((k) => k + 1);
      else setFitKey((k) => k + 1);
    } catch (e: any) {
      setError(e?.message || "Failed to load boundaries");
    } finally {
      setLoading(false);
    }
  };

  const retry = () => {
    if (!selState) return;
    if (selLGA) loadLGAView(selState, selLGA);
    else loadStateView(selState);
  };

  // current viewport bounds (for the supplemental "load this area" fallback) + whether the map is too zoomed out for that
  const currentBoundsRef = useRef<MapBounds | null>(null);
  const [zoomedOutTooFar, setZoomedOutTooFar] = useState(false);
  // which ward's full building set is currently loaded (kicked off), and whether that ward's fetch had to be capped
  const loadedWardRef = useRef("");
  // which ward's fetch has actually SETTLED (succeeded or failed) — distinct from loadedWardRef, which flips the
  // instant a fetch is kicked off. The pending-auto-pick effect below needs to know once data is truly ready, not
  // just "not currently loading" — that flag can still read stale-false in the same render pass that just started
  // a new fetch, since sibling effects in one flush see state as captured at render time, not live updates.
  const settledWardRef = useRef("");
  const [wardTruncated, setWardTruncated] = useState(false);
  const [wardBuildingTotal, setWardBuildingTotal] = useState(0);

  // primary fetch: every building inside the selected ward's actual polygon, from the local PostGIS-backed server
  const loadBuildingsForWard = async (wardName: string) => {
    const feature = findFeatureByName(primary, primaryKind, wardName);
    if (!feature?.geometry) {
      setBuildingsError("Could not determine this ward's boundary shape.");
      settledWardRef.current = wardName;
      return;
    }
    setBuildingsLoading(true);
    setBuildingsError(null);
    try {
      const res = await fetchBuildingsWithinPolygon(feature.geometry);
      setWardBuildingTotal(res.total);
      setWardTruncated(res.capped);
      setBuildings(res as any);
    } catch (err: any) {
      setBuildingsError(err?.message || "Could not load buildings");
    } finally {
      setBuildingsLoading(false);
      settledWardRef.current = wardName;
    }
  };

  // supplemental fetch: only used after a truncated ward load, to fill in detail for whatever you zoom into — additive, not a replacement
  const loadBuildingsForBounds = async (b: MapBounds) => {
    setBuildingsLoading(true);
    setBuildingsError(null);
    try {
      const res = await fetchBuildingsInBounds(b);
      setBuildings((prev) => {
        const existingIds = new Set((prev?.features as any[] ?? []).map((f) => f.properties.__id));
        const newOnes = (res.features as any[]).filter((f) => !existingIds.has(f.properties.__id));
        return { type: "FeatureCollection", features: [...((prev?.features as any[]) ?? []), ...newOnes] } as any;
      });
    } catch (err: any) {
      setBuildingsError(err?.message || "Could not load buildings");
    } finally {
      setBuildingsLoading(false);
    }
  };

  const reloadBuildings = () => {
    if (!selWard) return;
    if (wardTruncated && currentBoundsRef.current) {
      loadBuildingsForBounds(currentBoundsRef.current);
    } else {
      loadBuildingsForWard(selWard);
    }
  };

  // when state changes: fetch LGA list and load state view
  useEffect(() => {
    if (!selState) {
      setLgas([]);
      setWards([]);
      setPrimary(null);
      setOutline(null);
      setPrimaryKind(null);
      setMeta(null);
      setError(null);
      return;
    }
    setBusyLGAs(true);
    fetchLGAs(selState)
      .then(setLgas)
      .catch(() => {})
      .finally(() => setBusyLGAs(false));

    // clear ward-level stuff
    setWards([]);
    if (!selLGA) {
      loadStateView(selState);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selState]);

  // when LGA changes: fetch wards and load LGA view
  useEffect(() => {
    if (!selState || !selLGA) {
      setWards([]);
      if (selState && !selLGA) return;
      if (!selLGA) return;
    }
    if (!selState || !selLGA) return;
    setBusyLGAs(true);
    fetchWards(selState, selLGA)
      .then(setWards)
      .catch(() => {})
      .finally(() => setBusyLGAs(false));
    loadLGAView(selState, selLGA);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selLGA]);

  // handlers
  const onPickState = (name: string) => {
    setNotice(null);
    setResolveData(null);
    setMarker(null);
    setVerifyAddr("");
    setSelWard("");
    setSelLGA("");
    setBuildings(null);
    setBuildingPick(null);
    setBuildingsError(null);
    setBuildingMode(false);
    setPendingBuildingAutoPick(null);
    setSelState(name);
  };
  const onPickLGA = (name: string) => {
    setNotice(null);
    setResolveData(null);
    setMarker(null);
    setVerifyAddr("");
    setSelWard("");
    setSelLGA(name);
    setBuildings(null);
    setBuildingPick(null);
    setBuildingsError(null);
    setBuildingMode(false);
    setPendingBuildingAutoPick(null);
  };
  const onPickWard = (name: string) => {
    // leaving ward resets building selection
    setBuildingPick(null);
    setBuildings(null);
    setBuildingsError(null);
    setPendingBuildingAutoPick(null);
    loadedWardRef.current = "";
    setWardTruncated(false);
    setSelWard(name);
    if (name) setFocusKey((k) => k + 1);
    else setFitKey((k) => k + 1);
  };
  // auto-enable building select once per ward, and auto-load every building in that ward's polygon.
  // re-fires per ward (loadedWardRef guards against re-fetching the same ward's data twice).
  const autoEnabledWardRef = useRef<string>("");
  useEffect(() => {
    if (selWard && primaryKind === "wards" && primary && mapSettings?.show_buildings !== false) {
      if (!buildingMode) {
        autoEnabledWardRef.current = selWard;
        setBuildingMode(true);
      }
      if (loadedWardRef.current !== selWard) {
        loadedWardRef.current = selWard;
        setWardTruncated(false);
        loadBuildingsForWard(selWard);
      }
    }
    if (!selWard) {
      autoEnabledWardRef.current = "";
      loadedWardRef.current = "";
      settledWardRef.current = "";
      if (buildingMode) setBuildingMode(false);
      setBuildings(null);
      setBuildingPick(null);
      setBuildingsError(null);
      setWardTruncated(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selWard, primaryKind, primary]);

  // admin-toggleable settlement density overlay — fetched for the selected ward's bounding box, independent of building select
  useEffect(() => {
    if (!mapSettings?.show_settlements || !selWard || primaryKind !== "wards" || !primary) {
      setSettlementBlocks(null);
      return;
    }
    const feature = findFeatureByName(primary, primaryKind, selWard);
    const bbox = feature?.geometry ? bboxOfGeometry(feature.geometry) : null;
    if (!bbox) { setSettlementBlocks(null); return; }
    let cancelled = false;
    fetchSettlementBlocksInBounds(bbox)
      .then((fc) => { if (!cancelled) setSettlementBlocks(fc); })
      .catch(() => { if (!cancelled) setSettlementBlocks(null); });
    return () => { cancelled = true; };
  }, [selWard, primaryKind, primary, mapSettings?.show_settlements]);

  const toggleBuildingMode = () => {
    if (!selWard) return;
    setBuildingMode((v) => !v);
  };

  // tracks the visible map area for the supplemental fetch, and — once a ward's full load was capped — auto-
  // fires that fetch whenever the user settles on a new area (the map's "idle" event, so this only runs once
  // panning/zooming actually stops, not on every intermediate frame). The manual "Load this area" button stays
  // as a fallback (e.g. to force a retry after a network error) but is no longer the only way to fill a gap.
  const onViewportChange = (bounds: MapBounds | null, _zoom: number) => {
    setZoomedOutTooFar(bounds === null);
    currentBoundsRef.current = bounds;
    if (bounds && wardTruncated && buildingMode && !buildingsLoading) {
      loadBuildingsForBounds(bounds);
    }
  };
  const onFeatureClick = (name: string) => {
    if (primaryKind === "lgas") onPickLGA(name);
    else if (primaryKind === "wards") onPickWard(name);
  };

  // resolve a point (map click or geocode)
  const identify = async (lat: number, lon: number, label: string) => {
    setIdentifying(true);
    setNotice(null);
    try {
      const r = await resolvePoint(lat, lon);
      setResolveData(r);
      setMarker({ lat, lon, label: r.address?.display_name || label });
      if (r.address?.display_name) setVerifyAddr(r.address.display_name);
      else setVerifyAddr(label);

      if (r.match) {
        // directly await the LGA's ward polygons rather than guessing with a setTimeout — loadBuildingsForWard
        // looks the ward up in `primary` by name, so setting selWard before that data actually lands means the
        // lookup fails ("Could not determine this ward's boundary shape") regardless of how long a timeout waits
        if (r.match.state === selState) {
          if (r.match.lga !== selLGA) {
            setVerifyAddr((v) => v || label);
            setSelWard("");
            setSelLGA(r.match.lga);
            if (r.match.ward) await loadLGAView(selState, r.match.lga);
          }
          if (r.match.ward) {
            setSelWard(r.match.ward);
            setPendingBuildingAutoPick({ lat, lon });
            setFocusKey((k) => k + 1);
          } else {
            setSelWard("");
            setNotice(
              r.match.ward_raw
                ? `This point falls in "${r.match.ward_raw}" (${r.match.source}). Not in canonical ward list for ${r.match.lga}, so pick the closest ward below.`
                : "This point falls outside every ward polygon in the extract."
            );
          }
        } else {
          setSelState(r.match.state);
          setSelLGA(r.match.lga);
          if (r.match.ward) {
            await loadLGAView(r.match.state, r.match.lga);
            setSelWard(r.match.ward);
            setPendingBuildingAutoPick({ lat, lon });
            setFocusKey((k) => k + 1);
          } else {
            setNotice("This point falls outside every ward polygon in the extract.");
          }
        }
      } else {
        setNotice("No ward polygon contains this point. It may be outside Nigeria or in an unmapped water/forest area.");
      }
    } catch (e: any) {
      setNotice(e?.message || "Could not identify this location");
    } finally {
      setIdentifying(false);
    }
  };

  const onMapClick = (lat: number, lon: number) => {
    identify(lat, lon, `Pinned location (${lat.toFixed(5)}, ${lon.toFixed(5)})`);
  };
  const onGeocodePick = (r: GeocodeResult) => {
    identify(r.lat, r.lon, r.display_name);
  };
  const useMyLocation = () => {
    if (!navigator.geolocation) {
      setNotice("Geolocation is not available in this browser.");
      return;
    }
    setIdentifying(true);
    setNotice(null);
    navigator.geolocation.getCurrentPosition(
      (p) => identify(p.coords.latitude, p.coords.longitude, "My location"),
      () => {
        setIdentifying(false);
        setNotice("Could not get your position. Check location permissions and try again.");
      },
      { timeout: 12000 }
    );
  };

  const doVerify = async () => {
    setVerifyMsg(null);
    if (!selState || !selLGA || !selWard) {
      setVerifyMsg({ ok: false, text: "Select a state, LGA and ward first." });
      return;
    }
    if (!verifyAddr.trim()) {
      setVerifyMsg({ ok: false, text: "Enter the descriptive address you are verifying." });
      return;
    }
    setSubmitting(true);
    try {
      await submitVerification({
        address: verifyAddr.trim(),
        lat: buildingPick?.lat ?? marker?.lat ?? resolveData?.lat ?? null,
        lon: buildingPick?.lon ?? marker?.lon ?? resolveData?.lon ?? null,
        state: selState,
        lga: selLGA,
        ward: selWard,
        note: verifyNote.trim() || undefined,
      });
      setVerifyMsg({ ok: true, text: `Verified: this address is in ${selWard} ward, ${selLGA}.` });
      setVerifyNote("");
    } catch (e: any) {
      setVerifyMsg({ ok: false, text: e?.message || "Submit failed" });
    } finally {
      setSubmitting(false);
    }
  };

  const selectedLGACode = lgas.find((x) => x.name === selLGA)?.code;
  const selectedWardCode = wards.find((x) => x.name === selWard)?.code;

  const copyAddr = async () => {
    if (!verifyAddr) return;
    try {
      await navigator.clipboard.writeText(verifyAddr);
      setVerifyMsg({ ok: true, text: "Address copied to clipboard." });
      setTimeout(() => setVerifyMsg((m) => (m?.text === "Address copied to clipboard." ? null : m)), 1800);
    } catch {}
  };

  const handleBuildingPick = (pick: { id: string; lat: number; lon: number; label: string }, feature?: any) => {
    // a manually-traced building may carry a hand-typed address (saved verbatim, not geocoded — see "Add a
    // missing building") that's worth surfacing here even though it's not part of the base BuildingPick shape.
    // building_code is the server-assigned, persisted STATE-LGA-WARD-SEQ id (null only for a raw point tap
    // with no underlying building row, or a building outside any known ward polygon).
    const address = feature?.properties?.address ?? null;
    const buildingCode = feature?.properties?.building_code ?? null;
    // the real buildings.id row PK — only present for an actual building feature, null for a raw point tap with
    // nothing backing it in the database, which is how the address UI knows whether there's anything to attach to
    const rawId = feature?.properties?.id != null ? Number(feature.properties.id) : null;
    setBuildingPick({ ...pick, address, buildingCode, rawId });
    // also move the verification pin to this building
    setMarker({ lat: pick.lat, lon: pick.lon, label: pick.label });
    // prefill verify address with building label if user hasn't typed something custom
    // keep existing address if it already looks like a building label
  };

  // the server assigns a permanent building_code (STATE-LGA-WARD-SEQ) to every real building row at creation
  // time — it never changes as more buildings are added, unlike a live-recomputed position-in-list would. The
  // PT- fallback only applies to a raw point tap with no underlying building footprint at all.
  const buildingPickCode = buildingPick
    ? buildingPick.buildingCode || `PT-${shortGeoHash(buildingPick.lat, buildingPick.lon)}`
    : null;

  // proof-of-address: building_code identifies WHICH building; this is the actual address attached to it.
  // Nothing is saved automatically — a reverse-geocoded guess is only ever a starting point for a human to
  // review, correct, and explicitly confirm (see "go ahead and build" — the address confirmation flow).
  const [suggestedAddress, setSuggestedAddress] = useState<string | null>(null);
  const [addressInput, setAddressInput] = useState("");
  const [addressLookupLoading, setAddressLookupLoading] = useState(false);
  const [savingAddress, setSavingAddress] = useState(false);
  const [addressSaveError, setAddressSaveError] = useState<string | null>(null);
  const [addressJustSaved, setAddressJustSaved] = useState(false);
  // guards against the reverse-geocode suggestion (a slow network call) resolving AFTER the user has already
  // started typing their own correction and silently overwriting it — a real race that was clobbering saved
  // addresses with the auto-suggestion whenever a user typed quickly
  const addressUserEditedRef = useRef(false);

  useEffect(() => {
    setAddressSaveError(null);
    setAddressJustSaved(false);
    setSuggestedAddress(null);
    addressUserEditedRef.current = false;
    if (!buildingPick) { setAddressInput(""); return; }
    if (buildingPick.address) { setAddressInput(buildingPick.address); return; }
    setAddressInput("");
    if (!buildingPick.rawId) return; // no underlying building row — nothing to reverse-geocode a suggestion for
    setAddressLookupLoading(true);
    let cancelled = false;
    reverseGeocode(buildingPick.lat, buildingPick.lon)
      .then((addr) => {
        if (cancelled) return;
        setSuggestedAddress(addr);
        if (addr && !addressUserEditedRef.current) setAddressInput(addr);
      })
      .finally(() => { if (!cancelled) setAddressLookupLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buildingPick?.rawId]);

  const saveBuildingAddress = async () => {
    if (!buildingPick?.rawId || !addressInput.trim()) return;
    setSavingAddress(true);
    setAddressSaveError(null);
    try {
      const { address } = await updateBuildingAddress(buildingPick.rawId, addressInput.trim());
      setBuildingPick((prev) => (prev ? { ...prev, address } : prev));
      setBuildings((prev) => {
        if (!prev) return prev;
        return {
          type: "FeatureCollection",
          // f.properties.id comes back from the API as a string (Postgres BIGINT serializes as string in JSON),
          // while buildingPick.rawId is a number — compare numerically or this silently never matches, leaving
          // the map's cached feature with the stale address, which reappears the next time it's re-selected
          features: (prev.features as any[]).map((f) =>
            Number(f.properties.id) === buildingPick.rawId ? { ...f, properties: { ...f.properties, address } } : f
          ),
        };
      });
      setAddressJustSaved(true);
      setTimeout(() => setAddressJustSaved(false), 2000);
    } catch (err: any) {
      setAddressSaveError(err?.message || "Could not save this address");
    } finally {
      setSavingAddress(false);
    }
  };

  // once the currently-selected ward's footprint fetch has actually settled, snap the pending search/click point to
  // the nearest one. Gated on settledWardRef matching selWard rather than !buildingsLoading — that flag (and
  // `buildings` itself) can still read stale values from the previous ward in this same render pass, since this
  // effect and the one that kicks off the fetch both fire from one render and each sees state as captured then,
  // not live updates from sibling effects — so a naive loading-flag check could consume this one-shot pick against
  // the wrong ward's data before the real fetch even starts.
  useEffect(() => {
    if (!pendingBuildingAutoPick) return;
    if (settledWardRef.current !== selWard) return;
    const { lat, lon } = pendingBuildingAutoPick;
    setPendingBuildingAutoPick(null);
    let best: any = null;
    let bestDist = Infinity;
    if (buildings && buildings.features.length) {
      for (const f of buildings.features as any[]) {
        const c = featureLatLon(f);
        const d = haversineMeters(lat, lon, c.lat, c.lon);
        if (d < bestDist) { bestDist = d; best = f; }
      }
    }
    if (best && bestDist <= BUILDING_AUTO_PICK_RADIUS_M) {
      const c = featureLatLon(best);
      handleBuildingPick({ id: best.properties.__id, lat: c.lat, lon: c.lon, label: best.properties.label }, best);
      return;
    }
    // not in the already-loaded (possibly capped, for an oversized ward) set — ask the server directly instead
    // of giving up, since the loaded subset is not an exhaustive source of truth for what buildings actually exist
    let cancelled = false;
    fetchNearestBuilding(lat, lon, BUILDING_AUTO_PICK_RADIUS_M)
      .then((res) => {
        if (cancelled) return;
        if (res.found && res.building) {
          const f = res.building as any;
          const c = featureLatLon(f);
          // fold it into the loaded set too, so it's visible on the map and re-selectable without another round trip
          setBuildings((prev) =>
            prev ? { ...prev, features: [...prev.features, f] } : { type: "FeatureCollection", features: [f] }
          );
          handleBuildingPick({ id: f.properties.__id, lat: c.lat, lon: c.lon, label: f.properties.label }, f);
        } else {
          setNotice((n) => n || `No building footprint found within ${BUILDING_AUTO_PICK_RADIUS_M}m of this address — tap a footprint on the map to select it manually.`);
        }
      })
      .catch(() => {
        if (!cancelled) setNotice((n) => n || `No building footprint found within ${BUILDING_AUTO_PICK_RADIUS_M}m of this address — tap a footprint on the map to select it manually.`);
      });
    return () => { cancelled = true; };
  }, [buildings, buildingsLoading, buildingsError, pendingBuildingAutoPick, selWard]);

  // safety net: if the ward boundary itself never loads (so buildingMode never turns on and buildings never settle),
  // don't leave a pending auto-pick around to misfire against whatever ward the user browses to next
  useEffect(() => {
    if (!pendingBuildingAutoPick) return;
    const t = setTimeout(() => setPendingBuildingAutoPick(null), 15000);
    return () => clearTimeout(t);
  }, [pendingBuildingAutoPick]);

  const copyCoord = async (text: string, kind: "coord" | "dms" | "geojson" | "code") => {
    try {
      await navigator.clipboard.writeText(text);
      setCoordCopied(kind);
      setTimeout(() => setCoordCopied(""), 1600);
    } catch {}
  };

  return (
    <div className="flex min-h-screen flex-col bg-stone-100 text-slate-800 selection:bg-amber-200">
      {/* header */}
      <header className="sticky top-0 z-40 border-b border-black/10 bg-gradient-to-r from-green-950 via-green-900 to-emerald-900 text-white shadow-sm">
        <div className="mx-auto flex max-w-[1440px] items-center gap-3 px-4 py-3">
          <img src="/algon-seal.png" alt="ALGON seal" className="h-11 w-11 shrink-0 rounded-full bg-white shadow" />
          <div className="min-w-0 flex-1">
            <h1 className="flex items-center gap-2 truncate text-[17px] font-black leading-tight tracking-tight sm:text-xl">
              ALGON POA SYSTEM
              <span className="hidden items-center gap-1 rounded-full bg-white/15 px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest text-amber-200 ring-1 ring-white/20 sm:inline-flex">
                <Sparkles className="h-3 w-3" /> Ward boundaries
              </span>
            </h1>
            <p className="truncate text-xs font-medium text-emerald-100/90 sm:text-[13px]">Ward boundaries & address finder — every LGA, on demand</p>
          </div>

          {stats && (
            <div className="hidden shrink-0 items-center gap-2 text-xs md:flex">
              <span className="rounded-full bg-white/10 px-3 py-1.5 font-semibold ring-1 ring-white/15">{stats.states} states</span>
              <span className="rounded-full bg-white/10 px-3 py-1.5 font-semibold ring-1 ring-white/15">{stats.lgas} LGAs</span>
              <span className="rounded-full bg-amber-400 px-3 py-1.5 font-black text-green-950 shadow">{stats.wards.toLocaleString()} wards</span>
            </div>
          )}
          <a
            href="https://www.grid3.org"
            target="_blank"
            rel="noreferrer"
            className="hidden items-center gap-1 rounded-full bg-white px-3 py-1.5 text-xs font-bold text-green-900 hover:bg-amber-50 md:inline-flex"
          >
            GRID3 <ExternalLink className="h-3 w-3" />
          </a>
          <Link
            to="/admin"
            className="inline-flex items-center gap-1 rounded-full bg-white/10 px-3 py-1.5 text-xs font-bold ring-1 ring-white/15 hover:bg-white/20"
          >
            <ShieldCheck className="h-3.5 w-3.5" /> Admin
          </Link>
        </div>
      </header>

      <div className="mx-auto flex w-full max-w-[1440px] flex-1 flex-col lg:flex-row">
        {/* sidebar */}
        <aside className="order-2 flex w-full flex-col gap-4 p-4 lg:order-1 lg:h-[calc(100vh-64px)] lg:w-[430px] lg:shrink-0 lg:overflow-y-auto nice-scroll">
          {/* search */}
          <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
            <h2 className="mb-2 flex items-center gap-2 text-[11px] font-black uppercase tracking-widest text-slate-500">
              <Search className="h-4 w-4 text-green-700" /> Find an address
            </h2>
            <SearchBar onSelect={onGeocodePick} />
            <div className="mt-2.5 flex items-center gap-2">
              <button
                onClick={useMyLocation}
                className="inline-flex items-center gap-1.5 rounded-xl border border-green-700/20 bg-green-50 px-3 py-1.5 text-xs font-bold text-green-800 hover:bg-green-100 active:scale-[0.98]"
              >
                <LocateFixed className="h-3.5 w-3.5" /> Use my location
              </button>
              <p className="text-[11px] leading-tight text-slate-400">…or click anywhere on the map to identify its ward.</p>
            </div>
            <AnimatePresence>
              {notice && (
                <motion.p
                  initial={{ opacity: 0, y: -4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  className="mt-2.5 flex items-start gap-1.5 rounded-xl bg-amber-50 px-3 py-2.5 text-xs leading-snug font-medium text-amber-800 ring-1 ring-amber-200"
                >
                  <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" /> <span>{notice}</span>
                </motion.p>
              )}
            </AnimatePresence>
          </section>

          {/* landmarks filter */}
          <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
            <h2 className="mb-1 flex items-center gap-2 text-[11px] font-black uppercase tracking-widest text-slate-500">
              <MapPin className="h-4 w-4 text-green-700" /> Landmarks
            </h2>
            <p className="mb-3 text-xs leading-snug text-slate-500">
              Show social infrastructure on the map — useful for spotting coverage gaps across an LGA.
            </p>
            <div className="flex flex-wrap gap-2">
              {LANDMARK_CATEGORY_ORDER.map((cat) => {
                const active = activeLandmarkCategories.includes(cat);
                const style = LANDMARK_STYLES[cat];
                return (
                  <button
                    key={cat}
                    onClick={() => toggleLandmarkCategory(cat)}
                    className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-bold ring-1 transition ${
                      active ? "text-white ring-transparent" : "bg-white text-slate-500 ring-slate-300 hover:bg-slate-50"
                    }`}
                    style={active ? { backgroundColor: style.color } : undefined}
                  >
                    <span className="h-2 w-2 rounded-full" style={{ backgroundColor: active ? "#fff" : style.color }} />
                    {style.label}
                  </button>
                );
              })}
            </div>
            {activeLandmarkCategories.length > 0 && (
              <p className="mt-2.5 text-[11px] font-medium text-slate-400">
                {landmarks
                  ? landmarks.clustered
                    ? `Grouped into ${landmarks.features.length} clusters — zoom in to see individual landmarks`
                    : `${landmarks.features.length} shown in view${landmarks.capped ? " (zoom in for more)" : ""}`
                  : "Zoom in closer to load landmarks…"}
              </p>
            )}
          </section>

          {/* add a missing building — any logged-in user */}
          {user && (
            <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
              <h2 className="mb-1 flex items-center gap-2 text-[11px] font-black uppercase tracking-widest text-slate-500">
                <PenLine className="h-4 w-4 text-blue-700" /> Add a missing building
              </h2>

              {!drawMode && !pendingBuildingGeom && (
                <>
                  <p className="mb-3 text-xs leading-snug text-slate-500">
                    See a building on the map that isn't outlined? Trace its footprint by hand and save it to the shared dataset.
                  </p>
                  <button
                    onClick={startDraw}
                    className="inline-flex w-full items-center justify-center gap-1.5 rounded-xl bg-blue-700 px-3 py-2.5 text-sm font-black text-white shadow hover:bg-blue-800 active:scale-[0.98]"
                  >
                    <PenLine className="h-4 w-4" /> Trace a building
                  </button>
                </>
              )}

              {drawMode && (
                <>
                  <p className="mb-3 text-xs leading-snug text-slate-500">
                    Click each corner of the building on the map, in order. Once you have at least 3 points, tap <strong>Finish shape</strong>.
                  </p>
                  <div className="flex gap-2">
                    <button
                      onClick={() => setFinishDrawKey((k) => k + 1)}
                      className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-blue-700 px-3 py-2.5 text-sm font-black text-white shadow hover:bg-blue-800 active:scale-[0.98]"
                    >
                      <CircleCheck className="h-4 w-4" /> Finish shape
                    </button>
                    <button
                      onClick={cancelDraw}
                      className="inline-flex items-center justify-center gap-1.5 rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm font-bold text-slate-700 hover:bg-slate-50"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                </>
              )}

              {pendingBuildingGeom && (
                <>
                  <p className="mb-2 text-xs font-bold text-blue-800">Shape traced — review and save</p>
                  <input
                    value={buildingName}
                    onChange={(e) => setBuildingName(e.target.value)}
                    placeholder="Building name (optional)"
                    className="mb-2 w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm outline-none placeholder:text-slate-400 focus:border-blue-700 focus:ring-2 focus:ring-blue-700/15"
                  />
                  <input
                    value={buildingAddress}
                    onChange={(e) => setBuildingAddress(e.target.value)}
                    placeholder="Address (optional) — e.g. not found on any map"
                    className="mb-2 w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm outline-none placeholder:text-slate-400 focus:border-blue-700 focus:ring-2 focus:ring-blue-700/15"
                  />
                  <p className="mb-2 text-[11px] leading-snug text-slate-400">
                    Type the building's address here if it isn't listed on Google, Mapbox, or OSM — it's saved as entered, not geocoded.
                  </p>
                  {drawError && (
                    <p className="mb-2 rounded-lg bg-red-50 px-3 py-2 text-xs font-semibold text-red-700 ring-1 ring-red-200">{drawError}</p>
                  )}
                  <div className="flex gap-2">
                    <button
                      onClick={saveDrawnBuilding}
                      disabled={savingBuilding}
                      className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-blue-700 px-3 py-2.5 text-sm font-black text-white shadow hover:bg-blue-800 disabled:opacity-60 active:scale-[0.98]"
                    >
                      {savingBuilding ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <CircleCheck className="h-4 w-4" />}
                      {savingBuilding ? "Saving…" : "Save building"}
                    </button>
                    <button
                      onClick={cancelDraw}
                      disabled={savingBuilding}
                      className="inline-flex items-center justify-center gap-1.5 rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm font-bold text-slate-700 hover:bg-slate-50 disabled:opacity-60"
                    >
                      Discard
                    </button>
                  </div>
                </>
              )}
            </section>
          )}

          {/* browse */}
          <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
            <h2 className="mb-3 flex items-center gap-2 text-[11px] font-black uppercase tracking-widest text-slate-500">
              <Layers className="h-4 w-4 text-green-700" /> Browse boundaries
            </h2>

            <label className="mb-1 flex items-center gap-1.5 text-xs font-bold text-slate-600">
              <Landmark className="h-3.5 w-3.5 text-slate-400" /> State
            </label>
            <div className="relative mb-3">
              <select
                value={selState}
                onChange={(e) => onPickState(e.target.value)}
                className="w-full appearance-none rounded-xl border border-slate-300 bg-white px-3 py-2.5 pr-9 text-sm font-medium outline-none transition focus:border-green-700 focus:ring-2 focus:ring-green-700/15"
              >
                <option value="">Select state…</option>
                {states.map((s) => (
                  <option key={s.id} value={s.name}>
                    {prettyState(s.name)}
                  </option>
                ))}
              </select>
              <ChevronDown className="pointer-events-none absolute right-3 top-3.5 h-4 w-4 text-slate-400" />
            </div>

            <label className="mb-1 block text-xs font-bold text-slate-600">
              Local government{" "}
              {lgas.length > 0 && <span className="font-medium text-slate-400">({lgas.length})</span>}
            </label>
            <div className="relative mb-3">
              <select
                value={selLGA}
                onChange={(e) => onPickLGA(e.target.value)}
                disabled={!selState}
                className="w-full appearance-none rounded-xl border border-slate-300 bg-white px-3 py-2.5 pr-9 text-sm font-medium outline-none transition disabled:bg-slate-100 focus:border-green-700 focus:ring-2 focus:ring-green-700/15"
              >
                <option value="">{selState ? (busyLGAs && !lgas.length ? "Loading LGAs…" : "Select LGA…") : "Select a state first…"}</option>
                {lgas.map((l) => (
                  <option key={l.id} value={l.name}>
                    {l.name}
                  </option>
                ))}
              </select>
              <ChevronDown className="pointer-events-none absolute right-3 top-3.5 h-4 w-4 text-slate-400" />
            </div>

            <label className="mb-1 block text-xs font-bold text-slate-600">
              Ward {wards.length > 0 && <span className="font-medium text-slate-400">({wards.length})</span>}
            </label>
            <div className="relative">
              <select
                value={selWard}
                onChange={(e) => onPickWard(e.target.value)}
                disabled={!selLGA}
                className="w-full appearance-none rounded-xl border border-slate-300 bg-white px-3 py-2.5 pr-9 text-sm font-medium outline-none transition disabled:bg-slate-100 focus:border-green-700 focus:ring-2 focus:ring-green-700/15"
              >
                <option value="">{selLGA ? (busyLGAs && !wards.length ? "Loading wards…" : "Select ward…") : "Select an LGA first…"}</option>
                {wards.map((w) => (
                  <option key={w.id} value={w.name}>
                    {w.name}
                  </option>
                ))}
              </select>
              <ChevronDown className="pointer-events-none absolute right-3 top-3.5 h-4 w-4 text-slate-400" />
            </div>

            {/* quick stats row */}
            {selState && (
              <div className="mt-3 grid grid-cols-3 gap-2">
                <div className="rounded-xl bg-slate-50 px-2.5 py-2 text-center ring-1 ring-slate-200">
                  <div className="text-[11px] font-bold uppercase tracking-wide text-slate-400">LGAs</div>
                  <div className="text-sm font-black text-slate-800">{lgas.length || "—"}</div>
                </div>
                <div className="rounded-xl bg-green-50 px-2.5 py-2 text-center ring-1 ring-green-200">
                  <div className="text-[11px] font-bold uppercase tracking-wide text-green-700">Wards</div>
                  <div className="text-sm font-black text-green-900">{wards.length || "—"}</div>
                </div>
                <div className="rounded-xl bg-amber-50 px-2.5 py-2 text-center ring-1 ring-amber-200">
                  <div className="text-[11px] font-bold uppercase tracking-wide text-amber-700">Loaded</div>
                  <div className="text-sm font-black text-amber-800">{meta?.count ?? "—"}</div>
                </div>
              </div>
            )}
          </section>

          {/* selected place */}
          {(selState || resolveData) && (
            <section className="overflow-hidden rounded-2xl border border-green-800/20 bg-gradient-to-br from-green-900 via-green-800 to-emerald-800 p-4 text-white shadow-sm">
              <h2 className="mb-2 text-[11px] font-black uppercase tracking-widest text-emerald-200">Selected place</h2>
              <div className="space-y-1.5 text-sm">
                {selState && (
                  <p>
                    <span className="text-emerald-200/90">State:</span> <strong className="font-bold">{prettyState(selState)}</strong>
                  </p>
                )}
                {selLGA && (
                  <p>
                    <span className="text-emerald-200/90">LGA:</span> <strong className="font-bold">{selLGA}</strong>
                    {selectedLGACode && <span className="text-emerald-200"> · {selectedLGACode}</span>}
                  </p>
                )}
                {selWard && (
                  <p>
                    <span className="text-emerald-200/90">Ward:</span> <strong className="font-black text-amber-300">{selWard}</strong>
                    {selectedWardCode && <span className="text-emerald-200"> · {selectedWardCode}</span>}
                  </p>
                )}
                {!selWard && selLGA && primaryKind === "wards" && (
                  <p className="text-xs font-medium text-amber-200">Pick a ward in {selLGA} or click a ward on the map.</p>
                )}
              </div>

              {resolveData?.address && (
                <div className="mt-3 rounded-xl bg-white/10 p-3 ring-1 ring-white/15 backdrop-blur">
                  <p className="text-[11px] font-black uppercase tracking-widest text-amber-200">Descriptive address</p>
                  <p className="mt-1 text-[13px] font-medium leading-snug">{resolveData.address.display_name}</p>
                  <div className="mt-2 flex flex-wrap gap-1.5 text-[11px]">
                    {[
                      resolveData.address.road && `Road: ${resolveData.address.road}`,
                      resolveData.address.suburb && `Area: ${resolveData.address.suburb}`,
                      resolveData.address.city && `Town: ${resolveData.address.city}`,
                      resolveData.address.postcode && `Postcode: ${resolveData.address.postcode}`,
                    ]
                      .filter(Boolean)
                      .map((t) => (
                        <span key={String(t)} className="rounded-full bg-white/15 px-2 py-0.5 font-medium ring-1 ring-white/10">
                          {t}
                        </span>
                      ))}
                  </div>
                  {resolveData.match?.source && (
                    <p className="mt-2 text-[11px] font-medium text-emerald-100">Ward identified by point-in-polygon · {resolveData.match.source}</p>
                  )}
                  <div className="mt-2 flex gap-2">
                    <button onClick={copyAddr} className="inline-flex items-center gap-1 rounded-lg bg-white px-2.5 py-1 text-xs font-bold text-green-900 hover:bg-amber-50">
                      <Copy className="h-3 w-3" /> Copy
                    </button>
                    {marker && (
                      <a
                        href={`https://www.openstreetmap.org/?mlat=${marker.lat}&mlon=${marker.lon}#map=16/${marker.lat}/${marker.lon}`}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 rounded-lg bg-white/15 px-2.5 py-1 text-xs font-bold text-white ring-1 ring-white/20 hover:bg-white/20"
                      >
                        <ExternalLink className="h-3 w-3" /> Open in OSM
                      </a>
                    )}
                  </div>
                </div>
              )}

              {selWard && primaryKind === "wards" && (
                <button
                  onClick={() => setFocusKey((k) => k + 1)}
                  className="mt-3 inline-flex w-full items-center justify-center gap-1.5 rounded-xl bg-amber-400 px-3 py-2.5 text-sm font-black text-green-950 shadow hover:bg-amber-300 active:scale-[0.98]"
                >
                  <Crosshair className="h-4 w-4" /> Zoom to {selWard} ward
                </button>
              )}
            </section>
          )}

          {/* buildings in ward */}
          {selWard && primaryKind === "wards" && mapSettings?.show_buildings !== false && (
            <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
              <h2 className="mb-1 flex items-center gap-2 text-[11px] font-black uppercase tracking-widest text-slate-500">
                <Building2 className="h-4 w-4 text-green-700" /> Buildings in ward
              </h2>
              <p className="mb-3 text-xs leading-snug text-slate-500">
                Every building footprint in {selWard} loads automatically from OpenStreetMap as soon as the ward is selected. Tap any footprint on the map to capture its exact coordinate.{buildingPick ? " Selected building is highlighted in green." : ""}
              </p>

              <div className="flex items-center gap-2">
                <button
                  onClick={toggleBuildingMode}
                  className={`inline-flex flex-1 items-center justify-center gap-1.5 rounded-xl px-3 py-2.5 text-sm font-black shadow ring-1 transition active:scale-[0.98] ${buildingMode ? "bg-green-800 text-white ring-green-800 hover:bg-green-700" : "bg-amber-400 text-green-950 ring-amber-400 hover:bg-amber-300"}`}
                >
                  {buildingMode ? <MousePointer2 className="h-4 w-4" /> : <Building2 className="h-4 w-4" />}
                  {buildingMode ? "Building select: ON" : "Enable building select"}
                </button>
                {buildingMode && (
                  <button
                    onClick={reloadBuildings}
                    disabled={buildingsLoading || (wardTruncated && zoomedOutTooFar)}
                    className="inline-flex items-center gap-1.5 rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-xs font-bold text-slate-700 hover:bg-slate-50 disabled:opacity-60"
                  >
                    {buildingsLoading ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                    {buildingsLoading ? "Loading…" : wardTruncated ? "Load this area" : "Reload"}
                  </button>
                )}
              </div>
              {buildingMode && wardTruncated && zoomedOutTooFar && (
                <p className="mt-2 text-[11px] font-medium leading-snug text-slate-400">Zoom in closer (level {MIN_BUILDING_ZOOM}+) before using "Load this area".</p>
              )}

              {buildingMode && buildingsLoading && !buildings && (
                <p className="mt-3 flex items-center gap-2 rounded-xl bg-green-50 px-3 py-2.5 text-xs font-semibold text-green-800 ring-1 ring-green-200">
                  <LoaderCircle className="h-4 w-4 animate-spin" /> Loading every building in {selWard}… large wards can take a few seconds.
                </p>
              )}

              {buildingMode && buildingsError && (
                <div className="mt-3 rounded-xl bg-amber-50 p-3 ring-1 ring-amber-200">
                  <p className="flex items-start gap-2 text-xs font-medium leading-snug text-amber-800">
                    <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {buildingsError}
                  </p>
                  <button onClick={reloadBuildings} className="mt-2 inline-flex items-center gap-1.5 rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-bold text-white hover:bg-amber-700">
                    <RefreshCw className="h-3.5 w-3.5" /> Retry
                  </button>
                </div>
              )}

              {buildingMode && !buildingsError && buildings && !buildingsLoading && buildings.features.length > 0 && (
                <p className={`mt-3 flex flex-wrap items-center gap-1.5 rounded-xl px-3 py-2 text-xs font-bold ring-1 ${wardTruncated ? "bg-amber-50 text-amber-800 ring-amber-200" : "bg-green-50 text-green-800 ring-green-200"}`}>
                  <CircleCheck className="h-3.5 w-3.5 shrink-0" />
                  {wardTruncated
                    ? `Loaded ${buildings.features.length} of ${wardBuildingTotal.toLocaleString()} buildings in ${selWard} (capped)`
                    : `All ${buildings.features.length} building${buildings.features.length === 1 ? "" : "s"} in ${selWard} loaded`}
                  <span className="ml-auto font-medium">Tap a footprint to select</span>
                  {wardTruncated && (
                    <span className="w-full text-[11px] font-medium leading-snug text-amber-700">
                      This ward has more buildings than fit in one load. Zoom into a specific area and tap "Load this area" above to fill in the rest there.
                    </span>
                  )}
                </p>
              )}

              {buildingMode && !buildingsError && buildings && !buildingsLoading && buildings.features.length === 0 && (
                <p className="mt-3 flex items-center gap-1.5 rounded-xl bg-slate-50 px-3 py-2 text-xs font-medium text-slate-500 ring-1 ring-slate-200">
                  No building footprints mapped in {selWard} yet. You can still click the map to drop a pin and capture its coordinate.
                </p>
              )}

              {/* selected building coordinate */}
              {buildingPick && (
                <div className="mt-3 rounded-2xl border border-green-300 bg-gradient-to-br from-green-50 to-white p-3 shadow-sm ring-1 ring-green-200">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <p className="flex items-center gap-1.5 text-[11px] font-black uppercase tracking-widest text-green-700">
                        <ClipboardCheck className="h-3.5 w-3.5" /> Selected building
                      </p>
                      <p className="mt-1 truncate text-sm font-bold text-slate-800">{buildingPick.label}</p>
                      {buildingPick.address && (
                        <p className="truncate text-xs font-semibold text-green-800">{buildingPick.address}</p>
                      )}
                      <p className="text-[11px] font-medium text-slate-500">{buildingPick.id} · in {selWard}, {selLGA}</p>
                    </div>
                    <button
                      onClick={() => setBuildingPick(null)}
                      className="shrink-0 rounded-lg border border-slate-200 bg-white px-2 py-1 text-[11px] font-bold text-slate-600 hover:bg-slate-50"
                    >
                      Clear
                    </button>
                  </div>

                  <div className="mt-3 grid gap-2">
                    <div className="rounded-xl bg-green-900 px-3 py-2.5 font-mono text-xs leading-relaxed text-amber-50 shadow-inner ring-1 ring-green-700/40">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[11px] font-sans font-bold uppercase tracking-widest text-amber-300">Building code</span>
                        <button onClick={() => buildingPickCode && copyCoord(buildingPickCode, "code")} className="rounded-lg bg-white/15 px-2 py-1 font-sans text-[11px] font-bold text-white hover:bg-white/20">
                          {coordCopied === "code" ? "Copied!" : <span className="inline-flex items-center gap-1"><Copy className="h-3 w-3" /> Copy</span>}
                        </button>
                      </div>
                      <div className="mt-1 select-all text-[15px] font-black tracking-wide">{buildingPickCode}</div>
                      <div className="mt-0.5 text-[11px] text-amber-100/70">State–LGA–Ward–building sequence, generated from this pick</div>
                    </div>

                    {/* proof-of-address: building_code identifies WHICH building, this is the address attached to it */}
                    <div className="rounded-xl bg-white px-3 py-2.5 ring-1 ring-slate-200">
                      <div className="flex items-center justify-between gap-2">
                        <span className="flex items-center gap-1.5 text-[11px] font-black uppercase tracking-widest text-slate-500">
                          <MapPin className="h-3.5 w-3.5 text-green-700" /> Address
                        </span>
                        {buildingPick.address && (
                          <span className="inline-flex items-center gap-1 rounded-full bg-green-100 px-2 py-0.5 text-[10px] font-bold text-green-800 ring-1 ring-green-300">
                            <CircleCheck className="h-3 w-3" /> Confirmed
                          </span>
                        )}
                      </div>

                      {!buildingPick.rawId ? (
                        <p className="mt-1.5 text-xs text-slate-400">No building record to attach an address to — this is a raw map point, not a mapped footprint.</p>
                      ) : (
                        <>
                          {buildingPick.address ? (
                            <p className="mt-1.5 text-sm font-semibold text-slate-800">{buildingPick.address}</p>
                          ) : addressLookupLoading ? (
                            <p className="mt-1.5 flex items-center gap-1.5 text-xs text-slate-400">
                              <LoaderCircle className="h-3 w-3 animate-spin" /> Looking up a suggested address…
                            </p>
                          ) : suggestedAddress ? (
                            <p className="mt-1.5 text-xs italic text-amber-700">Suggested: {suggestedAddress} — unconfirmed</p>
                          ) : (
                            <p className="mt-1.5 text-xs text-slate-400">No address on file yet.</p>
                          )}

                          {user ? (
                            <div className="mt-2 flex gap-1.5">
                              <input
                                value={addressInput}
                                onChange={(e) => { addressUserEditedRef.current = true; setAddressInput(e.target.value); }}
                                placeholder="Type or correct the address…"
                                className="min-w-0 flex-1 rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs outline-none focus:border-green-700 focus:ring-2 focus:ring-green-700/15"
                              />
                              <button
                                onClick={saveBuildingAddress}
                                disabled={savingAddress || !addressInput.trim()}
                                className="shrink-0 rounded-lg bg-green-800 px-2.5 py-1.5 text-[11px] font-bold text-white hover:bg-green-700 disabled:opacity-50"
                              >
                                {savingAddress ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : addressJustSaved ? "Saved!" : buildingPick.address ? "Update" : "Confirm"}
                              </button>
                            </div>
                          ) : (
                            <p className="mt-2 text-[11px] text-slate-400">
                              <Link to="/login" className="font-bold text-green-700 hover:underline">Log in</Link> to confirm or correct this address.
                            </p>
                          )}
                          {addressSaveError && <p className="mt-1.5 text-[11px] font-semibold text-red-600">{addressSaveError}</p>}
                        </>
                      )}
                    </div>

                    <div className="rounded-xl bg-slate-900 px-3 py-2.5 font-mono text-xs leading-relaxed text-amber-100 shadow-inner">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[11px] font-sans font-bold uppercase tracking-widest text-amber-300">Decimal · WGS84</span>
                        <button onClick={() => copyCoord(`${buildingPick.lat.toFixed(6)}, ${buildingPick.lon.toFixed(6)}`, "coord")} className="rounded-lg bg-white/15 px-2 py-1 font-sans text-[11px] font-bold text-white hover:bg-white/20">
                          {coordCopied === "coord" ? "Copied!" : <span className="inline-flex items-center gap-1"><Copy className="h-3 w-3" /> Copy</span>}
                        </button>
                      </div>
                      <div className="mt-1 select-all text-[13px] font-bold tracking-wide">{buildingPick.lat.toFixed(6)}, {buildingPick.lon.toFixed(6)}</div>
                      <div className="mt-0.5 text-[11px] text-slate-400">lat, lon · 6 decimals ≈ 10 cm · use as marker position</div>
                    </div>

                    <div className="grid grid-cols-2 gap-2">
                      <div className="rounded-xl bg-white px-3 py-2.5 ring-1 ring-slate-200">
                        <div className="flex items-center justify-between">
                          <span className="text-[11px] font-black uppercase tracking-widest text-slate-400">DMS</span>
                          <button onClick={() => copyCoord(`${toDMS(buildingPick.lat, true)}, ${toDMS(buildingPick.lon, false)}`, "dms")} className="rounded-lg bg-slate-900 px-2 py-1 text-[10px] font-bold text-white hover:bg-black">
                            {coordCopied === "dms" ? "Copied!" : "Copy"}
                          </button>
                        </div>
                        <div className="mt-1 font-mono text-xs font-semibold leading-snug text-slate-800">{toDMS(buildingPick.lat, true)}<br />{toDMS(buildingPick.lon, false)}</div>
                      </div>
                      <div className="rounded-xl bg-white px-3 py-2.5 ring-1 ring-slate-200">
                        <div className="flex items-center justify-between">
                          <span className="text-[11px] font-black uppercase tracking-widest text-slate-400">GeoJSON</span>
                          <button onClick={() => copyCoord(`{"type":"Point","coordinates":[${buildingPick.lon.toFixed(6)}, ${buildingPick.lat.toFixed(6)}]}`, "geojson")} className="rounded-lg bg-slate-900 px-2 py-1 text-[10px] font-bold text-white hover:bg-black">
                            {coordCopied === "geojson" ? "Copied!" : "Copy"}
                          </button>
                        </div>
                        <div className="mt-1 select-all break-all font-mono text-[11px] leading-snug text-slate-700">[{buildingPick.lon.toFixed(6)}, {buildingPick.lat.toFixed(6)}]</div>
                        <div className="mt-1 text-[10px] font-medium text-slate-400">lon, lat order</div>
                      </div>
                    </div>

                    <div className="flex flex-wrap gap-1.5">
                      <button onClick={() => copyCoord(`${buildingPick.lat},${buildingPick.lon}`, "coord")} className="inline-flex items-center gap-1 rounded-full bg-green-800 px-3 py-1.5 text-xs font-bold text-white hover:bg-green-700">
                        <Copy className="h-3 w-3" /> Copy lat,lon
                      </button>
                      <a href={`https://www.openstreetmap.org/?mlat=${buildingPick.lat}&mlon=${buildingPick.lon}#map=19/${buildingPick.lat}/${buildingPick.lon}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 rounded-full bg-white px-3 py-1.5 text-xs font-bold text-slate-700 ring-1 ring-slate-200 hover:bg-slate-50">
                        <ExternalLink className="h-3 w-3" /> Open in OSM
                      </a>
                      <a href={`https://www.google.com/maps/search/?api=1&query=${buildingPick.lat},${buildingPick.lon}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 rounded-full bg-white px-3 py-1.5 text-xs font-bold text-slate-700 ring-1 ring-slate-200 hover:bg-slate-50">
                        <Navigation className="h-3 w-3" /> Google Maps
                      </a>
                    </div>
                  </div>
                </div>
              )}

              {buildingMode && buildings && !buildingPick && buildings.features.length > 0 && (
                <div className="mt-3 max-h-56 overflow-y-auto rounded-xl border border-slate-200 bg-slate-50 p-2 nice-scroll">
                  <p className="px-1 pb-1 text-[11px] font-bold uppercase tracking-widest text-slate-400">Quick pick list · {buildings.features.length <= 40 ? "all buildings" : "first 40"}</p>
                  {(buildings.features as any[]).slice(0, 40).map((f: any) => {
                    const id: string = f.properties.__id;
                    return (
                      <button
                        key={id}
                        onClick={() => {
                          const { lat, lon } = featureLatLon(f);
                          handleBuildingPick({ id, lat, lon, label: f.properties.label }, f);
                        }}
                        className="flex w-full items-center gap-2 rounded-lg bg-white px-2.5 py-2 text-left text-xs font-medium text-slate-700 ring-1 ring-slate-200 hover:bg-amber-50 hover:ring-amber-200"
                      >
                        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-amber-500 text-[10px] font-black text-white">{String(f.properties.building || "B").slice(0,1).toUpperCase()}</span>
                        <span className="min-w-0 flex-1 truncate font-semibold">{f.properties.label}</span>
                        <span className="shrink-0 text-[10px] text-slate-400">{f.properties.building_code || id}</span>
                      </button>
                    );
                  })}
                  {buildings.features.length > 40 && <p className="px-1 pt-1 text-center text-[11px] text-slate-400">…and {(buildings as any).features.length - 40} more on the map — pan/zoom to see</p>}
                </div>
              )}
            </section>
          )}

          {/* verify */}
          <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
            <h2 className="mb-1 flex items-center gap-2 text-[11px] font-black uppercase tracking-widest text-slate-500">
              <ShieldCheck className="h-4 w-4 text-green-700" /> Verify an address
            </h2>
            <p className="mb-3 text-xs leading-snug text-slate-500">Confirm that a descriptive address sits inside the selected ward. Saved to the shared ground-truth log.</p>

            <div className="relative">
              <input
                value={verifyAddr}
                onChange={(e) => setVerifyAddr(e.target.value)}
                placeholder="Descriptive address — e.g. 12 Allen Avenue, Ikeja"
                className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 pr-9 text-sm outline-none placeholder:text-slate-400 focus:border-green-700 focus:ring-2 focus:ring-green-700/15"
              />
              {verifyAddr && (
                <button onClick={() => setVerifyAddr("")} className="absolute right-2 top-2 rounded-lg p-1 text-slate-400 hover:bg-slate-100">
                  <TriangleAlert className="h-4 w-4 hidden" />
                  <span className="text-xs">✕</span>
                </button>
              )}
            </div>

            <input
              value={verifyNote}
              onChange={(e) => setVerifyNote(e.target.value)}
              placeholder="Note (optional) — e.g. opposite the bus stop"
              className="mt-2 w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm outline-none placeholder:text-slate-400 focus:border-green-700 focus:ring-2 focus:ring-green-700/15"
            />

            <button
              onClick={doVerify}
              disabled={submitting}
              className="mt-3 inline-flex w-full items-center justify-center gap-1.5 rounded-xl bg-green-800 px-3 py-2.5 text-sm font-black text-white shadow hover:bg-green-700 disabled:opacity-60 active:scale-[0.98]"
            >
              {submitting ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
              {submitting ? "Saving…" : `Verify in ${selWard || "…"}`}
            </button>

            {verifyMsg && (
              <p className={`mt-2.5 rounded-xl px-3 py-2 text-xs font-medium leading-snug ${verifyMsg.ok ? "bg-green-50 text-green-800 ring-1 ring-green-200" : "bg-red-50 text-red-700 ring-1 ring-red-200"}`}>
                {verifyMsg.text}
              </p>
            )}
            {!selWard && (
              <p className="mt-2 text-center text-[11px] font-medium text-slate-400">Select a ward to enable verification.</p>
            )}
          </section>

          <p className="pb-2 text-center text-[11px] font-medium leading-relaxed text-slate-400">
            Boundaries: GRID3 Nigeria (CC BY 4.0) · Geocoding: OpenStreetMap Nominatim
            <br />
            {stats ? `${stats.cached_geometries} geometries cached locally · ${stats.wards.toLocaleString()} wards in database` : "Loading stats…"}
          </p>
        </aside>

        {/* map */}
        <main className="relative order-1 flex min-h-[54vh] flex-1 flex-col bg-[#e8ece7] lg:order-2 lg:h-[calc(100vh-64px)] lg:min-h-0">
          <div className="relative flex-1">
            {mapSettings?.provider === "mapbox" || mapSettings?.provider === "osm" ? (
              <MapboxMapView
                provider={mapSettings.provider}
                primary={primary}
                primaryKind={primaryKind}
                outline={outline}
                selectedName={primaryKind === "wards" ? selWard : primaryKind === "lgas" ? selLGA : null}
                marker={marker}
                fitKey={fitKey}
                focusKey={focusKey}
                onFeatureClick={onFeatureClick}
                onMapClick={onMapClick}
                buildings={buildings}
                buildingPick={buildingPick}
                buildingMode={buildingMode}
                onBuildingPick={handleBuildingPick}
                onViewportChange={onViewportChange}
                showWards={mapSettings?.show_wards ?? true}
                showBuildings={mapSettings?.show_buildings ?? true}
                showSettlements={mapSettings?.show_settlements ?? false}
                settlementBlocks={settlementBlocks}
                landmarks={landmarks}
                onLandmarkViewportChange={onLandmarkViewportChange}
                onLandmarkClick={onLandmarkClick}
                landmarkBuilding={landmarkBuilding}
                drawMode={drawMode}
                onPolygonDrawn={onPolygonDrawn}
                pendingBuilding={pendingBuildingGeom}
                finishDrawKey={finishDrawKey}
              />
            ) : (
              <MapView
                primary={primary}
                primaryKind={primaryKind}
                outline={outline}
                selectedName={primaryKind === "wards" ? selWard : primaryKind === "lgas" ? selLGA : null}
                marker={marker}
                fitKey={fitKey}
                focusKey={focusKey}
                onFeatureClick={onFeatureClick}
                onMapClick={onMapClick}
                buildings={buildings}
                buildingPick={buildingPick}
                buildingMode={buildingMode}
                onBuildingPick={handleBuildingPick}
                onViewportChange={onViewportChange}
                showWards={mapSettings?.show_wards ?? true}
                showBuildings={mapSettings?.show_buildings ?? true}
                showSettlements={mapSettings?.show_settlements ?? false}
                settlementBlocks={settlementBlocks}
                landmarks={landmarks}
                onLandmarkViewportChange={onLandmarkViewportChange}
                onLandmarkClick={onLandmarkClick}
                landmarkBuilding={landmarkBuilding}
                drawMode={drawMode}
                onPolygonDrawn={onPolygonDrawn}
                pendingBuilding={pendingBuildingGeom}
                finishDrawKey={finishDrawKey}
              />
            )}

            {/* top hint */}
            <div className="pointer-events-none absolute left-14 top-3 z-[400] hidden rounded-xl bg-white/95 px-3 py-2 text-xs font-semibold text-slate-700 shadow-lg ring-1 ring-slate-200 backdrop-blur sm:block">
              {buildingMode && buildingPick
                ? `Building selected: ${buildingPick.lat.toFixed(5)}, ${buildingPick.lon.toFixed(5)} · click another footprint to change`
                : buildingMode && buildings
                ? "Building select ON — click any amber footprint to capture its coordinate"
                : "Click a boundary to drill in · click the map to identify a ward"}
            </div>

            {/* legend */}
            <div className="absolute bottom-4 left-4 z-[400] rounded-2xl bg-white/95 p-3 text-xs shadow-xl ring-1 ring-slate-200 backdrop-blur">
              <p className="mb-2 text-[11px] font-black uppercase tracking-widest text-slate-500">Legend</p>
              <div className="space-y-1.5 font-medium">
                <p className="flex items-center gap-2">
                  <span className="inline-block h-3.5 w-3.5 rounded border border-green-700 bg-green-500/20" /> Ward / LGA boundary
                </p>
                <p className="flex items-center gap-2">
                  <span className="inline-block h-3.5 w-3.5 rounded border border-amber-700 bg-amber-500/35" /> Selected ward
                </p>
                <p className="flex items-center gap-2">
                  <span className="inline-block h-3.5 w-3.5 rounded border border-slate-800 bg-amber-500/40" /> Building footprint
                </p>
                <p className="flex items-center gap-2">
                  <span className="inline-block h-2.5 w-2.5 rounded-full bg-green-500 ring-2 ring-green-800/40" /> Selected building
                </p>
                <p className="flex items-center gap-2">
                  <span className="inline-block h-0.5 w-5 border-t-2 border-dashed border-green-800" /> State / LGA outline
                </p>
              </div>
              <div className="mt-2.5 flex gap-1.5">
                <span className="rounded-full bg-green-800 px-2 py-1 text-[10px] font-black uppercase tracking-wide text-white">GRID3</span>
                <span className="rounded-full bg-slate-100 px-2 py-1 text-[10px] font-bold text-slate-600 ring-1 ring-slate-200">Nominatim</span>
              </div>
            </div>

            {/* mobile hint */}
            <div className="absolute left-3 right-3 top-3 z-[400] rounded-xl bg-white/95 px-3 py-2 text-center text-xs font-semibold text-slate-700 shadow-lg ring-1 ring-slate-200 sm:hidden">
              Tap a ward to select it
            </div>

            {(loading || identifying) && (
              <div className="absolute inset-0 z-[500] flex items-center justify-center bg-white/55 backdrop-blur-[2px]">
                <div className="flex items-center gap-3 rounded-2xl bg-white px-5 py-3.5 text-sm font-bold text-slate-700 shadow-xl ring-1 ring-slate-200">
                  <LoaderCircle className="h-5 w-5 animate-spin text-green-700" />
                  {identifying ? "Identifying ward for this point…" : `Loading ${selLGA ? `wards for ${selLGA}` : "boundaries"}…`}
                </div>
              </div>
            )}
          </div>

          {/* bottom bar on map for quick context - visible on desktop */}
          <div className="hidden items-center justify-between gap-3 border-t border-slate-200 bg-white px-4 py-2.5 text-xs lg:flex">
            <p className="truncate font-medium text-slate-600">
              {marker ? (
                <>
                  <span className="font-black text-slate-800">{marker.label.split(",").slice(0, 2).join(",")}</span>
                  <span className="text-slate-400"> · {marker.lat.toFixed(5)}, {marker.lon.toFixed(5)}</span>
                </>
              ) : selWard ? (
                <>
                  Viewing <strong className="text-green-800">{selWard}</strong> ward in <strong>{selLGA}</strong>, {prettyState(selState)}
                </>
              ) : selLGA ? (
                <>
                  Viewing <strong>{selLGA}</strong> — {wards.length} wards
                </>
              ) : selState ? (
                <>
                  Viewing <strong>{prettyState(selState)}</strong> — {lgas.length} LGAs
                </>
              ) : (
                "Select a state to begin · 37 states · 774 LGAs · 9,410 wards"
              )}
            </p>
            <div className="flex shrink-0 items-center gap-2">
              <span className="rounded-full bg-slate-100 px-2.5 py-1 font-bold text-slate-600 ring-1 ring-slate-200">
                {primaryKind === "wards" ? `${meta?.count ?? wards.length} wards` : primaryKind === "lgas" ? `${meta?.count ?? lgas.length} LGAs` : "Nigeria"}
              </span>
              <span className="hidden text-slate-400 sm:inline">Nigeria · WGS84</span>
            </div>
          </div>
        </main>
      </div>

      <style>{`
        .nice-scroll::-webkit-scrollbar { width: 8px; }
        .nice-scroll::-webkit-scrollbar-track { background: transparent; }
        .nice-scroll::-webkit-scrollbar-thumb { background: #cbd5e1; border-radius: 999px; }
        .nice-scroll::-webkit-scrollbar-thumb:hover { background: #94a3b8; }
      `}</style>
    </div>
  );
}
