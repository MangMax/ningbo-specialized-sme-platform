CREATE TABLE `comparison_scope_proof` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`evidence` text NOT NULL,
	`source_fingerprint` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `comparison_scope_proof_kind_idx` ON `comparison_scope_proof` (`kind`);--> statement-breakpoint
CREATE TABLE `comparison_scope_proof_audit` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`proof_id` integer NOT NULL,
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
	`decided_at` text NOT NULL,
	FOREIGN KEY (`proof_id`) REFERENCES `comparison_scope_proof`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`batch_id`) REFERENCES `import_batch`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `comparison_scope_proof_audit_proof_idx` ON `comparison_scope_proof_audit` (`proof_id`,`id`);