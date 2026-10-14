CREATE TABLE `stored_file_part` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`file_id` integer NOT NULL,
	`title_code` text NOT NULL,
	`event_kind` text NOT NULL,
	`year` integer,
	`batch` integer,
	`attachment` text,
	`row_count` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`file_id`) REFERENCES `stored_file`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`title_code`) REFERENCES `title`(`code`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `stored_file_part_file_idx` ON `stored_file_part` (`file_id`);