ALTER TABLE `record_event` ADD `revision` integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
CREATE TABLE `event_correction_audit` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `event_id` integer NOT NULL REFERENCES `record_event`(`id`),
  `batch_id` integer NOT NULL REFERENCES `import_batch`(`id`),
  `record_id` integer NOT NULL,
  `enterprise_id` integer NOT NULL,
  `before` text NOT NULL,
  `after` text NOT NULL,
  `evidence` text NOT NULL,
  `source_identity` text NOT NULL,
  `actor_type` text NOT NULL,
  `actor_id` text NOT NULL,
  `basis` text NOT NULL,
  `corrected_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `event_correction_audit_event_idx` ON `event_correction_audit` (`event_id`, `id`);

--> statement-breakpoint
CREATE INDEX `record_correspondence_predecessor_idx` ON `record_correspondence` (`predecessor_event_id`);
