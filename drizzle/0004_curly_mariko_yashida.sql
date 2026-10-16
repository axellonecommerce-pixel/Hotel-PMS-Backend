CREATE TABLE `guest_remarks` (
	`id` text PRIMARY KEY NOT NULL,
	`property_id` text NOT NULL,
	`guest_id` text NOT NULL,
	`remark` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`property_id`) REFERENCES `properties`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`guest_id`) REFERENCES `guests`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `guest_remarks_guest_date_idx` ON `guest_remarks` (`guest_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `rooms` ADD `smoking_allowed` integer DEFAULT false NOT NULL;