import { useEffect, useRef, useState } from "react";
import mapboxgl from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";
import type { BuildingPick, MapBounds } from "./MapView";
import { MIN_BUILDING_ZOOM } from "./MapView";
import { LANDMARK_STYLES } from "../lib/landmarkStyles";
import type { LandmarkCategory } from "../lib/api";

const NIGERIA_CENTER: [number, number] = [8.6753, 9.082];
const MAPBOX_TOKEN = import.meta.env.VITE_MAPBOX_TOKEN as string | undefined;

const OSM_STYLE: mapboxgl.StyleSpecification = {
  version: 8,
  sources: {
    osm: {
      type: "raster",
      tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
      tileSize: 256,
      maxzoom: 19,
      attribution: "© OpenStreetMap contributors",
    },
  },
  glyphs: MAPBOX_TOKEN
    ? "mapbox://fonts/mapbox/{fontstack}/{range}.pbf"
    : "https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf",
  layers: [{ id: "osm", type: "raster", source: "osm" }],
};
const MAPBOX_STYLE = "mapbox://styles/mapbox/light-v11";

function getFeatureName(props: any, kind: string | null) {
  if (!props) return "";
  if (kind === "wards") return String(props.wardname ?? "");
  if (kind === "lgas") return String(props.lganame ?? "");
  return String(props.wardname ?? props.lganame ?? props.statename ?? "");
}
function escapeHtml(s: string) {
  return s.replace(/</g, "&lt;");
}
function hexToRgba(hex: string, alpha: number) {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const n = parseInt(full, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}
const POPUP_ICON = (paths: string) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
const PIN_ICON_PATH =
  '<path d="M12 21s7-5.4 7-11a7 7 0 1 0-14 0c0 5.6 7 11 7 11Z"/><circle cx="12" cy="10" r="2.4"/>';
const BUILDING_ICON_PATH =
  '<path d="M5 21V4.5A1.5 1.5 0 0 1 6.5 3h7A1.5 1.5 0 0 1 15 4.5V21"/><path d="M15 9h2.5A1.5 1.5 0 0 1 19 10.5V21"/><path d="M4 21h16"/><path d="M8.5 8h2.5M8.5 12h2.5M8.5 16h2.5"/>';
const LANDMARK_ICON_PATHS: Record<LandmarkCategory, string> = {
  school: '<path d="M22 10 12 5 2 10l10 5 10-5Z"/><path d="M6 12v4.5c0 1.5 2.7 2.7 6 2.7s6-1.2 6-2.7V12"/>',
  church: '<path d="M12 2v6"/><path d="M9 5h6"/><path d="M6 21V11l6-3 6 3v10"/><path d="M4 21h16"/>',
  mosque: '<path d="M15.5 3.5a8.5 8.5 0 1 0 0 17 7 7 0 0 1 0-17Z"/>',
  market: '<path d="M6 7h12l1.1 13H4.9L6 7Z"/><path d="M9 7a3 3 0 0 1 6 0"/>',
  health_facility: '<path d="M12 21s-7-4.4-9.2-8.5A4.9 4.9 0 0 1 12 6.5a4.9 4.9 0 0 1 9.2 6C19 16.6 12 21 12 21Z"/>',
};
function popupCard(opts: { title: string; pill?: string; meta?: string; mono?: string; badge?: string; icon?: string; accent?: string; footerCenter?: boolean }) {
  const accent = opts.accent || "#15803d";
  const tint = hexToRgba(accent, 0.12);
  return `<div class="cc-pop${opts.footerCenter ? " cc-pop-fcenter" : ""}" style="border-color:${hexToRgba(accent, 0.5)}"><div class="cc-pop-top"><span style="background:${accent}"></span><span style="background:${hexToRgba(accent, 0.6)}"></span></div><div class="cc-pop-body"><div class="cc-pop-head">${opts.icon ? `<div class="cc-pop-icon" style="color:${accent};background:${tint}">${opts.icon}</div>` : ""}<div class="cc-pop-main"><div class="cc-pop-title">${opts.title}</div>${opts.pill ? `<span class="cc-pop-pill" style="color:${accent};background:${tint}">${opts.pill}</span>` : ""}</div></div>${opts.meta ? `<div class="cc-pop-meta">${opts.meta}</div>` : ""}${opts.mono ? `<div class="cc-pop-mono">${opts.mono}</div>` : ""}${opts.badge ? `<div class="cc-pop-badge" style="color:${accent};background:${tint}">${opts.badge}</div>` : ""}</div></div>`;
}
function landmarkMeta(p: { ward?: unknown; lga?: unknown }) {
  return [p.ward, p.lga].filter(Boolean).map((v) => escapeHtml(String(v))).join(", ");
}
function landmarkPopup(p: { category?: LandmarkCategory; name?: unknown; ward?: unknown; lga?: unknown }) {
  const style = p.category ? LANDMARK_STYLES[p.category] : undefined;
  return popupCard({
    title: escapeHtml(String(p.name || "Unnamed")),
    pill: style?.label,
    meta: landmarkMeta(p),
    icon: POPUP_ICON((p.category && LANDMARK_ICON_PATHS[p.category]) || PIN_ICON_PATH),
    accent: style?.color,
  });
}
function bboxOfFC(fc: GeoJSON.FeatureCollection | GeoJSON.Feature | null | undefined): mapboxgl.LngLatBoundsLike | null {
  if (!fc) return null;
  let south = Infinity, west = Infinity, north = -Infinity, east = -Infinity;
  let has = false;
  const visit = (coords: any) => {
    if (typeof coords[0] === "number") {
      const [lon, lat] = coords;
      if (lat < south) south = lat;
      if (lat > north) north = lat;
      if (lon < west) west = lon;
      if (lon > east) east = lon;
      has = true;
    } else {
      for (const c of coords) visit(c);
    }
  };
  const features = fc.type === "FeatureCollection" ? fc.features : [fc];
  for (const f of features) visit((f.geometry as any).coordinates);
  return has ? [[west, south], [east, north]] : null;
}

export interface MapboxMapViewProps {
  provider: "mapbox" | "osm";
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

const emptyFC: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };

export default function MapboxMapView({
  provider,
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
}: MapboxMapViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const [ready, setReady] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const markerElRef = useRef<mapboxgl.Marker | null>(null);
  const pickMarkerElRef = useRef<mapboxgl.Marker | null>(null);
  const clickGuardRef = useRef(0);
  const callbacksRef = useRef({ onFeatureClick, onMapClick, onBuildingPick, buildingMode, primaryKind, onViewportChange, onLandmarkViewportChange, onLandmarkClick, drawMode } as any);
  callbacksRef.current = { onFeatureClick, onMapClick, onBuildingPick, buildingMode, primaryKind, onViewportChange, onLandmarkViewportChange, onLandmarkClick, drawMode } as any;
  const drawingPathRef = useRef<[number, number][]>([]);

  // init map (once per provider — rebuild if switching mapbox <-> osm since the style is fundamentally different)
  useEffect(() => {
    if (!containerRef.current) return;
    if (provider === "mapbox" && !MAPBOX_TOKEN) {
      setLoadError("VITE_MAPBOX_TOKEN is not set — add it to .env.local");
      return;
    }
    mapboxgl.accessToken = MAPBOX_TOKEN || "";
    const map = new mapboxgl.Map({
      container: containerRef.current,
      style: provider === "osm" ? OSM_STYLE : MAPBOX_STYLE,
      center: NIGERIA_CENTER,
      zoom: 5.5,
    });
    mapRef.current = map;

    map.on("load", () => {
      map.addSource("outline", { type: "geojson", data: emptyFC });
      map.addLayer({ id: "outline-line", type: "line", source: "outline", paint: { "line-color": "#166534", "line-width": 2.2, "line-opacity": 0.92 } });

      map.addSource("primary", { type: "geojson", data: emptyFC });
      map.addLayer({ id: "primary-fill", type: "fill", source: "primary", paint: { "fill-color": "#22c55e", "fill-opacity": 0.13 } });
      map.addLayer({ id: "primary-line", type: "line", source: "primary", paint: { "line-color": "#15803d", "line-width": 1.35, "line-opacity": 0.9 } });

      map.addSource("settlements", { type: "geojson", data: emptyFC });
      map.addLayer({ id: "settlements-fill", type: "fill", source: "settlements", layout: { visibility: "none" }, paint: { "fill-color": "#7c3aed", "fill-opacity": 0.22 } });

      map.addSource("buildings", { type: "geojson", data: emptyFC });
      map.addLayer({
        id: "buildings-fill",
        type: "fill",
        source: "buildings",
        layout: { visibility: "none" },
        paint: { "fill-color": "#fb923c", "fill-opacity": 0.75 },
      });
      map.addLayer({
        id: "buildings-line",
        type: "line",
        source: "buildings",
        layout: { visibility: "none" },
        paint: { "line-color": "#9a3412", "line-width": 0.6, "line-opacity": 0.9 },
      });

      const landmarkColorExpr: any = ["match", ["get", "category"]];
      for (const [cat, style] of Object.entries(LANDMARK_STYLES)) landmarkColorExpr.push(cat, style.color);
      landmarkColorExpr.push("#64748b");
      map.addSource("landmarks", { type: "geojson", data: emptyFC });
      // most landmarks resolve to a real building footprint (precomputed — see matched_building_geom on the
      // server), so the source mixes Polygon and Point features. Mapbox routes each feature to the layer whose
      // type matches its geometry automatically — fill/line only ever draw the polygon ones, circle only the
      // point ones (landmarks with no nearby building, or synthetic cluster centroids) — no manual filtering needed.
      map.addLayer({
        id: "landmarks-fill",
        type: "fill",
        source: "landmarks",
        paint: { "fill-color": landmarkColorExpr, "fill-opacity": 0.6 },
      });
      map.addLayer({
        id: "landmarks-line",
        type: "line",
        source: "landmarks",
        paint: { "line-color": landmarkColorExpr, "line-width": 2 },
      });
      map.addLayer({
        id: "landmarks-circle",
        type: "circle",
        source: "landmarks",
        paint: {
          // cluster dots grow with count (sqrt so area scales roughly linearly), capped so a huge cluster never
          // dwarfs the map; individual (non-cluster) landmarks stay a fixed small size
          "circle-radius": ["case", ["get", "cluster"], ["min", ["+", 8, ["*", 1.6, ["sqrt", ["get", "count"]]]], 26], 6],
          "circle-color": landmarkColorExpr,
          "circle-opacity": ["case", ["get", "cluster"], 0.75, 0.95],
          "circle-stroke-width": ["case", ["get", "cluster"], 2, 1.3],
          "circle-stroke-color": "#ffffff",
        },
      });
      map.addLayer({
        id: "landmarks-count",
        type: "symbol",
        source: "landmarks",
        filter: ["==", ["get", "cluster"], true],
        layout: { "text-field": ["to-string", ["get", "count"]], "text-size": 11, "text-allow-overlap": true },
        paint: { "text-color": "#ffffff" },
      });
      map.on("click", "landmarks-circle", (e) => {
        const f = e.features?.[0];
        if (!f) return;
        clickGuardRef.current = Date.now();
        const p = f.properties || {};
        if (p.cluster) {
          // clusters stand in for many landmarks at once — clicking zooms in rather than showing a single name
          map.easeTo({ center: e.lngLat, zoom: map.getZoom() + 3 });
          return;
        }
        new mapboxgl.Popup({ offset: 12 })
          .setLngLat(e.lngLat)
          .setHTML(landmarkPopup(p))
          .addTo(map);
        callbacksRef.current.onLandmarkClick?.(String(p.id ?? ""));
      });
      map.on("mouseenter", "landmarks-circle", () => { map.getCanvas().style.cursor = "pointer"; });
      map.on("mouseleave", "landmarks-circle", () => { map.getCanvas().style.cursor = ""; });

      map.on("click", "landmarks-fill", (e) => {
        const f = e.features?.[0];
        if (!f) return;
        clickGuardRef.current = Date.now();
        const p = f.properties || {};
        new mapboxgl.Popup({ offset: 12 })
          .setLngLat(e.lngLat)
          .setHTML(landmarkPopup(p))
          .addTo(map);
        // already rendering the real building footprint — no on-demand lookup needed, unlike landmarks-circle
      });
      map.on("mouseenter", "landmarks-fill", () => { map.getCanvas().style.cursor = "pointer"; });
      map.on("mouseleave", "landmarks-fill", () => { map.getCanvas().style.cursor = ""; });

      map.addSource("landmark-building", { type: "geojson", data: emptyFC });
      map.addLayer({ id: "landmark-building-fill", type: "fill", source: "landmark-building", paint: { "fill-color": "#fde047", "fill-opacity": 0.55 } });
      map.addLayer({ id: "landmark-building-line", type: "line", source: "landmark-building", paint: { "line-color": "#1c1917", "line-width": 2.5 } });

      // lets a privileged user trace a missing building footprint by hand (see App.tsx's "Add building" flow) —
      // click to place each vertex (accumulated in drawingPathRef), live polygon preview here; "drawing" is the
      // in-progress shape, "pending-building" is the same shape after "Finish" but before save/cancel confirmation
      map.addSource("drawing", { type: "geojson", data: emptyFC });
      map.addLayer({ id: "drawing-fill", type: "fill", source: "drawing", paint: { "fill-color": "#3b82f6", "fill-opacity": 0.35 } });
      map.addLayer({ id: "drawing-line", type: "line", source: "drawing", paint: { "line-color": "#1d4ed8", "line-width": 2 } });
      map.addSource("pending-building", { type: "geojson", data: emptyFC });
      map.addLayer({ id: "pending-building-fill", type: "fill", source: "pending-building", paint: { "fill-color": "#3b82f6", "fill-opacity": 0.35 } });
      map.addLayer({ id: "pending-building-line", type: "line", source: "pending-building", paint: { "line-color": "#1d4ed8", "line-width": 2 } });
      map.on("click", "landmarks-count", (e) => {
        const f = e.features?.[0];
        if (!f) return;
        clickGuardRef.current = Date.now();
        map.easeTo({ center: e.lngLat, zoom: map.getZoom() + 3 });
      });

      map.on("click", "primary-fill", (e) => {
        if (callbacksRef.current.buildingMode) return;
        const f = e.features?.[0];
        const name = f ? getFeatureName(f.properties, callbacksRef.current.primaryKind) : "";
        if (!name) return;
        clickGuardRef.current = Date.now();
        callbacksRef.current.onFeatureClick(name);
      });
      map.on("mouseenter", "primary-fill", () => { map.getCanvas().style.cursor = "pointer"; });
      map.on("mouseleave", "primary-fill", () => { map.getCanvas().style.cursor = ""; });

      map.on("click", "buildings-fill", (e) => {
        const f = e.features?.[0];
        if (!f) return;
        clickGuardRef.current = Date.now();
        const id = String(f.properties?.__id ?? "");
        const label = f.properties?.label || `Building ${id}`;
        const center = e.lngLat;
        callbacksRef.current.onBuildingPick?.({ id, lat: center.lat, lon: center.lng, label }, f);
      });

      map.on("click", (e) => {
        if (Date.now() - clickGuardRef.current < 350) return;
        const cb = callbacksRef.current;
        if (cb.drawMode) {
          drawingPathRef.current = [...drawingPathRef.current, [e.lngLat.lng, e.lngLat.lat]];
          const path = drawingPathRef.current;
          const data: GeoJSON.FeatureCollection =
            path.length >= 3
              ? { type: "FeatureCollection", features: [{ type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [[...path, path[0]]] } }] }
              : emptyFC;
          (map.getSource("drawing") as mapboxgl.GeoJSONSource | undefined)?.setData(data);
          return;
        }
        const hit = map.queryRenderedFeatures(e.point, { layers: ["primary-fill", "buildings-fill", "landmarks-circle", "landmarks-count", "landmarks-fill"] });
        if (hit.length) return; // handled by the layer-specific click handlers above
        if (cb.buildingMode && typeof cb.onBuildingPick === "function") {
          const { lat, lng } = e.lngLat;
          cb.onBuildingPick({ id: `point/${lat.toFixed(6)}/${lng.toFixed(6)}`, lat, lon: lng, label: `Point · ${lat.toFixed(6)}, ${lng.toFixed(6)}` }, null);
          return;
        }
        cb.onMapClick(e.lngLat.lat, e.lngLat.lng);
      });

      map.on("moveend", () => {
        const cb = callbacksRef.current;
        const zoom = map.getZoom();
        const b = map.getBounds();
        if (b && typeof cb.onLandmarkViewportChange === "function") {
          cb.onLandmarkViewportChange({ south: b.getSouth(), west: b.getWest(), north: b.getNorth(), east: b.getEast() }, zoom);
        }
        if (typeof cb.onViewportChange !== "function") return;
        if (zoom < MIN_BUILDING_ZOOM) { cb.onViewportChange(null, zoom); return; }
        if (!b) return;
        cb.onViewportChange({ south: b.getSouth(), west: b.getWest(), north: b.getNorth(), east: b.getEast() }, zoom);
      });

      setReady(true);
    });
    map.on("error", (e) => setLoadError(e.error?.message || "Failed to load Mapbox"));

    // Mapbox GL measures its container once at construction time. On the mobile layout (flex `order`
    // reordering, vh-based heights) that size isn't always settled yet at that exact moment — without this,
    // the canvas can get stuck rendering at the browser's default size (observed: stuck at 300px tall
    // regardless of the container's real height) even though the container itself is sized correctly.
    const resizeObserver = new ResizeObserver(() => map.resize());
    resizeObserver.observe(containerRef.current);

    return () => {
      resizeObserver.disconnect();
      map.remove();
      mapRef.current = null;
      setReady(false);
    };
  }, [provider]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    (map.getSource("outline") as mapboxgl.GeoJSONSource | undefined)?.setData(outline || emptyFC);
  }, [outline, ready]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    (map.getSource("landmarks") as mapboxgl.GeoJSONSource | undefined)?.setData(landmarks || emptyFC);
  }, [landmarks, ready]);

  // the real building footprint behind a clicked landmark (fetched on demand — see onLandmarkClick)
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const fc: GeoJSON.FeatureCollection = landmarkBuilding ? { type: "FeatureCollection", features: [landmarkBuilding] } : emptyFC;
    (map.getSource("landmark-building") as mapboxgl.GeoJSONSource | undefined)?.setData(fc);
  }, [landmarkBuilding, ready]);

  // the shape just traced by hand, awaiting save/cancel confirmation in the sidebar (see App.tsx's "Add building" flow)
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const fc: GeoJSON.FeatureCollection = pendingBuilding ? { type: "FeatureCollection", features: [{ type: "Feature", properties: {}, geometry: pendingBuilding }] } : emptyFC;
    (map.getSource("pending-building") as mapboxgl.GeoJSONSource | undefined)?.setData(fc);
  }, [pendingBuilding, ready]);

  // enter/exit polygon-drawing mode — reset to an empty in-progress shape either way, so re-entering draw mode
  // (or leaving it, e.g. on cancel) never carries over vertices from a previous attempt
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    drawingPathRef.current = [];
    (map.getSource("drawing") as mapboxgl.GeoJSONSource | undefined)?.setData(emptyFC);
  }, [drawMode, ready]);

  // "Finish shape" — App.tsx increments finishDrawKey once the user has placed enough vertices
  useEffect(() => {
    if (!ready || !finishDrawKey) return;
    const path = drawingPathRef.current;
    if (path.length < 3) return;
    onPolygonDrawn?.({ type: "Polygon", coordinates: [[...path, path[0]]] });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [finishDrawKey, ready]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    (map.getSource("primary") as mapboxgl.GeoJSONSource | undefined)?.setData(primary || emptyFC);
    map.setLayoutProperty("primary-fill", "visibility", showWards ? "visible" : "none");
    map.setLayoutProperty("primary-line", "visibility", showWards ? "visible" : "none");
  }, [primary, showWards, ready]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const nameExpr: any = primaryKind === "lgas" ? ["get", "lganame"] : ["get", "wardname"];
    const inPick = !!buildingMode;
    map.setPaintProperty("primary-fill", "fill-color", ["case", ["==", nameExpr, selectedName ?? " "], "#f59e0b", "#22c55e"]);
    map.setPaintProperty("primary-fill", "fill-opacity", ["case", ["==", nameExpr, selectedName ?? " "], inPick ? 0.06 : 0.32, inPick ? 0.04 : 0.13]);
    map.setPaintProperty("primary-line", "line-color", ["case", ["==", nameExpr, selectedName ?? " "], "#b45309", "#15803d"]);
    map.setPaintProperty("primary-line", "line-width", ["case", ["==", nameExpr, selectedName ?? " "], 3, 1.35]);
  }, [selectedName, buildingMode, primaryKind, ready]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    (map.getSource("settlements") as mapboxgl.GeoJSONSource | undefined)?.setData(settlementBlocks || emptyFC);
    map.setLayoutProperty("settlements-fill", "visibility", showSettlements ? "visible" : "none");
  }, [settlementBlocks, showSettlements, ready]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const data = buildingMode && showBuildings ? buildings || emptyFC : emptyFC;
    (map.getSource("buildings") as mapboxgl.GeoJSONSource | undefined)?.setData(data);
    const visible = buildingMode && showBuildings ? "visible" : "none";
    map.setLayoutProperty("buildings-fill", "visibility", visible);
    map.setLayoutProperty("buildings-line", "visibility", visible);
  }, [buildings, buildingMode, showBuildings, ready]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const selectedId = buildingPick?.id ?? " ";
    map.setPaintProperty("buildings-fill", "fill-color", ["case", ["==", ["get", "__id"], selectedId], "#22c55e", "#fb923c"]);
    map.setPaintProperty("buildings-line", "line-color", ["case", ["==", ["get", "__id"], selectedId], "#14532d", "#9a3412"]);
    map.setPaintProperty("buildings-line", "line-width", ["case", ["==", ["get", "__id"], selectedId], 2.6, 0.6]);
  }, [buildingPick, ready]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    map.getCanvas().style.cursor = buildingMode || drawMode ? "crosshair" : "";
  }, [buildingMode, drawMode, ready]);

  // standard pin (geocode / resolve) — suppressed while a building is picked, mirrors MapView's Google renderer
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    markerElRef.current?.remove();
    markerElRef.current = null;
    if (!marker || buildingPick) return;
    const popup = new mapboxgl.Popup({ offset: 24 }).setHTML(
      popupCard({ title: escapeHtml(marker.label), icon: POPUP_ICON(PIN_ICON_PATH), accent: "#b45309", pill: "Location" })
    );
    const m = new mapboxgl.Marker({ color: "#b45309" }).setLngLat([marker.lon, marker.lat]).setPopup(popup).addTo(map);
    m.togglePopup();
    markerElRef.current = m;
  }, [marker, buildingPick, ready]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    pickMarkerElRef.current?.remove();
    pickMarkerElRef.current = null;
    if (!buildingPick) return;
    const popup = new mapboxgl.Popup({ offset: 14 }).setHTML(
      popupCard({
        title: buildingPick.buildingCode
          ? `<span class="cc-pop-kicker">Building ID:</span><span class="cc-pop-code">${escapeHtml(String(buildingPick.buildingCode))}</span>`
          : escapeHtml(String(buildingPick.label)),
        icon: POPUP_ICON(BUILDING_ICON_PATH),
        accent: "#15803d",
        footerCenter: true,
        mono: `${buildingPick.lat.toFixed(6)}, ${buildingPick.lon.toFixed(6)}`,
        badge: "WGS84",
      })
    );
    const m = new mapboxgl.Marker({ color: "#22c55e" }).setLngLat([buildingPick.lon, buildingPick.lat]).setPopup(popup).addTo(map);
    m.togglePopup();
    pickMarkerElRef.current = m;
    map.easeTo({ center: [buildingPick.lon, buildingPick.lat], zoom: Math.max(map.getZoom(), 18) });
  }, [buildingPick, ready]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || fitKey === 0) return;
    const b = bboxOfFC(primary) || bboxOfFC(outline);
    if (b) { map.fitBounds(b, { padding: 50 }); return; }
    if (marker) { map.setCenter([marker.lon, marker.lat]); map.setZoom(14); return; }
    map.setCenter(NIGERIA_CENTER);
    map.setZoom(5.5);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitKey, ready]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || focusKey === 0 || !selectedName || !primary) return;
    const nameOf = (f: any) => getFeatureName(f.properties, primaryKind);
    const feature = (primary.features as any[]).find((f) => nameOf(f) === selectedName);
    const b = feature ? bboxOfFC(feature) : null;
    if (b) map.fitBounds(b, { padding: 60 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusKey, ready]);

  return (
    // absolute inset-0 (not h-full w-full), on both this div and the inner one — the parent is a flex-grown
    // container, and percentage heights don't resolve against a flex-grown parent's computed height (only an
    // explicitly-set one); absolute positioning against the parent's already-`relative` box works regardless.
    // Without this, Mapbox GL measures a 0-height container and gets stuck rendering at its default canvas size.
    <div className="agon-map absolute inset-0">
      {/* h-full w-full (not absolute inset-0) — mapbox-gl.css itself sets .mapboxgl-map { position: relative },
          which wins the cascade over any "absolute" utility at equal specificity, so inset-0 would do nothing
          here anyway. That's fine: the parent above is now genuinely definite-height (absolute+inset, not
          flex-grow-derived), so percentage height correctly resolves against it. */}
      <div ref={containerRef} className="h-full w-full" />
      {loadError && (
        <div className="absolute inset-0 z-[600] flex items-center justify-center bg-white/90 p-6 text-center text-sm font-semibold text-red-700">
          {loadError}
        </div>
      )}
    </div>
  );
}
