CREATE TABLE `platform_business_projection` (
	`version_id` integer PRIMARY KEY NOT NULL,
	`record_id` integer NOT NULL,
	`declare_kind` text,
	`business_year` integer,
	`applied_at` text,
	`status` text,
	`batch` text,
	`award_batch_label` text,
	`province` text,
	`name_raw` text,
	`uscc_raw` text,
	`rule_version` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`version_id`) REFERENCES `platform_business_record_version`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`record_id`) REFERENCES `platform_business_record`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`version_id`,`record_id`) REFERENCES `platform_business_record_version`(`id`,`record_id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `platform_business_projection_record_idx` ON `platform_business_projection` (`record_id`);--> statement-breakpoint
CREATE INDEX `platform_business_projection_year_idx` ON `platform_business_projection` (`business_year`);--> statement-breakpoint
CREATE INDEX `platform_business_projection_kind_idx` ON `platform_business_projection` (`declare_kind`);--> statement-breakpoint
CREATE INDEX `platform_business_projection_status_idx` ON `platform_business_projection` (`status`);--> statement-breakpoint
CREATE INDEX `platform_business_projection_batch_idx` ON `platform_business_projection` (`batch`);--> statement-breakpoint
CREATE INDEX `platform_business_projection_applied_idx` ON `platform_business_projection` (`applied_at`);--> statement-breakpoint
CREATE INDEX `platform_business_projection_uscc_idx` ON `platform_business_projection` (`uscc_raw`);