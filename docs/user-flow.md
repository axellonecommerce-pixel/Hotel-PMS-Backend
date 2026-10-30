# Hotel PMS — User Flows

Status: **Approved** — owner approval recorded in `docs/approval.md`. These diagrams describe required behavior, not current implementation.

## 1. Reservation to checkout

```mermaid
flowchart TD
  A[Create reservation] --> B{Rooms requested}
  B -->|One| C[Reserve room type inventory]
  B -->|Many| D[Create group reservation]
  C --> E[Assign room now or later]
  D --> E
  E --> F[Add primary or extra guest]
  F --> F1[Enter or scan required ID]
  F1 --> F2[Find returning guest or enter basic data]
  F2 --> F3[Enter contact details and attach guest]
  F3 --> G[Post all nightly rent and tax]
  G --> H[Check in room or selected group rooms]
  H --> I{Checkout type}
  I -->|Non-company| J[Resolve room deposit and make balance zero]
  I -->|Company| K[Resolve deposit and transfer balance to company]
  J --> L[Checkout]
  K --> L
  L --> M[Room becomes dirty and available]
```

### Cancel, No Show, and reinstate

```mermaid
flowchart TD
  A[Reserved stay] --> B{Release reason}
  B -->|Cancelled| C[Release inventory and optionally post cancellation fee]
  B -->|No Show on current business date| D[Release inventory and optionally post no-show fee]
  C --> E[Staff chooses Reinstate Reservation]
  D --> E
  E --> F[Check assigned rooms and room-type inventory]
  F -->|Unavailable| G[Block reinstatement and explain what must change]
  F -->|Available| H[Restore Reserved status, group-room statuses, rent, tax, total, and balance]
```

## 2. Group partial checkout

```mermaid
flowchart TD
  A[Group has combined folio] --> B[Select one room to checkout]
  B --> C{Company reservation?}
  C -->|No| D[Create separate room folio]
  D --> E[Move room rent + linked tax + extras]
  E --> F[Collect payment until zero]
  C -->|Yes| G[Move room charges to company group billing]
  F --> H[Resolve room deposit]
  G --> H
  H --> I[Checkout selected room]
  I --> J[Other group rooms remain checked in]
  J --> K{All company rooms checked out?}
  K -->|Yes| L[Create one company group invoice]
```

## 3. Room move

```mermaid
flowchart LR
  A[Choose Move Room] --> B[Enter required remark]
  B --> C[Choose clean or dirty available room]
  C --> D{Dirty?}
  D -->|Yes| E[Show warning and confirm]
  D -->|No| F[Continue]
  E --> F
  F --> G[Keep existing rate or use new rate]
  G --> H[Move guest]
  H --> I[Old room: available + dirty]
  H --> J[Write Room Move Report entry]
```

## 4. Folio, payment, and deposit

```mermaid
flowchart TD
  A[Reservation charges] --> B[One or more folios]
  B --> C[Move charge if needed]
  C --> D[Room rent and tax move together]
  B --> E[Record external payment method]
  E --> F{Refund later?}
  F -->|Yes| G[Select original payment]
  G --> H[Refund up to unrefunded amount]
  B --> I[Per-room security deposit]
  I --> J{At checkout}
  J --> K[Release all]
  J --> L[Charge documented deductions and release rest]
  K --> M[Deposit resolved]
  L --> M
```

## 5. Company invoicing and allocation

```mermaid
flowchart TD
  A[Company stay checks out] --> B[Guest/Stay: ready to send]
  B --> C[Staff downloads and emails outside app]
  C --> D[Mark Sent]
  D --> E[Invoice list with newest sent date]
  E --> F[Record company payment]
  F --> G[Allocate across selected invoices]
  G --> H{Money remaining?}
  H -->|Invoices unpaid| G
  H -->|Payment excess| I[Store company credit]
  I --> J[Staff chooses future invoice to credit]
  E --> K{Overdue?}
  K -->|Yes| L[In-app reminder every 7 days]
```

## 6. Cash shift

```mermaid
flowchart TD
  A[Employee opens shift] --> B[Count and confirm opening cash]
  B --> C[Record cash payments, refunds, expenses and drops]
  C --> D[Optional additional drops]
  D --> E[Count closing cash]
  E --> F[System calculates expected cash]
  F --> G[System calculates Balanced / Over / Short]
  G --> H[Leave configured drawer float]
  H --> I[Drop remainder and close shift]
```

## 6a. Payroll run

```mermaid
flowchart TD
  A[Owner sets the property's state in Settings › Property] --> B[Choose pay schedule: weekly, biweekly, semi-monthly or monthly]
  B --> C[Set each employee: hourly rate or salary per period, and start date]
  C --> C2[Payroll creates every pay period since the start date: Pay Schedule shows pay date, amount, Paid or Pending]
  C2 --> D[Housekeepers clock in and out, or staff type hours for a past period]
  D --> E[Payroll splits hours: regular, overtime, double time by state]
  E --> F[Review gross, estimated taxes and take-home; fix rates below minimum wage]
  F --> G[Approve]
  G --> H[Mark Paid: Cash, Check, Direct deposit or Other, with the paid date]
  H --> I[Profit & Loss counts the wages on the paid date]
```

## 6b. Profit & Loss

```mermaid
flowchart TD
  A[Choose period] --> B[Period still running ends at today's business date]
  B --> C[Revenue: posted room nights and charges, tax shown separately]
  C --> D[Expenses: paid expenses, paid outs, paid or deducted OTA commission, paid payroll]
  D --> E[Net profit, Schedule C view, print / CSV]
```

## 6c. Create a motel (platform admin)

```mermaid
flowchart TD
  A[Platform › Create motel] --> B[Enter name, address and phone]
  B --> C[Choose country, then state / province]
  C --> D[Time zone suggested from the state; can be changed]
  D --> E[Owner login and subscription]
  E --> F[Property, settings, business day and owner created in one transaction]
  F --> G[Owner signs in: Settings › Property shows country, state and time zone; Payroll shows that state's rules]
```

## 7. Maintenance and housekeeping

```mermaid
flowchart TD
  A[Create maintenance issue] --> B{Keep room rentable?}
  B -->|No| C[Block reservation/check-in/move]
  B -->|Yes| D[Room stays sellable]
  C --> E[Record work, cost, files and completion]
  D --> E
  E --> F[Staff clicks Make Available]
  F --> G[Room becomes dirty]
  G --> H[Assign one housekeeper]
  H --> I[Manager/front desk marks clean]
  J[Open employee time clock] --> K{Use live clock?}
  K -->|Yes| L[Clock housekeeper in and out]
  K -->|No| M{Enter complete shift?}
  M -->|Yes| P[Enter work date, clock in, clock out and break minutes]
  M -->|No| Q[Add clock in, break start/end and clock out separately]
  L --> N[Calculate paid hours and overtime]
  P --> N
  Q --> N
  N --> O[Edit the time entry if a correction is needed]
```

## 8. Night Audit

```mermaid
flowchart TD
  A[Manual run or scheduled time] --> B[Run prechecks]
  B --> C{Blocking issue?}
  C -->|Yes| D[Stop audit and create in-app alert]
  D --> E[Staff resolves issue and reruns]
  C -->|No| F[Mark remaining same-day arrivals No Show]
  F --> G[Finalize and lock business date permanently]
  G --> H[Generate Final Audit control summary and open next day]
```

## 9. Guest merge and ID retention

```mermaid
flowchart TD
  A[Create/import guest with required ID] --> B{ID number already exists?}
  B -->|Yes| C[Merge automatically]
  C --> D[Newest profile fields + combined remarks/DNR]
  D --> E[Deduplicate identical payment sources; retain different ones]
  B -->|No| F[Create profile]
  E --> G[Store ID image for one year]
  F --> G
  G --> H[Notify staff 7 days before deletion]
  H --> I[Optional profile + ID PDF download]
  I --> J[Delete image; keep profile/stays]
```

## 10. Backup restore

```mermaid
flowchart LR
  A[Owner/Manager downloads full backup] --> B[Keep archive securely]
  B --> C[Upload backup]
  C --> D[Validate file and ownership]
  D --> E[Warn current data will be replaced]
  E --> F{Confirm?}
  F -->|No| G[Cancel with no changes]
  F -->|Yes| H[Transactional restore]
  H --> I[Verify and resume service]
```
