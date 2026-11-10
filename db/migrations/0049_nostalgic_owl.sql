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
CREATE INDEX `platform_assignment_enterprise_idx` ON `platform_observation_assignment` (`enterprise_id`,`observation_id`,`revision`);--> statement-breakpoint
CREATE INDEX `platform_assignment_uscc_idx` ON `platform_observation_assignment` (`uscc_raw`,`observation_id`);--> statement-breakpoint
ALTER TABLE platform_business_observation ADD COLUMN id integer CONSTRAINT "platform_observation_id_ck" CHECK("id" IS NULL OR (typeof("id") = 'integer' AND "id" BETWEEN 1 AND 9007199254740991));
--> statement-breakpoint
ALTER TABLE platform_business_observation ADD COLUMN collection_id integer REFERENCES platform_collection(id) ON DELETE RESTRICT CONSTRAINT "platform_observation_collection_id_ck" CHECK("collection_id" IS NULL OR (typeof("collection_id") = 'integer' AND "collection_id" BETWEEN 1 AND 9007199254740991));
--> statement-breakpoint
ALTER TABLE platform_business_observation ADD COLUMN sequence_no integer CONSTRAINT "platform_observation_sequence_no_ck" CHECK("sequence_no" IS NULL OR (typeof("sequence_no") = 'integer' AND "sequence_no" BETWEEN 1 AND 9007199254740991));
--> statement-breakpoint
ALTER TABLE platform_business_observation ADD COLUMN page_id integer REFERENCES platform_collection_page(id) ON DELETE RESTRICT CONSTRAINT "platform_observation_page_id_ck" CHECK("page_id" IS NULL OR (typeof("page_id") = 'integer' AND "page_id" BETWEEN 1 AND 9007199254740991));
--> statement-breakpoint
ALTER TABLE platform_business_observation ADD COLUMN page_row_no integer CONSTRAINT "platform_observation_page_row_no_ck" CHECK("page_row_no" IS NULL OR (typeof("page_row_no") = 'integer' AND "page_row_no" BETWEEN 1 AND 9007199254740991));
--> statement-breakpoint
ALTER TABLE platform_business_observation ADD COLUMN position_state text CONSTRAINT "platform_observation_position_state_ck" CHECK("position_state" IS NULL OR "position_state" IN ('verified','unknown','conflict'));
--> statement-breakpoint
ALTER TABLE platform_business_observation ADD COLUMN source_relation_key text CONSTRAINT "platform_observation_source_key_ck" CHECK("source_relation_key" IS NULL OR typeof("source_relation_key") = 'text') CONSTRAINT "platform_observation_mapping_ck" CHECK(("id" IS NULL AND "collection_id" IS NULL AND "sequence_no" IS NULL AND "page_id" IS NULL AND "page_row_no" IS NULL AND "position_state" IS NULL AND "source_relation_key" IS NULL) OR ("id" IS NOT NULL AND "collection_id" IS NOT NULL AND "sequence_no" IS NOT NULL AND "position_state" IS NOT NULL AND ("page_row_no" IS NULL OR "page_id" IS NOT NULL)));
--> statement-breakpoint
CREATE UNIQUE INDEX `platform_observation_id_uq` ON `platform_business_observation` (`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `platform_observation_collection_sequence_uq` ON `platform_business_observation` (`collection_id`,`sequence_no`);--> statement-breakpoint
CREATE INDEX `platform_observation_position_idx` ON `platform_business_observation` (`collection_id`,`page_id`,`sequence_no`);--> statement-breakpoint

CREATE TRIGGER platform_assignment_no_update BEFORE UPDATE ON platform_observation_assignment BEGIN SELECT RAISE(ABORT,'assignment is append only'); END;
--> statement-breakpoint
CREATE TRIGGER platform_assignment_no_delete BEFORE DELETE ON platform_observation_assignment BEGIN SELECT RAISE(ABORT,'assignment is append only'); END;
--> statement-breakpoint
CREATE TRIGGER platform_assignment_append BEFORE INSERT ON platform_observation_assignment
WHEN NEW.revision != COALESCE((SELECT MAX(revision) FROM platform_observation_assignment WHERE observation_id=NEW.observation_id),0)+1
BEGIN SELECT RAISE(ABORT,'assignment revision must append'); END;
--> statement-breakpoint
CREATE TRIGGER platform_observation_page_insert BEFORE INSERT ON platform_business_observation
WHEN NEW.page_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM platform_collection_page WHERE id=NEW.page_id AND collection_id=NEW.collection_id)
BEGIN SELECT RAISE(ABORT,'observation page collection mismatch'); END;
--> statement-breakpoint
CREATE TRIGGER platform_observation_page_update BEFORE UPDATE ON platform_business_observation
WHEN NEW.page_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM platform_collection_page WHERE id=NEW.page_id AND collection_id=NEW.collection_id)
BEGIN SELECT RAISE(ABORT,'observation page collection mismatch'); END;
--> statement-breakpoint
CREATE TRIGGER platform_observation_page_owner_update BEFORE UPDATE OF collection_id ON platform_collection_page
WHEN EXISTS(SELECT 1 FROM platform_business_observation WHERE page_id=OLD.id AND collection_id!=NEW.collection_id)
BEGIN SELECT RAISE(ABORT,'observation page collection mismatch'); END;
