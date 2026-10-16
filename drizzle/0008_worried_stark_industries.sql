CREATE TABLE `notifications` (
	`id` text PRIMARY KEY NOT NULL,
	`property_id` text NOT NULL,
	`employee_id` text,
	`type` text NOT NULL,
	`title` text NOT NULL,
	`detail` text NOT NULL,
	`href` text,
	`status` text DEFAULT 'Unread' NOT NULL,
	`read_at` text,
	`resolved_at` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`property_id`) REFERENCES `properties`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`employee_id`) REFERENCES `employees`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `notifications_property_status_idx` ON `notifications` (`property_id`,`status`);--> statement-breakpoint
CREATE TABLE `saved_report_definitions` (
	`id` text PRIMARY KEY NOT NULL,
	`property_id` text NOT NULL,
	`name` text NOT NULL,
	`base_report_id` text NOT NULL,
	`column_keys_json` text NOT NULL,
	`filters_json` text DEFAULT '{}' NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`property_id`) REFERENCES `properties`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `saved_reports_property_name_key` ON `saved_report_definitions` (`property_id`,`name`);--> statement-breakpoint
ALTER TABLE `expenses` ADD `recurring` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `expenses` ADD `recurrence` text;--> statement-breakpoint
ALTER TABLE `expenses` ADD `next_due_date` text;