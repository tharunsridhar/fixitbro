#!/usr/bin/env node
// End-to-end smoke test for a running FixItBro server (local, Docker or the live demo).
// Usage: node scripts/smoke.mjs [baseUrl]      (default http://localhost:4000)
// Flow: wake the server, sign in the three demo accounts, one customer books a slot, a second
// customer is refused with 409, the provider accepts, the first customer cancels to free the slot.
// Uses only the seeded demo accounts. Exits with code 1 if any step fails.

const base = (process.argv.find((a) => a.startsWith("http")) ?? "http://localhost:4000").replace(/\/$/, "");
const PASSWORD = "Password123!";
const steps = [];
let failed = false;

async function step(name, fn) {
  const t0 = performance.now();
  try {
    const detail = await fn();
    const ms = Math.round(performance.now() - t0);
    steps.push({ name, ok: true, ms });
    console.log(`PASS  ${name.padEnd(44)} ${String(ms).padStart(6)} ms${detail ? `  ${detail}` : ""}`);
  } catch (e) {
    const ms = Math.round(performance.now() - t0);
    steps.push({ name, ok: false, ms });
    failed = true;
    console.log(`FAIL  ${name.padEnd(44)} ${String(ms).padStart(6)} ms  ${e.message}`);
    throw e;
  }
}

async function api(path, { cookie, method = "GET", body } = {}) {
  const res = await fetch(`${base}/api${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}), ...(body ? { "Idempotency-Key": crypto.randomUUID() } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(90_000),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json, headers: res.headers };
}

async function login(email) {
  const r = await api("/auth/login", { method: "POST", body: { email, password: PASSWORD } });
  if (r.status !== 200) throw new Error(`login ${email} returned ${r.status}`);
  return r.headers.getSetCookie()[0].split(";")[0];
}

const expect = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

console.log(`Smoke test against ${base}\n`);
const wallStart = performance.now();
try {
  let firstLoadMs = 0;
  await step("wake server (GET /health)", async () => {
    const t0 = performance.now();
    for (;;) {
      try {
        const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(20_000) });
        if (res.ok) break;
      } catch {
        // free hosting can take a while to wake up; keep trying
      }
      expect(performance.now() - t0 < 180_000, "server did not wake within 3 minutes");
      await new Promise((r) => setTimeout(r, 3000));
    }
    firstLoadMs = Math.round(performance.now() - t0);
    return `first load ${(firstLoadMs / 1000).toFixed(1)} s`;
  });

  const cookies = {};
  for (const [label, email] of [
    ["customer", "customer@fixitbro.test"],
    ["customer2", "customer2@fixitbro.test"],
    ["provider", "provider@fixitbro.test"],
    ["admin", "admin@fixitbro.test"],
  ]) {
    await step(`sign in ${label}`, async () => {
      cookies[label] = await login(email);
    });
  }

  await step("admin can read stats, customer cannot", async () => {
    expect((await api("/admin/stats", { cookie: cookies.admin })).status === 200, "admin stats failed");
    expect((await api("/admin/stats", { cookie: cookies.customer })).status === 403, "customer was not refused");
  });

  let serviceId;
  await step("find the demo provider's active service", async () => {
    const r = await api("/provider/services", { cookie: cookies.provider });
    expect(r.status === 200, `provider services returned ${r.status}`);
    const svc = r.json.services.find((s) => s.active);
    expect(svc, "demo provider has no active service");
    serviceId = svc.id;
    return `service ${serviceId}: ${svc.title}`;
  });

  let startAt;
  let bookingId;
  await step("find a free slot 8 days ahead", async () => {
    // try a few days in case the first one is fully booked from earlier runs
    for (let d = 8; d < 14 && !startAt; d++) {
      const date = new Date(Date.now() + d * 86_400_000).toISOString().slice(0, 10);
      const r = await api(`/services/${serviceId}/slots?date=${date}`);
      expect(r.status === 200, `slots returned ${r.status}`);
      if (r.json.slots?.length) startAt = r.json.slots[r.json.slots.length - 1];
    }
    expect(startAt, "no free slot found");
    return startAt;
  });

  await step("customer books the slot (201)", async () => {
    const r = await api("/bookings", { cookie: cookies.customer, method: "POST", body: { serviceId, startAt } });
    expect(r.status === 201, `expected 201, got ${r.status} ${JSON.stringify(r.json)}`);
    bookingId = r.json.booking.id;
    return `booking ${bookingId}`;
  });

  await step("second customer, same slot, is refused (409)", async () => {
    const r = await api("/bookings", { cookie: cookies.customer2, method: "POST", body: { serviceId, startAt } });
    expect(r.status === 409, `expected 409, got ${r.status}`);
    return r.json.error?.code;
  });

  await step("provider accepts the booking", async () => {
    const r = await api(`/bookings/${bookingId}/transition`, { cookie: cookies.provider, method: "POST", body: { action: "accept" } });
    expect(r.status === 200 && r.json.booking?.status === "ACCEPTED", `accept returned ${r.status}`);
  });

  await step("customer cancels, freeing the slot", async () => {
    const r = await api(`/bookings/${bookingId}/transition`, { cookie: cookies.customer, method: "POST", body: { action: "cancel" } });
    expect(r.status === 200, `cancel returned ${r.status} ${JSON.stringify(r.json)}`);
    const again = await api(`/services/${serviceId}/slots?date=${startAt.slice(0, 10)}`);
    expect(again.json.slots.includes(startAt), "slot was not freed after cancelling");
  });
} catch {
  // the failing step already printed its message
}

const passed = steps.filter((s) => s.ok).length;
console.log(`\n${passed}/${steps.length} steps passed in ${((performance.now() - wallStart) / 1000).toFixed(1)} s`);
process.exit(failed ? 1 : 0);
