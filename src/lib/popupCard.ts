// Shared popup-card design — used by both MapboxMapView (mapbox-gl Popup) and MapView (Google Maps
// InfoWindow) so the two map providers render visually identical popups. The .cc-pop* CSS classes this
// markup relies on are global (src/index.css), not scoped to either map library.
import type { LandmarkCategory } from "./api";
import { LANDMARK_STYLES } from "./landmarkStyles";

export function escapeHtml(s: string): string {
  return s.replace(/</g, "&lt;");
}

export function hexToRgba(hex: string, alpha: number): string {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const n = parseInt(full, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

export const POPUP_ICON = (paths: string) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;

export const PIN_ICON_PATH =
  '<path d="M12 21s7-5.4 7-11a7 7 0 1 0-14 0c0 5.6 7 11 7 11Z"/><circle cx="12" cy="10" r="2.4"/>';
export const BUILDING_ICON_PATH =
  '<path d="M5 21V4.5A1.5 1.5 0 0 1 6.5 3h7A1.5 1.5 0 0 1 15 4.5V21"/><path d="M15 9h2.5A1.5 1.5 0 0 1 19 10.5V21"/><path d="M4 21h16"/><path d="M8.5 8h2.5M8.5 12h2.5M8.5 16h2.5"/>';
export const LANDMARK_ICON_PATHS: Record<LandmarkCategory, string> = {
  school: '<path d="M22 10 12 5 2 10l10 5 10-5Z"/><path d="M6 12v4.5c0 1.5 2.7 2.7 6 2.7s6-1.2 6-2.7V12"/>',
  church: '<path d="M12 2v6"/><path d="M9 5h6"/><path d="M6 21V11l6-3 6 3v10"/><path d="M4 21h16"/>',
  mosque: '<path d="M15.5 3.5a8.5 8.5 0 1 0 0 17 7 7 0 0 1 0-17Z"/>',
  market: '<path d="M6 7h12l1.1 13H4.9L6 7Z"/><path d="M9 7a3 3 0 0 1 6 0"/>',
  health_facility: '<path d="M12 21s-7-4.4-9.2-8.5A4.9 4.9 0 0 1 12 6.5a4.9 4.9 0 0 1 9.2 6C19 16.6 12 21 12 21Z"/>',
};

export function popupCard(opts: {
  title: string;
  pill?: string;
  meta?: string;
  mono?: string;
  badge?: string;
  icon?: string;
  accent?: string;
  footerCenter?: boolean;
}): string {
  const accent = opts.accent || "#15803d";
  const tint = hexToRgba(accent, 0.12);
  return `<div class="cc-pop${opts.footerCenter ? " cc-pop-fcenter" : ""}" style="border-color:${hexToRgba(accent, 0.5)}"><div class="cc-pop-top"><span style="background:${accent}"></span><span style="background:${hexToRgba(accent, 0.6)}"></span></div><div class="cc-pop-body"><div class="cc-pop-head">${opts.icon ? `<div class="cc-pop-icon" style="color:${accent};background:${tint}">${opts.icon}</div>` : ""}<div class="cc-pop-main"><div class="cc-pop-title">${opts.title}</div>${opts.pill ? `<span class="cc-pop-pill" style="color:${accent};background:${tint}">${opts.pill}</span>` : ""}</div></div>${opts.meta ? `<div class="cc-pop-meta">${opts.meta}</div>` : ""}${opts.mono ? `<div class="cc-pop-mono">${opts.mono}</div>` : ""}${opts.badge ? `<div class="cc-pop-badge" style="color:${accent};background:${tint}">${opts.badge}</div>` : ""}</div></div>`;
}

export function landmarkMeta(p: { ward?: unknown; lga?: unknown }): string {
  return [p.ward, p.lga].filter(Boolean).map((v) => escapeHtml(String(v))).join(", ");
}

export function landmarkPopup(p: { category?: LandmarkCategory; name?: unknown; ward?: unknown; lga?: unknown }): string {
  const style = p.category ? LANDMARK_STYLES[p.category] : undefined;
  return popupCard({
    title: escapeHtml(String(p.name || "Unnamed")),
    pill: style?.label,
    meta: landmarkMeta(p),
    icon: POPUP_ICON((p.category && LANDMARK_ICON_PATHS[p.category]) || PIN_ICON_PATH),
    accent: style?.color,
  });
}
