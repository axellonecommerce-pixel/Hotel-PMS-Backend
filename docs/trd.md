# Hotel PMS — Technical Requirements and Architecture

Status: **Approved** — owner approval recorded in `docs/approval.md`.

## 1. Architecture goals

- Multi-tenant SaaS with exactly one property per hotel account.
- Strict hotel data isolation, responsive web access, realtime collaboration, recoverable imports, and immutable closed business days.
- Separate frontend and backend GitHub repositories and independent deployment pipelines.

## 2. Recommended production stack

| Layer | Recommendation | Reason |
|---|---|---|
| Frontend | Next.js 16, React 19, TypeScript, Tailwind, Radix/shadcn | Matches current code; accessible responsive components |
| API/backend | Next.js server runtime with typed service/repository layers | Matches current backend; simple deployment and shared types |
| Database | Supabase PostgreSQL | Transactions, row-level security, backups, realtime support |
| Authentication | Supabase Auth, email/password | Unique employee identity and hotel-scoped sessions |
| File storage | Supabase Storage | Hotel logos, IDs, receipts, maintenance images, backup archives |
| Hosting | Netlify for the public Next.js frontend; Vercel for the Next.js API/backend | Matches the approved production topology. Netlify builds receive the public API origin, and Vercel restricts API CORS to the deployed Netlify origin. |
| Validation | Zod at every external boundary | Runtime validation and consistent errors |
| ORM/migrations | Drizzle ORM + reviewed SQL migrations | Already used; explicit schema history |
| Tests | Vitest + React Testing Library + Playwright | Unit, component, and end-to-end coverage |
| Observability | Provider to be selected with owner approval | Errors, failed jobs, Night Audit alerts |

No cloud service may be connected, purchased, or deployed before the owner approves cost and tradeoffs.

## 3. Repository boundaries

- `frontend`: presentation, client state, accessible components, print/PDF layouts, browser tests.
- `backend`: database schema/migrations, authentication/authorization, domain services, scheduled jobs, storage, backup/restore, API contracts.
- Generate an API schema/client or maintain a versioned shared contract package. Do not duplicate business calculations in both repositories.

## 4. Tenancy and authorization

- Every domain record carries `property_id` directly or inherits it through a verified parent.
- A user membership binds one user to one hotel and one role. V1 forbids cross-property membership.
- Database RLS and backend authorization must both verify property membership.
- Role policy is deny-by-default. Owner/Manager full access; Front Desk broad operations; Accountant financial CRUD/report access.
- Full card number and CVV are rejected at validation boundaries and never logged.

## 5. Domain services

- Reservation availability and group lifecycle
- Guest identity deduplication/merge
- Rate plan, nightly pricing, stacked promotions, stored tax snapshots
- Folio ledger, charge/tax pairing, shared document numbering
- Payment allocation/refunds/bad debt/security deposits
- Company A/R, invoice allocation, credit balance
- Room state, housekeeping assignment, maintenance/out-of-order inventory
- Employee time, state overtime rules (`server/payroll/pay-calculation.ts`), gross payroll, salary or hourly pay, payment method; state rules and withholding estimates on the frontend (`lib/payroll/us-payroll-rules.ts`)
- Back-dated pay: `GET /api/payroll` creates the schedule's pay periods from the earliest employee start date and returns them as `history` (the Pay Schedule, current period included, with `periodStart`, `periodEnd`, `payDate`). `PATCH /api/payroll` with `{ action: "hours", id, hours }` stores typed-in hours on an unpaid hourly entry (`hours: null` returns to the time clock). Salary in the start-date period is prorated (`salaryForPeriod`).
- Profit & Loss source rows (`api/reports/profit-loss`): cash basis, capped at the business date
- Property identity (`properties` row) kept in step with Settings › Property; location lists in `frontend/src/lib/locations.ts`
- Cash shift ledger and calculated over/short
- Business-day/Night Audit closure
- Revenue/ADR/RevPAR/occupancy reporting
- Notification, retention, export, backup/restore

Settings are one JSON document per property (`property_settings.application_settings`). The frontend merges it over `defaultSettings`, including nested objects (property, payroll, invoice, tax), so every property — existing or newly provisioned — has every current setting. The backend never depends on a setting existing; it falls back to the same default.

Money is stored as integer minor units plus ISO currency code. Dates use property-local business dates; timestamps are UTC with timezone conversion at the boundary. Financial operations use database transactions and idempotency keys.

## 6. API contract principles

- Version endpoints under `/api/v1`.
- Use resource IDs that are non-sequential and globally unique.
- Return typed field errors plus a human-readable recovery instruction.
- Lists provide pagination, sorting, filtering, and scoped search.
- Mutations include `updated_at` or version number for optimistic concurrency. A stale update returns `409 Conflict` with current data.
- Destructive actions require explicit confirmation tokens where the UI presents confirmation.
- Long-running exports/restores return a job ID and progress state.

Representative groups: `/auth`, `/property`, `/users`, `/guests`, `/reservations`, `/groups`, `/rooms`, `/folios`, `/charges`, `/payments`, `/deposits`, `/companies`, `/invoices`, `/housekeeping`, `/maintenance`, `/time-entries`, `/payroll`, `/expenses`, `/cash-shifts`, `/night-audit`, `/reports`, `/notifications`, `/backups`.

## 7. Realtime and concurrency

- Publish property-scoped changes for reservations, rooms, housekeeping, maintenance, cash shifts, notifications, and company invoices.
- Clients invalidate/refetch affected queries rather than treating websocket payloads as authoritative.
- Use optimistic concurrency for every editable record. Financial posting additionally uses database row locks/transactions.
- Availability is rechecked inside the reservation transaction to prevent overbooking races.

## 8. Jobs and retention

- Scheduler: automatic Night Audit, seven-day overdue reminders, ID-image deletion warning, one-year ID-image deletion, recurring expense generation, and export cleanup. A configured property-local Night Audit time is persisted as property data; the UI must describe it as a service window unless the deployed scheduler supports exact per-property execution.
- Jobs are idempotent, property-timezone aware, retryable, and observable.
- ID image deletion removes object storage content and active references while retaining guest/stay data. Backups must respect deletion tombstones.
- Closed business days cannot reopen; corrections occur through current-day adjusting transactions where applicable.

## 9. Backup/restore

- Create a versioned portable archive: manifest, JSON/CSV relational data, retained files, checksums, schema version, property identity, and creation time.
- Only Owner/Manager may export/restore. Restore validates archive, property ownership, checksum, schema compatibility, and available storage before confirmation.
- Restore runs transactionally into staging tables, validates relationships, then atomically replaces property data. Failure leaves current data intact.
- The owner declined password protection; UI must clearly warn that the downloaded archive contains private data.

## 10. Security and privacy

- HTTPS only; secure cookies; CSRF protection where relevant; rate limits on login/import/export.
- Password reset is an owner/manager initiated admin flow.
- Encrypt provider-managed disks/storage and secrets; signed short-lived file URLs.
- Logs redact personal IDs, tokens, payment metadata, and backup content.
- Validate uploads by MIME/signature, size, extension, and malware-scanning capability.
- Data isolation and authorization tests are release gates.

## 11. Performance and reliability targets

- Primary interactive reads: p95 under 500 ms after network connection; mutations: p95 under 1 s excluding files/reports.
- Initial route content usable on a typical hotel connection within 3 seconds.
- Paginate/virtualize data sets over 50 rows; reports run asynchronously when large.
- No offline mutation support; show clear connection/retry state.

## 12. Delivery pipeline

1. Format/lint/typecheck.
2. Unit and domain-rule tests.
3. Migration validation against a disposable database.
4. Component/accessibility tests.
5. Playwright critical-flow tests at phone, tablet, and desktop sizes.
6. Production build and preview deployment.
7. Human approval before production.

Every migration is forward-only, reviewed, backed up, and paired with rollback/repair guidance. Direct production database edits and destructive production actions are prohibited without explicit owner approval.
