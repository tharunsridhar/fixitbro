// Basic load test: slot search and booking creation against a running API.
// Usage: node scripts/loadtest.mjs [baseUrl]   (run `npm run db:seed` first)
import autocannon from "autocannon";
import { randomUUID } from "node:crypto";

const base = process.argv.find((a) => a.startsWith("http")) ?? "http://localhost:4000";
const day = new Date(Date.now() + 6 * 86400000).toISOString().slice(0, 10);

async function login(email) {
  const res = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "Password123!" }),
  });
  if (!res.ok) throw new Error(`login failed for ${email}: ${res.status}`);
  return res.headers.getSetCookie()[0].split(";")[0];
}

function run(opts) {
  return new Promise((resolve, reject) =>
    autocannon({ duration: 10, connections: 20, ...opts }, (err, r) => (err ? reject(err) : resolve(r))),
  );
}

function summary(name, r) {
  const codes = Object.entries(r.statusCodeStats ?? {})
    .map(([c, v]) => `${c}:${v.count}`)
    .join(" ");
  console.log(
    `${name}: ${Math.round(r.requests.average)} req/s, p50 ${r.latency.p50}ms, p99 ${r.latency.p99}ms, ` +
      `errors ${r.errors}, non-2xx ${r.non2xx}, codes [${codes}]`,
  );
}

// Double-booking race: N distinct customers fire at once for the SAME provider and SAME slot.
// Usage: DATABASE_URL=... node scripts/loadtest.mjs --race 20,50,100 [baseUrl]
// Needs the target API to run with high AUTH_RATE_MAX / MAX_USERS (see README, Load test).
async function race(sizes) {
  const { PrismaClient } = await import("@prisma/client");
  const prisma = new PrismaClient();
  const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
  const rows = [];
  for (const [run, n] of sizes.entries()) {
    const date = new Date(Date.now() + (7 + run) * 86400000).toISOString().slice(0, 10);
    const slots = (await (await fetch(`${base}/api/services/1/slots?date=${date}`)).json()).slots;
    if (!slots?.length) throw new Error(`no free slot on ${date}`);
    const startAt = slots[0];
    const tag = randomUUID().slice(0, 8);
    const cookies = await Promise.all(
      Array.from({ length: n }, async (_, i) => {
        const res = await fetch(`${base}/api/auth/register`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: `Racer ${i}`, email: `race-${tag}-${i}@loadtest.test`, password: "Password123!" }),
        });
        if (res.status !== 201) throw new Error(`register failed: ${res.status}`);
        return res.headers.getSetCookie()[0].split(";")[0];
      }),
    );
    const results = await Promise.all(
      cookies.map(async (cookie) => {
        const t0 = performance.now();
        const res = await fetch(`${base}/api/bookings`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Cookie: cookie, "Idempotency-Key": randomUUID() },
          body: JSON.stringify({ serviceId: 1, startAt }),
        });
        const body = await res.json().catch(() => ({}));
        return { status: res.status, code: body?.error?.code ?? "ok", ms: performance.now() - t0 };
      }),
    );
    const lat = results.map((r) => r.ms).sort((a, b) => a - b);
    const codes = {};
    for (const r of results) codes[`${r.status}:${r.code}`] = (codes[`${r.status}:${r.code}`] ?? 0) + 1;
    const overlaps = await prisma.$queryRaw`
      SELECT a.id FROM "Booking" a JOIN "Booking" b
        ON a."providerId" = b."providerId" AND a.id < b.id
       AND tsrange(a."startAt", a."endAt") && tsrange(b."startAt", b."endAt")
      WHERE a.status IN ('PENDING','ACCEPTED','IN_PROGRESS') AND b.status IN ('PENDING','ACCEPTED','IN_PROGRESS')`;
    const inSlot = await prisma.booking.count({
      where: { startAt: new Date(startAt), status: { in: ["PENDING", "ACCEPTED", "IN_PROGRESS"] } },
    });
    rows.push({
      n,
      sent: results.length,
      succeeded: results.filter((r) => r.status === 201).length,
      rejected: results.filter((r) => r.status !== 201).length,
      bookingsInSlot: inSlot,
      overlaps: overlaps.length,
      p50: pct(lat, 50).toFixed(0),
      p95: pct(lat, 95).toFixed(0),
      codes,
    });
  }
  await prisma.$disconnect();
  console.log("| Concurrent requests | Succeeded | Rejected | Bookings in slot | Overlapping bookings | p50 (ms) | p95 (ms) |");
  console.log("|---|---|---|---|---|---|---|");
  for (const r of rows)
    console.log(`| ${r.sent} | ${r.succeeded} | ${r.rejected} | ${r.bookingsInSlot} | ${r.overlaps} | ${r.p50} | ${r.p95} |`);
  for (const r of rows) console.log(`N=${r.n} response codes:`, JSON.stringify(r.codes));
  process.exit(rows.some((r) => r.overlaps !== 0 || r.succeeded !== 1) ? 1 : 0);
}

const raceArg = process.argv.indexOf("--race");
if (raceArg !== -1) await race(process.argv[raceArg + 1].split(",").map(Number));

const cookie = await login("customer2@fixitbro.test");

summary("slot search", await run({ url: `${base}/api/services/1/slots?date=${day}` }));

// Every request uses a fresh idempotency key against a handful of start times,
// so most return 409. That is the point: the DB constraint must hold under pressure.
const times = ["09:00", "09:30", "10:00", "13:00", "14:30", "16:00"].map((t) => `${day}T${t}:00.000Z`);
summary(
  "booking creation",
  await run({
    url: `${base}/api/bookings`,
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    requests: [
      {
        setupRequest: (req) => ({
          ...req,
          headers: { ...req.headers, "Idempotency-Key": randomUUID() },
          body: JSON.stringify({ serviceId: 1, startAt: times[Math.floor(Math.random() * times.length)] }),
        }),
      },
    ],
  }),
);
console.log("Check: no two blocking bookings overlap, see docs/concurrency.md for the SQL.");
