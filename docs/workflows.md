# Hotel PMS — Operating and Release Workflows

How work moves through the PMS for every motel, and how a change is released so that every motel — existing and new — gets it. Product rules are in `prd.md`, sequencing diagrams in `user-flow.md`, engineering rules in `rules.md`.

## 1. Every motel

A motel is one `properties` row. Everything else is scoped to it by `property_id`. A release must work the same for every row.

**When a motel is created** (Platform › Create motel, `server/provisioning/platform-motel.ts`), one transaction creates:

1. The property: name, address, phone, country, state/province, time zone.
2. The owner's sign-in, membership and employee record.
3. The settings document with the property details, including country and state.
4. The first open business day, in the motel's time zone.
5. The subscription.

**When an existing motel opens the app**, its saved settings are merged over the current defaults (`normalizeSettings`), nested objects included. A feature added later appears with its default, and nothing has to be copied into each motel.

**Before releasing a change, check:**

- [ ] It reads settings or data, never a specific property id, name or record.
- [ ] A new setting has a default in `default-settings.ts`, and the backend falls back to the same default.
- [ ] A new required piece of setup is created in `platform-motel.ts` for new motels, and created on first use for existing ones.
- [ ] Location-dependent behaviour (payroll, time zone, business date) uses the property's country, state and time zone.
- [ ] It was tried with a California property and with a property in another state (for example Texas).
- [ ] Schema changes go through a reviewed migration (rules.md §5); none are applied to production without the owner's approval.

## 2. Money workflows

| Figure | Where it comes from | Counted when |
|---|---|---|
| Room revenue | Ledger `Room Revenue` | The night's business date has been reached |
| Folio charges and Other Revenue | Ledger `Revenue:<category>` | Posted |
| Tax collected | Ledger `Tax Payable` | Shown beside revenue, never as revenue |
| OTA commission (Guest pays hotel) | Accrued as `Commission Payable` | Expense when paid to the OTA (Expenses › OTA Commission) |
| OTA commission (OTA collects) | Deducted from the payout | Expense on arrival (already paid) |
| Expenses and paid outs | `expenses`, `paid_outs` | Their date (recorded when paid) |
| Wages | `payroll_entries` | Marked Paid, on the paid date |

- The Revenue screen total includes tax. Profit & Loss shows revenue without tax, and states that revenue plus tax equals the Revenue total.
- A period that is still running (this month, this year) ends at today's business date.

## 3. Payroll workflow

1. **Settings › Property:** country and state. This decides the payroll rules: minimum wage, overtime, tax brackets, pay frequency, final pay and breaks.
2. **Settings › Payroll:** pay schedule (weekly, biweekly, semi-monthly or monthly), plus an optional city or county minimum wage.
3. **Pay setup:** in the Payroll drawer, set each employee to hourly (rate) or salary (amount per pay period).
4. **Hours:** the time clock provides them. The server splits them into regular, overtime and double time by state, with Monday-to-Sunday workweeks.
5. **Review:** check gross pay, estimated deductions and estimated take-home. Payroll flags rates below the minimum wage.
6. **Approve, then Mark Paid:** record the method (Cash, Check, Direct deposit or Other) and the paid date. To change a paid entry, mark it Pending first.
7. **Profit & Loss** includes the paid wages under Schedule C line 26.

State data is a reference compiled for 2026; see the "as of" date on the Payroll screen. Review it each January and July, when minimum wages change. Taxes are estimates; the PMS does not file payroll.

## 4. Release workflow

1. Work on the feature branch.
2. Backend: run `npx tsc --noEmit -p .` and `bun test`.
3. Frontend: run `bunx tsc --noEmit -p .` and `bunx next build`.
4. Check affected screens at phone, tablet and desktop sizes. Tests against production data run in rolled-back transactions, and real records are never changed.
5. Update `prd.md`, `trd.md`, `rules.md`, `user-flow.md` and this file in **both** repositories when behaviour changes. The `docs/` folders are kept identical.
6. Merge to `main` (Netlify frontend, Vercel backend). Verify on production with the owner's account.
