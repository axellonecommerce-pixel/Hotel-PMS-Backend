ALTER TABLE `reservations` ADD `nightly_rates_json` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `reservations` ADD `promotion_ids_json` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `reservations` ADD `tax_rate_basis_points` integer DEFAULT 1000 NOT NULL;--> statement-breakpoint
ALTER TABLE `reservations` ADD `tax_exempt` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `reservations` ADD `tax_exemption_reason` text;--> statement-breakpoint
ALTER TABLE `reservations` ADD `tax_exemption_certificate` text;--> statement-breakpoint
ALTER TABLE `reservations` ADD `ota_payment_status` text;