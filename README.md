# Hotel PMS Backend

Next.js + Drizzle backend foundation for the multi-hotel PMS. SQLite powers local development; the production schema targets PostgreSQL.

## Included

- Normalized motel schema and migrations
- Seed data for rooms, guests, reservations, companies, booking channels, maintenance, expenses, cash drops, employees, and tasks
- Booking channel commission configuration
- Business-day and maintenance work-order tables
- Product-team hotel provisioning API
- Supabase-token authentication with membership-derived hotel isolation
- Reservation optimistic locking and a tenant-scoped realtime event stream

## Run Locally

```bash
bun install
bun run db:migrate
bun run db:seed
```

## Authentication and tenancy

Set `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, and the server-only
`SUPABASE_SECRET_KEY`. The legacy `SUPABASE_SERVICE_ROLE_KEY` name remains
supported for existing deployments. Every operational API resolves the
signed-in user to an active `property_memberships` row. If the employee belongs
to more than one hotel, send `X-Property-Id`; the server rejects hotels outside
that user's memberships.

For local development only, set `PMS_DEMO_AUTH_ENABLED=true`, `PMS_DEMO_AUTH_TOKEN`, and `PMS_DEMO_AUTH_USER_ID`. Production never accepts the demo path.

## Product-team hotel provisioning

Set a strong `PMS_PROVISIONING_KEY`, then call `POST /api/admin/properties` with `X-PMS-Provisioning-Key`. The payload contains hotel contact/timezone details plus the existing Supabase owner's user ID and name. Provisioning transactionally creates the property, owner membership, owner employee, and starting settings.

Set `PMS_FRONTEND_ORIGINS` to the comma-separated frontend origins allowed to call the API. Reservation clients subscribe to `GET /api/events`; writes use a required expected version and return `409 EDIT_CONFLICT` instead of overwriting a newer edit.

## Platform Admin

The central motel and subscription console is available at the frontend route
`/platform`. It creates the motel, its owner email/password login, and its
subscription in one action. Add `PMS_PLATFORM_ADMIN_EMAILS` in Vercel as a
comma-separated list of the email addresses allowed to use this console.
These addresses must already be Supabase Auth users. The console intentionally
uses the server-only Supabase secret to create owner accounts; never place that
secret in frontend environment variables.

Apply `drizzle-production/0009_platform_subscriptions.sql` in the Supabase SQL
Editor before using the console. It creates the current subscription and manual
subscription-payment tables. Card charging is deliberately not implemented:
payments can be recorded manually until a payment processor is selected.
