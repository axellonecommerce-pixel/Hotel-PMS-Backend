CREATE TABLE `change_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`property_id` text NOT NULL,
	`actor_auth_user_id` text NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`action` text NOT NULL,
	`entity_version` integer NOT NULL,
	`payload_json` text DEFAULT '{}' NOT NULL,
	`occurred_at` text NOT NULL,
	FOREIGN KEY (`property_id`) REFERENCES `properties`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `change_events_property_id_idx` ON `change_events` (`property_id`,`id`);--> statement-breakpoint
CREATE TABLE `property_memberships` (
	`id` text PRIMARY KEY NOT NULL,
	`property_id` text NOT NULL,
	`auth_user_id` text NOT NULL,
	`role` text NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`property_id`) REFERENCES `properties`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `property_memberships_user_property_key` ON `property_memberships` (`auth_user_id`,`property_id`);--> statement-breakpoint
CREATE INDEX `property_memberships_user_active_idx` ON `property_memberships` (`auth_user_id`,`active`);--> statement-breakpoint
ALTER TABLE `employees` ADD `membership_id` text REFERENCES property_memberships(id);--> statement-breakpoint
ALTER TABLE `reservations` ADD `version` integer DEFAULT 1 NOT NULL;