CREATE TABLE `job` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`params` text NOT NULL,
	`state` text DEFAULT 'queued' NOT NULL,
	`progress` text DEFAULT '{"done":0,"total":1}' NOT NULL,
	`result` text,
	`error` text,
	`created_at` text NOT NULL,
	`started_at` text,
	`finished_at` text
);
--> statement-breakpoint
CREATE INDEX `job_kind_idx` ON `job` (`kind`);--> statement-breakpoint
CREATE INDEX `job_state_idx` ON `job` (`state`);--> statement-breakpoint
CREATE INDEX `job_created_at_idx` ON `job` (`created_at`);