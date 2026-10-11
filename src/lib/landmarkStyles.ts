import type { LandmarkCategory } from "./api";

export const LANDMARK_STYLES: Record<LandmarkCategory, { label: string; color: string }> = {
  school: { label: "Schools", color: "#2563eb" },
  church: { label: "Churches", color: "#7c3aed" },
  mosque: { label: "Mosques", color: "#059669" },
  market: { label: "Markets", color: "#d97706" },
  health_facility: { label: "Health facilities", color: "#dc2626" },
};

export const LANDMARK_CATEGORY_ORDER: LandmarkCategory[] = ["school", "church", "mosque", "market", "health_facility"];
