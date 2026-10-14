CREATE TABLE `ocr_result` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`file_id` integer NOT NULL,
	`page_no` integer NOT NULL,
	`page_rel_path` text,
	`markdown` text NOT NULL,
	`raw` text,
	`engine` text DEFAULT 'paddleocr' NOT NULL,
	`model` text,
	`channel` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`file_id`) REFERENCES `stored_file`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ocr_result_file_page_uq` ON `ocr_result` (`file_id`,`page_no`);--> statement-breakpoint
CREATE INDEX `ocr_result_file_idx` ON `ocr_result` (`file_id`);--> statement-breakpoint
ALTER TABLE `record_evidence` ADD `page` integer;