import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { app, at, futureDate, login, makeProviderWithService, makeUser, resetDb } from "./helpers.js";

beforeEach(resetDb);

describe("provider access control", () => {
  it("rejects anonymous callers and customers", async () => {
    await makeUser("CUSTOMER", "cust@test.dev");
    expect((await request(app).get("/api/provider/profile")).status).toBe(401);
    expect((await (await login("cust@test.dev")).get("/api/provider/services")).status).toBe(403);
  });
});

describe("provider profile", () => {
  it("reads and updates the profile, de-duplicating and upper-casing areas", async () => {
    await makeProviderWithService("pro@test.dev");
    const p = await login("pro@test.dev");

    const before = await p.get("/api/provider/profile");
    expect(before.body.profile).toMatchObject({ city: "Testville", timezone: "UTC", areas: [] });

    const res = await p
      .put("/api/provider/profile")
      .send({ bio: "Fast and tidy", city: "Chennai", timezone: "Asia/Kolkata", areas: ["600001", "ab1", "AB1"] });
    expect(res.status).toBe(200);
    expect(res.body.conflicts).toEqual([]);

    const after = await p.get("/api/provider/profile");
    expect(after.body.profile).toMatchObject({ bio: "Fast and tidy", city: "Chennai", timezone: "Asia/Kolkata" });
    expect([...after.body.profile.areas].sort()).toEqual(["600001", "AB1"]);
  });

  it("rejects an unknown timezone", async () => {
    await makeProviderWithService("pro@test.dev");
    const p = await login("pro@test.dev");
    const res = await p.put("/api/provider/profile").send({ bio: "", city: "", timezone: "Mars/Olympus", areas: [] });
    expect(res.status).toBe(400);
  });
});

describe("provider services", () => {
  it("creates, lists and edits a service, and hides other providers' services", async () => {
    const mine = await makeProviderWithService("pro@test.dev");
    await makeProviderWithService("other@test.dev");
    const p = await login("pro@test.dev");

    const created = await p.post("/api/provider/services").send({
      categoryId: mine.category.id,
      title: "Boiler service",
      durationMin: 90,
      priceCents: 12000,
    });
    expect(created.status).toBe(201);
    expect(created.body.service).toMatchObject({ title: "Boiler service", active: true, description: "" });

    const list = await p.get("/api/provider/services");
    expect(list.body.services).toHaveLength(2);

    const patched = await p.patch(`/api/provider/services/${created.body.service.id}`).send({ active: false, priceCents: 9000 });
    expect(patched.body.service).toMatchObject({ active: false, priceCents: 9000 });

    const theirs = await prisma.service.findFirstOrThrow({ where: { provider: { user: { email: "other@test.dev" } } } });
    expect((await p.patch(`/api/provider/services/${theirs.id}`).send({ active: false })).status).toBe(404);
    expect((await prisma.service.findUniqueOrThrow({ where: { id: theirs.id } })).active).toBe(true);
  });

  it("validates new services", async () => {
    const s = await makeProviderWithService("pro@test.dev");
    const p = await login("pro@test.dev");
    const base = { categoryId: s.category.id, title: "Valid title", durationMin: 60, priceCents: 1000 };
    expect((await p.post("/api/provider/services").send({ ...base, categoryId: 99999 })).status).toBe(400);
    expect((await p.post("/api/provider/services").send({ ...base, title: "ab" })).status).toBe(400);
    expect((await p.post("/api/provider/services").send({ ...base, durationMin: 5 })).status).toBe(400);
    expect((await p.post("/api/provider/services").send({ ...base, priceCents: -1 })).status).toBe(400);
  });
});

describe("provider availability", () => {
  it("replaces weekly hours and validates them", async () => {
    await makeProviderWithService("pro@test.dev");
    const p = await login("pro@test.dev");

    const ok = await p.put("/api/provider/availability").send({
      rules: [
        { weekday: 1, startMin: 540, endMin: 720 },
        { weekday: 1, startMin: 780, endMin: 1020 },
      ],
    });
    expect(ok.status).toBe(200);
    const got = await p.get("/api/provider/availability");
    expect(got.body.rules).toHaveLength(2);
    expect(got.body.timezone).toBe("UTC");

    const backwards = await p.put("/api/provider/availability").send({ rules: [{ weekday: 2, startMin: 600, endMin: 600 }] });
    expect(backwards.status).toBe(400);
    const overlap = await p.put("/api/provider/availability").send({
      rules: [
        { weekday: 3, startMin: 540, endMin: 700 },
        { weekday: 3, startMin: 650, endMin: 800 },
      ],
    });
    expect(overlap.status).toBe(400);
    // a rejected change must leave the previous hours in place
    expect((await p.get("/api/provider/availability")).body.rules).toHaveLength(2);
  });

  it("reports existing bookings that fall outside new hours, without cancelling them", async () => {
    const s = await makeProviderWithService("pro@test.dev");
    await makeUser("CUSTOMER", "c@test.dev");
    const c = await login("c@test.dev");
    const p = await login("pro@test.dev");
    const date = futureDate(5);
    const booked = await c.post("/api/bookings").send({ serviceId: s.service.id, startAt: at(date, "10:00") });
    expect(booked.status).toBe(201);

    const res = await p.put("/api/provider/availability").send({ rules: [{ weekday: 1, startMin: 0, endMin: 60 }] });
    expect(res.body.conflicts.map((x: { bookingId: number }) => x.bookingId)).toEqual([booked.body.booking.id]);
    expect((await prisma.booking.findUniqueOrThrow({ where: { id: booked.body.booking.id } })).status).toBe("PENDING");
  });

  it("adds, updates and removes day-off exceptions, with validation", async () => {
    await makeProviderWithService("pro@test.dev");
    await makeProviderWithService("other@test.dev");
    const p = await login("pro@test.dev");
    const date = futureDate(9);

    const off = await p.post("/api/provider/exceptions").send({ date });
    expect(off.status).toBe(201);
    const again = await p.post("/api/provider/exceptions").send({ date, startMin: 600, endMin: 720, note: "short day" });
    expect(again.body.exception.id).toBe(off.body.exception.id);
    expect(again.body.exception).toMatchObject({ startMin: 600, endMin: 720 });

    expect((await p.post("/api/provider/exceptions").send({ date: "2026-13-45" })).status).toBe(400);
    expect((await p.post("/api/provider/exceptions").send({ date, startMin: 600 })).status).toBe(400);
    expect((await p.post("/api/provider/exceptions").send({ date, startMin: 700, endMin: 600 })).status).toBe(400);

    const other = await login("other@test.dev");
    expect((await other.delete(`/api/provider/exceptions/${off.body.exception.id}`)).status).toBe(404);
    expect((await p.delete(`/api/provider/exceptions/${off.body.exception.id}`)).status).toBe(204);
    expect((await p.delete(`/api/provider/exceptions/${off.body.exception.id}`)).status).toBe(404);
  });
});

describe("provider stats", () => {
  it("counts pending, upcoming accepted and completed bookings", async () => {
    const s = await makeProviderWithService("pro@test.dev");
    await makeUser("CUSTOMER", "c@test.dev");
    const c = await login("c@test.dev");
    const p = await login("pro@test.dev");
    const date = futureDate(6);
    const one = await c.post("/api/bookings").send({ serviceId: s.service.id, startAt: at(date, "10:00") });
    await c.post("/api/bookings").send({ serviceId: s.service.id, startAt: at(date, "13:00") });
    expect((await p.get("/api/provider/stats")).body).toEqual({ pending: 2, upcoming: 0, completed: 0 });
    const accepted = await p.post(`/api/bookings/${one.body.booking.id}/transition`).send({ action: "accept" });
    expect(accepted.status).toBe(200);
    expect((await p.get("/api/provider/stats")).body).toEqual({ pending: 1, upcoming: 1, completed: 0 });
  });
});
