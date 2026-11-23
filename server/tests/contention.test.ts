import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/db.js";
import { at, futureDate, login, makeProviderWithService, makeUser, resetDb } from "./helpers.js";

beforeEach(resetDb);
afterEach(() => vi.resetModules());

const overlapRows = () =>
  prisma.$queryRaw<{ id: number }[]>`
    SELECT a.id FROM "Booking" a JOIN "Booking" b
      ON a."providerId" = b."providerId" AND a.id < b.id
     AND tsrange(a."startAt", a."endAt") && tsrange(b."startAt", b."endAt")
    WHERE a.status IN ('PENDING','ACCEPTED','IN_PROGRESS') AND b.status IN ('PENDING','ACCEPTED','IN_PROGRESS')`;

describe("contention beyond the basic race", () => {
  it("50 simultaneous customers: one winner, 49 clean 409s, zero overlaps in the database", async () => {
    const s = await makeProviderWithService("pro@test.dev");
    const date = futureDate(6);
    const customers = await Promise.all(
      Array.from({ length: 50 }, async (_, i) => {
        await makeUser("CUSTOMER", `c${i}@test.dev`);
        return login(`c${i}@test.dev`);
      }),
    );
    const results = await Promise.all(
      customers.map((c) => c.post("/api/bookings").send({ serviceId: s.service.id, startAt: at(date, "10:00") })),
    );
    const tally = results.map((r) => `${r.status}:${r.body?.error?.code ?? "ok"}`);
    expect(results.filter((r) => r.status === 201), tally.join(" ")).toHaveLength(1);
    expect(results.filter((r) => r.status === 409), tally.join(" ")).toHaveLength(49);
    expect(await prisma.booking.count()).toBe(1);
    expect(await overlapRows()).toHaveLength(0);
  });

  it("two server processes sharing one database still produce exactly one winner", async () => {
    // Each fresh import of the service gets its own in-process queue, like a second server instance.
    // Only the database lock and the exclusion constraint can protect the slot here.
    const s = await makeProviderWithService("pro@test.dev");
    const date = futureDate(6);
    const users = await Promise.all(
      Array.from({ length: 30 }, (_, i) => makeUser("CUSTOMER", `u${i}@test.dev`)),
    );

    vi.resetModules();
    const instanceA = await import("../src/services/bookingService.js");
    vi.resetModules();
    const instanceB = await import("../src/services/bookingService.js");
    expect(instanceA.createBooking).not.toBe(instanceB.createBooking);

    const startAt = new Date(at(date, "10:00"));
    const attempts = users.map((u, i) =>
      (i % 2 === 0 ? instanceA : instanceB)
        .createBooking({ customerId: u.id, serviceId: s.service.id, startAt, notes: "" })
        .then(() => "won", (e: { status?: number; code?: string }) => `lost:${e.status}:${e.code}`),
    );
    const outcomes = await Promise.all(attempts);

    expect(outcomes.filter((o) => o === "won"), outcomes.join(" ")).toHaveLength(1);
    const losers = outcomes.filter((o) => o !== "won");
    expect(losers).toHaveLength(29);
    // every loser got a clean conflict, never a 500 or a hang
    for (const l of losers) expect(["lost:409:SLOT_UNAVAILABLE", "lost:409:SLOT_TAKEN"]).toContain(l);
    expect(await prisma.booking.count()).toBe(1);
    expect(await overlapRows()).toHaveLength(0);
  });

  it("an expired pending request does not block the slot, and gets expired", async () => {
    const s = await makeProviderWithService("pro@test.dev");
    const stale = await makeUser("CUSTOMER", "stale@test.dev");
    await makeUser("CUSTOMER", "fresh@test.dev");
    const date = futureDate(6);
    const startAt = new Date(at(date, "10:00"));
    const old = await prisma.booking.create({
      data: {
        customerId: stale.id,
        providerId: s.profileId,
        serviceId: s.service.id,
        startAt,
        endAt: new Date(startAt.getTime() + 3_600_000),
        priceCents: 5000,
        currency: "INR",
        serviceTitle: "Fix a leak",
        status: "PENDING",
        createdAt: new Date(Date.now() - 3 * 86_400_000), // far older than the 24h pending TTL
      },
    });

    const fresh = await login("fresh@test.dev");
    const res = await fresh.post("/api/bookings").send({ serviceId: s.service.id, startAt: startAt.toISOString() });
    expect(res.status).toBe(201);
    expect((await prisma.booking.findUniqueOrThrow({ where: { id: old.id } })).status).toBe("EXPIRED");
    expect(await overlapRows()).toHaveLength(0);
  });

  it("a live pending request does block the same slot", async () => {
    const s = await makeProviderWithService("pro@test.dev");
    await makeUser("CUSTOMER", "a@test.dev");
    await makeUser("CUSTOMER", "b@test.dev");
    const date = futureDate(6);
    const body = { serviceId: s.service.id, startAt: at(date, "10:00") };
    expect((await (await login("a@test.dev")).post("/api/bookings").send(body)).status).toBe(201);
    const second = await (await login("b@test.dev")).post("/api/bookings").send(body);
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe("SLOT_UNAVAILABLE");
  });

  it("a cancelled booking frees the slot for the next customer", async () => {
    const s = await makeProviderWithService("pro@test.dev");
    await makeUser("CUSTOMER", "a@test.dev");
    await makeUser("CUSTOMER", "b@test.dev");
    const date = futureDate(6);
    const body = { serviceId: s.service.id, startAt: at(date, "10:00") };
    const a = await login("a@test.dev");
    const first = await a.post("/api/bookings").send(body);
    expect((await a.post(`/api/bookings/${first.body.booking.id}/transition`).send({ action: "cancel" })).status).toBe(200);
    expect((await (await login("b@test.dev")).post("/api/bookings").send(body)).status).toBe(201);
  });

  it("an idempotent retry that arrives while the original is still queued gets the original booking", async () => {
    const s = await makeProviderWithService("pro@test.dev");
    await makeUser("CUSTOMER", "a@test.dev");
    const a = await login("a@test.dev");
    const key = "retry-key-12345678";
    const body = { serviceId: s.service.id, startAt: at(futureDate(6), "10:00") };
    const results = await Promise.all(
      Array.from({ length: 8 }, () => a.post("/api/bookings").set("Idempotency-Key", key).send(body)),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 200)).toHaveLength(7);
    expect(new Set(results.map((r) => r.body.booking.id)).size).toBe(1);
    expect(await prisma.booking.count()).toBe(1);
  });
});
