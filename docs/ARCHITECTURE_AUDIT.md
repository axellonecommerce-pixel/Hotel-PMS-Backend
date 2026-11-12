# InnSeva PMS — Architecture Audit (Phase 1)

Date: 2026-11-11 · Scope: backend (Vercel, `backend/`), frontend (Netlify, `frontend/`), database (Supabase Postgres, `drizzle-production/`, `supabase/rls.sql`).
This is a read-only audit. **No code or database was changed while writing it.** Live database contents were not inspected; findings come from the code and migration files. Items marked *verify* need one check in the Supabase dashboard.

## 1. What is there today

```
Browser ─▶ Netlify (Next.js frontend)
              │  Supabase Auth only (sign-in, password reset). No direct table access.
              ▼
           Vercel (Next.js API routes, ~70 routes)
              │  verifies the Supabase token on every request,
              │  resolves the motel + permissions from property_memberships,
              │  runs all business logic in SQL transactions (postgres.js)
              ▼
           Supabase Postgres (pooler :6543)  ·  Supabase Storage (private bucket)
           pg_cron → night audit tick · Vercel cron → daily job
```

- **Tenancy:** one `properties` row per motel; `property_memberships (auth_user_id, property_id, role)` links logins to motels. One login can belong to several motels (motel switcher in the top bar). 85 tables; every operational table carries `property_id`.
- **Permissions:** enforced in the API (`requirePropertySession` + per-login/per-role access in `staff_access`). Owner-only Users & Roles.
- **Money:** `ledger_entries` (single-table double entry, `balancedLedgerLines`), `document_sequences` for invoice/folio numbers, `business_days` + property time zone, night audit runs server-side.

## 2. Findings

Severity: **CRITICAL** fix before the next motel signs up · **HIGH** fix before ~10 motels · **MEDIUM** fix before ~100 · **LOW** housekeeping.
"Auto-safe" = can be done in code/migration without risk to existing data.

### CRITICAL

**C1. Staff can bypass every permission through Supabase's built-in data API.** — *Fix written: `drizzle-production/0024_close_data_api.sql` (tested on a local copy of the schema with Supabase's default grants: a housekeeper could read guests and rewrite their own access before; "permission denied" after; the API's database user unaffected). **Applied to production 2026-11-11**: migration run, `public` removed from the Data API's exposed schemas; outside test with the public key now gets 404 for every table; sign-in unaffected.*
- *What:* `supabase/rls.sql` gives every active member `for all` (read, insert, update, delete) on every table of their motel. Supabase automatically publishes the `public` schema as a REST API, reachable with the public (publishable) key that is in the frontend bundle plus the person's own sign-in token.
- *Why it matters:* a Housekeeper or Front Desk login could read payroll and guest data, change payments, or edit `property_settings.staff_access` to make themselves an owner, all without going through the API's permission checks. Everything built in Users & Roles can be bypassed.
- *Affected:* every table with `property_id`; `supabase/rls.sql`.
- *Fix:* the frontend never uses the data API (0 calls found; it uses Supabase only for Auth). Turn it off: in Supabase › Settings › API, remove `public` from "Exposed schemas", **and** add a migration that revokes table rights from the `anon` and `authenticated` roles (`revoke all on all tables/sequences/functions in schema public from anon, authenticated` + matching `alter default privileges`). The backend connects as the database owner through the pooler and is unaffected. Keep RLS on as a second layer.
- *Auto-safe:* **yes** (migration + one dashboard switch).

**C2. RLS is only applied when someone re-runs `rls.sql`.** — *Fix written: 0024 turns RLS on for every table and removes the API roles' rights on future tables; `bun run test:rls` is now a read-only check that fails on any reachable table. **Applied; check passes on production.***
- *What:* the script loops over tables that exist at the moment it runs. Tables added by later migrations (e.g. `card_terminals` in 0023) have no RLS unless the script was re-run afterwards.
- *Why:* combined with C1, a new table can be fully open. *Verify* in Supabase › Table editor: every table should show "RLS enabled".
- *Fix:* each migration that creates a table also enables RLS on it, and a test fails if any `public` table has RLS off. C1 removes most of the risk.
- *Auto-safe:* yes.

**C3. Local development uses the production database.** — *Open again: a test project was created on 2026-11-12 and deleted the same day at the owner's request; local `.env.local` points to the live project again.*
- *What:* the backend's local `.env.local` points to the production Supabase pooler. Development servers, tests that touch the database, and dry-runs all hit real motel data.
- *Why:* one mistaken script or test can change a live motel's money or guests. Not acceptable once other motels' data is in the same database.
- *Fix:* create a separate Supabase project for staging/development (seeded with demo data). Production credentials only in Vercel's Production environment.
- *Auto-safe:* no; it needs you to create the project, and then I switch the env files.

### HIGH

**H1. No retry protection on taking a payment, refund or charge.** — *Done in code: `Idempotency-Key` on 20 money handlers (17 routes), keys kept in `idempotency_keys` (migration 0025); tested on the test motel (double tap → 1 saved, retry → same answer replayed). Live needs migration 0025; until then the API runs exactly as before.*
- *What:* `POST /api/reservations/:id/payments` (and charges, refunds, cash drops, paid-outs) have no idempotency key. The card-terminal path has one; cash and manual card do not.
- *Why:* a double tap or a network retry on a phone can post the same payment twice (and its ledger lines).
- *Fix:* the frontend sends an `Idempotency-Key` header per action; the API stores it in a small `idempotency_keys (property_id, key, response)` table, unique per motel, and returns the first result on a repeat.
- *Auto-safe:* yes (additive table + header).

**H2. Each screen loads a motel's whole history.** — *Mostly done 2026-11-12: `/api/sync` reports 12 areas so screens reload only what changed (a payment reloads only the reservation list), and the reservation list downloads only stays changed since its last read (`?since=`), with a full read at most every 30 minutes. Tested locally: payment update 1.1 KB vs full list; nothing changed 77 bytes. Still open: browser-computed reports and the first full read.*
- *What:* `GET /api/reservations` returns every reservation with nested sub-selects (folio totals, deposits, commission); `GET /api/guests` returns every guest. Many reports are computed in the browser from that list (`frontend/src/features/reports/report-data.ts`, 800 lines).
- *Why:* fine at Sun Star today; after 2–3 years a motel has 20,000+ reservations and every page load gets slower and heavier on the database, multiplied by every motel.
- *Fix:* the main list loads a date window (e.g. 60 days back, 365 ahead) with search for older stays; move remaining browser-computed reports to server report routes (18 already exist). No UI change.
- *Auto-safe:* mostly; needs careful testing of every page that uses the list.

**H3. Room double-booking is prevented only in application code.** — *Done in code (migration 0026): a deferred constraint trigger refuses two active stays in one room on overlapping nights; tested (overlap, adjacent, cancelled, reactivation, extension, room move). Needs applying on live.*
- *What:* booking, room move, reinstate and extension each check for overlapping stays with row locks. That is correct today, but nothing in the database stops an overlap if a future code path forgets the check.
- *Fix:* add a date range on `reservation_rooms` (kept in sync by the API) and an exclusion constraint (`btree_gist`) on (room, dates) for active stays, as a backstop.
- *Auto-safe:* after a check that no current overlaps exist (the migration would report them first).

**H4. The sign-in check calls Supabase on every API request.** — *Done: tokens checked locally with the project's ES256 keys (0.4 ms vs ~164 ms); falls back to Supabase for tokens it cannot check.*
- *What:* `verifiedAuthUserId` fetches `/auth/v1/user` for each request (~50–150 ms, and Supabase rate limits).
- *Why:* slows every click and becomes a bottleneck with many motels.
- *Fix:* verify the token locally with Supabase's JWT signing keys (JWKS), cached; keep the network check only for platform-admin actions.
- *Auto-safe:* yes.

### MEDIUM

**M1. Some financial rows are deleted instead of voided.** — *Done another way (0027): every deleted money record keeps its full row, who deleted it and when in `audit_log`; the ledger was already reversed. Totals stay unchanged, so no report changes.*
- *What:* deleting a payment, paid-out, an OTA settlement, an undo-checkout invoice, or unpaid payroll rows removes the rows. The ledger is reversed and an activity line written, so totals stay right, but the original row is gone.
- *Fix:* add a `voided_at / voided_by / void_reason` to these tables and filter them out of totals instead of deleting.
- *Auto-safe:* yes, but touches many queries; do it table by table.

**M2. Audit trail covers reservations, not other money.** — *Done (0027): database triggers on 25 money and staff tables record every insert, change and delete with before/after and who (set per request); append-only; owners see it in Settings › Change History.*
- *What:* `reservation_activity` records reservation changes well. Expenses, payroll, paid-outs, cash drops, invoices, house accounts and time entries have no before/after audit record (only the realtime `change_events`, which hold no details).
- *Fix:* one `audit_log (property_id, user_id, action, entity_type, entity_id, before, after, reason, created_at)` table written by those routes; insert-only for everyone except the database owner.
- *Auto-safe:* yes.

**M3. Error messages can leak database text.** — *Done: `isUserMessage()` never passes a database error; 19 call sites in 11 routes.*
- *What:* about 12 routes return `error.message` whenever it contains a word such as "charge", "room" or "tax" (`folios/charges`, `reservations/:id/rates`, …). A Postgres error such as `… violates foreign key constraint "charges_…"` matches and is shown to staff.
- *Fix:* throw typed errors (as `ReservationRequestError` already does) and return a generic message otherwise; log the real error server-side.
- *Auto-safe:* yes.

**M4. Business data stored as JSON inside text columns.**
- *What:* `reservations.notes` holds JSON (lifecycle events, online booking details, remarks); `maintenance_orders.notes` holds the out-of-order date range. All application settings live in one `property_settings.application_settings` JSON blob that is copied into relational tables on save (two sources of truth).
- *Why:* hard to index, query or constrain; a bad save can corrupt it.
- *Fix:* move the out-of-order dates and booking details into columns first; keep the settings blob but make the relational tables the single source for rooms, room types, sources and employees.
- *Auto-safe:* gradual migrations; not urgent.

**M5. Few CHECK constraints on core tables.** — *Done in code (0026): valid statuses, departure ≥ arrival, non-negative amounts; each added only if no existing row breaks it (skipped with a notice otherwise).*
- *What:* the first migration (reservations, payments, charges, folios) has no CHECK constraints; the 44 that exist are in later tables. Departure-after-arrival, non-negative amounts and allowed status values are enforced only in code.
- *Fix:* add `NOT VALID` checks (they protect new rows at once), then validate after confirming old rows pass.
- *Auto-safe:* yes with `NOT VALID`.

**M6. Migrations are applied by hand with no record.** — *Done: `scripts/migrate.ts` with `schema_migrations` (live needs one `--baseline 0024` run).*
- *What:* 25 SQL files in `drizzle-production/`; Drizzle's journal tracks only the first 9. There is no table saying which files a given database has.
- *Fix:* a small `schema_migrations` table plus a `bun run migrate` script that applies pending files in order; same files for staging and production.
- *Auto-safe:* yes.

**M7. No request rate limits on the API.**
- *What:* authenticated routes and the public booking-email endpoint have no rate limit (Supabase limits sign-in itself).
- *Fix:* Vercel Firewall rate-limit rules per IP for `/api/*`; stricter for `/api/public/*`.
- *Auto-safe:* dashboard configuration.

### LOW

- **L1.** `POST /api/admin/properties` is a leftover demo provisioning route (key-protected, writes to the demo SQLite path). Remove it; the Platform page is the real path.
- **L2.** *(Done.)* The backend has no `.env.example`; the frontend's is current. Add one with names only.
- **L3.** `NEXT_PUBLIC_PMS_DEMO_AUTH_TOKEN` exists in the frontend; it only works when the backend is not in production mode. Make sure it is **not** set on Netlify production.
- **L4.** No `organizations` table. An owner with several motels works through memberships today; an organization row becomes useful for one bill covering several motels. Not needed yet.
- **L5.** Ledger accounts are free text in `ledger_entries.account`; a `ledger_accounts` list with a unique code would stop typos creating new accounts.
- **L6.** No uptime/error monitoring is wired (Vercel logs only). Add Vercel log drains or Sentry with guest data scrubbed.

### GOOD — keep as is

- **API-only access:** browsers never touch the database; all business logic runs server-side in transactions with row locks.
- **Correct pooling for Vercel:** the transaction pooler on port 6543, `prepare: false`, `max: 5`.
- **Motel isolation in the API:** every query is filtered by `property_id`, and lookups by id also check the motel. Permissions are resolved from the sign-in token and the database, never from the request body.
- **Strong unique keys:** room number per motel, confirmation number, invoice and folio numbers, one business day per date, one payroll row per employee per period, and more.
- **Server-side numbering:** `document_sequences` hands out invoice and folio numbers under a lock, never as "count + 1" in the browser.
- **Business date and time zone:** `business_days` plus each property's time zone. Night audit runs server-side via `pg_cron` without a browser, locks the open day, and records each run.
- **Accounting:** double-entry posting goes through shared services (`production-finance`, `payment-ledger`) with balanced lines.
- **Secrets:** private storage with short-lived signed links (5 min); terminal secrets encrypted (`PMS_ENCRYPTION_KEY`); the service key exists only on the backend; CORS limited to `PMS_FRONTEND_ORIGINS`.
- **Live sync:** the backend's own change feed (`change_events` → `/api/events`), scoped per motel. The browser holds no Supabase Realtime subscriptions.
- **Tests:** 16 backend unit-test files and 7 Playwright end-to-end suites.

## 3. Suggested order

| Step | Items | Size |
|---|---|---|
| 1 | ~~**C1** turn off the data API + revoke grants; **C2** RLS-on check; **L3**~~ **Done 2026-11-11** (Netlify checked: no demo token) | Small, do first |
| 2 | **C3** staging Supabase project (open: test project deleted); ~~**M6** migration runner; **L2**~~ **Done** | Small |
| 3 | ~~**H1** idempotency keys; **M3** error messages; **H4** local token check~~ **Done in code 2026-11-12** (H1 needs migration 0025 on live) | Medium |
| 4 | ~~**H3** double-booking constraint; **M5** CHECK constraints~~ **Done in code 2026-11-12** (migration 0026 to apply on live) | Medium |
| 5 | ~~**M1** void instead of delete; **M2** audit log~~ **Done in code 2026-11-12** (migration 0027 to apply on live) | Medium |
| 6 | **H2** date-windowed lists + server reports | Larger, needs careful testing |
| 7 | **M4**, **M7**, **L1**, **L4–L6** | As you grow |

## 4. Readiness today

| Motels | Ready? | What stops it |
|---|---|---|
| 1 (Sun Star) | Yes, after C1 | C1 (staff bypass) |
| 10 | After steps 1–3 | Same plus C3 (shared dev/prod database), H1 (double posts) |
| 100 | After steps 1–6 | H2 (full-history loading), H3, M1/M2 for financial auditing |
| 1,000+ | After all steps, plus a larger Supabase compute size, PITR and monitoring | Database size, rate limits, observability |
