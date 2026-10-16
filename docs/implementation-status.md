# Requirements implementation status

Audit date: 2026-10-16

This is the code-backed traceability audit for the 65 formal requirements in `prd.md`. Those requirements consolidate the product owner's roughly 200 discovery answers.

## Status definitions

- **Verified demo:** The requested behavior is represented in the application UI and/or covered by executable domain tests. This does not by itself mean that every change survives a server restart.
- **Partial:** A meaningful part exists, but permanent backend storage, scheduled processing, authorization, file handling, integration, or complete automated coverage is still missing.
- **Not implemented:** The required production behavior is not present.

## Audit summary

| Status | Count |
|---|---:|
| Verified demo | 48 |
| Partial | 17 |
| Not implemented | 0 |
| Total | 65 |

All requirements now have an implementation path, but the product is **not yet production-complete against all approved requirements** because 17 remain partial. Most workflows are available for evaluation, while several operational screens still use React state and seeded data.

## Requirement-by-requirement traceability

| Requirement | Status | Evidence / remaining work |
|---|---|---|
| FR-TEN-001 | Verified demo | Protected product-team provisioning API transactionally creates the hotel, owner membership/employee, and starting settings. |
| FR-TEN-002 | Verified demo | APIs derive hotel scope from the authenticated user's active membership and reject cross-hotel access. |
| FR-TEN-003 | Verified demo | The full hotel configuration is loaded and saved through a tenant-scoped settings API. |
| FR-TEN-004 | Verified demo | USD/US defaults are used and production schema includes currency/country-ready fields. |
| FR-GST-001 | Verified demo | Multi-guest data, ID fields, remarks, DNR, and payment-source UI/domain models exist. |
| FR-GST-002 | Partial | Upload/download UI and retention rules exist; secure object storage, seven-day scheduled notification, and deletion worker are absent. |
| FR-GST-003 | Verified demo | Guest CSV import validates required ID type and number. |
| FR-GST-004 | Verified demo | Matching-ID merge and payment-source deduplication behavior is implemented in the guest domain/context. |
| FR-GST-005 | Verified demo | DNR warning, reasoned override, and remark display exist. |
| FR-GST-006 | Verified demo | Extra guest uses the reservation guest flow and compact workspace layout. |
| FR-RES-001 | Verified demo | Room-type inventory is checked and sold-out types are blocked. |
| FR-RES-002 | Verified demo | Multi-room/group reservation state and combined folio behavior exist. |
| FR-RES-003 | Verified demo | Individual and bulk room checkout controls exist with room-attributed charges. |
| FR-RES-004 | Partial | UI/domain logic exists; atomic backend folio split and checkout transaction are absent. |
| FR-RES-005 | Partial | Company group behavior exists in UI/domain; durable delayed invoice creation is not wired end-to-end. |
| FR-RES-006 | Verified demo | Move reason, rate choice, dirty source room, warnings, and out-of-order blocking exist. |
| FR-RES-007 | Verified demo | Date-filtered Room Move report exists. |
| FR-RES-008 | Verified demo | Early/late fees, cancellation, no-show, inventory release, and reinstatement controls exist. |
| FR-RES-009 | Verified demo | OTA source and three payment-status choices exist. |
| FR-RAT-001 | Verified demo | Same/different nightly rate entry and immediate planned postings exist. |
| FR-RAT-002 | Verified demo | Room-rent edit recalculates linked tax using the reservation tax snapshot. |
| FR-RAT-003 | Partial | Exemption and manual-tax fields exist; configured taxable charge types are not durably enforced server-side. |
| FR-RAT-004 | Verified demo | Booking sources, commissions, and commission expense representation exist. |
| FR-RAT-005 | Verified demo | Configurable, date/room eligible, stackable promotions exist. |
| FR-FOL-001 | Partial | Sequence settings and schema exist; transactional shared-number allocation is not exposed through a backend service. |
| FR-FOL-002 | Verified demo | Multiple folios and linked rent/tax movement exist. |
| FR-FOL-003 | Verified demo | Folio deletion is blocked when financial activity is linked. |
| FR-FOL-004 | Verified demo | Sent documents remain editable and resend updates sent state/date. |
| FR-FOL-005 | Verified demo | Folio/invoice/registration print layouts include hotel, stay, guest, and breakdown details. |
| FR-FOL-006 | Partial | Editable rules and acceptance schema exist; immutable accepted-version storage is not wired through an API. |
| FR-CHK-001 | Verified demo | Zero-balance, direct-bill, and deposit-settlement checkout rules exist. |
| FR-PAY-001 | Verified demo | All required payment methods exist and Other requires a note. |
| FR-PAY-002 | Verified demo | Optional card metadata is supported without full card/CVV persistence. |
| FR-PAY-003 | Verified demo | Payment deletion and bounded partial refund flows exist. |
| FR-PAY-004 | Verified demo | BAD DEBT checkout settlement and loss representation exist. |
| FR-DEP-001 | Verified demo | Per-room cash/card deposits, deductions, reasons, partial release, and folio display choice exist. |
| FR-COM-001 | Partial | Tenant-scoped company CRUD is connected; negotiated room-rate editing still needs durable UI/API fields. |
| FR-COM-002 | Verified demo | Checked-out Guest/Stay items can be marked Sent and moved to Invoices. |
| FR-COM-003 | Partial | Invoice statuses/reminder display exist; recurring seven-day reminder worker is absent. |
| FR-COM-004 | Verified demo | One payment can allocate across invoices with partial allocation and company credit. |
| FR-HSK-001 | Verified demo | All-room board, separate cleanliness/assignment, assign/unassign, and mark-clean flows exist. |
| FR-HSK-002 | Verified demo | Arrival/checkout/stayover context and productivity calculations exist. |
| FR-HSK-003 | Verified demo | Smoking designation/icon appears in Housekeeping and Floor Map. |
| FR-MNT-001 | Verified demo | Maintenance form supports requested operational fields and rentable status. |
| FR-MNT-002 | Verified demo | Completion and explicit make-available/dirty transition are separate. |
| FR-TIM-001 | Verified demo | Separate time events, live clock, complete manual shift, corrections, breaks, and configured overtime logic exist. |
| FR-PAYR-001 | Verified demo | Pay periods, payday, hourly/piece/total compensation, and gross-pay calculations exist. |
| FR-PAYR-002 | Verified demo | Paid state/date/method and optional correction note exist. |
| FR-EXP-001 | Partial | Expense and recurrence records now persist; receipt file bytes still need secure object storage. |
| FR-CSH-001 | Verified demo | Employee-shift cash, opening amount, multiple drops, and retained float exist. |
| FR-CSH-002 | Verified demo | Expected/count/over-short calculation and Other-expense note validation exist. |
| FR-AUD-001 | Partial | Manual/scheduled UI and blockers exist; durable scheduler, locked business day transaction, and failure notification job are absent. |
| FR-REV-001 | Partial | Accounting classifications are represented; a durable double-entry or equivalent posting service is not implemented. |
| FR-REV-002 | Verified demo | Gross/net revenue, ADR, both occupancy measures, and both RevPAR measures are shown. |
| FR-RPT-001 | Verified demo | Custom range, print, PDF/Excel export, comparison, and report detail controls exist. |
| FR-RPT-002 | Verified demo | Standard reports and tenant-scoped saved custom report definitions are connected to backend APIs. |
| FR-NOT-001 | Partial | Unified notification UI/read controls exist; persisted event production and scheduled alerts are absent. |
| FR-SRC-001 | Verified demo | Global search covers guests, reservations, rooms, companies, folios, and invoices. |
| FR-BKP-001 | Partial | Manual JSON backup download exists; retained files and a server-generated complete hotel snapshot are absent. |
| FR-BKP-002 | Partial | Destructive confirmation and restore UI exist; transactional server restore and expired-image filtering are absent. |
| NFR-UX-001 | Verified demo | Responsive phone/tablet/desktop layouts and overflow controls exist across the main workspace. |
| NFR-UX-002 | Partial | Light/dark, focus, keyboard, and semantic improvements exist; complete WCAG 2.2 AA audit/automation is outstanding. |
| NFR-RT-001 | Verified demo | Tenant-scoped server-sent events update reservation clients without refresh; versioned writes return a conflict instead of overwriting a newer edit. |
| NFR-SEC-001 | Partial | Property-scoped schema and authorization policy tests exist; API tenant identity is still fixed and end-to-end RLS evidence is incomplete. |
| NFR-QA-001 | Partial | Backend domain tests cover important rules; complete automated browser/API coverage for every named release flow is absent. |

## Production completion gates

The remaining work should be completed in this order:

1. Add backend services/APIs for folios, charges, payments, deposits, companies, invoices, housekeeping, maintenance, time, payroll, expenses, cash, reports, notifications, Night Audit, and backup/restore.
2. Move uploaded ID images and receipts to secure object storage and add retention/reminder workers.
3. Add database transactions, idempotency keys, and document-sequence locking to the remaining financial workflows.
4. Add complete end-to-end release tests and an automated WCAG 2.2 AA audit.

