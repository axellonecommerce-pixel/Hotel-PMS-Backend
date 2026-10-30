# Hotel PMS — Product, Engineering, and AI Rules

These rules apply to humans, AI coding tools, both repositories, database work, and documentation.

## 1. Source of truth

1. Approved `docs/prd.md` defines product behavior.
2. Approved `docs/user-flow.md` defines workflow sequencing.
3. Approved `docs/trd.md` and `docs/schema.md` define technical boundaries.
4. Approved `docs/design-system.md` defines UI behavior and visual tokens.
5. When documents conflict, stop and obtain owner clarification; do not silently choose.
6. Update affected documents whenever a requirement changes.

## 2. Authorization and scope

- Implement only approved requirements. Explain new cloud services, integrations, costs, permissions, and material architecture changes before using them.
- Never connect, purchase, deploy, or mutate an external/production service without explicit owner approval.
- Keep frontend and backend as separate repositories.
- Do not introduce guest/company portals, direct email/SMS, direct card processing, OTA sync, offline mutations, or payroll tax filing into v1 without approval. (Payroll tax *estimates* by state were approved on 2026-10-28.)

## 3. Privacy and security

- Never use real guest, employee, company, payment, payroll, or identity data in fixtures, tests, screenshots, prompts, logs, or commits.
- Never store full card numbers or CVV. Store only optional card type, last four, and external approval/reference.
- Enforce hotel isolation server-side and at the database layer; hiding UI is not authorization.
- Redact IDs, tokens, backup data, and payment details from logs/errors.
- Validate type, signature, size, and authorization for every uploaded/downloaded file.
- Prohibit direct production database edits, mass deletion, restore, or destructive production actions without explicit owner approval and a verified backup.

## 4. Domain integrity

- Store money in integer minor units with currency code; never use floating point.
- Store UTC timestamps and compute business dates in property timezone.
- Recheck availability in a transaction; never permit room-type or room overbooking.
- Room rent and linked tax move together. Editing rent recalculates its tax using the reservation tax snapshot.
- Non-company checkout requires zero balance; company balances transfer through approved direct-bill flows.
- Per-room deposits must resolve before that room checks out.
- Calculate cash Over/Short; never accept it as manual input.
- Closed Night Audit days cannot reopen.
- A manual No Show is valid only for a Reserved arrival on the current property business date. Night Audit converts any remaining same-day Reserved arrivals to No Show before closing the date.
- Same-day/day-use sales count as rooms sold but never remove overnight inventory availability.
- Preserve accepted rules version with signed registration records.
- Delete ID images at one year after seven-day warning; retain guest/stay data.

### 4.1 Every motel gets the same behaviour

- A fix or feature applies to every property: never branch on a property id, name, state or a specific record. Write rules from settings and data, not from what one motel happens to have.
- Every new setting has a default in `frontend/src/config/default-settings.ts`, and `normalizeSettings` merges nested defaults, so properties created earlier (and new ones created by the platform with a smaller settings document) get it without a migration.
- New motels are created by `backend/src/server/provisioning/platform-motel.ts`; anything a property needs to work (settings document, business day, owner employee, country/state/time zone) is created there, inside one transaction.
- Settings › Property is saved back to the `properties` row (name, address, country, state, time zone), so server code that reads the row and screens that read settings agree.
- Test changes against a property in another state (for example Texas) as well as California before release.

### 4.2 Financial reporting

- Revenue screens and Profit & Loss read the ledger and stop at the property's business date; nights booked for later dates are not revenue yet.
- Tax collected is a liability: show it beside revenue, never inside it.
- Profit & Loss is cash basis: an expense counts when it is paid. Unpaid OTA commission (Commission Payable) and unpaid payroll are not expenses.
- One source per figure: the same number on two screens comes from the same query or ledger account.

### 4.3 Payroll

- Overtime is calculated on the server from the time clock by the property's state (`backend/src/server/payroll/pay-calculation.ts`); workweeks run Monday to Sunday, the same weeks as weekly pay periods.
- State rules and 2026 tax tables live in `frontend/src/lib/payroll/us-payroll-rules.ts` with their sources and an "as of" date. Review them every January and July (minimum wage changes) and update the date.
- Tax amounts are estimates and must be labelled as estimates. Never present them as filed or exact withholding.
- Loading payroll creates the period for the saved schedule, so the screen must wait for saved settings before loading.
- An employee with a start date has a pay entry in every period from that date on (back to `SCHEDULE_DAYS`, 400 days) and none before it; moving the start date later removes unpaid entries before it. Without a start date, an employee is counted in the current period and in periods where they already have an entry.
- Each employee's periods follow their own pay schedule (`payFrequency` in Settings › Employees, else the motel's). An untouched unpaid entry in a period that is not on the employee's schedule (left from an earlier schedule) is removed; approved, adjusted or typed-in entries are kept.
- Hours typed in for a period are stored on the entry (`manualHours`) and are not overwritten by the time clock recount. Paid entries are never recounted.
- Clock times use the property's time zone, never a fixed zone. A text parameter cast to `timestamp` must go through `::text::timestamp`; postgres.js otherwise sends it as a time with zone and shifts it.

## 5. Database changes

- Every schema change uses a reviewed migration; no schema drift or hand-edited production tables.
- Migrations preserve existing data, include constraints/indexes, and document rollback/repair strategy.
- Every tenant table has enforceable property scoping.
- Use transactions and idempotency for financial posting, group checkout, invoice allocation, Night Audit, merge, backup, and restore.
- Do not delete records if doing so would orphan charges, allocations, refunds, deposits, signatures, or invoices.

## 6. UI/UX rules

- Use semantic design tokens; do not add raw colors inside feature components.
- Support light/dark mode and 320px phone through wide desktop without overlap, clipping, or hidden actions.
- Every feature remains available on phone/tablet; reorganize instead of silently removing.
- Meet WCAG 2.2 AA: keyboard operation, focus visibility, labelled inputs, screen-reader semantics, contrast, reduced motion, and non-color state cues.
- Use Lucide/SVG icons, not emoji as structural icons.
- Confirm destructive actions and clearly state impact. Preserve unsaved form data or warn before dismissal.
- Printed folio/registration layouts follow approved references and property branding.

## 7. Code and architecture

- Keep business rules in domain services/functions, not duplicated across React components or route handlers.
- Validate all external input with Zod and return field-specific recovery messages.
- Keep components focused, typed, and reusable; prefer existing primitives/tokens.
- Apply optimistic concurrency to editable records and return conflicts instead of last-write-wins overwrites.
- Avoid N+1 queries, unbounded lists, client-side authorization, and sensitive local storage.

## 8. Required verification before commit/push

- Run formatter/lint (when configured), typecheck, relevant unit/integration tests, and production build.
- Run migration/schema validation for backend changes.
- Test critical end-to-end workflows when affected: reservation/group inventory, ID merge, room move, rate/tax, folio move, deposit, payment/refund, checkout, company allocation, cash shift, Night Audit, report export, and backup restore.
- Test affected UI at phone, tablet, and desktop sizes, light/dark themes, keyboard, and reduced motion.
- Run `git diff --check`; inspect staged files; exclude secrets, real data, OS files, local agent instructions, and generated build output.
- Push only when explicitly requested. Verify local/remote commit IDs after push.

## 9. Documentation and review

- Requirement IDs from the PRD should be referenced in implementation issues/tests where practical.
- Architecture decisions that materially change the TRD require owner approval before implementation.
- Do not mark a feature complete based only on UI appearance; verify persistence, authorization, calculations, and recovery behavior end-to-end.
- The owner reviews and approves these documents before implementation starts.
