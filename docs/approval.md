# Hotel PMS approval record

Status: **Approved**
Scope: Multi-hotel Hotel PMS v1

This record is the approval gate required by `docs/rules.md`. It does not
claim that a screen is production-ready merely because it is visible in the
UI. The accompanying `implementation-status.md` is the source for the
current evidence and remaining migration work.

## Documents submitted for approval

- `prd.md` — product behaviour and 65 formal requirements.
- `trd.md` — tenancy, API, persistence, authentication, and deployment
  boundaries.
- `user-flow.md` — reservation, stay, finance, housekeeping, maintenance,
  Night Audit, and backup journeys.
- `design-system.md` — responsive, accessible operational UI rules.
- `schema.md` — tenant-scoped PostgreSQL target schema and constraints.
- `rules.md` — security, data integrity, verification, and release rules.

## Owner decision required

Approve only if the following are accepted:

1. One active property membership per v1 user, with server-side tenant
   enforcement and no cross-property access.
2. Every production record is property-scoped and financial values are stored
   in integer cents.
3. The documented role permissions, workflows, retention policy, and
   confirmation requirements are the intended v1 behaviour.
4. The remaining demo-backed client modules listed in
   `implementation-status.md` are not represented as production-complete until
   their tenant APIs and end-to-end tests are delivered.

## Approval fields

| Field | Value |
|---|---|
| Owner approval | Approved |
| Approved by | Project owner |
| Approval date | October 21, 2026 |
| Approved document versions | Current repository versions of PRD, TRD, user flow, design system, schema, rules, and this approval record |
| Approved exceptions / notes | Approval was provided in writing. The implementation-status record remains authoritative for evidence and any remaining migration work. |

To approve, the owner must explicitly confirm all six documents and this
record in writing. Any requirement change after approval requires a new
decision and an updated record.
