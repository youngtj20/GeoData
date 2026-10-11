// Human-readable building ID: STATE-LGA-WARD-SEQ (e.g. "FC-AM-07-7K42"). The format is configurable; only the
// last segment (a per-ward sequence number, persisted in buildings.building_seq / ward_building_counters and
// NEVER recalculated once assigned) is the actual identity. Everything else here is presentation.

// Crockford's Base32 — excludes I, L, O, U so the code can't be confused with 1/0 or misread aloud/on paper.
const BASE32_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export interface BuildingIdConfig {
  includeState: boolean;
  includeLga: boolean;
  includeWard: boolean;
  buildingCodeLength: number;
}

// change this to reconfigure the format nationwide — then re-run scripts/regenerate-building-codes.ts to
// re-render buildings.building_code from the permanent ward_id/building_seq values (no sequence reassignment)
export const buildingIdConfig: BuildingIdConfig = {
  includeState: true,
  includeLga: true,
  includeWard: true,
  buildingCodeLength: 4,
};

export function encodeBase32(n: number, length: number): string {
  if (!Number.isInteger(n) || n < 0) throw new Error(`encodeBase32: expected a non-negative integer, got ${n}`);
  let s = "";
  let v = n;
  do {
    s = BASE32_ALPHABET[v % 32] + s;
    v = Math.floor(v / 32);
  } while (v > 0);
  return s.padStart(length, "0");
}

export function formatWardNumber(n: number): string {
  return String(n).padStart(2, "0");
}

export interface BuildingCodeParts {
  stateShortCode?: string | null;
  lgaShortCode?: string | null;
  wardNumber?: number | null;
  buildingSeq: number;
}

export function generateBuildingCode(parts: BuildingCodeParts, config: BuildingIdConfig = buildingIdConfig): string {
  const segments: string[] = [];
  if (config.includeState && parts.stateShortCode) segments.push(parts.stateShortCode);
  if (config.includeLga && parts.lgaShortCode) segments.push(parts.lgaShortCode);
  if (config.includeWard && parts.wardNumber != null) segments.push(formatWardNumber(parts.wardNumber));
  segments.push(encodeBase32(parts.buildingSeq, config.buildingCodeLength));
  return segments.join("-");
}
