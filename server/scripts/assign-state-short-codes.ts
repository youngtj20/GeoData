import { pool } from "../src/db.js";

// standard 2-letter Nigerian state abbreviations (the same ones used on NYSC call-up numbers), matching the
// user's own example format (FC = FCT). Chosen over GRID3's sparse/inconsistent `code` column.
const STATE_SHORT_CODES: Record<string, string> = {
  Abia: "AB", Adamawa: "AD", "Akwa Ibom": "AK", Anambra: "AN", Bauchi: "BA", Bayelsa: "BY", Benue: "BE",
  Borno: "BO", "Cross River": "CR", Delta: "DE", Ebonyi: "EB", Edo: "ED", Ekiti: "EK", Enugu: "EN", Fct: "FC",
  Gombe: "GO", Imo: "IM", Jigawa: "JI", Kaduna: "KD", Kano: "KN", Katsina: "KT", Kebbi: "KB", Kogi: "KO",
  Kwara: "KW", Lagos: "LA", Nasarawa: "NA", Niger: "NI", Ogun: "OG", Ondo: "ON", Osun: "OS", Oyo: "OY",
  Plateau: "PL", Rivers: "RI", Sokoto: "SO", Taraba: "TA", Yobe: "YO", Zamfara: "ZA",
};

async function main() {
  const { rows } = await pool.query(`SELECT id, name FROM states_list`);
  let updated = 0;
  for (const r of rows) {
    const code = STATE_SHORT_CODES[r.name];
    if (!code) {
      console.warn(`No short code mapped for state "${r.name}" — skipping`);
      continue;
    }
    await pool.query(`UPDATE states_list SET short_code = $1 WHERE id = $2`, [code, r.id]);
    updated++;
  }
  console.log(`Assigned short codes to ${updated}/${rows.length} states`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
