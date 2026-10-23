# HotelKey workflow comparison plan

## Purpose

Use lawful, evidence-based behavioral research to improve only the following
Hotel PMS workflows: arrivals, reservations, departures, no shows,
cancellations, Night Audit, and reports.

This plan does not authorize copying source code, visual assets, branding,
database content, credentials, private APIs, or proprietary documentation from
any other PMS.

## Preconditions

Before external analysis begins, the product owner must provide all of:

1. Confirmation that the team is authorized to analyze the named target.
2. A permitted URL and a dedicated test account containing only test data.
3. Confirmation that its terms, contract, and applicable law permit this
   testing method.

REA is used only as a local research tool. It is not added to this product's
runtime dependencies, frontend bundle, backend deployment, or customer data
path.

## Fixed boundaries

The following existing areas remain unchanged by this comparison unless a
separate written requirement expands the scope:

- PMS UI system, branding, navigation, and visual design system.
- Money section: companies, revenue, expenses, cash drop, payments ledger,
  company A/R, and invoices.
- Management section: payroll, reports administration, employee management,
  and property settings.

Reports may receive changes only to their operational read models, filters,
exports, and Night Audit output. Financial accounting rules remain governed by
the approved PRD and TRD.

## Research method

For each permitted scenario, capture only observable behavior:

1. Entry point, role, preconditions, and test data.
2. User actions and every visible state transition.
3. Validation messages, required fields, and blocking conditions.
4. Date, timezone, inventory, charge, payment, and room-status effects.
5. Observable network request/response shape only where permitted.
6. A screenshot or event log proving the finding.

Every finding is labelled as one of:

- `Adopt`: aligns with the approved PMS requirements and improves a gap.
- `Adapt`: useful concept that needs an original implementation.
- `Reject`: conflicts with our approved requirements, security model, or
  tenant/data model.

## Comparison matrix

| Workflow | Existing governing requirements | Required scenarios |
|---|---|---|
| Arrival and reservation | FR-RES-001, FR-RES-004, FR-RAT-001, FR-PAY-001 | Walk-in, advance arrival, same-day/zero-night stay, room selection, rate selection, required payment method |
| In-house stay | FR-RES-006, FR-RAT-002, FR-HSK-002 | Extend by nights/date, move room/type with reason, dirty-room handoff, balance visibility |
| Departure and checkout | FR-RES-002 to FR-RES-005, FR-CHK-001 | Paid checkout, balance block, direct-bill checkout, deposit settlement, room-to-dirty transition |
| Cancellation and no show | FR-RES-008 | Fee/no-fee cancellation, no-show inventory release, reinstatement availability validation |
| Night Audit | FR-AUD-001, FR-NOT-001 | Schedule, manual run, unpaid departure/deposit/cash blockers, no-show handling, business-day advance, report output |
| Reports | FR-RPT-001, FR-RPT-002, FR-REV-002 | Daily close report, custom dates, print/PDF/Excel, prior-period comparison, drill-down |

## Scheduler deployment constraint

The configured Night Audit time is property data, not a browser-local timer.
The current backend deployment has one static Vercel cron expression, so it
cannot provide exact, independently configurable hotel-local execution times
on a Hobby plan. Vercel documents a daily-only Hobby interval and an
hour-sized timing window. Exact timing requires a minute-capable scheduled
worker (for example a qualifying Vercel plan or a separately approved
durable scheduler). Until that infrastructure is approved and deployed, the
PMS must describe an automatic audit as a daily service window rather than an
exact guarantee.

## Implementation sequence

1. Add evidence and approved deltas to PRD, TRD, user flows, schema, and
   project rules in both repositories.
2. Implement backend transactions, validation, and migrations first.
3. Implement matching frontend behavior using the existing UI components and
   design system.
4. Add domain/API/browser regression coverage for every new rule.
5. Run typecheck, production builds, full unit/domain suites, browser,
   accessibility, and authenticated live-data tests.
6. Review the complete diff and push frontend and backend once, together.

## Release acceptance checks

- A payment cannot be collected without a selected method.
- A room can never be double-booked or moved to an unavailable destination.
- No-show/cancellation actions atomically release inventory and preserve the
  required financial audit record.
- Night Audit cannot advance the business day with documented blockers.
- Scheduled audit timing is not represented as exact unless the deployed
  scheduler can meet the configured property-local time.
- Department status updates stay consistent among the floor map,
  housekeeping, maintenance, inventory, and reservation views.
- Reports use tenant-scoped persisted records and date ranges.
- Money and Management behavior remains unchanged unless separately approved.
