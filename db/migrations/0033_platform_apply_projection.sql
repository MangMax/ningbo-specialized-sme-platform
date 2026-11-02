CREATE TABLE `platform_apply_projection` (
	`version_id` integer PRIMARY KEY NOT NULL,
	`record_id` integer NOT NULL,
	`declare_kind` text,
	`declaration_year` integer,
	`applied_at` text,
	`status` text,
	`name_raw` text,
	`uscc_raw` text,
	`province` text,
	`rule_version` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`version_id`) REFERENCES `platform_business_record_version`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`record_id`) REFERENCES `platform_business_record`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`version_id`,`record_id`) REFERENCES `platform_business_record_version`(`id`,`record_id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `platform_apply_projection_record_idx` ON `platform_apply_projection` (`record_id`);--> statement-breakpoint
CREATE INDEX `platform_apply_projection_year_idx` ON `platform_apply_projection` (`declaration_year`);--> statement-breakpoint
CREATE INDEX `platform_apply_projection_kind_idx` ON `platform_apply_projection` (`declare_kind`);--> statement-breakpoint
CREATE INDEX `platform_apply_projection_status_idx` ON `platform_apply_projection` (`status`);--> statement-breakpoint
CREATE INDEX `platform_apply_projection_applied_idx` ON `platform_apply_projection` (`applied_at`);--> statement-breakpoint
CREATE INDEX `platform_apply_projection_uscc_idx` ON `platform_apply_projection` (`uscc_raw`);
