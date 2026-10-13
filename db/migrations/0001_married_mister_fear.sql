DROP TABLE `import_batch`;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_reconciliation_result` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`title_code` text NOT NULL,
	`enterprise_id` integer NOT NULL,
	`direction` text NOT NULL,
	`curated` integer DEFAULT false NOT NULL,
	`evidence` text,
	FOREIGN KEY (`title_code`) REFERENCES `title`(`code`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`enterprise_id`) REFERENCES `enterprise`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_reconciliation_result`("id", "title_code", "enterprise_id", "direction", "curated", "evidence") SELECT "id", "title_code", "enterprise_id", "direction", "curated", "evidence" FROM `reconciliation_result`;--> statement-breakpoint
DROP TABLE `reconciliation_result`;--> statement-breakpoint
ALTER TABLE `__new_reconciliation_result` RENAME TO `reconciliation_result`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `reconciliation_dir_idx` ON `reconciliation_result` (`direction`);--> statement-breakpoint
CREATE TABLE `__new_record` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`enterprise_id` integer NOT NULL,
	`title_code` text NOT NULL,
	`source` text NOT NULL,
	`district` text,
	`uscc_raw` text,
	`name_raw` text,
	`quality_flags` text DEFAULT '[]',
	FOREIGN KEY (`enterprise_id`) REFERENCES `enterprise`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`title_code`) REFERENCES `title`(`code`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_record`("id", "enterprise_id", "title_code", "source", "district", "uscc_raw", "name_raw", "quality_flags") SELECT "id", "enterprise_id", "title_code", "source", "district", "uscc_raw", "name_raw", "quality_flags" FROM `record`;--> statement-breakpoint
DROP TABLE `record`;--> statement-breakpoint
ALTER TABLE `__new_record` RENAME TO `record`;--> statement-breakpoint
CREATE UNIQUE INDEX `record_identity_uq` ON `record` (`enterprise_id`,`title_code`,`source`);--> statement-breakpoint
CREATE INDEX `record_title_idx` ON `record` (`title_code`);--> statement-breakpoint
CREATE INDEX `record_source_idx` ON `record` (`source`);--> statement-breakpoint
CREATE INDEX `record_district_idx` ON `record` (`district`);--> statement-breakpoint
CREATE TABLE `__new_source_document` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source` text NOT NULL,
	`title` text NOT NULL,
	`doc_number` text,
	`issue_date` text,
	`path` text NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_source_document`("id", "source", "title", "doc_number", "issue_date", "path") SELECT "id", "source", "title", "doc_number", "issue_date", "path" FROM `source_document`;--> statement-breakpoint
DROP TABLE `source_document`;--> statement-breakpoint
ALTER TABLE `__new_source_document` RENAME TO `source_document`;