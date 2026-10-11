// Strips a GeoPackage geometry blob's header down to the raw WKB payload PostGIS can parse directly.
// Format: 'G'(1) 'P'(1) version(1) flags(1) srs_id(int32) [envelope] wkb...
// flags bit0 = byte order, bits1-3 = envelope indicator (0/1/2/3/4 -> 0/32/48/48/64 bytes)
const ENVELOPE_BYTES = [0, 32, 48, 48, 64];

export function extractWKB(blob: Buffer): Buffer {
  if (blob[0] !== 0x47 || blob[1] !== 0x50) throw new Error("Not a GeoPackage geometry blob");
  const flags = blob[3];
  const envelopeCode = (flags >> 1) & 0x07;
  const envelopeSize = ENVELOPE_BYTES[envelopeCode] ?? 0;
  const headerSize = 8 + envelopeSize;
  return blob.subarray(headerSize);
}
