import { chromium, devices } from "playwright";
const dir = "C:/Users/talk2/AppData/Local/Temp/claude/c--Users-talk2-OneDrive-Desktop-agon-agent-1-2c00d686/9432e284-f30f-4f53-83c5-9e624549227f/scratchpad";
const URL = "http://localhost:5173/";

async function run(label, contextOptions, extraArgs = []) {
  const browser = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-webgl", "--ignore-gpu-blocklist", ...extraArgs] });
  const page = await browser.newPage(contextOptions);
  const errors = [];
  page.on("console", (m) => errors.push(`[${m.type()}] ${m.text()}`));
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("requestfailed", (r) => errors.push("requestfailed: " + r.url() + " " + r.failure()?.errorText));
  try {
    await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForSelector("text=ALGON POA SYSTEM", { timeout: 20000 });
    await page.waitForTimeout(4000);
    await page.screenshot({ path: `${dir}/mobile-${label}.png`, fullPage: false });
    const mapDiv = await page.evaluate(() => {
      const main = document.querySelector("main");
      const mapContainer = main?.querySelector("div > div");
      const rect = main?.getBoundingClientRect();
      return { mainRect: rect ? { w: rect.width, h: rect.height } : null, bodyHTML_len: document.body.innerHTML.length };
    });
    console.log(`[${label}] main element size:`, JSON.stringify(mapDiv));
  } catch (e) {
    console.log(`[${label}] NAVIGATION ERROR:`, e.message);
  }
  console.log(`[${label}] ERRORS:`, errors.slice(0, 10));
  await browser.close();
}

await run("desktop", { viewport: { width: 1440, height: 900 } });
await run("mobile", { ...devices["Pixel 7"] });
