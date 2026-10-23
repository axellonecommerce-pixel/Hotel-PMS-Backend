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
- Do not introduce guest/company portals, direct email/SMS, direct card processing, OTA sync, offline mutations, or payroll tax calculation into v1 without approval.

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
