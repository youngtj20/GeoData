import { pool } from "../src/db.js";
import { buildingIdConfig } from "../src/buildingId.js";

// Renders buildings.building_code (denormalized text) from the permanent ward_id/building_seq values + the
// short codes on states_list/lgas_list/wards_list. Safe to re-run any time buildingIdConfig changes (e.g.
// toggling includeLga, or a different buildingCodeLength) — it only reformats the display string, never
// touches building_seq, so already-issued codes for a given config stay stable and only the FORMAT updates.
// Does the base32 encoding in SQL (not row-by-row in JS) since this touches up to 49M+ rows.
async function main() {
  await pool.query(`
    CREATE OR REPLACE FUNCTION base32_encode(n integer, len integer) RETURNS text AS $$
    DECLARE
      alphabet text := '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
      result text := '';
      v integer := n;
    BEGIN
      IF v = 0 THEN
        result := '0';
      END IF;
      WHILE v > 0 LOOP
        result := substr(alphabet, (v % 32) + 1, 1) || result;
        v := v / 32;
      END LOOP;
      RETURN lpad(result, len, '0');
    END;
    $$ LANGUAGE plpgsql IMMUTABLE;
  `);

  const segments: string[] = [];
  if (buildingIdConfig.includeState) segments.push("s.short_code");
  if (buildingIdConfig.includeLga) segments.push("l.short_code");
  if (buildingIdConfig.includeWard) segments.push("lpad(w.ward_number::text, 2, '0')");
  segments.push(`base32_encode(b.building_seq, ${buildingIdConfig.buildingCodeLength})`);
  const codeExpr = `concat_ws('-', ${segments.join(", ")})`;

  const { rows: states } = await pool.query(`SELECT DISTINCT state_name FROM wards_list ORDER BY state_name`);
  const overallStart = Date.now();
  let total = 0;
  for (const { state_name } of states) {
    const start = Date.now();
    const { rowCount } = await pool.query(
      `UPDATE buildings b
       SET building_code = ${codeExpr}
       FROM wards_list w
       JOIN lgas_list l ON l.state_name = w.state_name AND l.name = w.lga_name
       JOIN states_list s ON s.name = w.state_name
       WHERE b.ward_id = w.id AND b.building_seq IS NOT NULL AND w.state_name = $1`,
      [state_name]
    );
    total += rowCount ?? 0;
    console.log(`${state_name}: ${rowCount} codes written (${((Date.now() - start) / 1000).toFixed(1)}s) — ${total} total, ${((Date.now() - overallStart) / 1000).toFixed(0)}s elapsed`);
  }
  console.log(`Done. ${total} building codes generated using config:`, buildingIdConfig);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
