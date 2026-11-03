CREATE TABLE `platform_recognized_projection` (
	`version_id` integer PRIMARY KEY NOT NULL,
	`record_id` integer NOT NULL,
	`validity_date_raw` text,
	`maintenance_year` integer,
	`maintenance_batch` text,
	`district` text,
	`award_note` text,
	`title_raw` text,
	`name_raw` text,
	`uscc_raw` text,
	`rule_version` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`version_id`) REFERENCES `platform_business_record_version`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`record_id`) REFERENCES `platform_business_record`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`version_id`,`record_id`) REFERENCES `platform_business_record_version`(`id`,`record_id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `platform_recognized_projection_record_idx` ON `platform_recognized_projection` (`record_id`);--> statement-breakpoint
CREATE INDEX `platform_recognized_projection_validity_idx` ON `platform_recognized_projection` (`validity_date_raw`);--> statement-breakpoint
CREATE INDEX `platform_recognized_projection_year_idx` ON `platform_recognized_projection` (`maintenance_year`);--> statement-breakpoint
CREATE INDEX `platform_recognized_projection_batch_idx` ON `platform_recognized_projection` (`maintenance_batch`);--> statement-breakpoint
CREATE INDEX `platform_recognized_projection_district_idx` ON `platform_recognized_projection` (`district`);--> statement-breakpoint
CREATE INDEX `platform_recognized_projection_title_idx` ON `platform_recognized_projection` (`title_raw`);--> statement-breakpoint
CREATE INDEX `platform_recognized_projection_uscc_idx` ON `platform_recognized_projection` (`uscc_raw`);

