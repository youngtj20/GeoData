import { pool } from "../src/db.js";

// LGA codes only need to be unique WITHIN a state (the state short code already disambiguates nationally), so
// a per-state collision-resolving generator is enough — no national LGA registry exists to draw from like
// states have. Tries, in order: first 2 letters, first letter + each later letter, initials of first 2 words
// (for multi-word names), then first letter + digit as a last resort.
function cleanLetters(name: string): string {
  return name.toUpperCase().replace(/[^A-Z]/g, "");
}

function generateCode(name: string, used: Set<string>): string {
  const letters = cleanLetters(name);
  const candidates: string[] = [];
  if (letters.length >= 2) candidates.push(letters.slice(0, 2));
  for (let i = 2; i < letters.length; i++) candidates.push(letters[0] + letters[i]);
  const words = name.toUpperCase().split(/[^A-Z]+/).filter(Boolean);
  if (words.length >= 2) candidates.push(words[0][0] + words[1][0]);
  for (let d = 0; d <= 9; d++) candidates.push((letters[0] || "X") + d);
  for (const c of candidates) {
    if (c.length === 2 && !used.has(c)) return c;
  }
  throw new Error(`Could not generate a unique 2-char code for "${name}"`);
}

async function main() {
  const { rows: states } = await pool.query(`SELECT DISTINCT state_name FROM lgas_list ORDER BY state_name`);
  let total = 0;
  for (const { state_name } of states) {
    const { rows: lgas } = await pool.query(`SELECT id, name FROM lgas_list WHERE state_name = $1 ORDER BY name`, [state_name]);
    const used = new Set<string>();
    for (const lga of lgas) {
      const code = generateCode(lga.name, used);
      used.add(code);
      await pool.query(`UPDATE lgas_list SET short_code = $1 WHERE id = $2`, [code, lga.id]);
      total++;
    }
  }
  console.log(`Assigned short codes to ${total} LGAs across ${states.length} states`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
