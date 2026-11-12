// Takes screenshots of the main pages in demo mode (deviceScaleFactor 1) and
// fails on any browser console error. Needs the dev or prod server on
// BASE_URL (default http://localhost:3100).
//   node scripts/screenshots.mjs
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, "..", "screenshots");
mkdirSync(out, { recursive: true });
const BASE = process.env.BASE_URL ?? "http://localhost:3100";
const executablePath = process.env.PW_CHROMIUM_PATH ?? "/opt/pw-browsers/chromium";

const browser = await chromium.launch({
  executablePath,
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
});
const errors = [];

async function shot(name, url, { width = 1280, height = 900, prepare, fullPage = true } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`${name}: ${m.text()}`);
  });
  page.on("pageerror", (e) => errors.push(`${name}: ${e.message}`));
  await page.goto(BASE + url, { waitUntil: "load" });
  if (prepare) await prepare(page);
  await page.waitForTimeout(1200);
  await page.screenshot({ path: path.join(out, `${name}.png`), fullPage });
  await ctx.close();
  console.log("saved", name);
}

const waitMap = async (page) => {
  await page.locator('[data-map-ready="true"]').first().waitFor({ timeout: 20000 }).catch(() => {});
};

await shot("coverage-map", "/", { prepare: async (p) => { await waitMap(p); await p.getByRole("button", { name: /99-03-02-002/ }).first().click(); } });
await shot("coverage-map-mobile", "/", { width: 390, height: 844, prepare: waitMap, fullPage: false });
await shot("night-stall", "/night?step=3", { prepare: waitMap });
await shot("night-late", "/night?step=4", { prepare: waitMap });
await shot("night-mobile", "/night?step=3", { width: 390, height: 844, prepare: waitMap, fullPage: false });
await shot("review-queue", "/review", {
  prepare: async (p) => {
    await p.getByTestId("evidence-card").waitFor({ timeout: 15000 });
  },
});
await shot("review-mobile", "/review", { width: 390, height: 844, fullPage: false, prepare: async (p) => { await p.getByTestId("evidence-card").waitFor({ timeout: 15000 }); } });
await shot("register", "/register", { prepare: async (p) => { await p.getByRole("table").waitFor({ timeout: 15000 }); } });
await shot("register-mobile", "/register", { width: 390, height: 844, fullPage: false });
await shot("pu-page", "/pu/99-01-01-002", { prepare: waitMap });
await shot("method", "/method");

await browser.close();
if (errors.length) {
  console.error("Console errors:\n" + errors.join("\n"));
  process.exit(1);
}
console.log("no console errors");
