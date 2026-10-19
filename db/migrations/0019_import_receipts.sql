CREATE TABLE `import_receipt` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `batch_id` integer NOT NULL REFERENCES `import_batch`(`id`),
  `operation` text NOT NULL,
  `request_hash` text NOT NULL,
  `request_body` text NOT NULL,
  `status` text NOT NULL,
  `summary` text,
  `item_results` text,
  `created_at` text NOT NULL,
  `completed_at` text
);
--> statement-breakpoint
CREATE INDEX `import_receipt_batch_id_idx` ON `import_receipt` (`batch_id`, `id`);
