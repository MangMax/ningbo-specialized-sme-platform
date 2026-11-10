-- #714: rebuild populated incoming FK owners atomically with foreign_keys ON.
-- Generated parent DDL; unchanged child/index/trigger DDL from accepted 0051 catalog.
CREATE TEMP TABLE t714_platform_business_observation AS SELECT * FROM platform_business_observation;
--> statement-breakpoint
CREATE TEMP TABLE t714_platform_apply_projection AS SELECT * FROM platform_apply_projection;
--> statement-breakpoint
CREATE TEMP TABLE t714_platform_business_projection AS SELECT * FROM platform_business_projection;
--> statement-breakpoint
CREATE TEMP TABLE t714_platform_legacy_relation_alias AS SELECT * FROM platform_legacy_relation_alias;
--> statement-breakpoint
CREATE TEMP TABLE t714_platform_observation_archive_ref AS SELECT * FROM platform_observation_archive_ref;
--> statement-breakpoint
CREATE TEMP TABLE t714_platform_observation_assignment AS SELECT * FROM platform_observation_assignment;
--> statement-breakpoint
CREATE TEMP TABLE t714_platform_recognized_projection AS SELECT * FROM platform_recognized_projection;
--> statement-breakpoint
DROP TABLE platform_apply_projection;
--> statement-breakpoint
DROP TABLE platform_business_projection;
--> statement-breakpoint
DROP TABLE platform_legacy_relation_alias;
--> statement-breakpoint
DROP TABLE platform_observation_archive_ref;
--> statement-breakpoint
DROP TABLE platform_observation_assignment;
--> statement-breakpoint
DROP TABLE platform_recognized_projection;
--> statement-breakpoint
DROP TABLE platform_business_observation;
--> statement-breakpoint
CREATE TABLE `platform_business_observation` (
	`relation_id` integer PRIMARY KEY NOT NULL,
	`id` integer,
	`collection_id` integer,
	`sequence_no` integer,
	`page_id` integer,
	`page_row_no` integer,
	`position_state` text,
	`source_relation_key` text,
	`record_id` integer,
	`version_id` integer,
	`identity_state` text NOT NULL,
	`content_state` text NOT NULL,
	`key_source` text,
	`projection_rule_version` text,
	`input_fingerprint` text,
	`indexed_at` text,
	`batch_id` integer,
	FOREIGN KEY (`relation_id`) REFERENCES `platform_relation`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`collection_id`) REFERENCES `platform_collection`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`page_id`) REFERENCES `platform_collection_page`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`record_id`) REFERENCES `platform_business_record`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`batch_id`) REFERENCES `import_batch`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`version_id`,`record_id`) REFERENCES `platform_business_record_version`(`id`,`record_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "platform_observation_id_ck" CHECK("platform_business_observation"."id" IS NULL OR (typeof("platform_business_observation"."id") = 'integer' AND "platform_business_observation"."id" BETWEEN 1 AND 9007199254740991)),
	CONSTRAINT "platform_observation_collection_id_ck" CHECK("platform_business_observation"."collection_id" IS NULL OR (typeof("platform_business_observation"."collection_id") = 'integer' AND "platform_business_observation"."collection_id" BETWEEN 1 AND 9007199254740991)),
	CONSTRAINT "platform_observation_sequence_no_ck" CHECK("platform_business_observation"."sequence_no" IS NULL OR (typeof("platform_business_observation"."sequence_no") = 'integer' AND "platform_business_observation"."sequence_no" BETWEEN 1 AND 9007199254740991)),
	CONSTRAINT "platform_observation_page_id_ck" CHECK("platform_business_observation"."page_id" IS NULL OR (typeof("platform_business_observation"."page_id") = 'integer' AND "platform_business_observation"."page_id" BETWEEN 1 AND 9007199254740991)),
	CONSTRAINT "platform_observation_page_row_no_ck" CHECK("platform_business_observation"."page_row_no" IS NULL OR (typeof("platform_business_observation"."page_row_no") = 'integer' AND "platform_business_observation"."page_row_no" BETWEEN 1 AND 9007199254740991)),
	CONSTRAINT "platform_observation_position_state_ck" CHECK("platform_business_observation"."position_state" IS NULL OR "platform_business_observation"."position_state" IN ('verified','unknown','conflict')),
	CONSTRAINT "platform_observation_source_key_ck" CHECK("platform_business_observation"."source_relation_key" IS NULL OR typeof("platform_business_observation"."source_relation_key") = 'text'),
	CONSTRAINT "platform_observation_mapping_ck" CHECK(("platform_business_observation"."id" IS NULL AND "platform_business_observation"."collection_id" IS NULL AND "platform_business_observation"."sequence_no" IS NULL AND "platform_business_observation"."page_id" IS NULL AND "platform_business_observation"."page_row_no" IS NULL AND "platform_business_observation"."position_state" IS NULL AND "platform_business_observation"."source_relation_key" IS NULL) OR ("platform_business_observation"."id" IS NOT NULL AND "platform_business_observation"."collection_id" IS NOT NULL AND "platform_business_observation"."sequence_no" IS NOT NULL AND "platform_business_observation"."position_state" IS NOT NULL AND ("platform_business_observation"."page_row_no" IS NULL OR "platform_business_observation"."page_id" IS NOT NULL))),
	CONSTRAINT "platform_business_observation_state_ck" CHECK(("platform_business_observation"."identity_state" = 'resolved' AND "platform_business_observation"."record_id" IS NOT NULL) OR ("platform_business_observation"."identity_state" IN ('missing_key','conflict','not_indexed') AND "platform_business_observation"."record_id" IS NULL)),
	CONSTRAINT "platform_business_observation_content_ck" CHECK(("platform_business_observation"."content_state" = 'verified' AND "platform_business_observation"."version_id" IS NOT NULL AND "platform_business_observation"."record_id" IS NOT NULL) OR ("platform_business_observation"."content_state" IN ('unverifiable','not_indexed') AND "platform_business_observation"."version_id" IS NULL)),
	CONSTRAINT "platform_observation_capture_ck" CHECK(("platform_business_observation"."identity_state" = 'not_indexed' AND "platform_business_observation"."content_state" = 'not_indexed' AND "platform_business_observation"."record_id" IS NULL AND "platform_business_observation"."version_id" IS NULL AND "platform_business_observation"."key_source" IS NULL AND "platform_business_observation"."projection_rule_version" IS NULL AND "platform_business_observation"."input_fingerprint" IS NULL AND "platform_business_observation"."indexed_at" IS NULL) OR ("platform_business_observation"."identity_state" IN ('resolved','missing_key','conflict') AND "platform_business_observation"."content_state" IN ('verified','unverifiable') AND "platform_business_observation"."key_source" IS NOT NULL AND "platform_business_observation"."key_source" IN ('relation_key','raw_id','both','none') AND typeof("platform_business_observation"."projection_rule_version") = 'text' AND typeof("platform_business_observation"."input_fingerprint") = 'text' AND typeof("platform_business_observation"."indexed_at") = 'text'))
);

--> statement-breakpoint
CREATE TABLE "platform_apply_projection" (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`observation_id` integer,
	`basis` text DEFAULT 'verified_raw' NOT NULL,
	`version_id` integer,
	`record_id` integer,
	`declare_kind` text,
	`declaration_year` integer,
	`applied_at` text,
	`status` text,
	`title_raw` text,
	`name_raw` text,
	`uscc_raw` text,
	`source_title_kind` text,
	`source_title_text` text,
	`source_title_number_text` text,
	`source_title_boolean` integer,
	`source_title_rule_version` text,
	`source_archive_id` integer,
	`parse_state` text,
	`stored_province_kind` text,
	`stored_province` text,
	`parsed_province_kind` text,
	`parsed_province` text,
	`reconciled_province` text,
	`province_conflict` integer,
	`stored_status_kind` text,
	`stored_status` text,
	`parsed_status_kind` text,
	`parsed_status` text,
	`reconciled_status` text,
	`status_conflict` integer,
	`stored_batch_kind` text,
	`stored_batch` text,
	`parsed_batch_kind` text,
	`parsed_batch` text,
	`reconciled_batch` text,
	`batch_conflict` integer,
	`stored_declare_kind_kind` text,
	`stored_declare_kind` text,
	`parsed_declare_kind_kind` text,
	`parsed_declare_kind` text,
	`reconciled_declare_kind` text,
	`declare_kind_conflict` integer,
	`stored_applied_at_kind` text,
	`stored_applied_at` text,
	`parsed_applied_at_kind` text,
	`parsed_applied_at` text,
	`reconciled_applied_at` text,
	`applied_at_conflict` integer,
	`stored_award_batch_label_kind` text,
	`stored_award_batch_label` text,
	`parsed_award_batch_label_kind` text,
	`parsed_award_batch_label` text,
	`reconciled_award_batch_label` text,
	`award_batch_label_conflict` integer,
	`stored_year_kind` text,
	`stored_year` integer,
	`parsed_year_kind` text,
	`parsed_year` integer,
	`reconciled_year` integer,
	`year_conflict` integer,
	`rule_version` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`observation_id`) REFERENCES `platform_business_observation`(`relation_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`version_id`) REFERENCES `platform_business_record_version`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`record_id`) REFERENCES `platform_business_record`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`source_archive_id`) REFERENCES `platform_archive_value`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`version_id`,`record_id`) REFERENCES `platform_business_record_version`(`id`,`record_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "platform_apply_projection_owner_ck" CHECK(( "platform_apply_projection"."version_id" IS NOT NULL AND "platform_apply_projection"."record_id" IS NOT NULL AND "platform_apply_projection"."observation_id" IS NULL AND "platform_apply_projection"."basis" = 'verified_raw') OR ("platform_apply_projection"."version_id" IS NULL AND "platform_apply_projection"."record_id" IS NULL AND "platform_apply_projection"."observation_id" IS NOT NULL AND "platform_apply_projection"."basis" IN ('observation_reconciliation','unavailable'))),
	CONSTRAINT "platform_apply_projection_id_ck" CHECK("platform_apply_projection"."id" IS NULL OR (typeof("platform_apply_projection"."id") = 'integer' AND "platform_apply_projection"."id" BETWEEN 1 AND 9007199254740991)),
	CONSTRAINT "platform_apply_projection_version_id_ck" CHECK("platform_apply_projection"."version_id" IS NULL OR (typeof("platform_apply_projection"."version_id") = 'integer' AND "platform_apply_projection"."version_id" BETWEEN 1 AND 9007199254740991)),
	CONSTRAINT "platform_apply_projection_record_id_ck" CHECK("platform_apply_projection"."record_id" IS NULL OR (typeof("platform_apply_projection"."record_id") = 'integer' AND "platform_apply_projection"."record_id" BETWEEN 1 AND 9007199254740991)),
	CONSTRAINT "platform_apply_projection_observation_id_ck" CHECK("platform_apply_projection"."observation_id" IS NULL OR (typeof("platform_apply_projection"."observation_id") = 'integer' AND "platform_apply_projection"."observation_id" BETWEEN 1 AND 9007199254740991)),
	CONSTRAINT "platform_apply_projection_source_archive_id_ck" CHECK("platform_apply_projection"."source_archive_id" IS NULL OR (typeof("platform_apply_projection"."source_archive_id") = 'integer' AND "platform_apply_projection"."source_archive_id" BETWEEN 1 AND 9007199254740991)),
	CONSTRAINT "platform_apply_projection_capture_ck" CHECK(("platform_apply_projection"."observation_id" IS NULL AND "platform_apply_projection"."source_title_kind" IS NULL AND "platform_apply_projection"."source_title_text" IS NULL AND "platform_apply_projection"."source_title_number_text" IS NULL AND "platform_apply_projection"."source_title_boolean" IS NULL AND "platform_apply_projection"."source_title_rule_version" IS NULL AND "platform_apply_projection"."source_archive_id" IS NULL AND "platform_apply_projection"."parse_state" IS NULL AND "platform_apply_projection"."stored_province_kind" IS NULL AND "platform_apply_projection"."stored_province" IS NULL AND "platform_apply_projection"."parsed_province_kind" IS NULL AND "platform_apply_projection"."parsed_province" IS NULL AND "platform_apply_projection"."reconciled_province" IS NULL AND "platform_apply_projection"."province_conflict" IS NULL AND "platform_apply_projection"."stored_status_kind" IS NULL AND "platform_apply_projection"."stored_status" IS NULL AND "platform_apply_projection"."parsed_status_kind" IS NULL AND "platform_apply_projection"."parsed_status" IS NULL AND "platform_apply_projection"."reconciled_status" IS NULL AND "platform_apply_projection"."status_conflict" IS NULL AND "platform_apply_projection"."stored_batch_kind" IS NULL AND "platform_apply_projection"."stored_batch" IS NULL AND "platform_apply_projection"."parsed_batch_kind" IS NULL AND "platform_apply_projection"."parsed_batch" IS NULL AND "platform_apply_projection"."reconciled_batch" IS NULL AND "platform_apply_projection"."batch_conflict" IS NULL AND "platform_apply_projection"."stored_declare_kind_kind" IS NULL AND "platform_apply_projection"."stored_declare_kind" IS NULL AND "platform_apply_projection"."parsed_declare_kind_kind" IS NULL AND "platform_apply_projection"."parsed_declare_kind" IS NULL AND "platform_apply_projection"."reconciled_declare_kind" IS NULL AND "platform_apply_projection"."declare_kind_conflict" IS NULL AND "platform_apply_projection"."stored_applied_at_kind" IS NULL AND "platform_apply_projection"."stored_applied_at" IS NULL AND "platform_apply_projection"."parsed_applied_at_kind" IS NULL AND "platform_apply_projection"."parsed_applied_at" IS NULL AND "platform_apply_projection"."reconciled_applied_at" IS NULL AND "platform_apply_projection"."applied_at_conflict" IS NULL AND "platform_apply_projection"."stored_award_batch_label_kind" IS NULL AND "platform_apply_projection"."stored_award_batch_label" IS NULL AND "platform_apply_projection"."parsed_award_batch_label_kind" IS NULL AND "platform_apply_projection"."parsed_award_batch_label" IS NULL AND "platform_apply_projection"."reconciled_award_batch_label" IS NULL AND "platform_apply_projection"."award_batch_label_conflict" IS NULL AND "platform_apply_projection"."stored_year_kind" IS NULL AND "platform_apply_projection"."stored_year" IS NULL AND "platform_apply_projection"."parsed_year_kind" IS NULL AND "platform_apply_projection"."parsed_year" IS NULL AND "platform_apply_projection"."reconciled_year" IS NULL AND "platform_apply_projection"."year_conflict" IS NULL) OR ("platform_apply_projection"."observation_id" IS NOT NULL AND "platform_apply_projection"."source_title_kind" IS NOT NULL AND "platform_apply_projection"."source_title_rule_version" IS NOT NULL AND "platform_apply_projection"."source_archive_id" IS NOT NULL AND "platform_apply_projection"."parse_state" IS NOT NULL AND "platform_apply_projection"."stored_province_kind" IS NOT NULL AND "platform_apply_projection"."parsed_province_kind" IS NOT NULL AND "platform_apply_projection"."stored_status_kind" IS NOT NULL AND "platform_apply_projection"."parsed_status_kind" IS NOT NULL AND "platform_apply_projection"."stored_batch_kind" IS NOT NULL AND "platform_apply_projection"."parsed_batch_kind" IS NOT NULL AND "platform_apply_projection"."stored_declare_kind_kind" IS NOT NULL AND "platform_apply_projection"."parsed_declare_kind_kind" IS NOT NULL AND "platform_apply_projection"."stored_applied_at_kind" IS NOT NULL AND "platform_apply_projection"."parsed_applied_at_kind" IS NOT NULL AND "platform_apply_projection"."stored_award_batch_label_kind" IS NOT NULL AND "platform_apply_projection"."parsed_award_batch_label_kind" IS NOT NULL AND "platform_apply_projection"."stored_year_kind" IS NOT NULL AND "platform_apply_projection"."parsed_year_kind" IS NOT NULL AND "platform_apply_projection"."province_conflict" IS NOT NULL AND "platform_apply_projection"."status_conflict" IS NOT NULL AND "platform_apply_projection"."batch_conflict" IS NOT NULL AND "platform_apply_projection"."declare_kind_conflict" IS NOT NULL AND "platform_apply_projection"."applied_at_conflict" IS NOT NULL AND "platform_apply_projection"."award_batch_label_conflict" IS NOT NULL AND "platform_apply_projection"."year_conflict" IS NOT NULL)),
	CONSTRAINT "platform_apply_projection_title_ck" CHECK("platform_apply_projection"."source_title_kind" IS NULL OR ("platform_apply_projection"."source_title_kind" IN ('absent','null','array','object','invalid') AND "platform_apply_projection"."source_title_text" IS NULL AND "platform_apply_projection"."source_title_number_text" IS NULL AND "platform_apply_projection"."source_title_boolean" IS NULL) OR ("platform_apply_projection"."source_title_kind" = 'text' AND typeof("platform_apply_projection"."source_title_text") = 'text' AND "platform_apply_projection"."source_title_number_text" IS NULL AND "platform_apply_projection"."source_title_boolean" IS NULL) OR ("platform_apply_projection"."source_title_kind" = 'number' AND typeof("platform_apply_projection"."source_title_number_text") = 'text' AND length("platform_apply_projection"."source_title_number_text") > 0 AND trim("platform_apply_projection"."source_title_number_text") = "platform_apply_projection"."source_title_number_text" AND CASE WHEN json_valid("platform_apply_projection"."source_title_number_text") THEN json_type("platform_apply_projection"."source_title_number_text") IN ('integer','real') ELSE 0 END AND "platform_apply_projection"."source_title_text" IS NULL AND "platform_apply_projection"."source_title_boolean" IS NULL) OR ("platform_apply_projection"."source_title_kind" = 'boolean' AND typeof("platform_apply_projection"."source_title_boolean") = 'integer' AND "platform_apply_projection"."source_title_boolean" IN (0,1) AND "platform_apply_projection"."source_title_text" IS NULL AND "platform_apply_projection"."source_title_number_text" IS NULL)),
	CONSTRAINT "platform_apply_projection_parse_ck" CHECK("platform_apply_projection"."parse_state" IS NULL OR ("platform_apply_projection"."parse_state" IN ('valid','invalid','absent') AND (("platform_apply_projection"."basis" = 'unavailable') = ("platform_apply_projection"."parse_state" <> 'valid')))),
	CONSTRAINT "platform_apply_projection_rule_ck" CHECK("platform_apply_projection"."source_title_rule_version" IS NULL OR (typeof("platform_apply_projection"."source_title_rule_version") = 'text' AND length(trim("platform_apply_projection"."source_title_rule_version")) > 0)),
	CONSTRAINT "platform_apply_projection_stored_province_kind_ck" CHECK("platform_apply_projection"."stored_province_kind" IS NULL OR ("platform_apply_projection"."stored_province_kind" IN ('absent','null','text','number','boolean','array','object','invalid') AND ("platform_apply_projection"."stored_province_kind" NOT IN ('absent','null','array','object','invalid','boolean') OR "platform_apply_projection"."stored_province" IS NULL))),
	CONSTRAINT "platform_apply_projection_parsed_province_kind_ck" CHECK("platform_apply_projection"."parsed_province_kind" IS NULL OR ("platform_apply_projection"."parsed_province_kind" IN ('absent','null','text','number','boolean','array','object','invalid') AND ("platform_apply_projection"."parsed_province_kind" NOT IN ('absent','null','array','object','invalid','boolean') OR "platform_apply_projection"."parsed_province" IS NULL))),
	CONSTRAINT "platform_apply_projection_stored_province_ck" CHECK("platform_apply_projection"."stored_province" IS NULL OR (typeof("platform_apply_projection"."stored_province") = 'text')),
	CONSTRAINT "platform_apply_projection_parsed_province_ck" CHECK("platform_apply_projection"."parsed_province" IS NULL OR (typeof("platform_apply_projection"."parsed_province") = 'text')),
	CONSTRAINT "platform_apply_projection_reconciled_province_ck" CHECK("platform_apply_projection"."reconciled_province" IS NULL OR (typeof("platform_apply_projection"."reconciled_province") = 'text')),
	CONSTRAINT "platform_apply_projection_province_reconcile_ck" CHECK("platform_apply_projection"."observation_id" IS NULL OR (typeof("platform_apply_projection"."province_conflict") = 'integer' AND "platform_apply_projection"."province_conflict" = ("platform_apply_projection"."stored_province" IS NOT NULL AND "platform_apply_projection"."parsed_province" IS NOT NULL AND "platform_apply_projection"."stored_province" <> "platform_apply_projection"."parsed_province") AND "platform_apply_projection"."reconciled_province" IS (CASE WHEN "platform_apply_projection"."province_conflict" = 1 THEN NULL ELSE coalesce("platform_apply_projection"."stored_province","platform_apply_projection"."parsed_province") END))),
	CONSTRAINT "platform_apply_projection_stored_status_kind_ck" CHECK("platform_apply_projection"."stored_status_kind" IS NULL OR ("platform_apply_projection"."stored_status_kind" IN ('absent','null','text','number','boolean','array','object','invalid') AND ("platform_apply_projection"."stored_status_kind" NOT IN ('absent','null','array','object','invalid','boolean') OR "platform_apply_projection"."stored_status" IS NULL))),
	CONSTRAINT "platform_apply_projection_parsed_status_kind_ck" CHECK("platform_apply_projection"."parsed_status_kind" IS NULL OR ("platform_apply_projection"."parsed_status_kind" IN ('absent','null','text','number','boolean','array','object','invalid') AND ("platform_apply_projection"."parsed_status_kind" NOT IN ('absent','null','array','object','invalid','boolean') OR "platform_apply_projection"."parsed_status" IS NULL))),
	CONSTRAINT "platform_apply_projection_stored_status_ck" CHECK("platform_apply_projection"."stored_status" IS NULL OR (typeof("platform_apply_projection"."stored_status") = 'text')),
	CONSTRAINT "platform_apply_projection_parsed_status_ck" CHECK("platform_apply_projection"."parsed_status" IS NULL OR (typeof("platform_apply_projection"."parsed_status") = 'text')),
	CONSTRAINT "platform_apply_projection_reconciled_status_ck" CHECK("platform_apply_projection"."reconciled_status" IS NULL OR (typeof("platform_apply_projection"."reconciled_status") = 'text')),
	CONSTRAINT "platform_apply_projection_status_reconcile_ck" CHECK("platform_apply_projection"."observation_id" IS NULL OR (typeof("platform_apply_projection"."status_conflict") = 'integer' AND "platform_apply_projection"."status_conflict" = ("platform_apply_projection"."stored_status" IS NOT NULL AND "platform_apply_projection"."parsed_status" IS NOT NULL AND "platform_apply_projection"."stored_status" <> "platform_apply_projection"."parsed_status") AND "platform_apply_projection"."reconciled_status" IS (CASE WHEN "platform_apply_projection"."status_conflict" = 1 THEN NULL ELSE coalesce("platform_apply_projection"."stored_status","platform_apply_projection"."parsed_status") END))),
	CONSTRAINT "platform_apply_projection_stored_batch_kind_ck" CHECK("platform_apply_projection"."stored_batch_kind" IS NULL OR ("platform_apply_projection"."stored_batch_kind" IN ('absent','null','text','number','boolean','array','object','invalid') AND ("platform_apply_projection"."stored_batch_kind" NOT IN ('absent','null','array','object','invalid','boolean') OR "platform_apply_projection"."stored_batch" IS NULL))),
	CONSTRAINT "platform_apply_projection_parsed_batch_kind_ck" CHECK("platform_apply_projection"."parsed_batch_kind" IS NULL OR ("platform_apply_projection"."parsed_batch_kind" IN ('absent','null','text','number','boolean','array','object','invalid') AND ("platform_apply_projection"."parsed_batch_kind" NOT IN ('absent','null','array','object','invalid','boolean') OR "platform_apply_projection"."parsed_batch" IS NULL))),
	CONSTRAINT "platform_apply_projection_stored_batch_ck" CHECK("platform_apply_projection"."stored_batch" IS NULL OR (typeof("platform_apply_projection"."stored_batch") = 'text')),
	CONSTRAINT "platform_apply_projection_parsed_batch_ck" CHECK("platform_apply_projection"."parsed_batch" IS NULL OR (typeof("platform_apply_projection"."parsed_batch") = 'text')),
	CONSTRAINT "platform_apply_projection_reconciled_batch_ck" CHECK("platform_apply_projection"."reconciled_batch" IS NULL OR (typeof("platform_apply_projection"."reconciled_batch") = 'text')),
	CONSTRAINT "platform_apply_projection_batch_reconcile_ck" CHECK("platform_apply_projection"."observation_id" IS NULL OR (typeof("platform_apply_projection"."batch_conflict") = 'integer' AND "platform_apply_projection"."batch_conflict" = ("platform_apply_projection"."stored_batch" IS NOT NULL AND "platform_apply_projection"."parsed_batch" IS NOT NULL AND "platform_apply_projection"."stored_batch" <> "platform_apply_projection"."parsed_batch") AND "platform_apply_projection"."reconciled_batch" IS (CASE WHEN "platform_apply_projection"."batch_conflict" = 1 THEN NULL ELSE coalesce("platform_apply_projection"."stored_batch","platform_apply_projection"."parsed_batch") END))),
	CONSTRAINT "platform_apply_projection_stored_declare_kind_kind_ck" CHECK("platform_apply_projection"."stored_declare_kind_kind" IS NULL OR ("platform_apply_projection"."stored_declare_kind_kind" IN ('absent','null','text','number','boolean','array','object','invalid') AND ("platform_apply_projection"."stored_declare_kind_kind" NOT IN ('absent','null','array','object','invalid','boolean') OR "platform_apply_projection"."stored_declare_kind" IS NULL))),
	CONSTRAINT "platform_apply_projection_parsed_declare_kind_kind_ck" CHECK("platform_apply_projection"."parsed_declare_kind_kind" IS NULL OR ("platform_apply_projection"."parsed_declare_kind_kind" IN ('absent','null','text','number','boolean','array','object','invalid') AND ("platform_apply_projection"."parsed_declare_kind_kind" NOT IN ('absent','null','array','object','invalid','boolean') OR "platform_apply_projection"."parsed_declare_kind" IS NULL))),
	CONSTRAINT "platform_apply_projection_stored_declare_kind_ck" CHECK("platform_apply_projection"."stored_declare_kind" IS NULL OR (typeof("platform_apply_projection"."stored_declare_kind") = 'text')),
	CONSTRAINT "platform_apply_projection_parsed_declare_kind_ck" CHECK("platform_apply_projection"."parsed_declare_kind" IS NULL OR (typeof("platform_apply_projection"."parsed_declare_kind") = 'text')),
	CONSTRAINT "platform_apply_projection_reconciled_declare_kind_ck" CHECK("platform_apply_projection"."reconciled_declare_kind" IS NULL OR (typeof("platform_apply_projection"."reconciled_declare_kind") = 'text')),
	CONSTRAINT "platform_apply_projection_declare_kind_reconcile_ck" CHECK("platform_apply_projection"."observation_id" IS NULL OR (typeof("platform_apply_projection"."declare_kind_conflict") = 'integer' AND "platform_apply_projection"."declare_kind_conflict" = ("platform_apply_projection"."stored_declare_kind" IS NOT NULL AND "platform_apply_projection"."parsed_declare_kind" IS NOT NULL AND "platform_apply_projection"."stored_declare_kind" <> "platform_apply_projection"."parsed_declare_kind") AND "platform_apply_projection"."reconciled_declare_kind" IS (CASE WHEN "platform_apply_projection"."declare_kind_conflict" = 1 THEN NULL ELSE coalesce("platform_apply_projection"."stored_declare_kind","platform_apply_projection"."parsed_declare_kind") END))),
	CONSTRAINT "platform_apply_projection_stored_applied_at_kind_ck" CHECK("platform_apply_projection"."stored_applied_at_kind" IS NULL OR ("platform_apply_projection"."stored_applied_at_kind" IN ('absent','null','text','number','boolean','array','object','invalid') AND ("platform_apply_projection"."stored_applied_at_kind" NOT IN ('absent','null','array','object','invalid','boolean') OR "platform_apply_projection"."stored_applied_at" IS NULL))),
	CONSTRAINT "platform_apply_projection_parsed_applied_at_kind_ck" CHECK("platform_apply_projection"."parsed_applied_at_kind" IS NULL OR ("platform_apply_projection"."parsed_applied_at_kind" IN ('absent','null','text','number','boolean','array','object','invalid') AND ("platform_apply_projection"."parsed_applied_at_kind" NOT IN ('absent','null','array','object','invalid','boolean') OR "platform_apply_projection"."parsed_applied_at" IS NULL))),
	CONSTRAINT "platform_apply_projection_stored_applied_at_ck" CHECK("platform_apply_projection"."stored_applied_at" IS NULL OR (typeof("platform_apply_projection"."stored_applied_at") = 'text')),
	CONSTRAINT "platform_apply_projection_parsed_applied_at_ck" CHECK("platform_apply_projection"."parsed_applied_at" IS NULL OR (typeof("platform_apply_projection"."parsed_applied_at") = 'text')),
	CONSTRAINT "platform_apply_projection_reconciled_applied_at_ck" CHECK("platform_apply_projection"."reconciled_applied_at" IS NULL OR (typeof("platform_apply_projection"."reconciled_applied_at") = 'text')),
	CONSTRAINT "platform_apply_projection_applied_at_reconcile_ck" CHECK("platform_apply_projection"."observation_id" IS NULL OR (typeof("platform_apply_projection"."applied_at_conflict") = 'integer' AND "platform_apply_projection"."applied_at_conflict" = ("platform_apply_projection"."stored_applied_at" IS NOT NULL AND "platform_apply_projection"."parsed_applied_at" IS NOT NULL AND "platform_apply_projection"."stored_applied_at" <> "platform_apply_projection"."parsed_applied_at") AND "platform_apply_projection"."reconciled_applied_at" IS (CASE WHEN "platform_apply_projection"."applied_at_conflict" = 1 THEN NULL ELSE coalesce("platform_apply_projection"."stored_applied_at","platform_apply_projection"."parsed_applied_at") END))),
	CONSTRAINT "platform_apply_projection_stored_award_batch_label_kind_ck" CHECK("platform_apply_projection"."stored_award_batch_label_kind" IS NULL OR ("platform_apply_projection"."stored_award_batch_label_kind" IN ('absent','null','text','number','boolean','array','object','invalid') AND ("platform_apply_projection"."stored_award_batch_label_kind" NOT IN ('absent','null','array','object','invalid','boolean') OR "platform_apply_projection"."stored_award_batch_label" IS NULL))),
	CONSTRAINT "platform_apply_projection_parsed_award_batch_label_kind_ck" CHECK("platform_apply_projection"."parsed_award_batch_label_kind" IS NULL OR ("platform_apply_projection"."parsed_award_batch_label_kind" IN ('absent','null','text','number','boolean','array','object','invalid') AND ("platform_apply_projection"."parsed_award_batch_label_kind" NOT IN ('absent','null','array','object','invalid','boolean') OR "platform_apply_projection"."parsed_award_batch_label" IS NULL))),
	CONSTRAINT "platform_apply_projection_stored_award_batch_label_ck" CHECK("platform_apply_projection"."stored_award_batch_label" IS NULL OR (typeof("platform_apply_projection"."stored_award_batch_label") = 'text')),
	CONSTRAINT "platform_apply_projection_parsed_award_batch_label_ck" CHECK("platform_apply_projection"."parsed_award_batch_label" IS NULL OR (typeof("platform_apply_projection"."parsed_award_batch_label") = 'text')),
	CONSTRAINT "platform_apply_projection_reconciled_award_batch_label_ck" CHECK("platform_apply_projection"."reconciled_award_batch_label" IS NULL OR (typeof("platform_apply_projection"."reconciled_award_batch_label") = 'text')),
	CONSTRAINT "platform_apply_projection_award_batch_label_reconcile_ck" CHECK("platform_apply_projection"."observation_id" IS NULL OR (typeof("platform_apply_projection"."award_batch_label_conflict") = 'integer' AND "platform_apply_projection"."award_batch_label_conflict" = ("platform_apply_projection"."stored_award_batch_label" IS NOT NULL AND "platform_apply_projection"."parsed_award_batch_label" IS NOT NULL AND "platform_apply_projection"."stored_award_batch_label" <> "platform_apply_projection"."parsed_award_batch_label") AND "platform_apply_projection"."reconciled_award_batch_label" IS (CASE WHEN "platform_apply_projection"."award_batch_label_conflict" = 1 THEN NULL ELSE coalesce("platform_apply_projection"."stored_award_batch_label","platform_apply_projection"."parsed_award_batch_label") END))),
	CONSTRAINT "platform_apply_projection_stored_year_kind_ck" CHECK("platform_apply_projection"."stored_year_kind" IS NULL OR ("platform_apply_projection"."stored_year_kind" IN ('absent','null','text','number','boolean','array','object','invalid') AND ("platform_apply_projection"."stored_year_kind" NOT IN ('absent','null','array','object','invalid','boolean') OR "platform_apply_projection"."stored_year" IS NULL))),
	CONSTRAINT "platform_apply_projection_parsed_year_kind_ck" CHECK("platform_apply_projection"."parsed_year_kind" IS NULL OR ("platform_apply_projection"."parsed_year_kind" IN ('absent','null','text','number','boolean','array','object','invalid') AND ("platform_apply_projection"."parsed_year_kind" NOT IN ('absent','null','array','object','invalid','boolean') OR "platform_apply_projection"."parsed_year" IS NULL))),
	CONSTRAINT "platform_apply_projection_stored_year_ck" CHECK("platform_apply_projection"."stored_year" IS NULL OR (typeof("platform_apply_projection"."stored_year") = 'integer' AND "platform_apply_projection"."stored_year" BETWEEN -9007199254740991 AND 9007199254740991)),
	CONSTRAINT "platform_apply_projection_parsed_year_ck" CHECK("platform_apply_projection"."parsed_year" IS NULL OR (typeof("platform_apply_projection"."parsed_year") = 'integer' AND "platform_apply_projection"."parsed_year" BETWEEN -9007199254740991 AND 9007199254740991)),
	CONSTRAINT "platform_apply_projection_reconciled_year_ck" CHECK("platform_apply_projection"."reconciled_year" IS NULL OR (typeof("platform_apply_projection"."reconciled_year") = 'integer' AND "platform_apply_projection"."reconciled_year" BETWEEN -9007199254740991 AND 9007199254740991)),
	CONSTRAINT "platform_apply_projection_year_reconcile_ck" CHECK("platform_apply_projection"."observation_id" IS NULL OR (typeof("platform_apply_projection"."year_conflict") = 'integer' AND "platform_apply_projection"."year_conflict" = ("platform_apply_projection"."stored_year" IS NOT NULL AND "platform_apply_projection"."parsed_year" IS NOT NULL AND "platform_apply_projection"."stored_year" <> "platform_apply_projection"."parsed_year") AND "platform_apply_projection"."reconciled_year" IS (CASE WHEN "platform_apply_projection"."year_conflict" = 1 THEN NULL ELSE coalesce("platform_apply_projection"."stored_year","platform_apply_projection"."parsed_year") END)))
);
--> statement-breakpoint
CREATE TABLE "platform_business_projection" (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`observation_id` integer,
	`basis` text DEFAULT 'verified_raw' NOT NULL,
	`version_id` integer,
	`record_id` integer,
	`declare_kind` text,
	`business_year` integer,
	`applied_at` text,
	`status` text,
	`batch` text,
	`award_batch_label` text,
	`province` text,
	`title_raw` text,
	`name_raw` text,
	`uscc_raw` text,
	`source_title_kind` text,
	`source_title_text` text,
	`source_title_number_text` text,
	`source_title_boolean` integer,
	`source_title_rule_version` text,
	`source_archive_id` integer,
	`parse_state` text,
	`stored_province_kind` text,
	`stored_province` text,
	`parsed_province_kind` text,
	`parsed_province` text,
	`reconciled_province` text,
	`province_conflict` integer,
	`stored_status_kind` text,
	`stored_status` text,
	`parsed_status_kind` text,
	`parsed_status` text,
	`reconciled_status` text,
	`status_conflict` integer,
	`stored_batch_kind` text,
	`stored_batch` text,
	`parsed_batch_kind` text,
	`parsed_batch` text,
	`reconciled_batch` text,
	`batch_conflict` integer,
	`stored_declare_kind_kind` text,
	`stored_declare_kind` text,
	`parsed_declare_kind_kind` text,
	`parsed_declare_kind` text,
	`reconciled_declare_kind` text,
	`declare_kind_conflict` integer,
	`stored_applied_at_kind` text,
	`stored_applied_at` text,
	`parsed_applied_at_kind` text,
	`parsed_applied_at` text,
	`reconciled_applied_at` text,
	`applied_at_conflict` integer,
	`stored_award_batch_label_kind` text,
	`stored_award_batch_label` text,
	`parsed_award_batch_label_kind` text,
	`parsed_award_batch_label` text,
	`reconciled_award_batch_label` text,
	`award_batch_label_conflict` integer,
	`stored_year_kind` text,
	`stored_year` integer,
	`parsed_year_kind` text,
	`parsed_year` integer,
	`reconciled_year` integer,
	`year_conflict` integer,
	`rule_version` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`observation_id`) REFERENCES `platform_business_observation`(`relation_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`version_id`) REFERENCES `platform_business_record_version`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`record_id`) REFERENCES `platform_business_record`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`source_archive_id`) REFERENCES `platform_archive_value`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`version_id`,`record_id`) REFERENCES `platform_business_record_version`(`id`,`record_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "platform_business_projection_owner_ck" CHECK(( "platform_business_projection"."version_id" IS NOT NULL AND "platform_business_projection"."record_id" IS NOT NULL AND "platform_business_projection"."observation_id" IS NULL AND "platform_business_projection"."basis" = 'verified_raw') OR ("platform_business_projection"."version_id" IS NULL AND "platform_business_projection"."record_id" IS NULL AND "platform_business_projection"."observation_id" IS NOT NULL AND "platform_business_projection"."basis" IN ('observation_reconciliation','unavailable'))),
	CONSTRAINT "platform_business_projection_id_ck" CHECK("platform_business_projection"."id" IS NULL OR (typeof("platform_business_projection"."id") = 'integer' AND "platform_business_projection"."id" BETWEEN 1 AND 9007199254740991)),
	CONSTRAINT "platform_business_projection_version_id_ck" CHECK("platform_business_projection"."version_id" IS NULL OR (typeof("platform_business_projection"."version_id") = 'integer' AND "platform_business_projection"."version_id" BETWEEN 1 AND 9007199254740991)),
	CONSTRAINT "platform_business_projection_record_id_ck" CHECK("platform_business_projection"."record_id" IS NULL OR (typeof("platform_business_projection"."record_id") = 'integer' AND "platform_business_projection"."record_id" BETWEEN 1 AND 9007199254740991)),
	CONSTRAINT "platform_business_projection_observation_id_ck" CHECK("platform_business_projection"."observation_id" IS NULL OR (typeof("platform_business_projection"."observation_id") = 'integer' AND "platform_business_projection"."observation_id" BETWEEN 1 AND 9007199254740991)),
	CONSTRAINT "platform_business_projection_source_archive_id_ck" CHECK("platform_business_projection"."source_archive_id" IS NULL OR (typeof("platform_business_projection"."source_archive_id") = 'integer' AND "platform_business_projection"."source_archive_id" BETWEEN 1 AND 9007199254740991)),
	CONSTRAINT "platform_business_projection_capture_ck" CHECK(("platform_business_projection"."observation_id" IS NULL AND "platform_business_projection"."source_title_kind" IS NULL AND "platform_business_projection"."source_title_text" IS NULL AND "platform_business_projection"."source_title_number_text" IS NULL AND "platform_business_projection"."source_title_boolean" IS NULL AND "platform_business_projection"."source_title_rule_version" IS NULL AND "platform_business_projection"."source_archive_id" IS NULL AND "platform_business_projection"."parse_state" IS NULL AND "platform_business_projection"."stored_province_kind" IS NULL AND "platform_business_projection"."stored_province" IS NULL AND "platform_business_projection"."parsed_province_kind" IS NULL AND "platform_business_projection"."parsed_province" IS NULL AND "platform_business_projection"."reconciled_province" IS NULL AND "platform_business_projection"."province_conflict" IS NULL AND "platform_business_projection"."stored_status_kind" IS NULL AND "platform_business_projection"."stored_status" IS NULL AND "platform_business_projection"."parsed_status_kind" IS NULL AND "platform_business_projection"."parsed_status" IS NULL AND "platform_business_projection"."reconciled_status" IS NULL AND "platform_business_projection"."status_conflict" IS NULL AND "platform_business_projection"."stored_batch_kind" IS NULL AND "platform_business_projection"."stored_batch" IS NULL AND "platform_business_projection"."parsed_batch_kind" IS NULL AND "platform_business_projection"."parsed_batch" IS NULL AND "platform_business_projection"."reconciled_batch" IS NULL AND "platform_business_projection"."batch_conflict" IS NULL AND "platform_business_projection"."stored_declare_kind_kind" IS NULL AND "platform_business_projection"."stored_declare_kind" IS NULL AND "platform_business_projection"."parsed_declare_kind_kind" IS NULL AND "platform_business_projection"."parsed_declare_kind" IS NULL AND "platform_business_projection"."reconciled_declare_kind" IS NULL AND "platform_business_projection"."declare_kind_conflict" IS NULL AND "platform_business_projection"."stored_applied_at_kind" IS NULL AND "platform_business_projection"."stored_applied_at" IS NULL AND "platform_business_projection"."parsed_applied_at_kind" IS NULL AND "platform_business_projection"."parsed_applied_at" IS NULL AND "platform_business_projection"."reconciled_applied_at" IS NULL AND "platform_business_projection"."applied_at_conflict" IS NULL AND "platform_business_projection"."stored_award_batch_label_kind" IS NULL AND "platform_business_projection"."stored_award_batch_label" IS NULL AND "platform_business_projection"."parsed_award_batch_label_kind" IS NULL AND "platform_business_projection"."parsed_award_batch_label" IS NULL AND "platform_business_projection"."reconciled_award_batch_label" IS NULL AND "platform_business_projection"."award_batch_label_conflict" IS NULL AND "platform_business_projection"."stored_year_kind" IS NULL AND "platform_business_projection"."stored_year" IS NULL AND "platform_business_projection"."parsed_year_kind" IS NULL AND "platform_business_projection"."parsed_year" IS NULL AND "platform_business_projection"."reconciled_year" IS NULL AND "platform_business_projection"."year_conflict" IS NULL) OR ("platform_business_projection"."observation_id" IS NOT NULL AND "platform_business_projection"."source_title_kind" IS NOT NULL AND "platform_business_projection"."source_title_rule_version" IS NOT NULL AND "platform_business_projection"."source_archive_id" IS NOT NULL AND "platform_business_projection"."parse_state" IS NOT NULL AND "platform_business_projection"."stored_province_kind" IS NOT NULL AND "platform_business_projection"."parsed_province_kind" IS NOT NULL AND "platform_business_projection"."stored_status_kind" IS NOT NULL AND "platform_business_projection"."parsed_status_kind" IS NOT NULL AND "platform_business_projection"."stored_batch_kind" IS NOT NULL AND "platform_business_projection"."parsed_batch_kind" IS NOT NULL AND "platform_business_projection"."stored_declare_kind_kind" IS NOT NULL AND "platform_business_projection"."parsed_declare_kind_kind" IS NOT NULL AND "platform_business_projection"."stored_applied_at_kind" IS NOT NULL AND "platform_business_projection"."parsed_applied_at_kind" IS NOT NULL AND "platform_business_projection"."stored_award_batch_label_kind" IS NOT NULL AND "platform_business_projection"."parsed_award_batch_label_kind" IS NOT NULL AND "platform_business_projection"."stored_year_kind" IS NOT NULL AND "platform_business_projection"."parsed_year_kind" IS NOT NULL AND "platform_business_projection"."province_conflict" IS NOT NULL AND "platform_business_projection"."status_conflict" IS NOT NULL AND "platform_business_projection"."batch_conflict" IS NOT NULL AND "platform_business_projection"."declare_kind_conflict" IS NOT NULL AND "platform_business_projection"."applied_at_conflict" IS NOT NULL AND "platform_business_projection"."award_batch_label_conflict" IS NOT NULL AND "platform_business_projection"."year_conflict" IS NOT NULL)),
	CONSTRAINT "platform_business_projection_title_ck" CHECK("platform_business_projection"."source_title_kind" IS NULL OR ("platform_business_projection"."source_title_kind" IN ('absent','null','array','object','invalid') AND "platform_business_projection"."source_title_text" IS NULL AND "platform_business_projection"."source_title_number_text" IS NULL AND "platform_business_projection"."source_title_boolean" IS NULL) OR ("platform_business_projection"."source_title_kind" = 'text' AND typeof("platform_business_projection"."source_title_text") = 'text' AND "platform_business_projection"."source_title_number_text" IS NULL AND "platform_business_projection"."source_title_boolean" IS NULL) OR ("platform_business_projection"."source_title_kind" = 'number' AND typeof("platform_business_projection"."source_title_number_text") = 'text' AND length("platform_business_projection"."source_title_number_text") > 0 AND trim("platform_business_projection"."source_title_number_text") = "platform_business_projection"."source_title_number_text" AND CASE WHEN json_valid("platform_business_projection"."source_title_number_text") THEN json_type("platform_business_projection"."source_title_number_text") IN ('integer','real') ELSE 0 END AND "platform_business_projection"."source_title_text" IS NULL AND "platform_business_projection"."source_title_boolean" IS NULL) OR ("platform_business_projection"."source_title_kind" = 'boolean' AND typeof("platform_business_projection"."source_title_boolean") = 'integer' AND "platform_business_projection"."source_title_boolean" IN (0,1) AND "platform_business_projection"."source_title_text" IS NULL AND "platform_business_projection"."source_title_number_text" IS NULL)),
	CONSTRAINT "platform_business_projection_parse_ck" CHECK("platform_business_projection"."parse_state" IS NULL OR ("platform_business_projection"."parse_state" IN ('valid','invalid','absent') AND (("platform_business_projection"."basis" = 'unavailable') = ("platform_business_projection"."parse_state" <> 'valid')))),
	CONSTRAINT "platform_business_projection_rule_ck" CHECK("platform_business_projection"."source_title_rule_version" IS NULL OR (typeof("platform_business_projection"."source_title_rule_version") = 'text' AND length(trim("platform_business_projection"."source_title_rule_version")) > 0)),
	CONSTRAINT "platform_business_projection_stored_province_kind_ck" CHECK("platform_business_projection"."stored_province_kind" IS NULL OR ("platform_business_projection"."stored_province_kind" IN ('absent','null','text','number','boolean','array','object','invalid') AND ("platform_business_projection"."stored_province_kind" NOT IN ('absent','null','array','object','invalid','boolean') OR "platform_business_projection"."stored_province" IS NULL))),
	CONSTRAINT "platform_business_projection_parsed_province_kind_ck" CHECK("platform_business_projection"."parsed_province_kind" IS NULL OR ("platform_business_projection"."parsed_province_kind" IN ('absent','null','text','number','boolean','array','object','invalid') AND ("platform_business_projection"."parsed_province_kind" NOT IN ('absent','null','array','object','invalid','boolean') OR "platform_business_projection"."parsed_province" IS NULL))),
	CONSTRAINT "platform_business_projection_stored_province_ck" CHECK("platform_business_projection"."stored_province" IS NULL OR (typeof("platform_business_projection"."stored_province") = 'text')),
	CONSTRAINT "platform_business_projection_parsed_province_ck" CHECK("platform_business_projection"."parsed_province" IS NULL OR (typeof("platform_business_projection"."parsed_province") = 'text')),
	CONSTRAINT "platform_business_projection_reconciled_province_ck" CHECK("platform_business_projection"."reconciled_province" IS NULL OR (typeof("platform_business_projection"."reconciled_province") = 'text')),
	CONSTRAINT "platform_business_projection_province_reconcile_ck" CHECK("platform_business_projection"."observation_id" IS NULL OR (typeof("platform_business_projection"."province_conflict") = 'integer' AND "platform_business_projection"."province_conflict" = ("platform_business_projection"."stored_province" IS NOT NULL AND "platform_business_projection"."parsed_province" IS NOT NULL AND "platform_business_projection"."stored_province" <> "platform_business_projection"."parsed_province") AND "platform_business_projection"."reconciled_province" IS (CASE WHEN "platform_business_projection"."province_conflict" = 1 THEN NULL ELSE coalesce("platform_business_projection"."stored_province","platform_business_projection"."parsed_province") END))),
	CONSTRAINT "platform_business_projection_stored_status_kind_ck" CHECK("platform_business_projection"."stored_status_kind" IS NULL OR ("platform_business_projection"."stored_status_kind" IN ('absent','null','text','number','boolean','array','object','invalid') AND ("platform_business_projection"."stored_status_kind" NOT IN ('absent','null','array','object','invalid','boolean') OR "platform_business_projection"."stored_status" IS NULL))),
	CONSTRAINT "platform_business_projection_parsed_status_kind_ck" CHECK("platform_business_projection"."parsed_status_kind" IS NULL OR ("platform_business_projection"."parsed_status_kind" IN ('absent','null','text','number','boolean','array','object','invalid') AND ("platform_business_projection"."parsed_status_kind" NOT IN ('absent','null','array','object','invalid','boolean') OR "platform_business_projection"."parsed_status" IS NULL))),
	CONSTRAINT "platform_business_projection_stored_status_ck" CHECK("platform_business_projection"."stored_status" IS NULL OR (typeof("platform_business_projection"."stored_status") = 'text')),
	CONSTRAINT "platform_business_projection_parsed_status_ck" CHECK("platform_business_projection"."parsed_status" IS NULL OR (typeof("platform_business_projection"."parsed_status") = 'text')),
	CONSTRAINT "platform_business_projection_reconciled_status_ck" CHECK("platform_business_projection"."reconciled_status" IS NULL OR (typeof("platform_business_projection"."reconciled_status") = 'text')),
	CONSTRAINT "platform_business_projection_status_reconcile_ck" CHECK("platform_business_projection"."observation_id" IS NULL OR (typeof("platform_business_projection"."status_conflict") = 'integer' AND "platform_business_projection"."status_conflict" = ("platform_business_projection"."stored_status" IS NOT NULL AND "platform_business_projection"."parsed_status" IS NOT NULL AND "platform_business_projection"."stored_status" <> "platform_business_projection"."parsed_status") AND "platform_business_projection"."reconciled_status" IS (CASE WHEN "platform_business_projection"."status_conflict" = 1 THEN NULL ELSE coalesce("platform_business_projection"."stored_status","platform_business_projection"."parsed_status") END))),
	CONSTRAINT "platform_business_projection_stored_batch_kind_ck" CHECK("platform_business_projection"."stored_batch_kind" IS NULL OR ("platform_business_projection"."stored_batch_kind" IN ('absent','null','text','number','boolean','array','object','invalid') AND ("platform_business_projection"."stored_batch_kind" NOT IN ('absent','null','array','object','invalid','boolean') OR "platform_business_projection"."stored_batch" IS NULL))),
	CONSTRAINT "platform_business_projection_parsed_batch_kind_ck" CHECK("platform_business_projection"."parsed_batch_kind" IS NULL OR ("platform_business_projection"."parsed_batch_kind" IN ('absent','null','text','number','boolean','array','object','invalid') AND ("platform_business_projection"."parsed_batch_kind" NOT IN ('absent','null','array','object','invalid','boolean') OR "platform_business_projection"."parsed_batch" IS NULL))),
	CONSTRAINT "platform_business_projection_stored_batch_ck" CHECK("platform_business_projection"."stored_batch" IS NULL OR (typeof("platform_business_projection"."stored_batch") = 'text')),
	CONSTRAINT "platform_business_projection_parsed_batch_ck" CHECK("platform_business_projection"."parsed_batch" IS NULL OR (typeof("platform_business_projection"."parsed_batch") = 'text')),
	CONSTRAINT "platform_business_projection_reconciled_batch_ck" CHECK("platform_business_projection"."reconciled_batch" IS NULL OR (typeof("platform_business_projection"."reconciled_batch") = 'text')),
	CONSTRAINT "platform_business_projection_batch_reconcile_ck" CHECK("platform_business_projection"."observation_id" IS NULL OR (typeof("platform_business_projection"."batch_conflict") = 'integer' AND "platform_business_projection"."batch_conflict" = ("platform_business_projection"."stored_batch" IS NOT NULL AND "platform_business_projection"."parsed_batch" IS NOT NULL AND "platform_business_projection"."stored_batch" <> "platform_business_projection"."parsed_batch") AND "platform_business_projection"."reconciled_batch" IS (CASE WHEN "platform_business_projection"."batch_conflict" = 1 THEN NULL ELSE coalesce("platform_business_projection"."stored_batch","platform_business_projection"."parsed_batch") END))),
	CONSTRAINT "platform_business_projection_stored_declare_kind_kind_ck" CHECK("platform_business_projection"."stored_declare_kind_kind" IS NULL OR ("platform_business_projection"."stored_declare_kind_kind" IN ('absent','null','text','number','boolean','array','object','invalid') AND ("platform_business_projection"."stored_declare_kind_kind" NOT IN ('absent','null','array','object','invalid','boolean') OR "platform_business_projection"."stored_declare_kind" IS NULL))),
	CONSTRAINT "platform_business_projection_parsed_declare_kind_kind_ck" CHECK("platform_business_projection"."parsed_declare_kind_kind" IS NULL OR ("platform_business_projection"."parsed_declare_kind_kind" IN ('absent','null','text','number','boolean','array','object','invalid') AND ("platform_business_projection"."parsed_declare_kind_kind" NOT IN ('absent','null','array','object','invalid','boolean') OR "platform_business_projection"."parsed_declare_kind" IS NULL))),
	CONSTRAINT "platform_business_projection_stored_declare_kind_ck" CHECK("platform_business_projection"."stored_declare_kind" IS NULL OR (typeof("platform_business_projection"."stored_declare_kind") = 'text')),
	CONSTRAINT "platform_business_projection_parsed_declare_kind_ck" CHECK("platform_business_projection"."parsed_declare_kind" IS NULL OR (typeof("platform_business_projection"."parsed_declare_kind") = 'text')),
	CONSTRAINT "platform_business_projection_reconciled_declare_kind_ck" CHECK("platform_business_projection"."reconciled_declare_kind" IS NULL OR (typeof("platform_business_projection"."reconciled_declare_kind") = 'text')),
	CONSTRAINT "platform_business_projection_declare_kind_reconcile_ck" CHECK("platform_business_projection"."observation_id" IS NULL OR (typeof("platform_business_projection"."declare_kind_conflict") = 'integer' AND "platform_business_projection"."declare_kind_conflict" = ("platform_business_projection"."stored_declare_kind" IS NOT NULL AND "platform_business_projection"."parsed_declare_kind" IS NOT NULL AND "platform_business_projection"."stored_declare_kind" <> "platform_business_projection"."parsed_declare_kind") AND "platform_business_projection"."reconciled_declare_kind" IS (CASE WHEN "platform_business_projection"."declare_kind_conflict" = 1 THEN NULL ELSE coalesce("platform_business_projection"."stored_declare_kind","platform_business_projection"."parsed_declare_kind") END))),
	CONSTRAINT "platform_business_projection_stored_applied_at_kind_ck" CHECK("platform_business_projection"."stored_applied_at_kind" IS NULL OR ("platform_business_projection"."stored_applied_at_kind" IN ('absent','null','text','number','boolean','array','object','invalid') AND ("platform_business_projection"."stored_applied_at_kind" NOT IN ('absent','null','array','object','invalid','boolean') OR "platform_business_projection"."stored_applied_at" IS NULL))),
	CONSTRAINT "platform_business_projection_parsed_applied_at_kind_ck" CHECK("platform_business_projection"."parsed_applied_at_kind" IS NULL OR ("platform_business_projection"."parsed_applied_at_kind" IN ('absent','null','text','number','boolean','array','object','invalid') AND ("platform_business_projection"."parsed_applied_at_kind" NOT IN ('absent','null','array','object','invalid','boolean') OR "platform_business_projection"."parsed_applied_at" IS NULL))),
	CONSTRAINT "platform_business_projection_stored_applied_at_ck" CHECK("platform_business_projection"."stored_applied_at" IS NULL OR (typeof("platform_business_projection"."stored_applied_at") = 'text')),
	CONSTRAINT "platform_business_projection_parsed_applied_at_ck" CHECK("platform_business_projection"."parsed_applied_at" IS NULL OR (typeof("platform_business_projection"."parsed_applied_at") = 'text')),
	CONSTRAINT "platform_business_projection_reconciled_applied_at_ck" CHECK("platform_business_projection"."reconciled_applied_at" IS NULL OR (typeof("platform_business_projection"."reconciled_applied_at") = 'text')),
	CONSTRAINT "platform_business_projection_applied_at_reconcile_ck" CHECK("platform_business_projection"."observation_id" IS NULL OR (typeof("platform_business_projection"."applied_at_conflict") = 'integer' AND "platform_business_projection"."applied_at_conflict" = ("platform_business_projection"."stored_applied_at" IS NOT NULL AND "platform_business_projection"."parsed_applied_at" IS NOT NULL AND "platform_business_projection"."stored_applied_at" <> "platform_business_projection"."parsed_applied_at") AND "platform_business_projection"."reconciled_applied_at" IS (CASE WHEN "platform_business_projection"."applied_at_conflict" = 1 THEN NULL ELSE coalesce("platform_business_projection"."stored_applied_at","platform_business_projection"."parsed_applied_at") END))),
	CONSTRAINT "platform_business_projection_stored_award_batch_label_kind_ck" CHECK("platform_business_projection"."stored_award_batch_label_kind" IS NULL OR ("platform_business_projection"."stored_award_batch_label_kind" IN ('absent','null','text','number','boolean','array','object','invalid') AND ("platform_business_projection"."stored_award_batch_label_kind" NOT IN ('absent','null','array','object','invalid','boolean') OR "platform_business_projection"."stored_award_batch_label" IS NULL))),
	CONSTRAINT "platform_business_projection_parsed_award_batch_label_kind_ck" CHECK("platform_business_projection"."parsed_award_batch_label_kind" IS NULL OR ("platform_business_projection"."parsed_award_batch_label_kind" IN ('absent','null','text','number','boolean','array','object','invalid') AND ("platform_business_projection"."parsed_award_batch_label_kind" NOT IN ('absent','null','array','object','invalid','boolean') OR "platform_business_projection"."parsed_award_batch_label" IS NULL))),
	CONSTRAINT "platform_business_projection_stored_award_batch_label_ck" CHECK("platform_business_projection"."stored_award_batch_label" IS NULL OR (typeof("platform_business_projection"."stored_award_batch_label") = 'text')),
	CONSTRAINT "platform_business_projection_parsed_award_batch_label_ck" CHECK("platform_business_projection"."parsed_award_batch_label" IS NULL OR (typeof("platform_business_projection"."parsed_award_batch_label") = 'text')),
	CONSTRAINT "platform_business_projection_reconciled_award_batch_label_ck" CHECK("platform_business_projection"."reconciled_award_batch_label" IS NULL OR (typeof("platform_business_projection"."reconciled_award_batch_label") = 'text')),
	CONSTRAINT "platform_business_projection_award_batch_label_reconcile_ck" CHECK("platform_business_projection"."observation_id" IS NULL OR (typeof("platform_business_projection"."award_batch_label_conflict") = 'integer' AND "platform_business_projection"."award_batch_label_conflict" = ("platform_business_projection"."stored_award_batch_label" IS NOT NULL AND "platform_business_projection"."parsed_award_batch_label" IS NOT NULL AND "platform_business_projection"."stored_award_batch_label" <> "platform_business_projection"."parsed_award_batch_label") AND "platform_business_projection"."reconciled_award_batch_label" IS (CASE WHEN "platform_business_projection"."award_batch_label_conflict" = 1 THEN NULL ELSE coalesce("platform_business_projection"."stored_award_batch_label","platform_business_projection"."parsed_award_batch_label") END))),
	CONSTRAINT "platform_business_projection_stored_year_kind_ck" CHECK("platform_business_projection"."stored_year_kind" IS NULL OR ("platform_business_projection"."stored_year_kind" IN ('absent','null','text','number','boolean','array','object','invalid') AND ("platform_business_projection"."stored_year_kind" NOT IN ('absent','null','array','object','invalid','boolean') OR "platform_business_projection"."stored_year" IS NULL))),
	CONSTRAINT "platform_business_projection_parsed_year_kind_ck" CHECK("platform_business_projection"."parsed_year_kind" IS NULL OR ("platform_business_projection"."parsed_year_kind" IN ('absent','null','text','number','boolean','array','object','invalid') AND ("platform_business_projection"."parsed_year_kind" NOT IN ('absent','null','array','object','invalid','boolean') OR "platform_business_projection"."parsed_year" IS NULL))),
	CONSTRAINT "platform_business_projection_stored_year_ck" CHECK("platform_business_projection"."stored_year" IS NULL OR (typeof("platform_business_projection"."stored_year") = 'integer' AND "platform_business_projection"."stored_year" BETWEEN -9007199254740991 AND 9007199254740991)),
	CONSTRAINT "platform_business_projection_parsed_year_ck" CHECK("platform_business_projection"."parsed_year" IS NULL OR (typeof("platform_business_projection"."parsed_year") = 'integer' AND "platform_business_projection"."parsed_year" BETWEEN -9007199254740991 AND 9007199254740991)),
	CONSTRAINT "platform_business_projection_reconciled_year_ck" CHECK("platform_business_projection"."reconciled_year" IS NULL OR (typeof("platform_business_projection"."reconciled_year") = 'integer' AND "platform_business_projection"."reconciled_year" BETWEEN -9007199254740991 AND 9007199254740991)),
	CONSTRAINT "platform_business_projection_year_reconcile_ck" CHECK("platform_business_projection"."observation_id" IS NULL OR (typeof("platform_business_projection"."year_conflict") = 'integer' AND "platform_business_projection"."year_conflict" = ("platform_business_projection"."stored_year" IS NOT NULL AND "platform_business_projection"."parsed_year" IS NOT NULL AND "platform_business_projection"."stored_year" <> "platform_business_projection"."parsed_year") AND "platform_business_projection"."reconciled_year" IS (CASE WHEN "platform_business_projection"."year_conflict" = 1 THEN NULL ELSE coalesce("platform_business_projection"."stored_year","platform_business_projection"."parsed_year") END)))
);
--> statement-breakpoint
CREATE TABLE `platform_legacy_relation_alias` (
	`old_id` integer PRIMARY KEY NOT NULL,
	`observation_id` integer NOT NULL,
	FOREIGN KEY (`observation_id`) REFERENCES `platform_business_observation`(`relation_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "platform_legacy_relation_alias_id_ck" CHECK("platform_legacy_relation_alias"."old_id" > 0 AND "platform_legacy_relation_alias"."old_id" <= 9007199254740991)
);
--> statement-breakpoint
CREATE TABLE `platform_observation_archive_ref` (
	`owner_id` integer NOT NULL,
	`field` text NOT NULL,
	`archive_id` integer NOT NULL,
	`sealed` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`owner_id`, `field`),
	FOREIGN KEY (`owner_id`) REFERENCES `platform_business_observation`(`relation_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`archive_id`) REFERENCES `platform_archive_value`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "platform_observation_archive_ref_ck" CHECK("platform_observation_archive_ref"."field" IN ('rawFields','sourceText','legacyRowSnapshot') AND "platform_observation_archive_ref"."sealed" IN (0,1))
);
--> statement-breakpoint
CREATE TABLE `platform_observation_assignment` (
	`observation_id` integer NOT NULL,
	`revision` integer NOT NULL,
	`enterprise_id` integer,
	`match_basis` text NOT NULL,
	`verification_status` text NOT NULL,
	`uscc_raw` text,
	`name_raw` text,
	`alias_name_raw` text,
	`actor` text,
	`basis` text,
	`command_receipt_id` integer,
	`recorded_at` text,
	`origin` text NOT NULL,
	PRIMARY KEY(`observation_id`, `revision`),
	FOREIGN KEY (`observation_id`) REFERENCES `platform_business_observation`(`relation_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`enterprise_id`) REFERENCES `enterprise`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "platform_assignment_observation_id_ck" CHECK("platform_observation_assignment"."observation_id" IS NULL OR (typeof("platform_observation_assignment"."observation_id") = 'integer' AND "platform_observation_assignment"."observation_id" BETWEEN 1 AND 9007199254740991)),
	CONSTRAINT "platform_assignment_revision_ck" CHECK("platform_observation_assignment"."revision" IS NULL OR (typeof("platform_observation_assignment"."revision") = 'integer' AND "platform_observation_assignment"."revision" BETWEEN 1 AND 9007199254740991)),
	CONSTRAINT "platform_assignment_enterprise_id_ck" CHECK("platform_observation_assignment"."enterprise_id" IS NULL OR (typeof("platform_observation_assignment"."enterprise_id") = 'integer' AND "platform_observation_assignment"."enterprise_id" BETWEEN 1 AND 9007199254740991)),
	CONSTRAINT "platform_assignment_command_receipt_id_ck" CHECK("platform_observation_assignment"."command_receipt_id" IS NULL OR (typeof("platform_observation_assignment"."command_receipt_id") = 'integer' AND "platform_observation_assignment"."command_receipt_id" BETWEEN 1 AND 9007199254740991)),
	CONSTRAINT "platform_assignment_uscc_raw_ck" CHECK("platform_observation_assignment"."uscc_raw" IS NULL OR typeof("platform_observation_assignment"."uscc_raw") = 'text'),
	CONSTRAINT "platform_assignment_name_raw_ck" CHECK("platform_observation_assignment"."name_raw" IS NULL OR typeof("platform_observation_assignment"."name_raw") = 'text'),
	CONSTRAINT "platform_assignment_alias_name_raw_ck" CHECK("platform_observation_assignment"."alias_name_raw" IS NULL OR typeof("platform_observation_assignment"."alias_name_raw") = 'text'),
	CONSTRAINT "platform_assignment_actor_ck" CHECK("platform_observation_assignment"."actor" IS NULL OR typeof("platform_observation_assignment"."actor") = 'text'),
	CONSTRAINT "platform_assignment_basis_ck" CHECK("platform_observation_assignment"."basis" IS NULL OR typeof("platform_observation_assignment"."basis") = 'text'),
	CONSTRAINT "platform_assignment_recorded_at_ck" CHECK("platform_observation_assignment"."recorded_at" IS NULL OR typeof("platform_observation_assignment"."recorded_at") = 'text'),
	CONSTRAINT "platform_assignment_match_ck" CHECK("platform_observation_assignment"."match_basis" IN ('uscc','alias','manual','none')),
	CONSTRAINT "platform_assignment_verification_ck" CHECK("platform_observation_assignment"."verification_status" IN ('confirmed','pending')),
	CONSTRAINT "platform_assignment_origin_ck" CHECK(("platform_observation_assignment"."origin" = 'migrated_current' AND "platform_observation_assignment"."revision" = 1 AND "platform_observation_assignment"."actor" IS NULL AND "platform_observation_assignment"."recorded_at" IS NULL AND "platform_observation_assignment"."command_receipt_id" IS NULL) OR "platform_observation_assignment"."origin" = 'command')
);
--> statement-breakpoint
CREATE TABLE "platform_recognized_projection" (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`observation_id` integer,
	`basis` text DEFAULT 'verified_raw' NOT NULL,
	`version_id` integer,
	`record_id` integer,
	`validity_date_raw` text,
	`maintenance_year` integer,
	`maintenance_batch` text,
	`source_validity_date` text,
	`source_maintenance_batch` text,
	`source_maintenance_year_absent` integer,
	`district` text,
	`award_note` text,
	`title_raw` text,
	`name_raw` text,
	`uscc_raw` text,
	`source_title_kind` text,
	`source_title_text` text,
	`source_title_number_text` text,
	`source_title_boolean` integer,
	`source_title_rule_version` text,
	`source_archive_id` integer,
	`parse_state` text,
	`stored_province_kind` text,
	`stored_province` text,
	`parsed_province_kind` text,
	`parsed_province` text,
	`reconciled_province` text,
	`province_conflict` integer,
	`stored_status_kind` text,
	`stored_status` text,
	`parsed_status_kind` text,
	`parsed_status` text,
	`reconciled_status` text,
	`status_conflict` integer,
	`stored_batch_kind` text,
	`stored_batch` text,
	`parsed_batch_kind` text,
	`parsed_batch` text,
	`reconciled_batch` text,
	`batch_conflict` integer,
	`stored_declare_kind_kind` text,
	`stored_declare_kind` text,
	`parsed_declare_kind_kind` text,
	`parsed_declare_kind` text,
	`reconciled_declare_kind` text,
	`declare_kind_conflict` integer,
	`stored_applied_at_kind` text,
	`stored_applied_at` text,
	`parsed_applied_at_kind` text,
	`parsed_applied_at` text,
	`reconciled_applied_at` text,
	`applied_at_conflict` integer,
	`stored_award_batch_label_kind` text,
	`stored_award_batch_label` text,
	`parsed_award_batch_label_kind` text,
	`parsed_award_batch_label` text,
	`reconciled_award_batch_label` text,
	`award_batch_label_conflict` integer,
	`stored_year_kind` text,
	`stored_year` integer,
	`parsed_year_kind` text,
	`parsed_year` integer,
	`reconciled_year` integer,
	`year_conflict` integer,
	`rule_version` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`observation_id`) REFERENCES `platform_business_observation`(`relation_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`version_id`) REFERENCES `platform_business_record_version`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`record_id`) REFERENCES `platform_business_record`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`source_archive_id`) REFERENCES `platform_archive_value`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`version_id`,`record_id`) REFERENCES `platform_business_record_version`(`id`,`record_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "platform_recognized_projection_owner_ck" CHECK(( "platform_recognized_projection"."version_id" IS NOT NULL AND "platform_recognized_projection"."record_id" IS NOT NULL AND "platform_recognized_projection"."observation_id" IS NULL AND "platform_recognized_projection"."basis" = 'verified_raw') OR ("platform_recognized_projection"."version_id" IS NULL AND "platform_recognized_projection"."record_id" IS NULL AND "platform_recognized_projection"."observation_id" IS NOT NULL AND "platform_recognized_projection"."basis" IN ('observation_reconciliation','unavailable'))),
	CONSTRAINT "platform_recognized_projection_id_ck" CHECK("platform_recognized_projection"."id" IS NULL OR (typeof("platform_recognized_projection"."id") = 'integer' AND "platform_recognized_projection"."id" BETWEEN 1 AND 9007199254740991)),
	CONSTRAINT "platform_recognized_projection_version_id_ck" CHECK("platform_recognized_projection"."version_id" IS NULL OR (typeof("platform_recognized_projection"."version_id") = 'integer' AND "platform_recognized_projection"."version_id" BETWEEN 1 AND 9007199254740991)),
	CONSTRAINT "platform_recognized_projection_record_id_ck" CHECK("platform_recognized_projection"."record_id" IS NULL OR (typeof("platform_recognized_projection"."record_id") = 'integer' AND "platform_recognized_projection"."record_id" BETWEEN 1 AND 9007199254740991)),
	CONSTRAINT "platform_recognized_projection_observation_id_ck" CHECK("platform_recognized_projection"."observation_id" IS NULL OR (typeof("platform_recognized_projection"."observation_id") = 'integer' AND "platform_recognized_projection"."observation_id" BETWEEN 1 AND 9007199254740991)),
	CONSTRAINT "platform_recognized_projection_source_archive_id_ck" CHECK("platform_recognized_projection"."source_archive_id" IS NULL OR (typeof("platform_recognized_projection"."source_archive_id") = 'integer' AND "platform_recognized_projection"."source_archive_id" BETWEEN 1 AND 9007199254740991)),
	CONSTRAINT "platform_recognized_projection_capture_ck" CHECK(("platform_recognized_projection"."observation_id" IS NULL AND "platform_recognized_projection"."source_title_kind" IS NULL AND "platform_recognized_projection"."source_title_text" IS NULL AND "platform_recognized_projection"."source_title_number_text" IS NULL AND "platform_recognized_projection"."source_title_boolean" IS NULL AND "platform_recognized_projection"."source_title_rule_version" IS NULL AND "platform_recognized_projection"."source_archive_id" IS NULL AND "platform_recognized_projection"."parse_state" IS NULL AND "platform_recognized_projection"."stored_province_kind" IS NULL AND "platform_recognized_projection"."stored_province" IS NULL AND "platform_recognized_projection"."parsed_province_kind" IS NULL AND "platform_recognized_projection"."parsed_province" IS NULL AND "platform_recognized_projection"."reconciled_province" IS NULL AND "platform_recognized_projection"."province_conflict" IS NULL AND "platform_recognized_projection"."stored_status_kind" IS NULL AND "platform_recognized_projection"."stored_status" IS NULL AND "platform_recognized_projection"."parsed_status_kind" IS NULL AND "platform_recognized_projection"."parsed_status" IS NULL AND "platform_recognized_projection"."reconciled_status" IS NULL AND "platform_recognized_projection"."status_conflict" IS NULL AND "platform_recognized_projection"."stored_batch_kind" IS NULL AND "platform_recognized_projection"."stored_batch" IS NULL AND "platform_recognized_projection"."parsed_batch_kind" IS NULL AND "platform_recognized_projection"."parsed_batch" IS NULL AND "platform_recognized_projection"."reconciled_batch" IS NULL AND "platform_recognized_projection"."batch_conflict" IS NULL AND "platform_recognized_projection"."stored_declare_kind_kind" IS NULL AND "platform_recognized_projection"."stored_declare_kind" IS NULL AND "platform_recognized_projection"."parsed_declare_kind_kind" IS NULL AND "platform_recognized_projection"."parsed_declare_kind" IS NULL AND "platform_recognized_projection"."reconciled_declare_kind" IS NULL AND "platform_recognized_projection"."declare_kind_conflict" IS NULL AND "platform_recognized_projection"."stored_applied_at_kind" IS NULL AND "platform_recognized_projection"."stored_applied_at" IS NULL AND "platform_recognized_projection"."parsed_applied_at_kind" IS NULL AND "platform_recognized_projection"."parsed_applied_at" IS NULL AND "platform_recognized_projection"."reconciled_applied_at" IS NULL AND "platform_recognized_projection"."applied_at_conflict" IS NULL AND "platform_recognized_projection"."stored_award_batch_label_kind" IS NULL AND "platform_recognized_projection"."stored_award_batch_label" IS NULL AND "platform_recognized_projection"."parsed_award_batch_label_kind" IS NULL AND "platform_recognized_projection"."parsed_award_batch_label" IS NULL AND "platform_recognized_projection"."reconciled_award_batch_label" IS NULL AND "platform_recognized_projection"."award_batch_label_conflict" IS NULL AND "platform_recognized_projection"."stored_year_kind" IS NULL AND "platform_recognized_projection"."stored_year" IS NULL AND "platform_recognized_projection"."parsed_year_kind" IS NULL AND "platform_recognized_projection"."parsed_year" IS NULL AND "platform_recognized_projection"."reconciled_year" IS NULL AND "platform_recognized_projection"."year_conflict" IS NULL) OR ("platform_recognized_projection"."observation_id" IS NOT NULL AND "platform_recognized_projection"."source_title_kind" IS NOT NULL AND "platform_recognized_projection"."source_title_rule_version" IS NOT NULL AND "platform_recognized_projection"."source_archive_id" IS NOT NULL AND "platform_recognized_projection"."parse_state" IS NOT NULL AND "platform_recognized_projection"."stored_province_kind" IS NOT NULL AND "platform_recognized_projection"."parsed_province_kind" IS NOT NULL AND "platform_recognized_projection"."stored_status_kind" IS NOT NULL AND "platform_recognized_projection"."parsed_status_kind" IS NOT NULL AND "platform_recognized_projection"."stored_batch_kind" IS NOT NULL AND "platform_recognized_projection"."parsed_batch_kind" IS NOT NULL AND "platform_recognized_projection"."stored_declare_kind_kind" IS NOT NULL AND "platform_recognized_projection"."parsed_declare_kind_kind" IS NOT NULL AND "platform_recognized_projection"."stored_applied_at_kind" IS NOT NULL AND "platform_recognized_projection"."parsed_applied_at_kind" IS NOT NULL AND "platform_recognized_projection"."stored_award_batch_label_kind" IS NOT NULL AND "platform_recognized_projection"."parsed_award_batch_label_kind" IS NOT NULL AND "platform_recognized_projection"."stored_year_kind" IS NOT NULL AND "platform_recognized_projection"."parsed_year_kind" IS NOT NULL AND "platform_recognized_projection"."province_conflict" IS NOT NULL AND "platform_recognized_projection"."status_conflict" IS NOT NULL AND "platform_recognized_projection"."batch_conflict" IS NOT NULL AND "platform_recognized_projection"."declare_kind_conflict" IS NOT NULL AND "platform_recognized_projection"."applied_at_conflict" IS NOT NULL AND "platform_recognized_projection"."award_batch_label_conflict" IS NOT NULL AND "platform_recognized_projection"."year_conflict" IS NOT NULL)),
	CONSTRAINT "platform_recognized_projection_title_ck" CHECK("platform_recognized_projection"."source_title_kind" IS NULL OR ("platform_recognized_projection"."source_title_kind" IN ('absent','null','array','object','invalid') AND "platform_recognized_projection"."source_title_text" IS NULL AND "platform_recognized_projection"."source_title_number_text" IS NULL AND "platform_recognized_projection"."source_title_boolean" IS NULL) OR ("platform_recognized_projection"."source_title_kind" = 'text' AND typeof("platform_recognized_projection"."source_title_text") = 'text' AND "platform_recognized_projection"."source_title_number_text" IS NULL AND "platform_recognized_projection"."source_title_boolean" IS NULL) OR ("platform_recognized_projection"."source_title_kind" = 'number' AND typeof("platform_recognized_projection"."source_title_number_text") = 'text' AND length("platform_recognized_projection"."source_title_number_text") > 0 AND trim("platform_recognized_projection"."source_title_number_text") = "platform_recognized_projection"."source_title_number_text" AND CASE WHEN json_valid("platform_recognized_projection"."source_title_number_text") THEN json_type("platform_recognized_projection"."source_title_number_text") IN ('integer','real') ELSE 0 END AND "platform_recognized_projection"."source_title_text" IS NULL AND "platform_recognized_projection"."source_title_boolean" IS NULL) OR ("platform_recognized_projection"."source_title_kind" = 'boolean' AND typeof("platform_recognized_projection"."source_title_boolean") = 'integer' AND "platform_recognized_projection"."source_title_boolean" IN (0,1) AND "platform_recognized_projection"."source_title_text" IS NULL AND "platform_recognized_projection"."source_title_number_text" IS NULL)),
	CONSTRAINT "platform_recognized_projection_parse_ck" CHECK("platform_recognized_projection"."parse_state" IS NULL OR ("platform_recognized_projection"."parse_state" IN ('valid','invalid','absent') AND (("platform_recognized_projection"."basis" = 'unavailable') = ("platform_recognized_projection"."parse_state" <> 'valid')))),
	CONSTRAINT "platform_recognized_projection_rule_ck" CHECK("platform_recognized_projection"."source_title_rule_version" IS NULL OR (typeof("platform_recognized_projection"."source_title_rule_version") = 'text' AND length(trim("platform_recognized_projection"."source_title_rule_version")) > 0)),
	CONSTRAINT "platform_recognized_projection_stored_province_kind_ck" CHECK("platform_recognized_projection"."stored_province_kind" IS NULL OR ("platform_recognized_projection"."stored_province_kind" IN ('absent','null','text','number','boolean','array','object','invalid') AND ("platform_recognized_projection"."stored_province_kind" NOT IN ('absent','null','array','object','invalid','boolean') OR "platform_recognized_projection"."stored_province" IS NULL))),
	CONSTRAINT "platform_recognized_projection_parsed_province_kind_ck" CHECK("platform_recognized_projection"."parsed_province_kind" IS NULL OR ("platform_recognized_projection"."parsed_province_kind" IN ('absent','null','text','number','boolean','array','object','invalid') AND ("platform_recognized_projection"."parsed_province_kind" NOT IN ('absent','null','array','object','invalid','boolean') OR "platform_recognized_projection"."parsed_province" IS NULL))),
	CONSTRAINT "platform_recognized_projection_stored_province_ck" CHECK("platform_recognized_projection"."stored_province" IS NULL OR (typeof("platform_recognized_projection"."stored_province") = 'text')),
	CONSTRAINT "platform_recognized_projection_parsed_province_ck" CHECK("platform_recognized_projection"."parsed_province" IS NULL OR (typeof("platform_recognized_projection"."parsed_province") = 'text')),
	CONSTRAINT "platform_recognized_projection_reconciled_province_ck" CHECK("platform_recognized_projection"."reconciled_province" IS NULL OR (typeof("platform_recognized_projection"."reconciled_province") = 'text')),
	CONSTRAINT "platform_recognized_projection_province_reconcile_ck" CHECK("platform_recognized_projection"."observation_id" IS NULL OR (typeof("platform_recognized_projection"."province_conflict") = 'integer' AND "platform_recognized_projection"."province_conflict" = ("platform_recognized_projection"."stored_province" IS NOT NULL AND "platform_recognized_projection"."parsed_province" IS NOT NULL AND "platform_recognized_projection"."stored_province" <> "platform_recognized_projection"."parsed_province") AND "platform_recognized_projection"."reconciled_province" IS (CASE WHEN "platform_recognized_projection"."province_conflict" = 1 THEN NULL ELSE coalesce("platform_recognized_projection"."stored_province","platform_recognized_projection"."parsed_province") END))),
	CONSTRAINT "platform_recognized_projection_stored_status_kind_ck" CHECK("platform_recognized_projection"."stored_status_kind" IS NULL OR ("platform_recognized_projection"."stored_status_kind" IN ('absent','null','text','number','boolean','array','object','invalid') AND ("platform_recognized_projection"."stored_status_kind" NOT IN ('absent','null','array','object','invalid','boolean') OR "platform_recognized_projection"."stored_status" IS NULL))),
	CONSTRAINT "platform_recognized_projection_parsed_status_kind_ck" CHECK("platform_recognized_projection"."parsed_status_kind" IS NULL OR ("platform_recognized_projection"."parsed_status_kind" IN ('absent','null','text','number','boolean','array','object','invalid') AND ("platform_recognized_projection"."parsed_status_kind" NOT IN ('absent','null','array','object','invalid','boolean') OR "platform_recognized_projection"."parsed_status" IS NULL))),
	CONSTRAINT "platform_recognized_projection_stored_status_ck" CHECK("platform_recognized_projection"."stored_status" IS NULL OR (typeof("platform_recognized_projection"."stored_status") = 'text')),
	CONSTRAINT "platform_recognized_projection_parsed_status_ck" CHECK("platform_recognized_projection"."parsed_status" IS NULL OR (typeof("platform_recognized_projection"."parsed_status") = 'text')),
	CONSTRAINT "platform_recognized_projection_reconciled_status_ck" CHECK("platform_recognized_projection"."reconciled_status" IS NULL OR (typeof("platform_recognized_projection"."reconciled_status") = 'text')),
	CONSTRAINT "platform_recognized_projection_status_reconcile_ck" CHECK("platform_recognized_projection"."observation_id" IS NULL OR (typeof("platform_recognized_projection"."status_conflict") = 'integer' AND "platform_recognized_projection"."status_conflict" = ("platform_recognized_projection"."stored_status" IS NOT NULL AND "platform_recognized_projection"."parsed_status" IS NOT NULL AND "platform_recognized_projection"."stored_status" <> "platform_recognized_projection"."parsed_status") AND "platform_recognized_projection"."reconciled_status" IS (CASE WHEN "platform_recognized_projection"."status_conflict" = 1 THEN NULL ELSE coalesce("platform_recognized_projection"."stored_status","platform_recognized_projection"."parsed_status") END))),
	CONSTRAINT "platform_recognized_projection_stored_batch_kind_ck" CHECK("platform_recognized_projection"."stored_batch_kind" IS NULL OR ("platform_recognized_projection"."stored_batch_kind" IN ('absent','null','text','number','boolean','array','object','invalid') AND ("platform_recognized_projection"."stored_batch_kind" NOT IN ('absent','null','array','object','invalid','boolean') OR "platform_recognized_projection"."stored_batch" IS NULL))),
	CONSTRAINT "platform_recognized_projection_parsed_batch_kind_ck" CHECK("platform_recognized_projection"."parsed_batch_kind" IS NULL OR ("platform_recognized_projection"."parsed_batch_kind" IN ('absent','null','text','number','boolean','array','object','invalid') AND ("platform_recognized_projection"."parsed_batch_kind" NOT IN ('absent','null','array','object','invalid','boolean') OR "platform_recognized_projection"."parsed_batch" IS NULL))),
	CONSTRAINT "platform_recognized_projection_stored_batch_ck" CHECK("platform_recognized_projection"."stored_batch" IS NULL OR (typeof("platform_recognized_projection"."stored_batch") = 'text')),
	CONSTRAINT "platform_recognized_projection_parsed_batch_ck" CHECK("platform_recognized_projection"."parsed_batch" IS NULL OR (typeof("platform_recognized_projection"."parsed_batch") = 'text')),
	CONSTRAINT "platform_recognized_projection_reconciled_batch_ck" CHECK("platform_recognized_projection"."reconciled_batch" IS NULL OR (typeof("platform_recognized_projection"."reconciled_batch") = 'text')),
	CONSTRAINT "platform_recognized_projection_batch_reconcile_ck" CHECK("platform_recognized_projection"."observation_id" IS NULL OR (typeof("platform_recognized_projection"."batch_conflict") = 'integer' AND "platform_recognized_projection"."batch_conflict" = ("platform_recognized_projection"."stored_batch" IS NOT NULL AND "platform_recognized_projection"."parsed_batch" IS NOT NULL AND "platform_recognized_projection"."stored_batch" <> "platform_recognized_projection"."parsed_batch") AND "platform_recognized_projection"."reconciled_batch" IS (CASE WHEN "platform_recognized_projection"."batch_conflict" = 1 THEN NULL ELSE coalesce("platform_recognized_projection"."stored_batch","platform_recognized_projection"."parsed_batch") END))),
	CONSTRAINT "platform_recognized_projection_stored_declare_kind_kind_ck" CHECK("platform_recognized_projection"."stored_declare_kind_kind" IS NULL OR ("platform_recognized_projection"."stored_declare_kind_kind" IN ('absent','null','text','number','boolean','array','object','invalid') AND ("platform_recognized_projection"."stored_declare_kind_kind" NOT IN ('absent','null','array','object','invalid','boolean') OR "platform_recognized_projection"."stored_declare_kind" IS NULL))),
	CONSTRAINT "platform_recognized_projection_parsed_declare_kind_kind_ck" CHECK("platform_recognized_projection"."parsed_declare_kind_kind" IS NULL OR ("platform_recognized_projection"."parsed_declare_kind_kind" IN ('absent','null','text','number','boolean','array','object','invalid') AND ("platform_recognized_projection"."parsed_declare_kind_kind" NOT IN ('absent','null','array','object','invalid','boolean') OR "platform_recognized_projection"."parsed_declare_kind" IS NULL))),
	CONSTRAINT "platform_recognized_projection_stored_declare_kind_ck" CHECK("platform_recognized_projection"."stored_declare_kind" IS NULL OR (typeof("platform_recognized_projection"."stored_declare_kind") = 'text')),
	CONSTRAINT "platform_recognized_projection_parsed_declare_kind_ck" CHECK("platform_recognized_projection"."parsed_declare_kind" IS NULL OR (typeof("platform_recognized_projection"."parsed_declare_kind") = 'text')),
	CONSTRAINT "platform_recognized_projection_reconciled_declare_kind_ck" CHECK("platform_recognized_projection"."reconciled_declare_kind" IS NULL OR (typeof("platform_recognized_projection"."reconciled_declare_kind") = 'text')),
	CONSTRAINT "platform_recognized_projection_declare_kind_reconcile_ck" CHECK("platform_recognized_projection"."observation_id" IS NULL OR (typeof("platform_recognized_projection"."declare_kind_conflict") = 'integer' AND "platform_recognized_projection"."declare_kind_conflict" = ("platform_recognized_projection"."stored_declare_kind" IS NOT NULL AND "platform_recognized_projection"."parsed_declare_kind" IS NOT NULL AND "platform_recognized_projection"."stored_declare_kind" <> "platform_recognized_projection"."parsed_declare_kind") AND "platform_recognized_projection"."reconciled_declare_kind" IS (CASE WHEN "platform_recognized_projection"."declare_kind_conflict" = 1 THEN NULL ELSE coalesce("platform_recognized_projection"."stored_declare_kind","platform_recognized_projection"."parsed_declare_kind") END))),
	CONSTRAINT "platform_recognized_projection_stored_applied_at_kind_ck" CHECK("platform_recognized_projection"."stored_applied_at_kind" IS NULL OR ("platform_recognized_projection"."stored_applied_at_kind" IN ('absent','null','text','number','boolean','array','object','invalid') AND ("platform_recognized_projection"."stored_applied_at_kind" NOT IN ('absent','null','array','object','invalid','boolean') OR "platform_recognized_projection"."stored_applied_at" IS NULL))),
	CONSTRAINT "platform_recognized_projection_parsed_applied_at_kind_ck" CHECK("platform_recognized_projection"."parsed_applied_at_kind" IS NULL OR ("platform_recognized_projection"."parsed_applied_at_kind" IN ('absent','null','text','number','boolean','array','object','invalid') AND ("platform_recognized_projection"."parsed_applied_at_kind" NOT IN ('absent','null','array','object','invalid','boolean') OR "platform_recognized_projection"."parsed_applied_at" IS NULL))),
	CONSTRAINT "platform_recognized_projection_stored_applied_at_ck" CHECK("platform_recognized_projection"."stored_applied_at" IS NULL OR (typeof("platform_recognized_projection"."stored_applied_at") = 'text')),
	CONSTRAINT "platform_recognized_projection_parsed_applied_at_ck" CHECK("platform_recognized_projection"."parsed_applied_at" IS NULL OR (typeof("platform_recognized_projection"."parsed_applied_at") = 'text')),
	CONSTRAINT "platform_recognized_projection_reconciled_applied_at_ck" CHECK("platform_recognized_projection"."reconciled_applied_at" IS NULL OR (typeof("platform_recognized_projection"."reconciled_applied_at") = 'text')),
	CONSTRAINT "platform_recognized_projection_applied_at_reconcile_ck" CHECK("platform_recognized_projection"."observation_id" IS NULL OR (typeof("platform_recognized_projection"."applied_at_conflict") = 'integer' AND "platform_recognized_projection"."applied_at_conflict" = ("platform_recognized_projection"."stored_applied_at" IS NOT NULL AND "platform_recognized_projection"."parsed_applied_at" IS NOT NULL AND "platform_recognized_projection"."stored_applied_at" <> "platform_recognized_projection"."parsed_applied_at") AND "platform_recognized_projection"."reconciled_applied_at" IS (CASE WHEN "platform_recognized_projection"."applied_at_conflict" = 1 THEN NULL ELSE coalesce("platform_recognized_projection"."stored_applied_at","platform_recognized_projection"."parsed_applied_at") END))),
	CONSTRAINT "platform_recognized_projection_stored_award_batch_label_kind_ck" CHECK("platform_recognized_projection"."stored_award_batch_label_kind" IS NULL OR ("platform_recognized_projection"."stored_award_batch_label_kind" IN ('absent','null','text','number','boolean','array','object','invalid') AND ("platform_recognized_projection"."stored_award_batch_label_kind" NOT IN ('absent','null','array','object','invalid','boolean') OR "platform_recognized_projection"."stored_award_batch_label" IS NULL))),
	CONSTRAINT "platform_recognized_projection_parsed_award_batch_label_kind_ck" CHECK("platform_recognized_projection"."parsed_award_batch_label_kind" IS NULL OR ("platform_recognized_projection"."parsed_award_batch_label_kind" IN ('absent','null','text','number','boolean','array','object','invalid') AND ("platform_recognized_projection"."parsed_award_batch_label_kind" NOT IN ('absent','null','array','object','invalid','boolean') OR "platform_recognized_projection"."parsed_award_batch_label" IS NULL))),
	CONSTRAINT "platform_recognized_projection_stored_award_batch_label_ck" CHECK("platform_recognized_projection"."stored_award_batch_label" IS NULL OR (typeof("platform_recognized_projection"."stored_award_batch_label") = 'text')),
	CONSTRAINT "platform_recognized_projection_parsed_award_batch_label_ck" CHECK("platform_recognized_projection"."parsed_award_batch_label" IS NULL OR (typeof("platform_recognized_projection"."parsed_award_batch_label") = 'text')),
	CONSTRAINT "platform_recognized_projection_reconciled_award_batch_label_ck" CHECK("platform_recognized_projection"."reconciled_award_batch_label" IS NULL OR (typeof("platform_recognized_projection"."reconciled_award_batch_label") = 'text')),
	CONSTRAINT "platform_recognized_projection_award_batch_label_reconcile_ck" CHECK("platform_recognized_projection"."observation_id" IS NULL OR (typeof("platform_recognized_projection"."award_batch_label_conflict") = 'integer' AND "platform_recognized_projection"."award_batch_label_conflict" = ("platform_recognized_projection"."stored_award_batch_label" IS NOT NULL AND "platform_recognized_projection"."parsed_award_batch_label" IS NOT NULL AND "platform_recognized_projection"."stored_award_batch_label" <> "platform_recognized_projection"."parsed_award_batch_label") AND "platform_recognized_projection"."reconciled_award_batch_label" IS (CASE WHEN "platform_recognized_projection"."award_batch_label_conflict" = 1 THEN NULL ELSE coalesce("platform_recognized_projection"."stored_award_batch_label","platform_recognized_projection"."parsed_award_batch_label") END))),
	CONSTRAINT "platform_recognized_projection_stored_year_kind_ck" CHECK("platform_recognized_projection"."stored_year_kind" IS NULL OR ("platform_recognized_projection"."stored_year_kind" IN ('absent','null','text','number','boolean','array','object','invalid') AND ("platform_recognized_projection"."stored_year_kind" NOT IN ('absent','null','array','object','invalid','boolean') OR "platform_recognized_projection"."stored_year" IS NULL))),
	CONSTRAINT "platform_recognized_projection_parsed_year_kind_ck" CHECK("platform_recognized_projection"."parsed_year_kind" IS NULL OR ("platform_recognized_projection"."parsed_year_kind" IN ('absent','null','text','number','boolean','array','object','invalid') AND ("platform_recognized_projection"."parsed_year_kind" NOT IN ('absent','null','array','object','invalid','boolean') OR "platform_recognized_projection"."parsed_year" IS NULL))),
	CONSTRAINT "platform_recognized_projection_stored_year_ck" CHECK("platform_recognized_projection"."stored_year" IS NULL OR (typeof("platform_recognized_projection"."stored_year") = 'integer' AND "platform_recognized_projection"."stored_year" BETWEEN -9007199254740991 AND 9007199254740991)),
	CONSTRAINT "platform_recognized_projection_parsed_year_ck" CHECK("platform_recognized_projection"."parsed_year" IS NULL OR (typeof("platform_recognized_projection"."parsed_year") = 'integer' AND "platform_recognized_projection"."parsed_year" BETWEEN -9007199254740991 AND 9007199254740991)),
	CONSTRAINT "platform_recognized_projection_reconciled_year_ck" CHECK("platform_recognized_projection"."reconciled_year" IS NULL OR (typeof("platform_recognized_projection"."reconciled_year") = 'integer' AND "platform_recognized_projection"."reconciled_year" BETWEEN -9007199254740991 AND 9007199254740991)),
	CONSTRAINT "platform_recognized_projection_year_reconcile_ck" CHECK("platform_recognized_projection"."observation_id" IS NULL OR (typeof("platform_recognized_projection"."year_conflict") = 'integer' AND "platform_recognized_projection"."year_conflict" = ("platform_recognized_projection"."stored_year" IS NOT NULL AND "platform_recognized_projection"."parsed_year" IS NOT NULL AND "platform_recognized_projection"."stored_year" <> "platform_recognized_projection"."parsed_year") AND "platform_recognized_projection"."reconciled_year" IS (CASE WHEN "platform_recognized_projection"."year_conflict" = 1 THEN NULL ELSE coalesce("platform_recognized_projection"."stored_year","platform_recognized_projection"."parsed_year") END))),
	CONSTRAINT "platform_recognized_projection_no_process_parse_ck" CHECK("platform_recognized_projection"."observation_id" IS NULL OR "platform_recognized_projection"."parsed_province" IS NULL AND "platform_recognized_projection"."parsed_province_kind" = 'absent' AND "platform_recognized_projection"."parsed_status" IS NULL AND "platform_recognized_projection"."parsed_status_kind" = 'absent' AND "platform_recognized_projection"."parsed_batch" IS NULL AND "platform_recognized_projection"."parsed_batch_kind" = 'absent' AND "platform_recognized_projection"."parsed_declare_kind" IS NULL AND "platform_recognized_projection"."parsed_declare_kind_kind" = 'absent' AND "platform_recognized_projection"."parsed_applied_at" IS NULL AND "platform_recognized_projection"."parsed_applied_at_kind" = 'absent' AND "platform_recognized_projection"."parsed_award_batch_label" IS NULL AND "platform_recognized_projection"."parsed_award_batch_label_kind" = 'absent' AND "platform_recognized_projection"."parsed_year" IS NULL AND "platform_recognized_projection"."parsed_year_kind" = 'absent'),
	CONSTRAINT "platform_recognized_projection_fidelity_ck" CHECK((("platform_recognized_projection"."source_maintenance_year_absent" IS NULL OR (typeof("platform_recognized_projection"."source_maintenance_year_absent") = 'integer' AND "platform_recognized_projection"."source_maintenance_year_absent" IN (0,1))) AND ("platform_recognized_projection"."observation_id" IS NULL OR (("platform_recognized_projection"."source_validity_date" IS NULL OR typeof("platform_recognized_projection"."source_validity_date") = 'text') AND ("platform_recognized_projection"."source_maintenance_batch" IS NULL OR typeof("platform_recognized_projection"."source_maintenance_batch") = 'text')))))
);
--> statement-breakpoint
INSERT INTO platform_business_observation("relation_id","record_id","version_id","identity_state","content_state","key_source","projection_rule_version","input_fingerprint","indexed_at","batch_id","id","collection_id","sequence_no","page_id","page_row_no","position_state","source_relation_key") SELECT "relation_id","record_id","version_id","identity_state","content_state","key_source","projection_rule_version","input_fingerprint","indexed_at","batch_id","id","collection_id","sequence_no","page_id","page_row_no","position_state","source_relation_key" FROM t714_platform_business_observation;
--> statement-breakpoint
DROP TABLE t714_platform_business_observation;
--> statement-breakpoint
INSERT INTO platform_apply_projection("id","observation_id","basis","version_id","record_id","declare_kind","declaration_year","applied_at","status","title_raw","name_raw","uscc_raw","source_title_kind","source_title_text","source_title_number_text","source_title_boolean","source_title_rule_version","source_archive_id","parse_state","stored_province_kind","stored_province","parsed_province_kind","parsed_province","reconciled_province","province_conflict","stored_status_kind","stored_status","parsed_status_kind","parsed_status","reconciled_status","status_conflict","stored_batch_kind","stored_batch","parsed_batch_kind","parsed_batch","reconciled_batch","batch_conflict","stored_declare_kind_kind","stored_declare_kind","parsed_declare_kind_kind","parsed_declare_kind","reconciled_declare_kind","declare_kind_conflict","stored_applied_at_kind","stored_applied_at","parsed_applied_at_kind","parsed_applied_at","reconciled_applied_at","applied_at_conflict","stored_award_batch_label_kind","stored_award_batch_label","parsed_award_batch_label_kind","parsed_award_batch_label","reconciled_award_batch_label","award_batch_label_conflict","stored_year_kind","stored_year","parsed_year_kind","parsed_year","reconciled_year","year_conflict","rule_version","created_at") SELECT "id","observation_id","basis","version_id","record_id","declare_kind","declaration_year","applied_at","status","title_raw","name_raw","uscc_raw","source_title_kind","source_title_text","source_title_number_text","source_title_boolean","source_title_rule_version","source_archive_id","parse_state","stored_province_kind","stored_province","parsed_province_kind","parsed_province","reconciled_province","province_conflict","stored_status_kind","stored_status","parsed_status_kind","parsed_status","reconciled_status","status_conflict","stored_batch_kind","stored_batch","parsed_batch_kind","parsed_batch","reconciled_batch","batch_conflict","stored_declare_kind_kind","stored_declare_kind","parsed_declare_kind_kind","parsed_declare_kind","reconciled_declare_kind","declare_kind_conflict","stored_applied_at_kind","stored_applied_at","parsed_applied_at_kind","parsed_applied_at","reconciled_applied_at","applied_at_conflict","stored_award_batch_label_kind","stored_award_batch_label","parsed_award_batch_label_kind","parsed_award_batch_label","reconciled_award_batch_label","award_batch_label_conflict","stored_year_kind","stored_year","parsed_year_kind","parsed_year","reconciled_year","year_conflict","rule_version","created_at" FROM t714_platform_apply_projection;
--> statement-breakpoint
DROP TABLE t714_platform_apply_projection;
--> statement-breakpoint
INSERT INTO platform_business_projection("id","observation_id","basis","version_id","record_id","declare_kind","business_year","applied_at","status","batch","award_batch_label","province","title_raw","name_raw","uscc_raw","source_title_kind","source_title_text","source_title_number_text","source_title_boolean","source_title_rule_version","source_archive_id","parse_state","stored_province_kind","stored_province","parsed_province_kind","parsed_province","reconciled_province","province_conflict","stored_status_kind","stored_status","parsed_status_kind","parsed_status","reconciled_status","status_conflict","stored_batch_kind","stored_batch","parsed_batch_kind","parsed_batch","reconciled_batch","batch_conflict","stored_declare_kind_kind","stored_declare_kind","parsed_declare_kind_kind","parsed_declare_kind","reconciled_declare_kind","declare_kind_conflict","stored_applied_at_kind","stored_applied_at","parsed_applied_at_kind","parsed_applied_at","reconciled_applied_at","applied_at_conflict","stored_award_batch_label_kind","stored_award_batch_label","parsed_award_batch_label_kind","parsed_award_batch_label","reconciled_award_batch_label","award_batch_label_conflict","stored_year_kind","stored_year","parsed_year_kind","parsed_year","reconciled_year","year_conflict","rule_version","created_at") SELECT "id","observation_id","basis","version_id","record_id","declare_kind","business_year","applied_at","status","batch","award_batch_label","province","title_raw","name_raw","uscc_raw","source_title_kind","source_title_text","source_title_number_text","source_title_boolean","source_title_rule_version","source_archive_id","parse_state","stored_province_kind","stored_province","parsed_province_kind","parsed_province","reconciled_province","province_conflict","stored_status_kind","stored_status","parsed_status_kind","parsed_status","reconciled_status","status_conflict","stored_batch_kind","stored_batch","parsed_batch_kind","parsed_batch","reconciled_batch","batch_conflict","stored_declare_kind_kind","stored_declare_kind","parsed_declare_kind_kind","parsed_declare_kind","reconciled_declare_kind","declare_kind_conflict","stored_applied_at_kind","stored_applied_at","parsed_applied_at_kind","parsed_applied_at","reconciled_applied_at","applied_at_conflict","stored_award_batch_label_kind","stored_award_batch_label","parsed_award_batch_label_kind","parsed_award_batch_label","reconciled_award_batch_label","award_batch_label_conflict","stored_year_kind","stored_year","parsed_year_kind","parsed_year","reconciled_year","year_conflict","rule_version","created_at" FROM t714_platform_business_projection;
--> statement-breakpoint
DROP TABLE t714_platform_business_projection;
--> statement-breakpoint
INSERT INTO platform_legacy_relation_alias("old_id","observation_id") SELECT "old_id","observation_id" FROM t714_platform_legacy_relation_alias;
--> statement-breakpoint
DROP TABLE t714_platform_legacy_relation_alias;
--> statement-breakpoint
INSERT INTO platform_observation_archive_ref("owner_id","field","archive_id","sealed") SELECT "owner_id","field","archive_id","sealed" FROM t714_platform_observation_archive_ref;
--> statement-breakpoint
DROP TABLE t714_platform_observation_archive_ref;
--> statement-breakpoint
INSERT INTO platform_observation_assignment("observation_id","revision","enterprise_id","match_basis","verification_status","uscc_raw","name_raw","alias_name_raw","actor","basis","command_receipt_id","recorded_at","origin") SELECT "observation_id","revision","enterprise_id","match_basis","verification_status","uscc_raw","name_raw","alias_name_raw","actor","basis","command_receipt_id","recorded_at","origin" FROM t714_platform_observation_assignment;
--> statement-breakpoint
DROP TABLE t714_platform_observation_assignment;
--> statement-breakpoint
INSERT INTO platform_recognized_projection("id","observation_id","basis","version_id","record_id","validity_date_raw","maintenance_year","maintenance_batch","source_validity_date","source_maintenance_batch","source_maintenance_year_absent","district","award_note","title_raw","name_raw","uscc_raw","source_title_kind","source_title_text","source_title_number_text","source_title_boolean","source_title_rule_version","source_archive_id","parse_state","stored_province_kind","stored_province","parsed_province_kind","parsed_province","reconciled_province","province_conflict","stored_status_kind","stored_status","parsed_status_kind","parsed_status","reconciled_status","status_conflict","stored_batch_kind","stored_batch","parsed_batch_kind","parsed_batch","reconciled_batch","batch_conflict","stored_declare_kind_kind","stored_declare_kind","parsed_declare_kind_kind","parsed_declare_kind","reconciled_declare_kind","declare_kind_conflict","stored_applied_at_kind","stored_applied_at","parsed_applied_at_kind","parsed_applied_at","reconciled_applied_at","applied_at_conflict","stored_award_batch_label_kind","stored_award_batch_label","parsed_award_batch_label_kind","parsed_award_batch_label","reconciled_award_batch_label","award_batch_label_conflict","stored_year_kind","stored_year","parsed_year_kind","parsed_year","reconciled_year","year_conflict","rule_version","created_at") SELECT "id","observation_id","basis","version_id","record_id","validity_date_raw","maintenance_year","maintenance_batch","source_validity_date","source_maintenance_batch","source_maintenance_year_absent","district","award_note","title_raw","name_raw","uscc_raw","source_title_kind","source_title_text","source_title_number_text","source_title_boolean","source_title_rule_version","source_archive_id","parse_state","stored_province_kind","stored_province","parsed_province_kind","parsed_province","reconciled_province","province_conflict","stored_status_kind","stored_status","parsed_status_kind","parsed_status","reconciled_status","status_conflict","stored_batch_kind","stored_batch","parsed_batch_kind","parsed_batch","reconciled_batch","batch_conflict","stored_declare_kind_kind","stored_declare_kind","parsed_declare_kind_kind","parsed_declare_kind","reconciled_declare_kind","declare_kind_conflict","stored_applied_at_kind","stored_applied_at","parsed_applied_at_kind","parsed_applied_at","reconciled_applied_at","applied_at_conflict","stored_award_batch_label_kind","stored_award_batch_label","parsed_award_batch_label_kind","parsed_award_batch_label","reconciled_award_batch_label","award_batch_label_conflict","stored_year_kind","stored_year","parsed_year_kind","parsed_year","reconciled_year","year_conflict","rule_version","created_at" FROM t714_platform_recognized_projection;
--> statement-breakpoint
DROP TABLE t714_platform_recognized_projection;
--> statement-breakpoint
CREATE INDEX `platform_apply_projection_applied_idx` ON `platform_apply_projection` (`applied_at`);
--> statement-breakpoint
CREATE INDEX `platform_apply_projection_kind_idx` ON `platform_apply_projection` (`declare_kind`);
--> statement-breakpoint
CREATE UNIQUE INDEX `platform_apply_projection_observation_uq` ON `platform_apply_projection` (`observation_id`);
--> statement-breakpoint
CREATE INDEX `platform_apply_projection_record_idx` ON `platform_apply_projection` (`record_id`);
--> statement-breakpoint
CREATE INDEX `platform_apply_projection_status_idx` ON `platform_apply_projection` (`status`);
--> statement-breakpoint
CREATE INDEX `platform_apply_projection_title_version_idx` ON `platform_apply_projection` (`title_raw`,`version_id`);
--> statement-breakpoint
CREATE INDEX `platform_apply_projection_uscc_idx` ON `platform_apply_projection` (`uscc_raw`);
--> statement-breakpoint
CREATE UNIQUE INDEX `platform_apply_projection_version_uq` ON `platform_apply_projection` (`version_id`);
--> statement-breakpoint
CREATE INDEX `platform_apply_projection_year_idx` ON `platform_apply_projection` (`declaration_year`);
--> statement-breakpoint
CREATE INDEX `platform_assignment_enterprise_idx` ON `platform_observation_assignment` (`enterprise_id`,`observation_id`,`revision`);
--> statement-breakpoint
CREATE INDEX `platform_assignment_uscc_idx` ON `platform_observation_assignment` (`uscc_raw`,`observation_id`);
--> statement-breakpoint
CREATE INDEX platform_business_observation_record_idx ON platform_business_observation(record_id, version_id, relation_id);
--> statement-breakpoint
CREATE INDEX platform_business_observation_version_idx ON platform_business_observation(version_id, relation_id);
--> statement-breakpoint
CREATE INDEX `platform_business_projection_applied_idx` ON `platform_business_projection` (`applied_at`);
--> statement-breakpoint
CREATE INDEX `platform_business_projection_batch_idx` ON `platform_business_projection` (`batch`);
--> statement-breakpoint
CREATE INDEX `platform_business_projection_kind_idx` ON `platform_business_projection` (`declare_kind`);
--> statement-breakpoint
CREATE UNIQUE INDEX `platform_business_projection_observation_uq` ON `platform_business_projection` (`observation_id`);
--> statement-breakpoint
CREATE INDEX `platform_business_projection_record_idx` ON `platform_business_projection` (`record_id`);
--> statement-breakpoint
CREATE INDEX `platform_business_projection_status_idx` ON `platform_business_projection` (`status`);
--> statement-breakpoint
CREATE INDEX `platform_business_projection_title_version_idx` ON `platform_business_projection` (`title_raw`,`version_id`);
--> statement-breakpoint
CREATE INDEX `platform_business_projection_uscc_idx` ON `platform_business_projection` (`uscc_raw`);
--> statement-breakpoint
CREATE UNIQUE INDEX `platform_business_projection_version_uq` ON `platform_business_projection` (`version_id`);
--> statement-breakpoint
CREATE INDEX `platform_business_projection_year_idx` ON `platform_business_projection` (`business_year`);
--> statement-breakpoint
CREATE UNIQUE INDEX `platform_legacy_relation_alias_observation_id_unique` ON `platform_legacy_relation_alias` (`observation_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `platform_observation_archive_ref_archive_id_unique` ON `platform_observation_archive_ref` (`archive_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `platform_observation_collection_sequence_uq` ON `platform_business_observation` (`collection_id`,`sequence_no`);
--> statement-breakpoint
CREATE UNIQUE INDEX `platform_observation_id_uq` ON `platform_business_observation` (`id`);
--> statement-breakpoint
CREATE INDEX `platform_observation_position_idx` ON `platform_business_observation` (`collection_id`,`page_id`,`sequence_no`);
--> statement-breakpoint
CREATE INDEX `platform_recognized_projection_batch_idx` ON `platform_recognized_projection` (`maintenance_batch`);
--> statement-breakpoint
CREATE INDEX `platform_recognized_projection_district_idx` ON `platform_recognized_projection` (`district`);
--> statement-breakpoint
CREATE UNIQUE INDEX `platform_recognized_projection_observation_uq` ON `platform_recognized_projection` (`observation_id`);
--> statement-breakpoint
CREATE INDEX `platform_recognized_projection_record_idx` ON `platform_recognized_projection` (`record_id`);
--> statement-breakpoint
CREATE INDEX `platform_recognized_projection_title_idx` ON `platform_recognized_projection` (`title_raw`);
--> statement-breakpoint
CREATE INDEX `platform_recognized_projection_title_version_idx` ON `platform_recognized_projection` (`title_raw`,`version_id`);
--> statement-breakpoint
CREATE INDEX `platform_recognized_projection_uscc_idx` ON `platform_recognized_projection` (`uscc_raw`);
--> statement-breakpoint
CREATE INDEX `platform_recognized_projection_validity_idx` ON `platform_recognized_projection` (`validity_date_raw`);
--> statement-breakpoint
CREATE UNIQUE INDEX `platform_recognized_projection_version_uq` ON `platform_recognized_projection` (`version_id`);
--> statement-breakpoint
CREATE INDEX `platform_recognized_projection_year_idx` ON `platform_recognized_projection` (`maintenance_year`);
--> statement-breakpoint
CREATE TRIGGER platform_apply_platform_business_observation_replace_guard BEFORE INSERT ON platform_business_observation WHEN (NEW.collection_id IS NOT (SELECT collection_id FROM platform_business_observation WHERE relation_id=NEW.relation_id)) AND EXISTS (SELECT 1 FROM platform_apply_projection p WHERE p.observation_id=NEW.relation_id) BEGIN SELECT RAISE(ABORT,'projection owner replacement'); END;
--> statement-breakpoint
CREATE TRIGGER platform_apply_projection_owner_insert BEFORE INSERT ON platform_apply_projection
WHEN (NEW.version_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM platform_business_record r JOIN platform_business_record_version v ON v.record_id=r.id WHERE v.id=NEW.version_id AND r.id=NEW.record_id AND r.interface='apply_list'))
OR (NEW.observation_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM platform_business_observation o JOIN platform_collection c ON c.id=o.collection_id WHERE o.relation_id=NEW.observation_id AND c.interface='apply_list'))
OR (NEW.source_archive_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM platform_observation_archive_ref a WHERE a.owner_id=NEW.observation_id AND a.field='rawFields' AND a.archive_id=NEW.source_archive_id AND a.sealed=1))
BEGIN SELECT RAISE(ABORT,'projection source or archive owner mismatch'); END;
--> statement-breakpoint
CREATE TRIGGER platform_apply_projection_owner_update BEFORE UPDATE ON platform_apply_projection
WHEN (NEW.version_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM platform_business_record r JOIN platform_business_record_version v ON v.record_id=r.id WHERE v.id=NEW.version_id AND r.id=NEW.record_id AND r.interface='apply_list'))
OR (NEW.observation_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM platform_business_observation o JOIN platform_collection c ON c.id=o.collection_id WHERE o.relation_id=NEW.observation_id AND c.interface='apply_list'))
OR (NEW.source_archive_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM platform_observation_archive_ref a WHERE a.owner_id=NEW.observation_id AND a.field='rawFields' AND a.archive_id=NEW.source_archive_id AND a.sealed=1))
BEGIN SELECT RAISE(ABORT,'projection source or archive owner mismatch'); END;
--> statement-breakpoint
CREATE TRIGGER platform_assignment_append BEFORE INSERT ON platform_observation_assignment
WHEN NEW.revision != COALESCE((SELECT MAX(revision) FROM platform_observation_assignment WHERE observation_id=NEW.observation_id),0)+1
BEGIN SELECT RAISE(ABORT,'assignment revision must append'); END;
--> statement-breakpoint
CREATE TRIGGER platform_assignment_no_delete BEFORE DELETE ON platform_observation_assignment BEGIN SELECT RAISE(ABORT,'assignment is append only'); END;
--> statement-breakpoint
CREATE TRIGGER platform_assignment_no_update BEFORE UPDATE ON platform_observation_assignment BEGIN SELECT RAISE(ABORT,'assignment is append only'); END;
--> statement-breakpoint
CREATE TRIGGER platform_business_platform_business_observation_replace_guard BEFORE INSERT ON platform_business_observation WHEN (NEW.collection_id IS NOT (SELECT collection_id FROM platform_business_observation WHERE relation_id=NEW.relation_id)) AND EXISTS (SELECT 1 FROM platform_business_projection p WHERE p.observation_id=NEW.relation_id) BEGIN SELECT RAISE(ABORT,'projection owner replacement'); END;
--> statement-breakpoint
CREATE TRIGGER platform_business_projection_owner_insert BEFORE INSERT ON platform_business_projection
WHEN (NEW.version_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM platform_business_record r JOIN platform_business_record_version v ON v.record_id=r.id WHERE v.id=NEW.version_id AND r.id=NEW.record_id AND r.interface='business_list'))
OR (NEW.observation_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM platform_business_observation o JOIN platform_collection c ON c.id=o.collection_id WHERE o.relation_id=NEW.observation_id AND c.interface='business_list'))
OR (NEW.source_archive_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM platform_observation_archive_ref a WHERE a.owner_id=NEW.observation_id AND a.field='rawFields' AND a.archive_id=NEW.source_archive_id AND a.sealed=1))
BEGIN SELECT RAISE(ABORT,'projection source or archive owner mismatch'); END;
--> statement-breakpoint
CREATE TRIGGER platform_business_projection_owner_update BEFORE UPDATE ON platform_business_projection
WHEN (NEW.version_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM platform_business_record r JOIN platform_business_record_version v ON v.record_id=r.id WHERE v.id=NEW.version_id AND r.id=NEW.record_id AND r.interface='business_list'))
OR (NEW.observation_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM platform_business_observation o JOIN platform_collection c ON c.id=o.collection_id WHERE o.relation_id=NEW.observation_id AND c.interface='business_list'))
OR (NEW.source_archive_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM platform_observation_archive_ref a WHERE a.owner_id=NEW.observation_id AND a.field='rawFields' AND a.archive_id=NEW.source_archive_id AND a.sealed=1))
BEGIN SELECT RAISE(ABORT,'projection source or archive owner mismatch'); END;
--> statement-breakpoint
CREATE TRIGGER platform_legacy_relation_alias_no_delete BEFORE DELETE ON platform_legacy_relation_alias BEGIN SELECT RAISE(ABORT, 'immutable alias'); END;
--> statement-breakpoint
CREATE TRIGGER platform_legacy_relation_alias_no_replace BEFORE INSERT ON platform_legacy_relation_alias WHEN EXISTS (SELECT 1 FROM platform_legacy_relation_alias WHERE old_id=NEW.old_id OR observation_id=NEW.observation_id) BEGIN SELECT RAISE(ABORT, 'immutable alias collision'); END;
--> statement-breakpoint
CREATE TRIGGER platform_legacy_relation_alias_no_update BEFORE UPDATE ON platform_legacy_relation_alias BEGIN SELECT RAISE(ABORT, 'immutable alias'); END;
--> statement-breakpoint
CREATE TRIGGER platform_legacy_relation_alias_owner BEFORE INSERT ON platform_legacy_relation_alias WHEN NOT EXISTS (SELECT 1 FROM platform_business_observation o JOIN platform_relation r ON r.id=o.relation_id JOIN platform_legacy_query_alias q ON q.old_id=r.query_id WHERE o.relation_id=NEW.observation_id) BEGIN SELECT RAISE(ABORT, 'unmapped transitional observation collection'); END;
--> statement-breakpoint
CREATE TRIGGER platform_observation_archive_ref_no_delete BEFORE DELETE ON platform_observation_archive_ref BEGIN SELECT RAISE(ABORT, 'immutable archive binding'); END;
--> statement-breakpoint
CREATE TRIGGER platform_observation_archive_ref_no_replace BEFORE INSERT ON platform_observation_archive_ref WHEN EXISTS (SELECT 1 FROM platform_observation_archive_ref WHERE owner_id=NEW.owner_id AND (field=NEW.field OR sealed=1)) OR EXISTS (SELECT 1 FROM platform_collection_archive_ref WHERE archive_id=NEW.archive_id) OR EXISTS (SELECT 1 FROM platform_observation_archive_ref WHERE archive_id=NEW.archive_id) OR EXISTS (SELECT 1 FROM platform_version_archive_ref WHERE archive_id=NEW.archive_id) BEGIN SELECT RAISE(ABORT, 'sealed or duplicate archive binding'); END;
--> statement-breakpoint
CREATE TRIGGER platform_observation_archive_ref_seal_only BEFORE UPDATE ON platform_observation_archive_ref WHEN OLD.sealed != 0 OR NEW.sealed != 1 OR NEW.owner_id != OLD.owner_id OR NEW.field != OLD.field OR NEW.archive_id != OLD.archive_id BEGIN SELECT RAISE(ABORT, 'immutable archive binding'); END;
--> statement-breakpoint
CREATE TRIGGER platform_observation_page_insert BEFORE INSERT ON platform_business_observation
WHEN NEW.page_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM platform_collection_page WHERE id=NEW.page_id AND collection_id=NEW.collection_id)
BEGIN SELECT RAISE(ABORT,'observation page collection mismatch'); END;
--> statement-breakpoint
CREATE TRIGGER platform_observation_page_update BEFORE UPDATE ON platform_business_observation
WHEN NEW.page_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM platform_collection_page WHERE id=NEW.page_id AND collection_id=NEW.collection_id)
BEGIN SELECT RAISE(ABORT,'observation page collection mismatch'); END;
--> statement-breakpoint
CREATE TRIGGER platform_projection_platform_business_observation_guard BEFORE UPDATE ON platform_business_observation WHEN (NEW.collection_id IS NOT OLD.collection_id) AND (EXISTS (SELECT 1 FROM platform_apply_projection p WHERE p.observation_id=OLD.relation_id) OR EXISTS (SELECT 1 FROM platform_business_projection p WHERE p.observation_id=OLD.relation_id) OR EXISTS (SELECT 1 FROM platform_recognized_projection p WHERE p.observation_id=OLD.relation_id)) BEGIN SELECT RAISE(ABORT,'projection owner is bound'); END;
--> statement-breakpoint
CREATE TRIGGER platform_recognized_platform_business_observation_replace_guard BEFORE INSERT ON platform_business_observation WHEN (NEW.collection_id IS NOT (SELECT collection_id FROM platform_business_observation WHERE relation_id=NEW.relation_id)) AND EXISTS (SELECT 1 FROM platform_recognized_projection p WHERE p.observation_id=NEW.relation_id) BEGIN SELECT RAISE(ABORT,'projection owner replacement'); END;
--> statement-breakpoint
CREATE TRIGGER platform_recognized_projection_owner_insert BEFORE INSERT ON platform_recognized_projection
WHEN (NEW.version_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM platform_business_record r JOIN platform_business_record_version v ON v.record_id=r.id WHERE v.id=NEW.version_id AND r.id=NEW.record_id AND r.interface='recognized_list'))
OR (NEW.observation_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM platform_business_observation o JOIN platform_collection c ON c.id=o.collection_id WHERE o.relation_id=NEW.observation_id AND c.interface='recognized_list'))
OR (NEW.source_archive_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM platform_observation_archive_ref a WHERE a.owner_id=NEW.observation_id AND a.field='rawFields' AND a.archive_id=NEW.source_archive_id AND a.sealed=1))
BEGIN SELECT RAISE(ABORT,'projection source or archive owner mismatch'); END;
--> statement-breakpoint
CREATE TRIGGER platform_recognized_projection_owner_update BEFORE UPDATE ON platform_recognized_projection
WHEN (NEW.version_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM platform_business_record r JOIN platform_business_record_version v ON v.record_id=r.id WHERE v.id=NEW.version_id AND r.id=NEW.record_id AND r.interface='recognized_list'))
OR (NEW.observation_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM platform_business_observation o JOIN platform_collection c ON c.id=o.collection_id WHERE o.relation_id=NEW.observation_id AND c.interface='recognized_list'))
OR (NEW.source_archive_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM platform_observation_archive_ref a WHERE a.owner_id=NEW.observation_id AND a.field='rawFields' AND a.archive_id=NEW.source_archive_id AND a.sealed=1))
BEGIN SELECT RAISE(ABORT,'projection source or archive owner mismatch'); END;
