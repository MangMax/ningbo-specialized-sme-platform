CREATE TABLE `official_evidence_row_revision` (
  `evidence_id` integer NOT NULL REFERENCES `record_evidence`(`id`),
  `revision` integer NOT NULL,
  `format_version` integer DEFAULT 1 NOT NULL,
  `event_id` integer NOT NULL REFERENCES `record_event`(`id`),
  `captured_record_id` integer NOT NULL,
  `captured_enterprise_id` integer NOT NULL,
  `name_raw` text, `uscc_raw` text, `district_raw` text,
  `source_document_id` integer REFERENCES `source_document`(`id`),
  `stored_file_id` integer REFERENCES `stored_file`(`id`),
  `path` text, `sha256` text, `bytes` integer,
  `attachment` text, `section_key` text, `list_no` integer, `page` integer,
  `source_binding_known` integer NOT NULL,
  `actor` text NOT NULL, `basis` text NOT NULL,
  `command_kind` text NOT NULL,
  `import_batch_id` integer REFERENCES `import_batch`(`id`),
  `correction_batch_key` text REFERENCES `evidence_correction_batch`(`idempotency_key`),
  `created_at` text NOT NULL,
  CONSTRAINT `official_evidence_row_version_ck` CHECK (`format_version` = 1 AND typeof(`revision`) = 'integer' AND `revision` BETWEEN 1 AND 9007199254740991),
  CONSTRAINT `official_evidence_row_ids_ck` CHECK (
    typeof(`evidence_id`) = 'integer' AND `evidence_id` BETWEEN 1 AND 9007199254740991 AND
    typeof(`event_id`) = 'integer' AND `event_id` BETWEEN 1 AND 9007199254740991 AND
    typeof(`captured_record_id`) = 'integer' AND `captured_record_id` BETWEEN 1 AND 9007199254740991 AND
    typeof(`captured_enterprise_id`) = 'integer' AND `captured_enterprise_id` BETWEEN 1 AND 9007199254740991),
  CONSTRAINT `official_evidence_row_optional_ids_ck` CHECK (
    (`source_document_id` IS NULL OR (typeof(`source_document_id`) = 'integer' AND `source_document_id` BETWEEN 1 AND 9007199254740991)) AND
    (`stored_file_id` IS NULL OR (typeof(`stored_file_id`) = 'integer' AND `stored_file_id` BETWEEN 1 AND 9007199254740991)) AND
    (`list_no` IS NULL OR (typeof(`list_no`) = 'integer' AND `list_no` BETWEEN 1 AND 9007199254740991)) AND
    (`page` IS NULL OR (typeof(`page`) = 'integer' AND `page` BETWEEN 1 AND 9007199254740991)) AND
    (`import_batch_id` IS NULL OR (typeof(`import_batch_id`) = 'integer' AND `import_batch_id` BETWEEN 1 AND 9007199254740991))),
  CONSTRAINT `official_evidence_row_text_ck` CHECK (
    (`name_raw` IS NULL OR typeof(`name_raw`) = 'text') AND (`uscc_raw` IS NULL OR typeof(`uscc_raw`) = 'text') AND
    (`district_raw` IS NULL OR typeof(`district_raw`) = 'text') AND (`path` IS NULL OR typeof(`path`) = 'text') AND
    (`sha256` IS NULL OR typeof(`sha256`) = 'text') AND (`attachment` IS NULL OR typeof(`attachment`) = 'text') AND
    (`section_key` IS NULL OR typeof(`section_key`) = 'text') AND (`correction_batch_key` IS NULL OR typeof(`correction_batch_key`) = 'text')),
  CONSTRAINT `official_evidence_row_bytes_ck` CHECK (`bytes` IS NULL OR (typeof(`bytes`) = 'integer' AND `bytes` BETWEEN 0 AND 9007199254740991)),
  CONSTRAINT `official_evidence_row_binding_ck` CHECK (`source_binding_known` IN (0,1) AND (`source_binding_known` = 0 OR (
    `source_document_id` IS NOT NULL AND `sha256` IS NOT NULL AND length(`sha256`) = 64 AND `sha256` NOT GLOB '*[^0-9a-f]*' AND
    `bytes` IS NOT NULL AND `section_key` IS NOT NULL AND length(CAST(`section_key` AS BLOB)) > 0 AND `list_no` IS NOT NULL))),
  CONSTRAINT `official_evidence_row_actor_ck` CHECK (CASE WHEN json_valid(`actor`) THEN coalesce(json_type(`actor`) = 'object' AND json_extract(`actor`, '$.type') IN ('user','agent') AND json_type(`actor`, '$.id') = 'text' AND length(CAST(json_extract(`actor`, '$.id') AS BLOB)) > 0, 0) ELSE 0 END),
  CONSTRAINT `official_evidence_row_command_ck` CHECK (
    (`command_kind` = 'import' AND `import_batch_id` IS NOT NULL AND `correction_batch_key` IS NULL) OR
    (`command_kind` = 'evidence_correction' AND `correction_batch_key` IS NOT NULL AND `import_batch_id` IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `official_evidence_row_revision_uq` ON `official_evidence_row_revision` (`evidence_id`,`revision`);
--> statement-breakpoint
CREATE INDEX `official_evidence_row_source_idx` ON `official_evidence_row_revision` (`source_document_id`,`sha256`,`bytes`,`attachment`,`section_key`,`list_no`,`evidence_id`,`revision`);
--> statement-breakpoint
CREATE INDEX `official_evidence_row_event_idx` ON `official_evidence_row_revision` (`event_id`,`evidence_id`,`revision`);
