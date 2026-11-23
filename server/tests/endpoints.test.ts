import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { app, at, futureDate, login, makeProviderWithService, makeUser, resetDb } from "./helpers.js";

beforeEach(resetDb);

type Agent = Awaited<ReturnType<typeof login>>;

async function bookAndComplete(customer: Agent, provider: Agent, serviceId: number, startAt: string) {
  const created = await customer.post("/api/bookings").send({ serviceId, startAt });
  expect(created.status).toBe(201);
  const id = created.body.booking.id as number;
  for (const action of ["accept", "start", "complete"]) {
    const r = await provider.post(`/api/bookings/${id}/transition`).send({ action });
    expect(r.status, `${action}: ${JSON.stringify(r.body)}`).toBe(200);
  }
  return id;
}

describe("public service search", () => {
  async function catalogue() {
    const cheap = await makeProviderWithService("cheap@test.dev");
    const dear = await makeProviderWithService("dear@test.dev");
    await prisma.service.update({ where: { id: cheap.service.id }, data: { title: "Drain unblocking", priceCents: 3000 } });
    await prisma.service.update({ where: { id: dear.service.id }, data: { title: "Boiler replacement", priceCents: 90000 } });
    await prisma.serviceArea.create({ data: { providerId: cheap.profileId, postcode: "600" } });
    return { cheap, dear };
  }

  it("filters by text, price range and postcode prefix, and sorts", async () => {
    const { cheap } = await catalogue();
    const titles = (r: request.Response) => r.body.items.map((i: { title: string }) => i.title);

    const all = await request(app).get("/api/services");
    expect(all.body.total).toBe(2);

    expect(titles(await request(app).get("/api/services").query({ q: "boiler" }))).toEqual(["Boiler replacement"]);
    expect(titles(await request(app).get("/api/services").query({ maxPrice: 5000 }))).toEqual(["Drain unblocking"]);
    expect(titles(await request(app).get("/api/services").query({ minPrice: 5000 }))).toEqual(["Boiler replacement"]);
    expect(titles(await request(app).get("/api/services").query({ postcode: "600123" }))).toEqual(["Drain unblocking"]);
    expect(titles(await request(app).get("/api/services").query({ sort: "price_desc" }))).toEqual([
      "Boiler replacement",
      "Drain unblocking",
    ]);
    expect(titles(await request(app).get("/api/services").query({ sort: "price_asc" }))).toEqual([
      "Drain unblocking",
      "Boiler replacement",
    ]);
    expect(cheap.service.id).toBeGreaterThan(0);
  });

  it("paginates and rejects bad parameters", async () => {
    await catalogue();
    const page = await request(app).get("/api/services").query({ pageSize: 1, page: 2, sort: "price_asc" });
    expect(page.body).toMatchObject({ total: 2, page: 2, pageSize: 1, totalPages: 2 });
    expect(page.body.items).toHaveLength(1);
    expect((await request(app).get("/api/services").query({ pageSize: 500 })).status).toBe(400);
    expect((await request(app).get("/api/services").query({ sort: "random" })).status).toBe(400);
  });

  it("with a date, only lists services that still have a free slot that day", async () => {
    const { cheap } = await catalogue();
    const date = futureDate(4);
    // a day off for one provider removes it from the dated search
    await prisma.availabilityException.create({ data: { providerId: cheap.profileId, date } });
    const res = await request(app).get("/api/services").query({ date });
    expect(res.body.items.map((i: { title: string }) => i.title)).toEqual(["Boiler replacement"]);
  });

  it("hides inactive services and suspended providers", async () => {
    const { cheap, dear } = await catalogue();
    await prisma.service.update({ where: { id: cheap.service.id }, data: { active: false } });
    await prisma.user.update({ where: { id: dear.user.id }, data: { status: "SUSPENDED" } });
    expect((await request(app).get("/api/services")).body.total).toBe(0);
    expect((await request(app).get(`/api/services/${cheap.service.id}`)).status).toBe(404);
    expect((await request(app).get(`/api/services/${dear.service.id}`)).status).toBe(404);
    expect((await request(app).get(`/api/providers/${dear.profileId}`)).status).toBe(404);
  });

  it("returns service details, categories and slot errors", async () => {
    const { dear } = await catalogue();
    const detail = await request(app).get(`/api/services/${dear.service.id}`);
    expect(detail.body.service).toMatchObject({ title: "Boiler replacement", provider: { reviewCount: 0, rating: null } });
    expect((await request(app).get("/api/categories")).body.categories).toHaveLength(1);
    expect((await request(app).get(`/api/services/${dear.service.id}/slots`)).status).toBe(400);
    expect((await request(app).get(`/api/services/${dear.service.id}/slots`).query({ date: "not-a-date" })).status).toBe(400);
    expect((await request(app).get("/api/services/99999/slots").query({ date: futureDate(3) })).status).toBe(404);
  });
});

describe("booking views", () => {
  it("lists a customer's and a provider's own bookings and hides them from strangers", async () => {
    const s = await makeProviderWithService("pro@test.dev");
    await makeUser("CUSTOMER", "a@test.dev");
    await makeUser("CUSTOMER", "stranger@test.dev");
    const a = await login("a@test.dev");
    const p = await login("pro@test.dev");
    const stranger = await login("stranger@test.dev");
    const date = futureDate(6);

    const one = await a.post("/api/bookings").send({ serviceId: s.service.id, startAt: at(date, "10:00") });
    await a.post("/api/bookings").send({ serviceId: s.service.id, startAt: at(date, "13:00") });
    const id = one.body.booking.id;
    await p.post(`/api/bookings/${id}/transition`).send({ action: "decline" });

    expect((await a.get("/api/bookings")).body.bookings).toHaveLength(2);
    expect((await a.get("/api/bookings").query({ status: "DECLINED" })).body.bookings).toHaveLength(1);
    expect((await p.get("/api/bookings")).body.bookings).toHaveLength(2);
    expect((await stranger.get("/api/bookings")).body.bookings).toHaveLength(0);

    const detail = await a.get(`/api/bookings/${id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.booking.history.map((h: { toStatus: string }) => h.toStatus)).toEqual(["PENDING", "DECLINED"]);
    expect((await p.get(`/api/bookings/${id}`)).status).toBe(200);
    // unrelated users cannot even tell the booking exists
    expect((await stranger.get(`/api/bookings/${id}`)).status).toBe(404);
    expect((await a.get("/api/bookings/99999")).status).toBe(404);
    expect((await request(app).get("/api/bookings")).status).toBe(401);
  });

  it("will not let a customer accept their own booking or a stranger cancel it", async () => {
    const s = await makeProviderWithService("pro@test.dev");
    await makeUser("CUSTOMER", "a@test.dev");
    await makeUser("CUSTOMER", "stranger@test.dev");
    const a = await login("a@test.dev");
    const stranger = await login("stranger@test.dev");
    const made = await a.post("/api/bookings").send({ serviceId: s.service.id, startAt: at(futureDate(6), "10:00") });
    const id = made.body.booking.id;
    expect((await a.post(`/api/bookings/${id}/transition`).send({ action: "accept" })).status).toBe(403);
    expect((await stranger.post(`/api/bookings/${id}/transition`).send({ action: "cancel" })).status).toBe(404);
    expect((await a.post(`/api/bookings/${id}/transition`).send({ action: "explode" })).status).toBe(400);
  });
});

describe("notifications", () => {
  it("creates notifications for both sides, counts unread and marks them read", async () => {
    const s = await makeProviderWithService("pro@test.dev");
    await makeUser("CUSTOMER", "a@test.dev");
    const a = await login("a@test.dev");
    const p = await login("pro@test.dev");
    await a.post("/api/bookings").send({ serviceId: s.service.id, startAt: at(futureDate(6), "10:00") });

    const mine = await a.get("/api/notifications");
    expect(mine.body.unread).toBe(1);
    expect(mine.body.notifications[0].type).toBe("BOOKING_CREATED");
    const theirs = await p.get("/api/notifications");
    expect(theirs.body.notifications[0].type).toBe("BOOKING_REQUESTED");

    // someone else's notification looks like it does not exist
    expect((await a.post(`/api/notifications/${theirs.body.notifications[0].id}/read`)).status).toBe(404);
    expect((await a.post(`/api/notifications/${mine.body.notifications[0].id}/read`)).status).toBe(204);
    expect((await a.get("/api/notifications")).body.unread).toBe(0);

    expect((await p.post("/api/notifications/read-all")).status).toBe(204);
    expect((await p.get("/api/notifications")).body.unread).toBe(0);
    expect((await request(app).get("/api/notifications")).status).toBe(401);
  });
});

describe("reviews and reports", () => {
  it("lets a customer review a completed booking once, and shows it on the provider page", async () => {
    const s = await makeProviderWithService("pro@test.dev");
    await makeUser("CUSTOMER", "a@test.dev");
    await makeUser("CUSTOMER", "b@test.dev");
    const a = await login("a@test.dev");
    const b = await login("b@test.dev");
    const p = await login("pro@test.dev");
    const date = futureDate(6);

    const pending = await a.post("/api/bookings").send({ serviceId: s.service.id, startAt: at(date, "09:00") });
    const early = await a.post(`/api/bookings/${pending.body.booking.id}/review`).send({ rating: 5 });
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe("NOT_REVIEWABLE");

    const id = await bookAndComplete(a, p, s.service.id, at(date, "13:00"));
    expect((await b.post(`/api/bookings/${id}/review`).send({ rating: 1 })).status).toBe(404);
    expect((await a.post(`/api/bookings/${id}/review`).send({ rating: 9 })).status).toBe(400);
    const ok = await a.post(`/api/bookings/${id}/review`).send({ rating: 4, text: "Great work" });
    expect(ok.status).toBe(201);
    const dup = await a.post(`/api/bookings/${id}/review`).send({ rating: 5 });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe("ALREADY_REVIEWED");

    const page = await request(app).get(`/api/providers/${s.profileId}`);
    expect(page.body.provider).toMatchObject({ rating: 4, reviewCount: 1 });
    expect(page.body.reviews[0]).toMatchObject({ rating: 4, text: "Great work" });

    // a hidden review disappears from the public page
    await prisma.review.updateMany({ data: { hidden: true } });
    expect((await request(app).get(`/api/providers/${s.profileId}`)).body.reviews).toHaveLength(0);
  });

  it("accepts reports from signed-in users only, with validation", async () => {
    const s = await makeProviderWithService("pro@test.dev");
    await makeUser("CUSTOMER", "a@test.dev");
    const a = await login("a@test.dev");
    const body = { targetType: "service", targetId: s.service.id, reason: "Looks like a scam" };

    expect((await request(app).post("/api/reports").send(body)).status).toBe(401);
    expect((await a.post("/api/reports").send(body)).status).toBe(201);
    expect((await a.post("/api/reports").send({ ...body, reason: "no" })).status).toBe(400);
    expect((await a.post("/api/reports").send({ ...body, targetType: "user" })).status).toBe(400);
    expect((await a.post("/api/reports").send({ ...body, targetId: 99999 })).status).toBe(404);
    expect(await prisma.report.count()).toBe(1);
  });
});
