CREATE TABLE `record_correspondence` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`edge_key` text NOT NULL,
	`type` text NOT NULL,
	`role` text NOT NULL,
	`event_id` integer,
	`predecessor_event_id` integer,
	`relation_id` integer,
	`export_row_id` integer,
	`enterprise_id` integer,
	`title_code` text NOT NULL,
	`status` text NOT NULL,
	`revision` integer NOT NULL,
	`target_identity` text NOT NULL,
	`provenance` text NOT NULL,
	`source_fingerprint` text NOT NULL,
	`rule_id` text NOT NULL,
	`rule_version` text NOT NULL,
	`created_at` text NOT NULL,
	`decided_at` text,
	`ended_at` text,
	FOREIGN KEY (`event_id`) REFERENCES `record_event`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`predecessor_event_id`) REFERENCES `record_event`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`relation_id`) REFERENCES `platform_relation`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`export_row_id`) REFERENCES `platform_export_row`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`enterprise_id`) REFERENCES `enterprise`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`title_code`) REFERENCES `title`(`code`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `record_correspondence_edge_uq` ON `record_correspondence` (`edge_key`);--> statement-breakpoint
CREATE INDEX `record_correspondence_event_idx` ON `record_correspondence` (`event_id`);--> statement-breakpoint
CREATE INDEX `record_correspondence_relation_idx` ON `record_correspondence` (`relation_id`);--> statement-breakpoint
CREATE INDEX `record_correspondence_export_idx` ON `record_correspondence` (`export_row_id`);--> statement-breakpoint
CREATE INDEX `record_correspondence_enterprise_idx` ON `record_correspondence` (`enterprise_id`,`title_code`);--> statement-breakpoint
CREATE TABLE `record_correspondence_audit` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`correspondence_id` integer NOT NULL,
	`batch_id` integer NOT NULL,
	`idempotency_key` text NOT NULL,
	`from_status` text,
	`to_status` text NOT NULL,
	`expected_revision` integer NOT NULL,
	`resulting_revision` integer NOT NULL,
	`actor_type` text NOT NULL,
	`actor_id` text NOT NULL,
	`basis` text NOT NULL,
	`rule_id` text NOT NULL,
	`rule_version` text NOT NULL,
	`evidence` text NOT NULL,
	`decided_at` text NOT NULL,
	FOREIGN KEY (`correspondence_id`) REFERENCES `record_correspondence`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`batch_id`) REFERENCES `import_batch`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `record_correspondence_audit_edge_idx` ON `record_correspondence_audit` (`correspondence_id`,`id`);