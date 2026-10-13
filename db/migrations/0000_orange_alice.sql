CREATE TABLE `enterprise` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`uscc_norm` text,
	`name` text NOT NULL,
	`name_norm` text NOT NULL,
	`district` text,
	`city` text,
	`reg_status` text,
	`quality_flags` text DEFAULT '[]'
);
--> statement-breakpoint
CREATE UNIQUE INDEX `enterprise_uscc_norm_uq` ON `enterprise` (`uscc_norm`);--> statement-breakpoint
CREATE INDEX `enterprise_name_norm_idx` ON `enterprise` (`name_norm`);--> statement-breakpoint
CREATE TABLE `import_batch` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`label` text NOT NULL,
	`source_root` text NOT NULL,
	`imported_at` text DEFAULT (datetime('now')) NOT NULL,
	`note` text
);
--> statement-breakpoint
CREATE TABLE `reconciliation_result` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`import_batch_id` integer NOT NULL,
	`title_code` text NOT NULL,
	`enterprise_id` integer NOT NULL,
	`direction` text NOT NULL,
	`curated` integer DEFAULT false NOT NULL,
	`evidence` text,
	FOREIGN KEY (`import_batch_id`) REFERENCES `import_batch`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`title_code`) REFERENCES `title`(`code`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`enterprise_id`) REFERENCES `enterprise`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `reconciliation_dir_idx` ON `reconciliation_result` (`direction`);--> statement-breakpoint
CREATE TABLE `record` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`import_batch_id` integer NOT NULL,
	`enterprise_id` integer NOT NULL,
	`title_code` text NOT NULL,
	`source` text NOT NULL,
	`district` text,
	`uscc_raw` text,
	`name_raw` text,
	`quality_flags` text DEFAULT '[]',
	FOREIGN KEY (`import_batch_id`) REFERENCES `import_batch`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`enterprise_id`) REFERENCES `enterprise`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`title_code`) REFERENCES `title`(`code`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `record_identity_uq` ON `record` (`enterprise_id`,`title_code`,`source`);--> statement-breakpoint
CREATE INDEX `record_title_idx` ON `record` (`title_code`);--> statement-breakpoint
CREATE INDEX `record_source_idx` ON `record` (`source`);--> statement-breakpoint
CREATE INDEX `record_district_idx` ON `record` (`district`);--> statement-breakpoint
CREATE TABLE `record_event` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`record_id` integer NOT NULL,
	`event_type` text NOT NULL,
	`year` integer,
	`batch_seq` integer,
	`sort_key` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`record_id`) REFERENCES `record`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `record_event_record_idx` ON `record_event` (`record_id`);--> statement-breakpoint
CREATE TABLE `record_evidence` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`record_event_id` integer NOT NULL,
	`source_file` text NOT NULL,
	`attachment` text,
	`list_no` integer,
	FOREIGN KEY (`record_event_id`) REFERENCES `record_event`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `record_evidence_event_idx` ON `record_evidence` (`record_event_id`);--> statement-breakpoint
CREATE TABLE `source_document` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source` text NOT NULL,
	`title` text NOT NULL,
	`doc_number` text,
	`issue_date` text,
	`path` text NOT NULL,
	`import_batch_id` integer,
	FOREIGN KEY (`import_batch_id`) REFERENCES `import_batch`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `title` (
	`code` text PRIMARY KEY NOT NULL,
	`name_zh` text NOT NULL,
	`level` text NOT NULL,
	`rank` integer NOT NULL
);
