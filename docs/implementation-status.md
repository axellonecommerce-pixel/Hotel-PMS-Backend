# Requirements implementation status

Audit date: 2026-10-23

This is the code-backed traceability audit for the 65 formal requirements in `prd.md`. Those requirements consolidate the product owner's roughly 200 discovery answers.

## Status definitions

- **Verified demo:** The requested behavior is represented in the application UI and/or covered by executable domain tests. This does not by itself mean that every change survives a server restart.
- **Verified production path:** The previously missing durable API, transaction, worker, private-storage, security, or automated test path is implemented and has passed its applicable checks.
- **Partial:** A meaningful part exists, but permanent backend storage, scheduled processing, authorization, file handling, integration, or complete automated coverage is still missing.
- **Not implemented:** The required production behavior is not present.

## Audit summary

| Status | Count |
|---|---:|
| Verified demo | 25 |
| Verified production path | 40 |
| Partial | 0 |
| Not implemented | 0 |
| Total | 65 |

The 16 items that were partial in the October 16 audit now have durable implementation paths. This closes the recorded requirement gaps, but it does **not** turn every earlier “Verified demo” workflow into a production workflow: several operational screens still use React state and seeded data and must be migrated before a full live launch.

## Requirement-by-requirement traceability

| Requirement | Status | Evidence / remaining work |
|---|---|---|
| FR-TEN-001 | Verified demo | Protected product-team provisioning API transactionally creates the hotel, owner membership/employee, and starting settings. |
| FR-TEN-002 | Verified demo | APIs derive hotel scope from the authenticated user's active membership and reject cross-hotel access. |
| FR-TEN-003 | Verified demo | The full hotel configuration is loaded and saved through a tenant-scoped settings API; each save also transactionally synchronizes configured room types, rooms, and operational employees into relational production records used by workflows. |
| FR-TEN-004 | Verified demo | USD/US defaults are used and production schema includes currency/country-ready fields. |
| FR-GST-001 | Verified demo | Multi-guest data, ID fields, remarks, DNR, and payment-source UI/domain models exist. The guest directory now has a tenant-scoped PostgreSQL read/create/update API that persists manually entered profiles, contact/address edits, fixed rates, selectable guest status, notes, DNR state, vehicles, payment-source tokens, and guest remarks; multi-guest workflow coverage remains demo-backed. |
| FR-GST-002 | Verified production path | Guest ID images use the private Supabase bucket, identity metadata is durable, the daily worker warns seven days before expiry, deletes at one year, and writes a retention tombstone so backups cannot restore an expired image. |
| FR-GST-003 | Verified production path | Guest CSV import validates required ID type and number, then transactionally creates or merges tenant-scoped guest and identity records by normalized ID number. |
| FR-GST-004 | Verified demo | Matching-ID merge and payment-source deduplication behavior is implemented in the guest domain/context. |
| FR-GST-005 | Verified demo | DNR warning, reasoned override, and remark display exist. |
| FR-GST-006 | Verified demo | Extra guest uses the reservation guest flow and compact workspace layout. |
| FR-RES-001 | Verified demo | Room-type inventory is checked and sold-out types are blocked. |
| FR-RES-002 | Verified demo | Multi-room/group reservation state and combined folio behavior exist. |
| FR-RES-003 | Verified demo | Individual and bulk room checkout controls exist with room-attributed charges. |
| FR-RES-004 | Verified production path | The checkout API locks the reservation and selected rooms, validates deposits and balances, creates room folios with locked numbering, moves each room’s charges and linked tax, checks out rooms, and marks physical rooms dirty in one transaction. |
| FR-RES-005 | Verified production path | Company group checkout waits for every room, then transactionally creates exactly one draft company invoice containing all group folio charges and tax. |
| FR-RES-006 | Verified production path | The room-move API locks the reservation and both room assignments, blocks non-rentable or occupied destinations, stores the move reason and rate decision, updates the active reservation room/type, marks the vacated physical room dirty, and returns the complete posted-charge balance in one transaction. |
| FR-RES-007 | Verified production path | The Room Move Report reads tenant-scoped persisted moves by date range, including guest, old/new room, required reason, and the saved rate decision; its prior-period comparison uses the same API. |
| FR-RES-008 | Verified production path | Cancellation and no-show lock the reserved room assignments, void the original room charges, post balancing ledger reversals, and release inventory in one transaction. Reinstatement validates current inventory, restores the originally voided charges/rates, posts the corresponding ledger entries, and returns the stay to Reserved. |
| FR-RES-009 | Verified demo | OTA source and three payment-status choices exist. |
| FR-RAT-001 | Verified production path | The reservation workflow passes the selected Availability default or explicit rate code, accepts same or nightly-specific prices, validates one price per night, and transactionally persists nightly rates with posted room-rent and tax entries. |
| FR-RAT-002 | Verified production path | The rate-adjustment API locks posted room charges, updates nightly rates and linked tax from the reservation's stored tax snapshot, records balanced adjustments, recalculates the authoritative balance, and requires a reason for manual tax overrides. |
| FR-RAT-003 | Verified production path | The folio-charge API resolves the authenticated property's configured charge type, snapshots tax, requires an override reason, and durably creates, edits, and voids manual charges with balanced ledger adjustments. |
| FR-RAT-004 | Verified demo | Booking sources, commissions, and commission expense representation exist. |
| FR-RAT-005 | Verified demo | Configurable, date/room eligible, stackable promotions exist. |
| FR-FOL-001 | Verified production path | A row-locked PostgreSQL allocator supplies the shared folio/invoice sequence and is used by checkout and the document-number API. |
| FR-FOL-002 | Verified production path | Reservation folios are tenant-scoped database records. Extra folios, manual-charge moves, and each room's posted rent with its linked tax can be moved through row-locked server transactions. |
| FR-FOL-003 | Verified production path | Tenant-scoped folio deletion locks the folio and rejects primary or financially active folios; empty secondary folios can be removed. |
| FR-FOL-004 | Verified demo | Sent documents remain editable and resend updates sent state/date. |
| FR-FOL-005 | Verified demo | Folio/invoice/registration print layouts include hotel, stay, guest, and breakdown details. |
| FR-FOL-006 | Verified production path | Registration-rule edits create versioned records and each acceptance stores the exact rule version and immutable accepted content snapshot. |
| FR-CHK-001 | Verified demo | Zero-balance, direct-bill, and deposit-settlement checkout rules exist. |
| FR-PAY-001 | Verified production path | Tenant-scoped payment operations persist collection, allocation, deletion, and refund records; the server rejects a collection greater than the authoritative folio balance. |
| FR-PAY-002 | Verified demo | Optional card metadata is supported without full card/CVV persistence. |
| FR-PAY-003 | Verified production path | Refunds are durable records, reduce the allocated folio amount, and cannot exceed the unrefunded payment; deletion removes the tenant-owned payment, allocation, and refund records together. |
| FR-PAY-004 | Verified demo | BAD DEBT checkout settlement and loss representation exist. |
| FR-DEP-001 | Verified production path | Tenant-scoped security deposits and immutable hold/charge/release transactions now persist through the reservation workspace. The server prevents duplicate holds, caps deductions/releases at the held balance, and checkout continues to require every held deposit be settled. |
| FR-COM-001 | Verified production path | Company CRUD, payment terms, contacts, statuses, and per-room-type negotiated rates are editable in the UI and stored through tenant-scoped PostgreSQL APIs. Primary-contact SQL safely quotes the database column name, so creation, listing, and editing work on PostgreSQL. |
| FR-COM-002 | Verified demo | Checked-out Guest/Stay items can be marked Sent and moved to Invoices. |
| FR-COM-003 | Verified production path | The daily worker marks eligible invoices overdue and creates a persisted reminder notification every seven days until payment. |
| FR-COM-004 | Verified demo | One payment can allocate across invoices with partial allocation and company credit. |
| FR-HSK-001 | Verified production path | The all-room board loads and writes tenant-scoped housekeeping records; assignment, cleaning progress, and cleanliness update the authoritative physical room state. Settings hydrate that state on refresh, and housekeeping/maintenance changes publish a property-scoped refresh. |
| FR-HSK-002 | Verified production path | Arrival, checkout, and stayover context are derived from persisted reservation/room data. Employee cleaning productivity is counted from completed tenant housekeeping records and reloads with time entries. |
| FR-HSK-003 | Verified production path | Smoking configuration persists with each room and the shared room presentation renders its smoking designation in Housekeeping and the Floor Map. |
| FR-MNT-001 | Verified production path | Tenant-scoped PostgreSQL work orders persist the room, issue, priority, worker, cost, notes, service dates, and rentable/non-rentable period; reservations exclude overlapping non-rentable periods. Images and PDF receipts are uploaded to tenant-scoped private storage after the work order receives its durable ID. |
| FR-MNT-002 | Verified production path | Completion, extension, and explicit make-available actions are tenant-scoped persisted API operations. Completing work does not reopen inventory; making available explicitly resolves the block and the client marks the room dirty. |
| FR-TIM-001 | Verified production path | Housekeeping time clock and manual correction forms now load and upsert tenant-scoped PostgreSQL time entries. The server validates active motel staff, work date/times, break ordering, and one entry per employee per date. |
| FR-PAYR-001 | Verified production path | Payroll now creates the configured weekly, biweekly, semi-monthly, or monthly tenant pay period, derives completed time-entry minutes, snapshots hourly rates, and persists each employee payroll entry. Paid entries are not recalculated when a later refresh derives current-period payroll. |
| FR-PAYR-002 | Verified production path | Payroll approval, adjustment, paid status, and paid-on date persist in the tenant payroll entry. |
| FR-EXP-001 | Verified production path | Expense writes, vendors, recurring schedules, and optional receipts persist in tenant-scoped PostgreSQL/private storage. The daily job locks each due schedule, posts its expense and balanced ledger entries transactionally, then advances the next due date; the Expenses API reloads active schedules after refresh. |
| FR-CSH-001 | Verified production path | Cash reconciliation now writes tenant-scoped PostgreSQL cash shifts, adjustment transactions, and cash-drop records. The server reads the configured drawer float, retains it on every drop, rejects short counts without a reason, and verifies the named supervisor is an active Owner or Manager. |
| FR-CSH-002 | Verified production path | The durable cash-drop API calculates expected cash from the saved drawer float and signed adjustment ledger, persists count/drop totals, derives over/short status, and requires a reason for shortages. |
| FR-AUD-001 | Verified production path | Manual and scheduled Night Audit use an advisory lock and locked business-day row, store run results and blockers, close/open business days transactionally, and persist a failure notification. The current open business date is also exposed through a tenant-scoped read API for every operational screen. |
| FR-REV-001 | Verified production path | PostgreSQL ledger entries enforce balanced debit/credit posting for initial reservation room rent/tax, room moves, charge edits, and expenses; financial writes and ledger lines share the same transaction. |
| FR-REV-002 | Verified production path | The Revenue screen reads tenant-scoped daily room, tax, and miscellaneous revenue from immutable PostgreSQL ledger credits; its ADR, occupancy, and RevPAR calculations use that durable total. |
| FR-RPT-001 | Verified demo | Custom range, print, PDF/Excel export, comparison, and report detail controls exist. |
| FR-RPT-002 | Verified production path | Standard reports and tenant-scoped saved custom report definitions are connected to backend APIs; production saves are durably stored in the property settings record with duplicate-name protection. |
| FR-NOT-001 | Verified production path | Tenant- and role-scoped notifications persist in PostgreSQL, support read/resolve controls, and are produced by scheduled ID-retention, invoice-reminder, and Night Audit workflows. |
| FR-SRC-001 | Verified demo | Global search covers guests, reservations, rooms, companies, folios, and invoices. |
| FR-BKP-001 | Verified production path | The server produces a complete tenant snapshot with durable tables and private file bytes while removing expired/deleted ID-image keys. |
| FR-BKP-002 | Verified production path | Restore requires the typed hotel-specific confirmation, replaces tenant data in dependency order inside one PostgreSQL transaction, then restores private files. Owners and managers can also explicitly reset tenant operational data while retaining all property settings and configuration. |
| NFR-UX-001 | Verified demo | Responsive phone/tablet/desktop layouts and overflow controls exist across the main workspace. |
| NFR-UX-002 | Verified production path | Playwright plus axe-core now checks representative dashboards, operational boards, companies, settings, and reservation workspace views for serious/critical WCAG issues; skip-link and reduced-motion behavior are also exercised. |
| NFR-RT-001 | Verified demo | Tenant-scoped server-sent events update reservation clients without refresh; versioned writes return a conflict instead of overwriting a newer edit. |
| NFR-SEC-001 | Verified production path | API property scope comes from the authenticated production membership. All 62 public Supabase tables have RLS, and the live rollback-only isolation test proves Hotel A cannot read Hotel B property/company records. |
| NFR-QA-001 | Verified production path | The release checks include 29 domain/authorization tests, a live RLS integration check, TypeScript checks, and 49 browser tests spanning phone, tablet portrait/landscape, desktop, keyboard navigation, accessibility, and horizontal overflow. |

## Next production migration gates

The original 16 partial requirements are closed. Before a real hotel launch, the remaining demo-backed workflows should be migrated in this order:

1. Provision the first hotel owner, relational room types/rooms, business day, taxes, and charge types.
2. Link and deploy the backend, add its URL to the frontend environment, then deploy the frontend.
3. Run the same release suite against the deployed URLs with the first real hotel account.

