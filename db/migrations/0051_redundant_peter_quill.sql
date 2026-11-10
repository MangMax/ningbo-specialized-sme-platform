CREATE TABLE `platform_migration_checkpoint` (
	`run_id` text NOT NULL,
	`phase` text NOT NULL,
	`source_table` text NOT NULL,
	`last_old_id` integer NOT NULL,
	`copied_count` integer NOT NULL,
	`batch_digest` text NOT NULL,
	PRIMARY KEY(`run_id`, `phase`, `source_table`),
	FOREIGN KEY (`run_id`) REFERENCES `platform_migration_run`(`run_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "platform_migration_checkpoint_last_old_id_ck" CHECK(typeof("platform_migration_checkpoint"."last_old_id") = 'integer' AND "platform_migration_checkpoint"."last_old_id" BETWEEN 0 AND 9007199254740991),
	CONSTRAINT "platform_migration_checkpoint_copied_count_ck" CHECK(typeof("platform_migration_checkpoint"."copied_count") = 'integer' AND "platform_migration_checkpoint"."copied_count" BETWEEN 0 AND 9007199254740991)
);
--> statement-breakpoint
CREATE TABLE `platform_migration_run` (
	`run_id` text PRIMARY KEY NOT NULL,
	`source_snapshot_sha256` text NOT NULL,
	`source_schema_hash` text NOT NULL,
	`source_manifest_sha256` text NOT NULL,
	`target_schema_version` text NOT NULL,
	`transform_version` text NOT NULL,
	`state` text NOT NULL,
	CONSTRAINT "platform_migration_run_state_ck" CHECK("platform_migration_run"."state" IN ('running','complete'))
);
