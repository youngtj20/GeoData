import { useEffect, useRef, useState } from "react";
import { loadGoogleMaps } from "../lib/googleMaps";
import { LANDMARK_STYLES } from "../lib/landmarkStyles";

const NIGERIA_CENTER = { lat: 9.082, lng: 8.6753 };
// below this zoom, an Overpass query would cover too much area — buildings are hidden and a hint shown instead
export const MIN_BUILDING_ZOOM = 17;

function getFeatureName(props: any, kind: string | null) {
  if (!props) return "";
  if (kind === "wards") return String(props.wardname ?? "");
  if (kind === "lgas") return String(props.lganame ?? "");
  return String(props.wardname ?? props.lganame ?? props.statename ?? "");
}
function featureLatLon(f: any): { lat: number; lon: number } {
  const g = f.geometry;
  if (g.type === "Point") return { lon: g.coordinates[0], lat: g.coordinates[1] };
  const ring = (g.type === "MultiPolygon" ? g.coordinates[0][0] : g.coordinates[0]) as number[][];
  let sx = 0, sy = 0;
  for (const p of ring) { sx += p[0]; sy += p[1]; }
  return { lon: sx / ring.length, lat: sy / ring.length };
}
function escapeHtml(s: string) {
  return s.replace(/</g, "&lt;");
}
function boundsFromData(data: google.maps.Data): google.maps.LatLngBounds | null {
  const bounds = new google.maps.LatLngBounds();
  let has = false;
  data.forEach((f) => {
    f.getGeometry()?.forEachLatLng((ll) => { bounds.extend(ll); has = true; });
  });
  return has ? bounds : null;
}

export interface BuildingPick {
  id: string;
  lat: number;
  lon: number;
  label: string;
  buildingCode?: string | null;
}
export interface MapBounds {
  south: number;
  west: number;
  north: number;
  east: number;
}

export interface MapViewProps {
  primary: GeoJSON.FeatureCollection | null;
  primaryKind: "wards" | "lgas" | null;
  outline: GeoJSON.FeatureCollection | null;
  selectedName: string | null;
  marker: { lat: number; lon: number; label: string } | null;
  fitKey: number;
  focusKey: number;
  onFeatureClick: (name: string) => void;
  onMapClick: (lat: number, lon: number) => void;
  buildings?: GeoJSON.FeatureCollection | null;
  buildingPick?: BuildingPick | null;
  onBuildingPick?: (pick: BuildingPick, feature: any) => void;
  buildingMode?: boolean;
  onViewportChange?: (bounds: MapBounds | null, zoom: number) => void;
  // unlike onViewportChange, this fires on every idle regardless of zoom — landmarks are sparse points, useful
  // at much lower zoom than the building-footprint threshold, so the consumer picks its own zoom cutoff
  onLandmarkViewportChange?: (bounds: MapBounds, zoom: number) => void;
  showWards?: boolean;
  showBuildings?: boolean;
  showSettlements?: boolean;
  settlementBlocks?: GeoJSON.FeatureCollection | null;
  landmarks?: GeoJSON.FeatureCollection | null;
  onLandmarkClick?: (landmarkId: string) => void;
  landmarkBuilding?: GeoJSON.Feature | null;
  drawMode?: boolean;
  onPolygonDrawn?: (geometry: GeoJSON.Geometry) => void;
  pendingBuilding?: GeoJSON.Geometry | null;
  finishDrawKey?: number;
}

export default function MapView({
  primary,
  primaryKind,
  outline,
  selectedName,
  marker,
  fitKey,
  focusKey,
  onFeatureClick,
  onMapClick,
  buildings,
  buildingPick,
  onBuildingPick,
  buildingMode,
  onViewportChange,
  onLandmarkViewportChange,
  showWards = true,
  showBuildings = true,
  showSettlements = false,
  settlementBlocks,
  landmarks,
  onLandmarkClick,
  landmarkBuilding,
  drawMode,
  onPolygonDrawn,
  pendingBuilding,
  finishDrawKey,
}: MapViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<google.maps.Map | null>(null);
  const [ready, setReady] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const outlineDataRef = useRef<google.maps.Data | null>(null);
  const primaryDataRef = useRef<google.maps.Data | null>(null);
  const buildingsDataRef = useRef<google.maps.Data | null>(null);
  const settlementsDataRef = useRef<google.maps.Data | null>(null);
  const landmarksDataRef = useRef<google.maps.Data | null>(null);
  const landmarksFeatureMapRef = useRef<Map<google.maps.Data.Feature, any>>(new Map());
  const landmarkInfoRef = useRef<google.maps.InfoWindow | null>(null);
  const landmarkBuildingDataRef = useRef<google.maps.Data | null>(null);
  const pendingBuildingDataRef = useRef<google.maps.Data | null>(null);
  const primaryFeatureMapRef = useRef<Map<google.maps.Data.Feature, any>>(new Map());
  const primaryByNameRef = useRef<Map<string, google.maps.Data.Feature>>(new Map());
  const buildingFeatureMapRef = useRef<Map<google.maps.Data.Feature, any>>(new Map());

  const markerRef = useRef<google.maps.Marker | null>(null);
  const markerInfoRef = useRef<google.maps.InfoWindow | null>(null);
  const pickMarkerRef = useRef<google.maps.Marker | null>(null);
  const pickInfoRef = useRef<google.maps.InfoWindow | null>(null);
  const hoverInfoRef = useRef<google.maps.InfoWindow | null>(null);

  const clickGuardRef = useRef(0);
  const callbacksRef = useRef({ onFeatureClick, onMapClick, onBuildingPick, buildingMode, primaryKind, onViewportChange, onLandmarkViewportChange, onLandmarkClick, onPolygonDrawn, drawMode } as any);
  callbacksRef.current = { onFeatureClick, onMapClick, onBuildingPick, buildingMode, primaryKind, onViewportChange, onLandmarkViewportChange, onLandmarkClick, onPolygonDrawn, drawMode } as any;
  const drawingPolygonRef = useRef<google.maps.Polygon | null>(null);
  const drawingPathRef = useRef<google.maps.LatLng[]>([]);

  // init map (once)
  useEffect(() => {
    let cancelled = false;
    loadGoogleMaps()
      .then((g) => {
        if (cancelled || !containerRef.current || mapRef.current) return;
        const map = new g.maps.Map(containerRef.current, {
          center: NIGERIA_CENTER,
          zoom: 6,
          mapTypeControl: true,
          mapTypeControlOptions: { style: g.maps.MapTypeControlStyle.DROPDOWN_MENU },
          streetViewControl: false,
          fullscreenControl: false,
          scaleControl: true,
          clickableIcons: false,
        });
        mapRef.current = map;

        // lets a privileged user trace a missing building footprint by hand (see App.tsx's "Add building" flow).
        // Google's own DrawingManager was deprecated/removed as of Maps JS API v3.65 (this app loads "v: weekly",
        // so it's always on the latest release) — this is a minimal hand-rolled replacement: click to place each
        // vertex, a live Polygon overlay tracks progress, "Finish shape" (App.tsx, via finishDrawKey) closes it.
        const drawingPolygon = new g.maps.Polygon({
          fillColor: "#3b82f6", fillOpacity: 0.35, strokeColor: "#1d4ed8", strokeWeight: 2, clickable: false, zIndex: 50,
        });
        drawingPolygonRef.current = drawingPolygon;

        const outlineData = new g.maps.Data({ map });
        outlineData.setStyle({ strokeColor: "#166534", strokeWeight: 2.2, strokeOpacity: 0.92, fillOpacity: 0, clickable: false, zIndex: 1 } as any);
        outlineDataRef.current = outlineData;

        const primaryData = new g.maps.Data({ map });
        primaryDataRef.current = primaryData;

        const buildingsData = new g.maps.Data({ map });
        buildingsDataRef.current = buildingsData;

        const settlementsData = new g.maps.Data();
        settlementsData.setStyle({ strokeWeight: 0, fillColor: "#7c3aed", fillOpacity: 0.22, clickable: false, zIndex: 0 } as any);
        settlementsDataRef.current = settlementsData;

        const landmarksData = new g.maps.Data();
        landmarksDataRef.current = landmarksData;
        landmarkInfoRef.current = new g.maps.InfoWindow();
        landmarksData.addListener("click", (e: google.maps.Data.MouseEvent) => {
          const raw = landmarksFeatureMapRef.current.get(e.feature);
          if (!raw || !e.latLng) return;
          clickGuardRef.current = Date.now();
          const p = raw.properties || {};
          if (p.cluster) {
            // clusters stand in for many landmarks at once — clicking zooms in rather than showing a single name
            map.panTo(e.latLng);
            map.setZoom((map.getZoom() ?? 12) + 3);
            return;
          }
          const info = landmarkInfoRef.current!;
          info.setContent(
            `<div style="min-width:160px"><div style="font-weight:900;font-size:13px;color:#1c1917">${escapeHtml(String(p.name || "Unnamed"))}</div><div style="font-size:11px;color:#57534e;margin-top:2px">${escapeHtml(String(p.ward || ""))}${p.lga ? ", " + escapeHtml(String(p.lga)) : ""}</div></div>`
          );
          info.setPosition(e.latLng);
          info.open(map);
          // most landmarks already render as a real building (has_building) from the precomputed match — only
          // worth an extra on-demand lookup for the rare ones that don't have one baked in
          if (!p.has_building) callbacksRef.current.onLandmarkClick?.(String(p.id ?? ""));
        });

        const landmarkBuildingData = new g.maps.Data();
        landmarkBuildingData.setStyle({ strokeColor: "#1c1917", strokeWeight: 2.5, fillColor: "#fde047", fillOpacity: 0.55, clickable: false, zIndex: 7 } as any);
        landmarkBuildingDataRef.current = landmarkBuildingData;

        const pendingBuildingData = new g.maps.Data();
        pendingBuildingData.setStyle({ strokeColor: "#1d4ed8", strokeWeight: 2.5, fillColor: "#3b82f6", fillOpacity: 0.4, clickable: false, zIndex: 50 } as any);
        pendingBuildingDataRef.current = pendingBuildingData;

        hoverInfoRef.current = new g.maps.InfoWindow({ disableAutoPan: true });

        map.addListener("click", (e: google.maps.MapMouseEvent) => {
          if (Date.now() - clickGuardRef.current < 350 || !e.latLng) return;
          const cb = callbacksRef.current;
          if (cb.drawMode) {
            drawingPathRef.current = [...drawingPathRef.current, e.latLng];
            drawingPolygonRef.current?.setPath(drawingPathRef.current);
            return;
          }
          if (cb.buildingMode && typeof cb.onBuildingPick === "function") {
            const lat = e.latLng.lat(), lon = e.latLng.lng();
            cb.onBuildingPick({ id: `point/${lat.toFixed(6)}/${lon.toFixed(6)}`, lat, lon, label: `Point · ${lat.toFixed(6)}, ${lon.toFixed(6)}` }, null);
            return;
          }
          cb.onMapClick(e.latLng.lat(), e.latLng.lng());
        });

        map.addListener("idle", () => {
          const cb = callbacksRef.current;
          const zoom = map.getZoom() ?? 0;
          const b = map.getBounds();
          if (b && typeof cb.onLandmarkViewportChange === "function") {
            const ne = b.getNorthEast(), sw = b.getSouthWest();
            cb.onLandmarkViewportChange({ south: sw.lat(), west: sw.lng(), north: ne.lat(), east: ne.lng() }, zoom);
          }
          if (typeof cb.onViewportChange !== "function") return;
          if (zoom < MIN_BUILDING_ZOOM) { cb.onViewportChange(null, zoom); return; }
          if (!b) return;
          const ne = b.getNorthEast(), sw = b.getSouthWest();
          cb.onViewportChange({ south: sw.lat(), west: sw.lng(), north: ne.lat(), east: ne.lng() }, zoom);
        });

        setReady(true);
      })
      .catch((err) => setLoadError(err?.message || "Failed to load Google Maps"));
    return () => { cancelled = true; };
  }, []);

  // outline (state / LGA dashed boundary)
  useEffect(() => {
    const data = outlineDataRef.current;
    if (!data || !ready) return;
    data.forEach((f) => data.remove(f));
    if (outline) data.addGeoJson(outline as any);
  }, [outline, ready]);

  // admin-controlled visibility: ward/LGA layer (outline + primary polygons) on/off
  useEffect(() => {
    const map = mapRef.current;
    outlineDataRef.current?.setMap(showWards ? map : null);
    primaryDataRef.current?.setMap(showWards ? map : null);
  }, [showWards, ready]);

  // settlement density blocks — admin-toggleable overlay, independent of ward/building selection
  useEffect(() => {
    const data = settlementsDataRef.current;
    if (!data || !ready) return;
    data.forEach((f) => data.remove(f));
    if (settlementBlocks) data.addGeoJson(settlementBlocks as any);
  }, [settlementBlocks, ready]);

  useEffect(() => {
    settlementsDataRef.current?.setMap(showSettlements ? mapRef.current : null);
  }, [showSettlements, ready]);

  // landmarks (schools/churches/mosques/markets/health facilities) — a public, filterable POI layer, independent
  // of the admin-controlled ward/building/settlement layers above
  useEffect(() => {
    const data = landmarksDataRef.current;
    if (!data || !ready) return;
    data.forEach((f) => data.remove(f));
    landmarksFeatureMapRef.current = new Map();
    if (!landmarks) { data.setMap(null); return; }
    data.setMap(mapRef.current);
    const added = data.addGeoJson(landmarks as any);
    added.forEach((f, i) => landmarksFeatureMapRef.current.set(f, (landmarks.features as any[])[i]));
  }, [landmarks, ready]);

  useEffect(() => {
    const data = landmarksDataRef.current;
    if (!data || !ready) return;
    data.setStyle((feature) => {
      const raw = landmarksFeatureMapRef.current.get(feature);
      const props = raw?.properties || {};
      const category = props.category as keyof typeof LANDMARK_STYLES | undefined;
      const color = (category && LANDMARK_STYLES[category]?.color) || "#64748b";
      // most landmarks resolve to a real building footprint (precomputed — see matched_building_geom), so the
      // feature geometry itself is a polygon and needs fill/stroke styling, not a point icon. Landmarks with no
      // nearby building (rare — sparse/rural areas) stay as the fallback point dot.
      if (props.has_building) {
        return { fillColor: color, fillOpacity: 0.6, strokeColor: color, strokeWeight: 2, zIndex: 5 } as any;
      }
      // cluster dots grow with count (sqrt so area scales roughly linearly, not radius) so a cluster of thousands
      // doesn't dwarf the map, capped so it never overwhelms a small viewport
      const scale = props.cluster ? Math.min(8 + Math.sqrt(Number(props.count) || 1) * 1.6, 26) : 6;
      const icon: google.maps.Symbol = { path: google.maps.SymbolPath.CIRCLE, scale, fillColor: color, fillOpacity: props.cluster ? 0.75 : 0.95, strokeColor: "#fff", strokeWeight: props.cluster ? 2 : 1.3 };
      return { icon, zIndex: props.cluster ? 6 : 5 } as any;
    });
  }, [landmarks, ready]);

  // the real building footprint behind a clicked landmark (fetched on demand — see onLandmarkClick)
  useEffect(() => {
    const data = landmarkBuildingDataRef.current;
    if (!data || !ready) return;
    data.forEach((f) => data.remove(f));
    if (landmarkBuilding) data.addGeoJson(landmarkBuilding as any);
    data.setMap(landmarkBuilding ? mapRef.current : null);
  }, [landmarkBuilding, ready]);

  // the shape just traced by hand, awaiting save/cancel confirmation in the sidebar (see App.tsx's "Add building" flow)
  useEffect(() => {
    const data = pendingBuildingDataRef.current;
    if (!data || !ready) return;
    data.forEach((f) => data.remove(f));
    if (pendingBuilding) data.addGeoJson({ type: "Feature", properties: {}, geometry: pendingBuilding } as any);
    data.setMap(pendingBuilding ? mapRef.current : null);
  }, [pendingBuilding, ready]);

  // enter/exit polygon-drawing mode — reset to an empty in-progress shape either way, so re-entering draw mode
  // (or leaving it, e.g. on cancel) never carries over vertices from a previous attempt
  useEffect(() => {
    if (!ready) return;
    drawingPathRef.current = [];
    drawingPolygonRef.current?.setPath([]);
    drawingPolygonRef.current?.setMap(drawMode ? mapRef.current : null);
  }, [drawMode, ready]);

  // "Finish shape" — App.tsx increments finishDrawKey once the user has placed enough vertices
  useEffect(() => {
    if (!ready || !finishDrawKey) return;
    const path = drawingPathRef.current;
    if (path.length < 3) return;
    const coords: [number, number][] = path.map((ll) => [ll.lng(), ll.lat()]);
    coords.push(coords[0]);
    onPolygonDrawn?.({ type: "Polygon", coordinates: [coords] });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [finishDrawKey, ready]);

  // primary wards/LGAs — (re)build feature set
  useEffect(() => {
    const data = primaryDataRef.current;
    if (!data || !ready) return;
    data.forEach((f) => data.remove(f));
    primaryFeatureMapRef.current = new Map();
    primaryByNameRef.current = new Map();
    if (!primary || !primaryKind) return;
    const added = data.addGeoJson(primary as any);
    added.forEach((f, i) => {
      const raw = (primary.features as any[])[i];
      primaryFeatureMapRef.current.set(f, raw);
      const name = getFeatureName(raw.properties, primaryKind);
      if (name) primaryByNameRef.current.set(name, f);
    });
  }, [primary, primaryKind, ready]);

  // primary styling — selected ward/LGA highlighted; non-interactive while picking buildings
  useEffect(() => {
    const data = primaryDataRef.current;
    if (!data || !ready) return;
    const kind = primaryKind;
    const inPickMode = !!buildingMode;
    data.setStyle((feature) => {
      const raw = primaryFeatureMapRef.current.get(feature);
      const name = raw ? getFeatureName(raw.properties, kind) : "";
      const isSel = !!name && name === selectedName;
      if (isSel) {
        return { strokeColor: "#b45309", strokeWeight: 3, fillColor: "#f59e0b", fillOpacity: inPickMode ? 0.06 : 0.32, strokeOpacity: 1, clickable: !inPickMode, zIndex: 2 } as any;
      }
      return { strokeColor: "#15803d", strokeWeight: 1.35, fillColor: "#22c55e", fillOpacity: inPickMode ? 0.04 : 0.13, strokeOpacity: inPickMode ? 0.5 : 0.9, clickable: !inPickMode } as any;
    });
  }, [selectedName, buildingMode, primaryKind, ready, primary]);

  // primary hover/click — attached once, reads live refs so ward switching & drill-in keep working
  useEffect(() => {
    const data = primaryDataRef.current;
    const map = mapRef.current;
    if (!data || !map || !ready) return;
    const info = hoverInfoRef.current!;
    const overL = data.addListener("mouseover", (e: google.maps.Data.MouseEvent) => {
      if (callbacksRef.current.buildingMode || !e.latLng) return;
      const raw = primaryFeatureMapRef.current.get(e.feature);
      const name = raw ? getFeatureName(raw.properties, callbacksRef.current.primaryKind) : "";
      if (!name) return;
      info.setContent(name);
      info.setPosition(e.latLng);
      info.open(map);
    });
    const outL = data.addListener("mouseout", () => info.close());
    const clickL = data.addListener("click", (e: google.maps.Data.MouseEvent) => {
      const raw = primaryFeatureMapRef.current.get(e.feature);
      const name = raw ? getFeatureName(raw.properties, callbacksRef.current.primaryKind) : "";
      if (!name) return;
      clickGuardRef.current = Date.now();
      callbacksRef.current.onFeatureClick(name);
    });
    return () => {
      google.maps.event.removeListener(overL);
      google.maps.event.removeListener(outL);
      google.maps.event.removeListener(clickL);
    };
  }, [ready]);

  // building footprints — only rendered while buildingMode is on; feature set follows the viewport-scoped `buildings` prop
  useEffect(() => {
    const data = buildingsDataRef.current;
    if (!data || !ready) return;
    data.forEach((f) => data.remove(f));
    buildingFeatureMapRef.current = new Map();
    if (!buildings || !buildingMode || !showBuildings) return;
    const added = data.addGeoJson(buildings as any);
    added.forEach((f, i) => buildingFeatureMapRef.current.set(f, (buildings.features as any[])[i]));
  }, [buildings, buildingMode, showBuildings, ready]);

  // building styling — selected footprint highlighted in amber/gold
  useEffect(() => {
    const data = buildingsDataRef.current;
    if (!data || !ready) return;
    const selectedId = buildingPick?.id ?? null;
    data.setStyle((feature) => {
      const raw = buildingFeatureMapRef.current.get(feature);
      const id = raw ? String(raw.properties?.__id ?? "") : "";
      const sel = !!selectedId && id === selectedId;
      const icon: google.maps.Symbol = sel
        ? { path: google.maps.SymbolPath.CIRCLE, scale: 9, fillColor: "#22c55e", fillOpacity: 1, strokeColor: "#14532d", strokeWeight: 1.6 }
        : { path: google.maps.SymbolPath.CIRCLE, scale: 7, fillColor: "#fb923c", fillOpacity: 0.98, strokeColor: "#1e293b", strokeWeight: 1.1 };
      // a 1.1px dark stroke was designed for viewing a handful of buildings up close — at whole-ward scale, dense
      // wards can have tens of thousands of tiny polygons where the stroke visually dominates the amber fill,
      // making clusters look solid black instead of amber. Thinner stroke + higher fill opacity keeps the amber
      // legible at both zoom extremes. The selected building is green so it stands out clearly against the sea
      // of orange/amber unselected footprints.
      return sel
        ? ({ strokeColor: "#14532d", strokeWeight: 2.6, fillColor: "#22c55e", fillOpacity: 0.85, strokeOpacity: 1, zIndex: 10, icon } as any)
        : ({ strokeColor: "#9a3412", strokeWeight: 0.6, fillColor: "#fb923c", fillOpacity: 0.75, strokeOpacity: 0.9, icon } as any);
    });
  }, [buildingPick, buildings, ready]);

  // building click — attached once. No hover tooltip here on purpose: with tens of thousands of tiny, densely
  // packed footprints, a popup following the cursor on every mouseover covers the very buildings you're trying
  // to tell apart, making precise clicking harder rather than easier. The amber fill/outline is feedback enough;
  // clicking reveals full detail via the pick marker's own popup.
  useEffect(() => {
    const data = buildingsDataRef.current;
    const map = mapRef.current;
    if (!data || !map || !ready) return;
    const clickL = data.addListener("click", (e: google.maps.Data.MouseEvent) => {
      const raw = buildingFeatureMapRef.current.get(e.feature);
      if (!raw) return;
      clickGuardRef.current = Date.now();
      const id = String(raw.properties?.__id ?? "");
      const { lat, lon } = featureLatLon(raw);
      const label = raw.properties?.label || `Building ${id}`;
      callbacksRef.current.onBuildingPick?.({ id, lat, lon, label }, raw);
    });
    return () => {
      google.maps.event.removeListener(clickL);
    };
  }, [ready]);

  // crosshair cursor while picking buildings or tracing a new one
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    map.setOptions({ draggableCursor: buildingMode || drawMode ? "crosshair" : null } as any);
  }, [buildingMode, drawMode, ready]);

  // standard pin (geocode / resolve) — suppressed while a building is picked: handleBuildingPick() moves `marker`
  // to the same coordinates as buildingPick, so rendering both here would just stack a second, less detailed
  // popup (plain label only) directly on top of the pick marker's own popup (label + coordinates + WGS84 caption)
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    markerRef.current?.setMap(null);
    markerInfoRef.current?.close();
    markerRef.current = null;
    if (!marker || buildingPick) return;
    const m = new google.maps.Marker({
      map,
      position: { lat: marker.lat, lng: marker.lon },
      icon: {
        path: "M15 0C6.7 0 0 6.7 0 15c0 11.25 15 27 15 27s15-15.75 15-27C30 6.7 23.3 0 15 0z",
        fillColor: "#b45309",
        fillOpacity: 1,
        strokeColor: "#92400e",
        strokeWeight: 1,
        anchor: new google.maps.Point(15, 42),
      } as google.maps.Symbol,
      zIndex: 500,
    });
    const info = new google.maps.InfoWindow({ content: escapeHtml(marker.label) });
    info.open(map, m);
    markerRef.current = m;
    markerInfoRef.current = info;
  }, [marker, buildingPick, ready]);

  // building-pick marker — distinct amber dot, stays visible even if pick mode later toggled off
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    pickMarkerRef.current?.setMap(null);
    pickInfoRef.current?.close();
    pickMarkerRef.current = null;
    if (!buildingPick) return;
    const m = new google.maps.Marker({
      map,
      position: { lat: buildingPick.lat, lng: buildingPick.lon },
      icon: { path: google.maps.SymbolPath.CIRCLE, scale: 9, fillColor: "#22c55e", fillOpacity: 1, strokeColor: "#fff", strokeWeight: 2.5 },
      zIndex: 900,
    });
    const info = new google.maps.InfoWindow({
      content: `<div style="min-width:190px"><div style="font-weight:900;font-size:13px;color:#1c1917">${escapeHtml(String(buildingPick.label))}</div><div style="font-size:11px;color:#57534e;margin-top:3px;font-family:ui-monospace,monospace">${buildingPick.lat.toFixed(6)}, ${buildingPick.lon.toFixed(6)}</div><div style="font-size:11px;color:#15803d;margin-top:4px;font-weight:700">Building coordinate · WGS84</div></div>`,
    });
    info.open(map, m);
    pickMarkerRef.current = m;
    pickInfoRef.current = info;
    map.panTo({ lat: buildingPick.lat, lng: buildingPick.lon });
    if ((map.getZoom() ?? 18) < 18) map.setZoom(18);
  }, [buildingPick, ready]);

  // fit bounds
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || fitKey === 0) return;
    const primaryData = primaryDataRef.current;
    if (primaryData) {
      const b = boundsFromData(primaryData);
      if (b) { map.fitBounds(b, 40); return; }
    }
    const outlineData = outlineDataRef.current;
    if (outlineData) {
      const b = boundsFromData(outlineData);
      if (b) { map.fitBounds(b, 60); return; }
    }
    if (marker) { map.setCenter({ lat: marker.lat, lng: marker.lon }); map.setZoom(14); return; }
    map.setCenter(NIGERIA_CENTER);
    map.setZoom(6);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitKey, ready]);

  // focus selected ward/LGA
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || focusKey === 0 || !selectedName) return;
    const feature = primaryByNameRef.current.get(selectedName);
    if (!feature) return;
    const bounds = new google.maps.LatLngBounds();
    let has = false;
    feature.getGeometry()?.forEachLatLng((ll) => { bounds.extend(ll); has = true; });
    if (has) map.fitBounds(bounds, 60);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusKey, ready]);

  return (
    <div className="relative h-full w-full">
      <div ref={containerRef} className="h-full w-full" />
      {loadError && (
        <div className="absolute inset-0 z-[600] flex items-center justify-center bg-white/90 p-6 text-center text-sm font-semibold text-red-700">
          {loadError}
        </div>
      )}
    </div>
  );
}
