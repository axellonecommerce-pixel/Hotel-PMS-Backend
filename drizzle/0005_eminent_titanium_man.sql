CREATE TABLE `room_moves` (
	`id` text PRIMARY KEY NOT NULL,
	`property_id` text NOT NULL,
	`reservation_room_id` text NOT NULL,
	`from_room_id` text NOT NULL,
	`to_room_id` text NOT NULL,
	`rate_decision` text NOT NULL,
	`remark` text NOT NULL,
	`moved_by_employee_id` text,
	`moved_at` text NOT NULL,
	FOREIGN KEY (`property_id`) REFERENCES `properties`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`reservation_room_id`) REFERENCES `reservation_rooms`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`from_room_id`) REFERENCES `rooms`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`to_room_id`) REFERENCES `rooms`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`moved_by_employee_id`) REFERENCES `employees`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `room_moves_reservation_room_idx` ON `room_moves` (`reservation_room_id`);--> statement-breakpoint
ALTER TABLE `guests` ADD `room_preferences` text;