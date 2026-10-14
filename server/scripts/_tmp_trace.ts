import { pool } from "../src/db.js";
async function main() {
  // stage 2: did address-text matching find anything at all?
  const addr = await pool.query(
    `SELECT id, address, similarity(lower(address), lower($1)) AS sim
     FROM buildings WHERE address IS NOT NULL
     ORDER BY sim DESC LIMIT 5`,
    ["Avali2datedAvenue 3, Off Opebi Road by T junction"]
  );
  console.log("address-text candidates (any buildings.address at all):", JSON.stringify(addr.rows));

  // stage 3: did landmark matching find anything close to "Oppo2site Zenith Bank" in Lagos/Ikeja?
  const lm = await pool.query(
    `SELECT id, name, category, similarity(lower(name), lower($1)) AS sim
     FROM landmarks
     WHERE lower(state_name) = lower($2) AND lower(lga_name) = lower($3)
     ORDER BY sim DESC LIMIT 5`,
    ["Oppo2site Zenith Bank", "Lagos", "Ikeja"]
  );
  console.log("landmark candidates in Lagos/Ikeja, ranked by similarity to 'Oppo2site Zenith Bank':", JSON.stringify(lm.rows));

  // what categories of landmark exist at all?
  const cats = await pool.query(`SELECT DISTINCT category FROM landmarks`);
  console.log("landmark categories that exist in the dataset:", JSON.stringify(cats.rows));

  await pool.end();
}
main();
