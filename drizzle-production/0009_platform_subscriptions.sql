CREATE TABLE "platform_subscriptions" (
  "property_id" uuid PRIMARY KEY NOT NULL REFERENCES "properties"("id") ON DELETE CASCADE,
  "plan_name" text NOT NULL,
  "billing_cycle" text NOT NULL,
  "amount_cents" integer NOT NULL DEFAULT 0,
  "currency_code" text NOT NULL DEFAULT 'USD',
  "starts_on" date NOT NULL,
  "expires_on" date NOT NULL,
  "status" text NOT NULL DEFAULT 'active',
  "notes" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "platform_subscriptions_expiry_idx" ON "platform_subscriptions" ("expires_on", "status");
--> statement-breakpoint
CREATE TABLE "platform_subscription_payments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "property_id" uuid NOT NULL REFERENCES "properties"("id") ON DELETE CASCADE,
  "amount_cents" integer NOT NULL,
  "received_on" date NOT NULL,
  "payment_method" text NOT NULL,
  "reference" text,
  "note" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "platform_subscription_payments_property_idx" ON "platform_subscription_payments" ("property_id", "received_on" DESC);
