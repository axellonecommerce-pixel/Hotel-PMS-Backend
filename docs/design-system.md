# Hotel PMS — UI/UX Design System

Status: **Approved** — owner approval recorded in `docs/approval.md`.

## 1. Design direction

Replace the current green/cream palette with a calm enterprise hospitality system: **deep navy + royal blue + warm gold**, neutral surfaces, clear semantic statuses, and true light/dark themes. The interface is data-dense but readable, with restrained depth and motion. It must feel dependable during fast front-desk work rather than decorative or luxury-themed.

## 2. Proposed color tokens

| Token | Light | Dark | Purpose |
|---|---:|---:|---|
| Background | `#F6F8FC` | `#0B1220` | App canvas |
| Surface/Card | `#FFFFFF` | `#111B2E` | Cards, tables, dialogs |
| Foreground | `#111827` | `#F8FAFC` | Primary text |
| Muted text | `#526174` | `#A8B3C5` | Supporting text |
| Border | `#D8E0EA` | `#2A3850` | Dividers and controls |
| Primary | `#1E3A8A` | `#7DA2F8` | Main actions/navigation |
| Primary text | `#FFFFFF` | `#07101F` | Text on primary |
| Secondary | `#2563EB` | `#60A5FA` | Links/selection/info |
| Accent | `#A16207` | `#F4C152` | Highlights and attention |
| Success | `#16734A` | `#55D69B` | Paid, clean, complete |
| Warning | `#A15C00` | `#F6B84A` | Pending, dirty, caution |
| Danger | `#B42318` | `#FF8178` | Error, delete, DNR |
| Focus ring | `#2563EB` | `#93C5FD` | Keyboard focus |

Color never communicates status alone; pair it with text and an icon. All normal text pairs target WCAG 2.2 AA contrast of at least 4.5:1.

## 3. Typography

- Use one highly readable variable sans-serif family for the application (recommended: **Inter** or retain **Public Sans** after comparison). Avoid decorative display fonts in operational views.
- Scale: 12 helper, 14 table/metadata, 16 body/control, 18 section title, 24 page title, 32 dashboard/date hero.
- Body line height 1.5; headings 1.2–1.3; weights 400/500/600/700.
- Currency, room numbers, folio numbers, dates, timers, and metrics use tabular figures.

## 4. Spacing, shape, and elevation

- Base spacing unit: 4px; standard gaps: 8, 12, 16, 24, 32.
- Control height: 44px minimum; high-use mobile actions: 48px.
- Radius: 8px controls, 12px cards, 16px dialogs/drawers.
- Shadows are subtle and limited to overlays, sticky bars, and elevated action areas. Borders establish most hierarchy.
- Desktop content max width is consistent; financial/data tables may use the full working width.

## 5. Responsive layout

| Width | Navigation | Content behavior |
|---|---|---|
| 320–767 | Bottom navigation for up to 5 priority items + More drawer | Single column; actions use menus/sheets; tables become cards or intentional scroll regions |
| 768–1023 | Compact rail/drawer | Two-column where useful; touch-first controls |
| 1024–1439 | Persistent sidebar | Dense dashboard grids and full tables |
| 1440+ | Persistent sidebar | Wider grids without stretching readable text |

- No page-level horizontal overflow, overlap, clipped menus, or hidden bottom-bar content.
- Support portrait/landscape and zoom to 200%.
- Phone/tablet expose every feature; information is reorganized, not removed.

## 6. Navigation and hierarchy

- Desktop/sidebar groups: Front Desk, Operations, Money, Management.
- Mobile bottom navigation contains Dashboard, Reservations, In House, Housekeeping, and More. Every other module is inside More and remains one tap away.
- Global search is always reachable and searches guests, reservations, rooms, companies, folios, and invoices.
- Notification center is always reachable and shows unresolved count.
- Deep screens use breadcrumbs and preserve search/filter/scroll state on Back.

## 7. Components and behavior

- **Buttons:** one primary action per region; secondary/quiet/danger variants; loading and disabled state never shift layout.
- **Forms:** visible labels, required markers, helper text, validation on blur, inline error plus focusable error summary for multiple failures.
- **Tables:** sortable headers, sticky header when useful, keyboard reachable, responsive card alternative or labelled scroll container, export action.
- **Status badges:** icon + text + semantic tone; never color-only.
- **Dialogs/drawers:** desktop dialog, mobile bottom sheet/full screen where content needs room; confirm unsaved dismissal.
- **Action menus:** consolidate secondary actions without hiding the screen's primary workflow.
- **Notifications/toasts:** toast confirms short-lived success; notification center holds unresolved operational items.
- **Charts:** exact values, legend, keyboard/touch tooltip, text/table alternative, locale-aware numbers, reduced-motion support.
- **Print/PDF:** fixed document system separate from responsive UI; hotel identity configurable while approved folio/registration layouts remain consistent.

## 8. Accessibility requirements

- WCAG 2.2 AA; complete keyboard path; visible focus; logical headings/landmarks; screen-reader names.
- Web touch targets at least 44×44px for operational controls with at least 8px separation.
- Respect `prefers-reduced-motion`; motion communicates state and never blocks input.
- Meaningful images have alternatives; decorative icons are hidden from assistive technology.
- Error/success messages do not rely on color and are announced appropriately.
- Data charts always have a readable text/table equivalent.

## 9. Motion

- Motion is restrained: 120–180ms control feedback, 180–240ms overlays, transform/opacity only.
- No decorative auto-animation. Loading skeletons are used only when delay is perceptible.
- Reduced-motion mode renders final states immediately.

## 10. Approval checklist

- Approve navy/blue/gold direction and both theme palettes.
- Compare Inter and Public Sans in real dashboard screens.
- Review Dashboard, Reservation Workspace, Company Invoice, Housekeeping, and mobile navigation prototypes.
- Verify 320px phone, 768px tablet, 1024px laptop, and 1440px desktop.
- Measure light/dark contrast and test keyboard/screen reader before rollout.
