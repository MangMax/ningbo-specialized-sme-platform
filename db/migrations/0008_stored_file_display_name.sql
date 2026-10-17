CREATE TABLE `stored_file_audit` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`stored_file_id` integer NOT NULL,
	`old_display_name` text NOT NULL,
	`new_display_name` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`stored_file_id`) REFERENCES `stored_file`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `stored_file_audit_file_idx` ON `stored_file_audit` (`stored_file_id`);--> statement-breakpoint
ALTER TABLE `stored_file` ADD `display_name` text;
--> statement-breakpoint
CREATE TRIGGER `stored_file_audit_no_update`
BEFORE UPDATE ON `stored_file_audit`
BEGIN
	SELECT RAISE(ABORT, 'stored_file_audit is append-only');
END;
--> statement-breakpoint
CREATE TRIGGER `stored_file_audit_no_delete`
BEFORE DELETE ON `stored_file_audit`
BEGIN
	SELECT RAISE(ABORT, 'stored_file_audit is append-only');
END;
