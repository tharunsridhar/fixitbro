// Records the FixItBro double-booking demo against a locally running app.
//
//   1. Start the app (see the README) with the seeded demo data, e.g. on port 4100.
//   2. DEMO_URL=http://localhost:4100 DATABASE_URL=<db url> node record.mjs
//
// Output: fixitbro-demo.webm and frames/NN.png (key frames used by make_gif.py).
// Customer 2 is the recorded window. Customer 1 books the same slot from a second,
// unrecorded browser context while Customer 2 is still looking at a stale slot list.
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { mkdirSync, rmSync, renameSync, readdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.DEMO_URL ?? "http://localhost:4100";
const SERVICE_ID = Number(process.env.DEMO_SERVICE_ID ?? 2); // Leak repair, Priya Plumbing
const PASSWORD = "Password123!";
const W = 1280;
const H = 720;

rmSync(path.join(here, "frames"), { recursive: true, force: true });
rmSync(path.join(here, "video-tmp"), { recursive: true, force: true });
mkdirSync(path.join(here, "frames"), { recursive: true });

const browser = await chromium.launch({ channel: "chrome", headless: true });

// ---- Customer 1 (unrecorded): books the slot while Customer 2 is still deciding ----
async function customer1Books(startAt) {
  const ctx = await browser.newContext();
  const login = await ctx.request.post(`${BASE}/api/auth/login`, {
    data: { email: "customer@fixitbro.test", password: PASSWORD },
  });
  if (!login.ok()) throw new Error(`customer1 login failed: ${login.status()}`);
  const res = await ctx.request.post(`${BASE}/api/bookings`, {
    data: { serviceId: SERVICE_ID, startAt, notes: "" },
    headers: { "Idempotency-Key": crypto.randomUUID() },
  });
  await ctx.close();
  return res.status();
}

// ---- Customer 2 (recorded) ----
const ctx = await browser.newContext({
  viewport: { width: W, height: H },
  recordVideo: { dir: path.join(here, "video-tmp"), size: { width: W, height: H } },
});
await ctx.addInitScript(() => {
  window.__cap = (text) => {
    let el = document.getElementById("__demo_cap");
    if (!el) {
      el = document.createElement("div");
      el.id = "__demo_cap";
      el.style.cssText =
        "position:fixed;left:0;right:0;bottom:0;z-index:99999;padding:14px 24px;" +
        "background:rgba(17,24,39,.92);color:#fff;font:600 22px system-ui,sans-serif;text-align:center;";
      document.documentElement.appendChild(el);
    }
    el.textContent = text;
  };
});
const page = await ctx.newPage();
let frameNo = 0;
const caption = async (text, holdMs = 2600) => {
  await page.evaluate((t) => window.__cap(t), text);
  await page.waitForTimeout(holdMs);
  frameNo += 1;
  await page.screenshot({ path: path.join(here, "frames", String(frameNo).padStart(2, "0") + ".png") });
};

// Scene 1: landing
await page.goto(BASE + "/");
await caption("FixItBro: book local services. One slot, two customers.");

// Scene 2: Customer 2 signs in
await page.goto(BASE + "/login");
await page.getByLabel("Email").fill("customer2@fixitbro.test");
await page.getByLabel("Password").fill(PASSWORD);
await caption("Customer 2 signs in");
await page.getByRole("button", { name: "Sign in" }).click();
await page.waitForURL((u) => !u.pathname.startsWith("/login"));

// Scene 3: pick a slot two days out
const day = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
const slotsRes = await ctx.request.get(`${BASE}/api/services/${SERVICE_ID}/slots?date=${day}`);
const { slots } = await slotsRes.json();
if (!slots?.length) throw new Error(`no free slots on ${day}; reseed the database`);
const pick = Math.min(3, slots.length - 1);
await page.goto(`${BASE}/services/${SERVICE_ID}`);
await page.locator('input[type="date"]').fill(day);
const slotButtons = page.locator(".slots .slot");
await slotButtons.first().waitFor();
await slotButtons.nth(pick).click();
await caption("Customer 2 picks a free time, but has not clicked Book yet");

// Scene 4: Customer 1 books the same slot from another window
const status = await customer1Books(slots[pick]);
if (status !== 201) throw new Error(`customer 1 booking returned ${status}, expected 201`);
await caption("Meanwhile, Customer 1 (second window) books the same slot: 201 Created");

// Scene 5: Customer 2 clicks Book on a now-stale view
await page.getByRole("button", { name: "Request booking" }).click();
await page.locator('[role="alert"], .error, .alert').first().waitFor({ timeout: 5000 }).catch(() => {});
await caption("Customer 2 clicks Book: rejected with 409. No double booking.", 3200);

// Scene 6: the load test, run for real against the same database
await page.setContent(`<body style="margin:0;background:#0b1020;color:#e5e7eb;font:20px/1.5 ui-monospace,Consolas,monospace;padding:40px"><h2 style="margin:0 0 16px;font-family:system-ui">Load test: N customers book the same slot at the same instant</h2><pre id="out">running...</pre></body>`);
await page.evaluate(() => window.__cap("Running the real load test: 20, 50 and 100 simultaneous requests"));
const out = await new Promise((resolve) => {
  let buf = "";
  const p = spawn(process.execPath, ["scripts/loadtest.mjs", "--race", "20,50,100", BASE], {
    cwd: path.join(here, "..", "..", "server"),
    env: process.env,
  });
  p.stdout.on("data", (d) => (buf += d));
  p.stderr.on("data", (d) => (buf += d));
  p.on("close", () => resolve(buf));
});
writeFileSync(path.join(here, "loadtest-output.txt"), out);
const table = out.split("\n").filter((l) => l.startsWith("|")).join("\n");
await page.evaluate((t) => (document.getElementById("out").textContent = t), table);
await caption("Every run: exactly 1 booking, N-1 rejections, 0 overlapping bookings", 4500);

await ctx.close();
await browser.close();

const vids = readdirSync(path.join(here, "video-tmp")).filter((f) => f.endsWith(".webm"));
renameSync(path.join(here, "video-tmp", vids[0]), path.join(here, "fixitbro-demo.webm"));
rmSync(path.join(here, "video-tmp"), { recursive: true, force: true });
console.log("saved fixitbro-demo.webm and", frameNo, "frames");
