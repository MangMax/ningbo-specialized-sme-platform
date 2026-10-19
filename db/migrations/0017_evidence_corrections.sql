CREATE TABLE `evidence_correction_batch` (
  `idempotency_key` text PRIMARY KEY NOT NULL,
  `request_hash` text NOT NULL,
  `plan_hash` text NOT NULL,
  `receipt` text NOT NULL,
  `created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `evidence_correction_audit` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `evidence_id` integer NOT NULL REFERENCES `record_evidence`(`id`),
  `event_id` integer NOT NULL REFERENCES `record_event`(`id`),
  `batch_key` text REFERENCES `evidence_correction_batch`(`idempotency_key`),
  `entry_point` text NOT NULL,
  `actor` text NOT NULL,
  `basis` text NOT NULL,
  `before` text NOT NULL,
  `after` text NOT NULL,
  `created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `evidence_correction_audit_evidence_idx` ON `evidence_correction_audit` (`evidence_id`, `id`);
--> statement-breakpoint
CREATE INDEX `record_evidence_coordinate_idx` ON `record_evidence` (`source_file`, `list_no`, `attachment`);
