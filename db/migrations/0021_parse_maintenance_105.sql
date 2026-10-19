CREATE TABLE `file_parse_audit_105` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `file_id` integer NOT NULL REFERENCES `stored_file`(`id`),
  `idempotency_key` text NOT NULL,
  `request_hash` text NOT NULL,
  `operation` text NOT NULL,
  `actor` text NOT NULL,
  `reason` text NOT NULL,
  `before` text NOT NULL,
  `after` text NOT NULL,
  `created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `file_parse_105_key_uq` ON `file_parse_audit_105` (`file_id`,`idempotency_key`);
--> statement-breakpoint
CREATE INDEX `file_parse_105_history_idx` ON `file_parse_audit_105` (`file_id`,`id`);

--> statement-breakpoint
CREATE INDEX `record_evidence_source_file_105_idx` ON `record_evidence` (`source_file`);
