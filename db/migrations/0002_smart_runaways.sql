CREATE TABLE `stored_file` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`rel_path` text NOT NULL,
	`filename` text NOT NULL,
	`ext` text NOT NULL,
	`bytes` integer NOT NULL,
	`sha256` text NOT NULL,
	`source` text,
	`kind` text,
	`year` integer,
	`batch` integer,
	`title_code` text,
	`category_state` text DEFAULT 'unset' NOT NULL,
	`parse_state` text DEFAULT 'unparsed' NOT NULL,
	`created_at` text NOT NULL,
	`removed_at` text,
	FOREIGN KEY (`title_code`) REFERENCES `title`(`code`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `stored_file_rel_path_uq` ON `stored_file` (`rel_path`);--> statement-breakpoint
CREATE INDEX `stored_file_source_idx` ON `stored_file` (`source`);--> statement-breakpoint
CREATE INDEX `stored_file_category_state_idx` ON `stored_file` (`category_state`);--> statement-breakpoint
CREATE INDEX `stored_file_parse_state_idx` ON `stored_file` (`parse_state`);