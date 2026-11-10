CREATE TABLE `platform_collection` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`interface` text NOT NULL,
	`query_key` text NOT NULL,
	`rdjb` text NOT NULL,
	`title_code` text,
	`queried_at` text NOT NULL,
	`created_at` text NOT NULL,
	`last_collected_at` text,
	`status` text NOT NULL,
	`failure_reason` text,
	`source` text,
	`evidence_status` text,
	`completed_at` text,
	`completeness` text NOT NULL,
	`full_range` integer,
	`fetched_count` integer,
	`declared_total` integer,
	`scope_mode` text,
	`provenance_state` text NOT NULL,
	`parse_state` text NOT NULL,
	`rule_version` text NOT NULL,
	`error_code` text,
	`error_message` text,
	`max_requests` integer,
	`max_rows` integer,
	`max_duration_ms` integer,
	`page_size` integer,
	FOREIGN KEY (`title_code`) REFERENCES `title`(`code`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "platform_collection_interface_ck" CHECK("platform_collection"."interface" IN ('business_list','apply_list','recognized_list')),
	CONSTRAINT "platform_collection_status_ck" CHECK("platform_collection"."status" IN ('success','failed','no_record','not_queried','partial')),
	CONSTRAINT "platform_collection_completeness_ck" CHECK("platform_collection"."completeness" IN ('complete','partial','not_queried','unknown')),
	CONSTRAINT "platform_collection_provenance_ck" CHECK("platform_collection"."provenance_state" IN ('captured','legacy_supplement','unknown','conflict')),
	CONSTRAINT "platform_collection_parse_ck" CHECK("platform_collection"."parse_state" IN ('valid','invalid','absent')),
	CONSTRAINT "platform_collection_full_range_ck" CHECK("platform_collection"."full_range" IS NULL OR (typeof("platform_collection"."full_range") = 'integer' AND "platform_collection"."full_range" IN (0,1))),
	CONSTRAINT "platform_collection_fetched_count_ck" CHECK("platform_collection"."fetched_count" IS NULL OR (typeof("platform_collection"."fetched_count") = 'integer' AND "platform_collection"."fetched_count" BETWEEN 0 AND 9007199254740991)),
	CONSTRAINT "platform_collection_declared_total_ck" CHECK("platform_collection"."declared_total" IS NULL OR (typeof("platform_collection"."declared_total") = 'integer' AND "platform_collection"."declared_total" BETWEEN 0 AND 9007199254740991)),
	CONSTRAINT "platform_collection_max_requests_ck" CHECK("platform_collection"."max_requests" IS NULL OR (typeof("platform_collection"."max_requests") = 'integer' AND "platform_collection"."max_requests" BETWEEN 1 AND 9007199254740991)),
	CONSTRAINT "platform_collection_max_rows_ck" CHECK("platform_collection"."max_rows" IS NULL OR (typeof("platform_collection"."max_rows") = 'integer' AND "platform_collection"."max_rows" BETWEEN 1 AND 9007199254740991)),
	CONSTRAINT "platform_collection_max_duration_ms_ck" CHECK("platform_collection"."max_duration_ms" IS NULL OR (typeof("platform_collection"."max_duration_ms") = 'integer' AND "platform_collection"."max_duration_ms" BETWEEN 1 AND 9007199254740991)),
	CONSTRAINT "platform_collection_page_size_ck" CHECK("platform_collection"."page_size" IS NULL OR (typeof("platform_collection"."page_size") = 'integer' AND "platform_collection"."page_size" BETWEEN 1 AND 9007199254740991))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `platform_collection_identity_uq` ON `platform_collection` (`interface`,`query_key`,`rdjb`,`queried_at`);--> statement-breakpoint
CREATE INDEX `platform_collection_key_idx` ON `platform_collection` (`query_key`,`id`);--> statement-breakpoint
CREATE INDEX `platform_collection_status_time_idx` ON `platform_collection` (`status`,`queried_at`,`id`);--> statement-breakpoint
CREATE INDEX `platform_collection_title_idx` ON `platform_collection` (`title_code`,`id`);--> statement-breakpoint
CREATE TABLE `platform_collection_condition` (
	`collection_id` integer NOT NULL,
	`name` text NOT NULL,
	`value_kind` text NOT NULL,
	`text_value` text,
	`integer_value` integer,
	PRIMARY KEY(`collection_id`, `name`),
	FOREIGN KEY (`collection_id`) REFERENCES `platform_collection`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "platform_collection_condition_name_ck" CHECK("platform_collection_condition"."name" IN ('name','uscc','combination','sqsj','rddqrq','whpcyear','whpc','szq','orderField','orderDirection')),
	CONSTRAINT "platform_collection_condition_value_ck" CHECK(
    ("platform_collection_condition"."value_kind" = 'text' AND "platform_collection_condition"."text_value" IS NOT NULL AND "platform_collection_condition"."integer_value" IS NULL) OR
    ("platform_collection_condition"."value_kind" = 'integer' AND "platform_collection_condition"."text_value" IS NULL AND "platform_collection_condition"."integer_value" IS NOT NULL AND typeof("platform_collection_condition"."integer_value") = 'integer' AND "platform_collection_condition"."integer_value" BETWEEN -9007199254740991 AND 9007199254740991) OR
    ("platform_collection_condition"."value_kind" = 'boolean' AND "platform_collection_condition"."text_value" IS NULL AND "platform_collection_condition"."integer_value" IS NOT NULL AND typeof("platform_collection_condition"."integer_value") = 'integer' AND "platform_collection_condition"."integer_value" IN (0,1)) OR
    ("platform_collection_condition"."value_kind" IN ('absent','null','real','array','object') AND "platform_collection_condition"."text_value" IS NULL AND "platform_collection_condition"."integer_value" IS NULL)
  )
);
--> statement-breakpoint
CREATE TABLE `platform_collection_page` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`collection_id` integer NOT NULL,
	`ordinal` integer NOT NULL,
	`source` text,
	`rdjb` text,
	`page_no` integer,
	`max_page` integer,
	`fetched_count` integer,
	`declared_total` integer,
	`status` text,
	`error_code` text,
	`error_message` text,
	`sequence_start` integer,
	`sequence_end` integer,
	`position_state` text NOT NULL,
	FOREIGN KEY (`collection_id`) REFERENCES `platform_collection`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "platform_collection_page_position_ck" CHECK("platform_collection_page"."position_state" IN ('verified','unknown','conflict')),
	CONSTRAINT "platform_collection_page_ordinal_ck" CHECK(typeof("platform_collection_page"."ordinal") = 'integer' AND "platform_collection_page"."ordinal" BETWEEN 0 AND 9007199254740991),
	CONSTRAINT "platform_collection_page_page_no_ck" CHECK("platform_collection_page"."page_no" IS NULL OR (typeof("platform_collection_page"."page_no") = 'integer' AND "platform_collection_page"."page_no" BETWEEN 1 AND 9007199254740991)),
	CONSTRAINT "platform_collection_page_max_page_ck" CHECK("platform_collection_page"."max_page" IS NULL OR (typeof("platform_collection_page"."max_page") = 'integer' AND "platform_collection_page"."max_page" BETWEEN 1 AND 9007199254740991)),
	CONSTRAINT "platform_collection_page_sequence_start_ck" CHECK("platform_collection_page"."sequence_start" IS NULL OR (typeof("platform_collection_page"."sequence_start") = 'integer' AND "platform_collection_page"."sequence_start" BETWEEN 1 AND 9007199254740991)),
	CONSTRAINT "platform_collection_page_sequence_end_ck" CHECK("platform_collection_page"."sequence_end" IS NULL OR (typeof("platform_collection_page"."sequence_end") = 'integer' AND "platform_collection_page"."sequence_end" BETWEEN 1 AND 9007199254740991)),
	CONSTRAINT "platform_collection_page_fetched_count_ck" CHECK("platform_collection_page"."fetched_count" IS NULL OR (typeof("platform_collection_page"."fetched_count") = 'integer' AND "platform_collection_page"."fetched_count" BETWEEN 0 AND 9007199254740991)),
	CONSTRAINT "platform_collection_page_declared_total_ck" CHECK("platform_collection_page"."declared_total" IS NULL OR (typeof("platform_collection_page"."declared_total") = 'integer' AND "platform_collection_page"."declared_total" BETWEEN 0 AND 9007199254740991)),
	CONSTRAINT "platform_collection_page_sequence_ck" CHECK(("platform_collection_page"."sequence_start" IS NULL AND "platform_collection_page"."sequence_end" IS NULL) OR ("platform_collection_page"."sequence_start" IS NOT NULL AND "platform_collection_page"."sequence_end" IS NOT NULL AND "platform_collection_page"."sequence_end" >= "platform_collection_page"."sequence_start"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `platform_collection_page_ordinal_uq` ON `platform_collection_page` (`collection_id`,`ordinal`);--> statement-breakpoint
CREATE INDEX `platform_collection_page_title_idx` ON `platform_collection_page` (`collection_id`,`rdjb`,`page_no`);--> statement-breakpoint
CREATE TABLE `platform_collection_unfinished` (
	`collection_id` integer NOT NULL,
	`ordinal` integer NOT NULL,
	`source` text,
	`rdjb` text,
	`page_no` integer,
	PRIMARY KEY(`collection_id`, `ordinal`),
	FOREIGN KEY (`collection_id`) REFERENCES `platform_collection`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "platform_collection_unfinished_ordinal_ck" CHECK(typeof("platform_collection_unfinished"."ordinal") = 'integer' AND "platform_collection_unfinished"."ordinal" BETWEEN 0 AND 9007199254740991),
	CONSTRAINT "platform_collection_unfinished_page_ck" CHECK("platform_collection_unfinished"."page_no" IS NULL OR (typeof("platform_collection_unfinished"."page_no") = 'integer' AND "platform_collection_unfinished"."page_no" BETWEEN 1 AND 9007199254740991))
);
--> statement-breakpoint
ALTER TABLE `platform_query_title_scope` ADD `collection_id` integer REFERENCES platform_collection(id) ON DELETE restrict;--> statement-breakpoint
CREATE UNIQUE INDEX `platform_query_title_scope_collection_uq` ON `platform_query_title_scope` (`collection_id`,`rdjb`);--> statement-breakpoint
CREATE INDEX `platform_query_title_scope_rdjb_collection_idx` ON `platform_query_title_scope` (`rdjb`,`collection_id`);--> statement-breakpoint
ALTER TABLE `platform_query_title_scope_error` ADD `collection_id` integer REFERENCES platform_collection(id) ON DELETE restrict;--> statement-breakpoint
CREATE UNIQUE INDEX `platform_query_title_scope_error_collection_uq` ON `platform_query_title_scope_error` (`collection_id`);