CREATE TABLE `reservation_rooms` (
	`id` text PRIMARY KEY NOT NULL,
	`property_id` text NOT NULL,
	`reservation_id` text NOT NULL,
	`room_type_id` text NOT NULL,
	`room_id` text,
	`status` text NOT NULL,
	`checked_in_at` text,
	`checked_out_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`property_id`) REFERENCES `properties`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`reservation_id`) REFERENCES `reservations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`room_type_id`) REFERENCES `room_types`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`room_id`) REFERENCES `rooms`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `reservation_rooms_reservation_idx` ON `reservation_rooms` (`reservation_id`);--> statement-breakpoint
CREATE INDEX `reservation_rooms_room_status_idx` ON `reservation_rooms` (`room_id`,`status`);