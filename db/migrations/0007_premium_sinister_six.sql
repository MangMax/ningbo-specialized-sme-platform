CREATE TABLE `difference_reason` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`enterprise_id` integer NOT NULL,
	`title_code` text NOT NULL,
	`direction` text NOT NULL,
	`status` text DEFAULT 'not_queried' NOT NULL,
	`reason_code` text,
	`reason_note` text,
	`measure_code` text,
	`measure_note` text,
	`evidence_query_id` integer,
	`evidence_relation_id` integer,
	`moved_in_city` text,
	`moved_in_title_code` text,
	`moved_in_year` integer,
	`moved_in_batch` integer,
	`verification_status` text DEFAULT 'pending' NOT NULL,
	`recorded_at` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`enterprise_id`) REFERENCES `enterprise`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`title_code`) REFERENCES `title`(`code`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`evidence_query_id`) REFERENCES `platform_query`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`evidence_relation_id`) REFERENCES `platform_relation`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`moved_in_title_code`) REFERENCES `title`(`code`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `difference_reason_version_uq` ON `difference_reason` (`enterprise_id`,`title_code`,`direction`,`recorded_at`);--> statement-breakpoint
CREATE INDEX `difference_reason_lookup_idx` ON `difference_reason` (`enterprise_id`,`title_code`,`direction`);--> statement-breakpoint
CREATE TABLE `enterprise_alias` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`enterprise_id` integer NOT NULL,
	`name` text NOT NULL,
	`name_norm` text NOT NULL,
	`source_kind` text NOT NULL,
	`source_ref_id` integer DEFAULT 0 NOT NULL,
	`valid_from` text,
	`valid_to` text,
	`verification_status` text DEFAULT 'pending' NOT NULL,
	`note` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`enterprise_id`) REFERENCES `enterprise`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `enterprise_alias_identity_uq` ON `enterprise_alias` (`enterprise_id`,`name_norm`,`source_kind`,`source_ref_id`);--> statement-breakpoint
CREATE INDEX `enterprise_alias_name_norm_idx` ON `enterprise_alias` (`name_norm`);--> statement-breakpoint
CREATE INDEX `enterprise_alias_enterprise_idx` ON `enterprise_alias` (`enterprise_id`);--> statement-breakpoint
CREATE TABLE `import_batch` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`idempotency_key` text NOT NULL,
	`source_kind` text NOT NULL,
	`source_identity` text NOT NULL,
	`source_sha256` text,
	`status` text DEFAULT 'preflight' NOT NULL,
	`preflight_result` text,
	`item_results` text,
	`summary` text,
	`error` text,
	`created_at` text NOT NULL,
	`committed_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `import_batch_idempotency_uq` ON `import_batch` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `import_batch_status_idx` ON `import_batch` (`status`);--> statement-breakpoint
CREATE TABLE `platform_export_batch` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`title_code` text NOT NULL,
	`year` integer NOT NULL,
	`collected_on` text NOT NULL,
	`original_filename` text NOT NULL,
	`sha256` text NOT NULL,
	`row_count` integer DEFAULT 0 NOT NULL,
	`import_status` text DEFAULT 'pending' NOT NULL,
	`source_document_id` integer,
	`import_batch_id` integer,
	`replaced_batch_id` integer,
	`created_at` text NOT NULL,
	FOREIGN KEY (`title_code`) REFERENCES `title`(`code`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_document_id`) REFERENCES `source_document`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`import_batch_id`) REFERENCES `import_batch`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`replaced_batch_id`) REFERENCES `platform_export_batch`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `platform_export_batch_identity_uq` ON `platform_export_batch` (`title_code`,`year`,`sha256`);--> statement-breakpoint
CREATE INDEX `platform_export_batch_title_year_idx` ON `platform_export_batch` (`title_code`,`year`);--> statement-breakpoint
CREATE TABLE `platform_export_row` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`batch_id` integer NOT NULL,
	`source_row_no` integer NOT NULL,
	`uscc_raw` text,
	`name_raw` text,
	`district` text,
	`province` text,
	`city` text,
	`reg_status` text,
	`raw_fields` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`batch_id`) REFERENCES `platform_export_batch`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `platform_export_row_identity_uq` ON `platform_export_row` (`batch_id`,`source_row_no`);--> statement-breakpoint
CREATE INDEX `platform_export_row_batch_idx` ON `platform_export_row` (`batch_id`);--> statement-breakpoint
CREATE TABLE `platform_query` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`interface` text NOT NULL,
	`query_key` text NOT NULL,
	`rdjb` text DEFAULT '' NOT NULL,
	`title_code` text,
	`queried_at` text NOT NULL,
	`status` text DEFAULT 'not_queried' NOT NULL,
	`failure_reason` text,
	`raw_response` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`title_code`) REFERENCES `title`(`code`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `platform_query_identity_uq` ON `platform_query` (`interface`,`query_key`,`rdjb`,`queried_at`);--> statement-breakpoint
CREATE INDEX `platform_query_key_idx` ON `platform_query` (`query_key`);--> statement-breakpoint
CREATE TABLE `platform_relation` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`query_id` integer NOT NULL,
	`sequence_no` integer NOT NULL,
	`relation_key` text,
	`enterprise_id` integer,
	`raw_fields` text,
	`source_text` text,
	`uscc_raw` text,
	`name_raw` text,
	`alias_name_raw` text,
	`province` text,
	`status` text,
	`batch` text,
	`declare_kind` text,
	`applied_at` text,
	`award_batch_label` text,
	`year` integer,
	`match_basis` text DEFAULT 'none' NOT NULL,
	`verification_status` text DEFAULT 'pending' NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`query_id`) REFERENCES `platform_query`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`enterprise_id`) REFERENCES `enterprise`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `platform_relation_query_seq_uq` ON `platform_relation` (`query_id`,`sequence_no`);--> statement-breakpoint
CREATE INDEX `platform_relation_enterprise_idx` ON `platform_relation` (`enterprise_id`);--> statement-breakpoint
CREATE INDEX `platform_relation_relation_key_idx` ON `platform_relation` (`relation_key`);--> statement-breakpoint
ALTER TABLE `record_event` ADD `review_outcome` text;--> statement-breakpoint
ALTER TABLE `record_event` ADD `decided_year` integer;