# HotelKey public workflow evidence and implementation mapping

## Scope and evidence boundary

This comparison uses HotelKey's public knowledge-base articles only. It does
not use HotelKey source code, private APIs, credentials, customer data, or
protected screens. The implementation in this repository remains original and
keeps the existing PMS UI, Money, and Management areas intact.

An authenticated test environment has not been supplied, so items marked
**not runtime-verified** are documentation findings rather than observations
of a logged-in HotelKey account.

## Public evidence

| Workflow | Public evidence | Product behavior documented | PMS mapping |
| --- | --- | --- | --- |
| Front desk lifecycle | [Front desk operations](https://kb.hotelkeyapp.com/hk-kb/front-desk-operations) and [Check In / Check Out](https://kb.hotelkeyapp.com/hk-kb/check-in-check-out) | HotelKey documents a connected front-desk flow covering availability, guest profiles, check-in, check-out, room move, night audit, and business-day close. | Existing Arrival, Departure, In House, reservation workspace, and room move routes remain the single lifecycle source of truth. |
| No-show recovery | [No Show Reinstatement](https://kb.hotelkeyapp.com/hk-kb/reinstate-for-no-show-reservations-ng) | A no-show is reinstated from an arrival/search quick action only when its original arrival matches the current business date. The article distinguishes that quick action from a broader “reinstate as booked” reservation action. | Keep a fast current-business-day no-show path in Arrivals; preserve the PMS's guarded reinstatement action for audit-safe restoration where pricing and inventory are still valid. |
| Day-use stays | [Day Use / Zero-Night Reservations](https://kb.hotelkeyapp.com/hk-kb/day-use-zero-night-reservations-ng) | Equal arrival and departure dates create a zero-night stay; extending departure makes it overnight. Day use is included in occupancy, ADR, and revenue and checkout moves the room to cleaning, without reducing overnight inventory. | Zero-night dates are accepted by reservation APIs and UI; departure and housekeeping behavior use the existing checked-in/check-out lifecycle. The tenant-scoped Occupancy report counts day use as rooms sold without subtracting it from overnight availability. |
| Night audit | [Final Audit](https://kb.hotelkeyapp.com/hk-kb/final-audit-ng) and [Night Auditor Key Reports](https://kb.hotelkeyapp.com/hk-kb/night-auditor-key-report-ng) | Final audit presents operational, room-revenue, charges, tax/payment, cash-drop, and statistical information. Night-audit procedures require review of unresolved activity before business-day close. | `runNightAudit` blocks unpaid departure/in-house folios, deposits, open shifts, and critical operational issues. It then converts unarrived same-day reservations to no-shows before advancing the business day. |
| No-show and late-cancel reporting | [No Show and Late Cancel report](https://kb.hotelkeyapp.com/hk-kb/no-show-and-late-cancel) | The documented report includes confirmation, guest, company, dates, amount, status/sub-status, user, and remarks. | The tenant-scoped **No Show & Late Cancel** report reads current cancelled/no-show reservations, their durable processing date, posted fee, and remarks. Reinstated records are deliberately excluded from this current-status report. |
| Report design | [Reports](https://kb.hotelkeyapp.com/hk-kb/reports-1) and [Final Audit](https://kb.hotelkeyapp.com/hk-kb/final-audit-ng) | HotelKey supports configured, scheduled, and dynamic reports; final-audit output contains daily operational and financial summaries. | Preserve existing Report UI. Add only original operational read models when a verified gap remains; do not alter accounting behavior through reporting. |

## Implementation decisions

### Adopt

- A single business-date lifecycle: reservation → check-in → in-house →
  check-out, with day-use supported as a same-day check-in/check-out.
- Night audit may close remaining same-day unarrived reservations as no-shows
  only after financial and operational blockers are clear.
- No-show/cancellation releases inventory while keeping an auditable fee,
  charge, and lifecycle record.
- Reinstatement must re-check rentable inventory and prior pricing rather than
  blindly reopening a released stay.

### Adapt

- The PMS uses its existing navigation, wording, design system, and data
  model. It does not copy HotelKey visuals, labels, code, or assets.
- A current-business-day no-show quick-action rule is used only for the
  arrival board. Broader reinstatement remains an explicit, guarded
  reservation action because the PMS must preserve its existing audit trail.
- Final-audit concepts are presented through the existing reporting area and
  night-audit blockers, not a copied report layout.

### Reject

- Storing external PMS credentials, reproducing HotelKey interfaces, or
  importing HotelKey source/data.
- Advancing the business day with a non-zero in-house folio balance.
- Restoring a no-show/cancellation if its prior room or pricing history is no
  longer safe to restore.

## Verification requirements before release

1. Create, check in, and check out a zero-night reservation; confirm it is in
   the departure workflow and the room becomes dirty on checkout.
2. Attempt night audit with a non-zero in-house folio and confirm it fails.
3. Leave an arrival unprocessed, run night audit, and confirm it becomes a
   no-show before the business date advances.
4. Cancel/no-show then reinstate a reservation; confirm original inventory,
   rates, charges, and audit events are restored only when valid.
5. Verify reports remain read-only and show the correct lifecycle status.
6. Verify the occupancy report counts a same-day stay as day-use sold while
   keeping the room available for an overnight booking.
