CREATE TABLE `loyalty_memberships` (
	`id` text PRIMARY KEY NOT NULL,
	`property_id` text NOT NULL,
	`guest_id` text NOT NULL,
	`program_id` text NOT NULL,
	`member_number` text NOT NULL,
	`status` text NOT NULL,
	`custom_nights_required` integer,
	`custom_reward_description` text,
	`sms_consent` integer DEFAULT false NOT NULL,
	`email_consent` integer DEFAULT false NOT NULL,
	`consented_at` text,
	`joined_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`property_id`) REFERENCES `properties`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`guest_id`) REFERENCES `guests`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`program_id`) REFERENCES `loyalty_programs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `loyalty_memberships_property_guest_key` ON `loyalty_memberships` (`property_id`,`guest_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `loyalty_memberships_property_number_key` ON `loyalty_memberships` (`property_id`,`member_number`);--> statement-breakpoint
CREATE TABLE `loyalty_programs` (
	`id` text PRIMARY KEY NOT NULL,
	`property_id` text NOT NULL,
	`name` text NOT NULL,
	`status` text NOT NULL,
	`nights_required` integer NOT NULL,
	`reward_type` text NOT NULL,
	`reward_value_cents` integer,
	`reward_description` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`property_id`) REFERENCES `properties`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `loyalty_programs_property_key` ON `loyalty_programs` (`property_id`);--> statement-breakpoint
CREATE TABLE `loyalty_rewards` (
	`id` text PRIMARY KEY NOT NULL,
	`property_id` text NOT NULL,
	`membership_id` text NOT NULL,
	`program_id` text NOT NULL,
	`status` text NOT NULL,
	`description` text NOT NULL,
	`value_cents` integer,
	`reservation_id` text,
	`issued_at` text NOT NULL,
	`reserved_at` text,
	`redeemed_at` text,
	`expires_at` text,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`property_id`) REFERENCES `properties`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`membership_id`) REFERENCES `loyalty_memberships`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`program_id`) REFERENCES `loyalty_programs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `loyalty_transactions` (
	`id` text PRIMARY KEY NOT NULL,
	`property_id` text NOT NULL,
	`membership_id` text NOT NULL,
	`reservation_id` text,
	`reward_id` text,
	`type` text NOT NULL,
	`nights_delta` integer NOT NULL,
	`description` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`actor_auth_user_id` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`property_id`) REFERENCES `properties`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`membership_id`) REFERENCES `loyalty_memberships`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `loyalty_transactions_property_idempotency_key` ON `loyalty_transactions` (`property_id`,`idempotency_key`);--> statement-breakpoint
CREATE TABLE `loyalty_wallet_passes` (
	`id` text PRIMARY KEY NOT NULL,
	`property_id` text NOT NULL,
	`membership_id` text NOT NULL,
	`platform` text NOT NULL,
	`external_id` text,
	`token_hash` text,
	`status` text NOT NULL,
	`last_synced_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`property_id`) REFERENCES `properties`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`membership_id`) REFERENCES `loyalty_memberships`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `loyalty_wallet_passes_member_platform_key` ON `loyalty_wallet_passes` (`membership_id`,`platform`);--> statement-breakpoint
CREATE UNIQUE INDEX `loyalty_wallet_passes_token_key` ON `loyalty_wallet_passes` (`token_hash`);