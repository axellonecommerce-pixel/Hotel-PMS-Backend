# Hotel PMS — Product Requirements Document

Status: **Approved** — owner approval recorded in `docs/approval.md`.
Version: 1.0  
Product name: Hotel PMS (working name)

## 1. Product vision

Hotel PMS is a cloud-based property-management system for independent hotels. Each hotel has one independent account and completely isolated data. The product replaces spreadsheets and disconnected front-desk processes with one responsive workspace for reservations, stays, folios, payments, companies, housekeeping, maintenance, cash control, payroll, revenue, and reports.

The first release is employee-only. It supports many hotels, but one owner account cannot manage several properties. The product team creates each hotel account; the hotel's owner or manager then maintains property settings and employees.

## 2. Users and access

| Role | Required access |
|---|---|
| Owner | All features and settings |
| Manager | All features and settings |
| Front Desk | Reservations, guests, rates, charges, payments, refunds, checkout, companies, housekeeping, maintenance, cash drops, payroll/financial visibility, and reports |
| Accountant | Add/edit payments, expenses, payroll, and reports |

- Every employee has a unique email/password. Password-only login is sufficient.
- Only an owner or manager resets passwords and disables users.
- Disabled users retain attribution on existing records.
- No inactivity logout or MFA is required in v1.
- Guests, housekeepers, maintenance workers, and company contacts do not log in.
- The product does not require an edit/deletion audit trail in v1.

## 3. Functional requirements

### 3.1 Hotel setup and tenancy

- **FR-TEN-001:** The product team creates hotel accounts.
- **FR-TEN-002:** Data must be isolated by hotel; one hotel can never access another hotel's data.
- **FR-TEN-003:** A hotel configures identity, logo, contact details, timezone, rooms, room types, floors, rates, floor map, taxes, currency-ready settings, employees, rules, checkout times, cash float, payroll periods, invoice due days, and Night Audit time.
- **FR-TEN-004:** V1 uses US conventions/USD but the data model must allow additional countries/currencies later.

### 3.2 Guests and identity

- **FR-GST-001:** A reservation may contain multiple guests. Each guest stores name, phone, address, ID type/number, ID image, dated append-only remark entries, DNR information, and payment-source metadata. Adding a new guest remark never replaces an earlier remark.
- **FR-GST-002:** ID images may be uploaded or scanned and are retained for one year. Staff receive an in-app notification seven days before automatic image deletion and can download the guest profile plus image as PDF. Other guest/stay data is retained until an authorized deletion.
- **FR-GST-003:** Excel/CSV guest import is supported; ID type and ID number are mandatory. Other bulk imports are out of scope.
- **FR-GST-004:** Matching ID numbers automatically merge duplicate profiles. The newest profile details win; remarks and DNR data merge; identical payment sources deduplicate; distinct payment sources remain.
- **FR-GST-005:** DNR opens a warning rather than a hard block. Staff may override only after entering a reason. All guest and DNR remarks appear in reservations.
- **FR-GST-006:** Adding an extra guest uses the same ID → basic data → contact flow as reservation creation, including returning-guest lookup and optional ID image capture. The reservation guest summary uses a compact single-screen layout on tablet and desktop.

### 3.3 Reservations, rooms, and groups

- **FR-RES-001:** Reservations may be created without a room number but must reserve available room-type inventory. Sold-out room types are disabled; overbooking is blocked.
- **FR-RES-002:** A reservation may contain one or many rooms. Multiple rooms form a group reservation with one main guest, one combined balance, and initially one combined folio.
- **FR-RES-003:** Group rooms can check in/out individually or through bulk checkout. The combined folio identifies room rent/tax/extras per room.
- **FR-RES-004:** On partial non-company checkout, the departing room's rent, tax, and extras move automatically to a separate folio and must be paid to zero. Remaining rooms stay on the group folio. All rooms checking out together may use one combined payment/folio.
- **FR-RES-005:** On partial company checkout, room charges transfer toward one group company invoice. The invoice is created only after all group rooms check out.
- **FR-RES-006:** Staff may change room or room type only after entering a remark. Moves use a Move Room popup: choose the room type, then a room on the floor map where only free rooms of that type are selectable; group stays choose which room moves; unassigned rooms are assigned the same way. If no room is chosen, the reservation keeps its room and type. They choose whether to retain or replace the rate. The prior room becomes vacant/available and dirty. A dirty available destination is allowed after a warning; out-of-order rooms are blocked.
- **FR-RES-007:** All moves appear in a date-filtered Room Move Report.
- **FR-RES-008:** Early check-in, cancellation fee, late checkout, and no-show fee are supported. A No Show may be marked only for a reservation arriving on the current business date; it releases inventory immediately. Staff may reinstate a cancelled or No Show reservation after the system confirms that the assigned room and room-type inventory are still available; reinstatement restores the stay charges and group-room reservation statuses.
- **FR-RES-009:** Online/OTA bookings are entered manually. Payment status supports Guest Pays Hotel, Paid Online, and Virtual Card Pending. Selecting a commissioned reservation source shows OTA Details in the payment breakdown: OTA Gross Amount (rent + tax), OTA Tax Amount, OTA Commission (percentage of room rent before tax), and OTA Net Amount (gross − commission). For Paid Online and Virtual Card Pending, the OTA deducts its commission: the commission settles automatically on the folio as a non-cash, non-refundable "OTA COMMISSION" entry, so the balance due is the net amount the OTA remits. For Guest Pays Hotel, the hotel collects the gross amount and the commission is payable to the OTA.

### 3.4 Rates, promotions, taxes, and charges

- **FR-RAT-001:** Staff may apply one nightly rate to the stay or different rates by night. All planned room rent and tax post when the reservation is created.
- **FR-RAT-002:** Editing room rent recalculates linked tax using the reservation's stored tax rate. Existing reservations retain their original tax rate when settings change.
- **FR-RAT-003:** Managers configure taxable extra-charge types. Manual tax changes require a reason. Tax-exempt stays require an exemption reason/certificate number.
- **FR-RAT-004:** Hotels configure booking sources and commissions. OTA commissions post as expenses (credited to Commission Payable when the hotel collects, or to Guest Receivable when the OTA deducted it). Commission deducted by the OTA is recorded as an "OTA Commission" expense immediately; commission on Guest Pays Hotel bookings shows as payable on Expenses until staff pay it, which records the expense. Staff may edit a reservation's total commission with a reason until a payable commission has been paid. Cancel/No Show reverses an unpaid commission and reinstatement restores it. The OTA Commission report shows gross, tax, commission, net, settlement, paid and payable per reservation.
- **FR-RAT-005:** Hotels configure promotions with discount, eligible room types, and date range. Staff manually select promotions and may stack multiple promotions.

### 3.5 Folios, documents, and checkout

- **FR-FOL-001:** Folios and company invoices use one hotel-configurable shared sequence (prefix, format, starting number, annual reset setting).
- **FR-FOL-002:** Unlimited folios may exist on a reservation. Charges can move between folios; room rent and its tax always move together.
- **FR-FOL-003:** A folio may be deleted only when it has no charges, payments, or deposit activity.
- **FR-FOL-004:** Sent documents remain editable. Resending replaces the sent date with the latest date.
- **FR-FOL-005:** Folio/invoice output matches the supplied folio reference; registration output matches the supplied registration-card reference. All include configurable hotel logo/contact details and every guest name. Room charges support total plus nightly/room breakdown.
- **FR-FOL-006:** Hotels edit their own rules/regulations. Signed registration cards permanently retain the exact accepted version.
- **FR-CHK-001:** Non-company checkout requires a zero balance. Company balances transfer to company direct billing. Deposits for the checked-out room must be fully released or charged first.

### 3.6 Payments, refunds, debt, and deposits

- **FR-PAY-001:** Methods: cash, credit card, debit card, check, bank transfer, direct bill, and other. Other requires a note.
- **FR-PAY-002:** Cards are processed outside the PMS. Optional recorded fields are card type, last four digits, and approval/reference number. Full card/CVV storage is forbidden.
- **FR-PAY-003:** Incorrect payments may be permanently deleted by authorized roles. Refunds select the original payment, support multiple partial refunds, and cannot exceed the unrefunded amount.
- **FR-PAY-004:** BAD DEBT settles an uncollectible guest balance for checkout and posts as a separate loss/expense.
- **FR-DEP-001:** Security deposits are per room, including groups, and may be card authorization or cash. Deductions require notes, support multiple reasons, allow partial release, and can optionally appear on the printed folio.

### 3.7 Companies and accounts receivable

- **FR-COM-001:** Companies have contacts, billing address, negotiated rates by room type, and status. All use the hotel's shared due-period setting; no credit limit is required.
- **FR-COM-002:** Checked-out stays remain in Guest/Stay until staff marks them Sent. Sending is performed outside the app; the button records sent state/date and moves the item to Invoices.
- **FR-COM-003:** Staff can mark one selected invoice sent, track sent/overdue/partial/paid state, and receive unresolved overdue reminders every seven days.
- **FR-COM-004:** One company payment may allocate to many invoices until fully allocated. Partial allocations are allowed. Excess becomes company credit and staff chooses when to apply it.

### 3.8 Housekeeping and maintenance

- **FR-HSK-001:** All hotel rooms appear. Cleanliness (Dirty/Clean) and assignment (Assigned/Unassigned) are separate. One housekeeper per room; manager/front desk assigns, unassigns, and marks clean.
- **FR-HSK-003:** Rooms store a Smoking or Non-Smoking designation. Smoking rooms show a clear smoking icon in Housekeeping and Floor Map views.
- **FR-HSK-002:** Room cards show arrival, checkout, and stayover context. Productivity reports show rooms cleaned and average rooms per paid work period using clock-in/out time; no per-room timer is required.
- **FR-MNT-001:** Maintenance stores room, problem, priority, worker, cost, notes, dates, photos, and receipts. Staff choose rentable versus out of order.
- **FR-MNT-002:** Completing work does not reopen inventory. Staff explicitly make the room available, after which it is dirty.

### 3.9 Time, payroll, expenses, and cash

- **FR-TIM-001:** One clock-in/out period per housekeeper per day. Staff can record clock-in, break start/end, and clock-out as separate events, use the live time clock, or enter the completed shift at once. Staff can correct the work date and times. Only the recorded break duration is deducted. Overtime/double-time rules follow the hotel's configured jurisdiction.
- **FR-PAYR-001:** Hotels configure weekly/biweekly/semi-monthly or custom pay periods and payday. Employees may be hourly, quantity × fixed rate, or description + total amount. The PMS calculates hours and gross pay only.
- **FR-PAYR-002:** Payroll records show paid status, date, and method. Owner/manager/accountant can correct time; correction note is optional.
- **FR-EXP-001:** Hotels configure categories, vendors, recurring expenses, payment method, and optional receipt.
- **FR-CSH-001:** Cash is tracked by employee shift. Opening cash is confirmed; multiple drops per shift are allowed; a hotel-configured float remains for the next shift.
- **FR-CSH-002:** Expected cash includes recorded cash activity. Over/Short is calculated automatically from expected versus counted cash; it is never manually entered. Other cash expense requires a note.

### 3.10 Night Audit, revenue, reports, notifications

- **FR-AUD-001:** Night Audit may run manually or at a hotel-configured time. As in HotelKey, in-house guests may carry a balance and a held deposit overnight; they must pay before checkout. Night Audit stops only for unpaid departures (due out or overdue), unresolved deposits on departing stays, open shifts, or other blocking issues. Before it advances the business day, any unprocessed arrival for that business date becomes a No Show. Closed days cannot reopen. Failed automatic runs notify owner/manager in-app. The deployed scheduler must not promise exact property-local timing unless its infrastructure can deliver it.
- **FR-REV-001:** Taxes and refundable deposits are liabilities, not revenue. Charged deposit deductions become the configured revenue/charge type. Refunds reduce revenue on refund date; BAD DEBT is a separate loss; OTA commissions are expenses.
- **FR-REV-002:** Show Gross Revenue and Net Revenue. ADR counts all sold rooms, including a zero-rate room and same-day/day-use rooms. Day use contributes to rooms sold and occupancy without reducing overnight availability. Show occupancy and RevPAR both including and excluding out-of-order rooms.
- **FR-RPT-001:** Every report supports custom dates, print, PDF, and Excel. Financial reports support prior-period comparison and drill-down.
- **FR-RPT-002:** Hotels build and save custom reports/columns. Required standard reports include revenue/metrics, room moves, occupancy, No Show & Late Cancel, cash drops, expenses, payroll, housekeeping productivity, maintenance, guest/stay, folios, company A/R, refunds, bad debt, Night Audit, and a Final Audit control summary. The Final Audit summary combines durable ledger, payment, cash-drop, occupancy, and business-day data, and must never certify an unrun or blocked Night Audit as closed. Reports must read tenant-scoped persisted records when the PMS API is connected.
- **FR-NOT-001:** One notification center contains overdue invoices, upcoming ID-image deletion, Night Audit failures, and operational alerts. Items remain until read or resolved.
- **FR-SRC-001:** Global search finds guests, reservations, rooms, companies, folios, and invoices.

### 3.11 Backup and restore

- **FR-BKP-001:** Owner/manager manually downloads a full, non-password-protected hotel backup containing data and retained files. The product provides no scheduled backup feature to hotel users.
- **FR-BKP-002:** Owner/manager can upload and restore a backup only after confirming current hotel data will be replaced. Expired/deleted ID images must not re-enter an active backup.

## 4. Experience and quality requirements

- **NFR-UX-001:** Every feature works on phones, tablets, and desktop; no overlap, clipping, or inaccessible action.
- **NFR-UX-002:** Light/dark modes, keyboard operation, screen-reader semantics, visible focus, non-color status cues, and WCAG 2.2 AA are required.
- **NFR-RT-001:** Concurrent changes appear without refresh. Conflicting edits warn the second editor before overwrite.
- **NFR-SEC-001:** Hotel isolation is enforced server-side and in the database. Test data must never use real personal/payment information.
- **NFR-QA-001:** Automated checks cover reservation, group stay, deposits, payments/refunds, checkout, company invoicing, Night Audit, and backup restore before release.

## 5. Explicitly out of scope for v1

- Direct card processing or storage of full card details/CVV
- Automatic OTA/channel-manager synchronization
- Direct guest/company login
- Direct email/SMS delivery from the PMS
- Offline operations
- Payroll tax/withholding/net-pay calculation
- Multi-property management under one owner account
- Help/tutorial section

## 6. Approval and delivery

This PRD and its companion documents must be approved before implementation. Every requirement is v1 scope unless explicitly listed as later/out of scope. Documentation must change with business rules. Implementation occurs in traceable phases with tests and owner review.
