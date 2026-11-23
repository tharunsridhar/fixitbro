# FixItBro

[![CI](https://github.com/tharunsridhar/fixitbro/actions/workflows/ci.yml/badge.svg)](https://github.com/tharunsridhar/fixitbro/actions/workflows/ci.yml)

A booking site for local services like plumbing, electrical work and cleaning. Customers pick a free time slot and book it. Providers set their working hours and accept jobs. Admins keep things in order.

Live demo: https://fixitbro.onrender.com

It runs on free hosting, so the first load after a quiet period can take up to a minute. Sign in with the demo logins below.

## What you can do
- Customers: search services, book a slot, cancel, get notified, leave a review.
- Providers: add services, set weekly hours and days off, accept or decline requests, mark jobs done.
- Admins: manage users and categories, hide reviews, see an audit log.
- Two people can never book the same slot (see below).

## Tech
- React + TypeScript (Vite)
- Node.js + Express + TypeScript
- PostgreSQL with Prisma
- Tests with Vitest and Supertest

## Run it
You need Node 22+ and PostgreSQL 16+.

```bash
npm run install:all
cp server/.env.example server/.env
```

Open `server/.env` and set `DATABASE_URL` and a long random `JWT_SECRET`. Then:

```bash
npm run db:migrate
npm run db:seed
npm run dev:server
npm run dev:web
```

- Website: http://localhost:5173
- API docs: http://localhost:4000/api/docs

No local database? Run `docker compose up -d postgres` and use `postgresql://fixitbro:fixitbro@localhost:5434/fixitbro` as `DATABASE_URL`.

## Demo logins
Password for all of them is `Password123!`

- Customer: `customer@fixitbro.test`
- Provider: `provider@fixitbro.test`
- Admin: `admin@fixitbro.test`

## Tests
```bash
npm test
```
- 100 tests across 13 files, run in CI on every push with lint and typecheck.
- Coverage is about 93% of statements and 96% of lines (`npm run test:coverage`). CI fails if it drops below a floor.
- Uses a separate `fixitbro_test` database and wipes it each run, so never point it at real data.
- What the tests cover:
  - Booking rules: slot generation, state machine, cancellation cutoff, idempotent retries, expiry of old pending requests.
  - Concurrency: races of 8, 20 and 50 customers for one slot, overlapping slots, deadlock retries, and two server instances sharing one database.
  - Access control: customer, provider and admin routes reject the wrong role, and other users' bookings look like 404.
  - Admin and provider features, search, reviews, reports and notifications.
- Checks beyond the unit tests, run from `server/`:
  - `npm run smoke -- <url>` signs in the demo accounts, books a slot, gets the 409 for a second customer, accepts, and cancels. It also reports how long the first load took, so it works against the live demo.
  - `npm run loadtest:race` runs the double-booking race. Add `--max-p95 <ms>` to fail on a latency budget. It refuses to target a remote URL unless you pass `--allow-remote`.

## How double booking is stopped
- The server rechecks the slot when you book, and bookings for one provider are processed one at a time.
- On top of that, PostgreSQL itself rejects overlapping bookings for the same provider, so two people clicking at the same moment cannot both win.
- Full explanation: [docs/concurrency.md](docs/concurrency.md)

## Load test
Same provider, same slot, N customers booking at the same moment (6 runs each, after a warm-up).

| Concurrent requests | Succeeded | Rejected (409) | Overlapping bookings | p50 | p95 |
|---|---|---|---|---|---|
| 20 | 1 | 19 | 0 | 96-152 ms | 134-200 ms |
| 50 | 1 | 49 | 0 | 211-334 ms | 312-478 ms |
| 100 | 1 | 99 | 0 | 513-613 ms | 750-914 ms |

- Across 20 runs (2 of them warm-ups, left out of the table), exactly one request won every time and the database held zero overlapping bookings.
- Ran on a local dev machine (i7-8665U, 16 GB RAM, Windows 11) with the API and Postgres 16 both in Docker. The load test client shared the machine.
- Latency still grows with N, because requests for one slot are handled one after another.
- To reproduce, start the API on port 4001 against a test database with `AUTH_RATE_MAX`, `API_RATE_MAX`, `MAX_USERS`, `MAX_BOOKINGS` and `DAILY_REQUEST_BUDGET` set high, seed it, then:

```bash
cd server
DATABASE_URL=<test db url> node scripts/loadtest.mjs --race 20,50,100 http://localhost:4001
```

## Docker
```bash
docker compose up --build -d
```
Set `JWT_SECRET` first. The app runs on http://localhost:4000. Add demo data with `docker compose exec app npx tsx prisma/seed.ts`, or set `AUTO_SEED=true` to load it on every start.

## Deploying on a free tier
- `render.yaml` sets up a free Render web service and a free Render Postgres, already connected to each other. Render deletes free databases after 30 days. For a database that does not expire, use a free Neon database and set its connection string as `DATABASE_URL` instead.
- Free hosting has limits, so the app protects itself: caps on users, bookings and services, a daily request budget, and a "server is full" banner when they are reached. All of it is configurable in `server/.env.example`.

## Notes
- Prices are in rupees. Times are stored in UTC and shown in the provider's timezone.
- Notifications are in-app only. There are no payments or emails.

<!-- last updated: 2026-11-11 -->
