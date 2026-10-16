CREATE TABLE `attachments` (
	`id` text PRIMARY KEY NOT NULL,
	`property_id` text NOT NULL,
	`resource_type` text NOT NULL,
	`resource_id` text NOT NULL,
	`storage_key` text NOT NULL,
	`original_name` text NOT NULL,
	`mime_type` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`delete_after` text,
	`warned_at` text,
	`deleted_at` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`property_id`) REFERENCES `properties`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `attachments_property_resource_idx` ON `attachments` (`property_id`,`resource_type`,`resource_id`);--> statement-breakpoint
CREATE TABLE `document_records` (
	`id` text PRIMARY KEY NOT NULL,
	`property_id` text NOT NULL,
	`reservation_id` text,
	`company_id` text,
	`document_number` text NOT NULL,
	`document_type` text NOT NULL,
	`status` text NOT NULL,
	`total_cents` integer DEFAULT 0 NOT NULL,
	`balance_cents` integer DEFAULT 0 NOT NULL,
	`due_date` text,
	`sent_at` text,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`property_id`) REFERENCES `properties`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`reservation_id`) REFERENCES `reservations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `document_records_property_number_key` ON `document_records` (`property_id`,`document_number`);--> statement-breakpoint
CREATE TABLE `document_sequences` (
	`id` text PRIMARY KEY NOT NULL,
	`property_id` text NOT NULL,
	`prefix` text NOT NULL,
	`format` text NOT NULL,
	`next_number` integer NOT NULL,
	`annual_reset` integer DEFAULT false NOT NULL,
	`reset_year` integer,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`property_id`) REFERENCES `properties`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `document_sequences_property_key` ON `document_sequences` (`property_id`);--> statement-breakpoint
CREATE TABLE `ledger_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`property_id` text NOT NULL,
	`business_date` text NOT NULL,
	`account` text NOT NULL,
	`debit_cents` integer DEFAULT 0 NOT NULL,
	`credit_cents` integer DEFAULT 0 NOT NULL,
	`resource_type` text NOT NULL,
	`resource_id` text NOT NULL,
	`description` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`property_id`) REFERENCES `properties`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `ledger_entries_property_date_idx` ON `ledger_entries` (`property_id`,`business_date`);--> statement-breakpoint
CREATE TABLE `night_audit_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`property_id` text NOT NULL,
	`business_date` text NOT NULL,
	`status` text NOT NULL,
	`blocking_issues_json` text DEFAULT '[]' NOT NULL,
	`started_at` text NOT NULL,
	`completed_at` text,
	FOREIGN KEY (`property_id`) REFERENCES `properties`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `night_audit_property_date_key` ON `night_audit_runs` (`property_id`,`business_date`);--> statement-breakpoint
CREATE TABLE `registration_acceptances` (
	`id` text PRIMARY KEY NOT NULL,
	`property_id` text NOT NULL,
	`reservation_id` text NOT NULL,
	`rule_version_id` text NOT NULL,
	`signed_name` text NOT NULL,
	`signature_storage_key` text,
	`accepted_at` text NOT NULL,
	FOREIGN KEY (`property_id`) REFERENCES `properties`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`reservation_id`) REFERENCES `reservations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`rule_version_id`) REFERENCES `registration_rule_versions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `registration_acceptances_reservation_idx` ON `registration_acceptances` (`reservation_id`);--> statement-breakpoint
CREATE TABLE `registration_rule_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`property_id` text NOT NULL,
	`version_number` integer NOT NULL,
	`content` text NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`property_id`) REFERENCES `properties`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `registration_rules_property_version_key` ON `registration_rule_versions` (`property_id`,`version_number`);