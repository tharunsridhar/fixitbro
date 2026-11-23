import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { app, login, makeProviderWithService, makeUser, resetDb } from "./helpers.js";

beforeEach(resetDb);

async function setup() {
  const admin = await makeUser("ADMIN", "admin@test.dev", "Ada Admin");
  const customer = await makeUser("CUSTOMER", "cust@test.dev", "Carl Customer");
  return { admin, customer, a: await login("admin@test.dev") };
}

describe("admin access control", () => {
  it("rejects anonymous callers, customers and providers", async () => {
    await makeUser("CUSTOMER", "cust@test.dev");
    await makeProviderWithService("pro@test.dev");
    expect((await request(app).get("/api/admin/stats")).status).toBe(401);
    expect((await (await login("cust@test.dev")).get("/api/admin/stats")).status).toBe(403);
    expect((await (await login("pro@test.dev")).get("/api/admin/users")).status).toBe(403);
  });
});

describe("admin users and stats", () => {
  it("returns counts and filters users by role and search text", async () => {
    const { a } = await setup();
    await makeProviderWithService("pro@test.dev");

    const stats = await a.get("/api/admin/stats");
    expect(stats.status).toBe(200);
    expect(stats.body).toMatchObject({ users: 3, providers: 1, services: 1, bookings: 0, pendingReports: 0 });

    const providers = await a.get("/api/admin/users").query({ role: "PROVIDER" });
    expect(providers.body.users.map((u: { email: string }) => u.email)).toEqual(["pro@test.dev"]);

    const search = await a.get("/api/admin/users").query({ q: "CARL" });
    expect(search.body.users.map((u: { email: string }) => u.email)).toEqual(["cust@test.dev"]);

    // empty filters from the UI must behave like no filter
    const blank = await a.get("/api/admin/users").query({ q: "", role: "" });
    expect(blank.body.users).toHaveLength(3);
  });

  it("suspends and reactivates a user, writes an audit entry, and blocks self-suspension", async () => {
    const { admin, customer, a } = await setup();

    const off = await a.patch(`/api/admin/users/${customer.id}/status`).send({ status: "SUSPENDED" });
    expect(off.status).toBe(200);
    expect(off.body.user.status).toBe("SUSPENDED");
    const on = await a.patch(`/api/admin/users/${customer.id}/status`).send({ status: "ACTIVE" });
    expect(on.body.user.status).toBe("ACTIVE");

    const logs = await a.get("/api/admin/audit-logs");
    expect(logs.body.logs.map((l: { action: string }) => l.action)).toEqual(["USER_ACTIVATED", "USER_SUSPENDED"]);

    expect((await a.patch(`/api/admin/users/${admin.id}/status`).send({ status: "SUSPENDED" })).status).toBe(403);
    expect((await a.patch("/api/admin/users/99999/status").send({ status: "ACTIVE" })).status).toBe(404);
    expect((await a.patch(`/api/admin/users/${customer.id}/status`).send({ status: "BANNED" })).status).toBe(400);
  });
});

describe("admin categories", () => {
  it("creates, rejects duplicates, renames and deletes a category", async () => {
    const { a } = await setup();

    const created = await a.post("/api/admin/categories").send({ name: "Pest Control" });
    expect(created.status).toBe(201);
    expect(created.body.category.slug).toBe("pest-control");

    const dup = await a.post("/api/admin/categories").send({ name: "Pest Control" });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe("CATEGORY_EXISTS");

    expect((await a.post("/api/admin/categories").send({ name: "x" })).status).toBe(400);

    const id = created.body.category.id;
    const renamed = await a.patch(`/api/admin/categories/${id}`).send({ name: "Garden Care" });
    expect(renamed.body.category).toMatchObject({ name: "Garden Care", slug: "garden-care" });
    expect((await a.patch("/api/admin/categories/99999").send({ name: "Nope" })).status).toBe(404);

    expect((await a.delete(`/api/admin/categories/${id}`)).status).toBe(204);
    expect((await a.delete(`/api/admin/categories/${id}`)).status).toBe(404);
  });

  it("refuses to delete a category that still has services", async () => {
    const { a } = await setup();
    const s = await makeProviderWithService("pro@test.dev");
    const res = await a.delete(`/api/admin/categories/${s.category.id}`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("CATEGORY_IN_USE");
  });
});

describe("admin moderation", () => {
  it("lists bookings with a status filter", async () => {
    const { a, customer } = await setup();
    const s = await makeProviderWithService("pro@test.dev");
    const start = new Date(Date.now() + 5 * 86_400_000);
    for (const status of ["PENDING", "CANCELLED"] as const) {
      start.setHours(start.getHours() + 3);
      await prisma.booking.create({
        data: {
          customerId: customer.id,
          providerId: s.profileId,
          serviceId: s.service.id,
          startAt: new Date(start),
          endAt: new Date(start.getTime() + 3_600_000),
          priceCents: 5000,
          currency: "INR",
          serviceTitle: "Fix a leak",
          status,
        },
      });
    }
    expect((await a.get("/api/admin/bookings")).body.bookings).toHaveLength(2);
    const pending = await a.get("/api/admin/bookings").query({ status: "PENDING" });
    expect(pending.body.bookings).toHaveLength(1);
    expect((await a.get("/api/admin/bookings").query({ status: "NOPE" })).status).toBe(400);
  });

  it("hides and restores a review, and resolves a report", async () => {
    const { a, customer } = await setup();
    const s = await makeProviderWithService("pro@test.dev");
    const booking = await prisma.booking.create({
      data: {
        customerId: customer.id,
        providerId: s.profileId,
        serviceId: s.service.id,
        startAt: new Date(Date.now() - 2 * 86_400_000),
        endAt: new Date(Date.now() - 2 * 86_400_000 + 3_600_000),
        priceCents: 5000,
        currency: "INR",
        serviceTitle: "Fix a leak",
        status: "COMPLETED",
      },
    });
    const review = await prisma.review.create({
      data: { bookingId: booking.id, customerId: customer.id, providerId: s.profileId, rating: 1, text: "rude" },
    });
    const report = await prisma.report.create({
      data: { reporterId: customer.id, targetType: "review", targetId: review.id, reason: "spam" },
    });

    expect((await a.get("/api/admin/reviews")).body.reviews).toHaveLength(1);

    const hidden = await a.post(`/api/admin/reviews/${review.id}/hide`).send({ hidden: true, reason: "abusive" });
    expect(hidden.body.review.hidden).toBe(true);
    const restored = await a.post(`/api/admin/reviews/${review.id}/hide`).send({ hidden: false });
    expect(restored.body.review.hidden).toBe(false);
    expect((await a.post("/api/admin/reviews/99999/hide").send({ hidden: true })).status).toBe(404);

    expect((await a.get("/api/admin/stats")).body.pendingReports).toBe(1);
    expect((await a.get("/api/admin/reports")).body.reports).toHaveLength(1);
    expect((await a.post(`/api/admin/reports/${report.id}/resolve`)).status).toBe(204);
    expect((await a.post("/api/admin/reports/99999/resolve")).status).toBe(404);
    expect((await a.get("/api/admin/stats")).body.pendingReports).toBe(0);

    const actions = (await a.get("/api/admin/audit-logs")).body.logs.map((l: { action: string }) => l.action);
    expect(actions).toEqual(expect.arrayContaining(["REVIEW_HIDDEN", "REVIEW_RESTORED", "REPORT_RESOLVED"]));
  });
});
