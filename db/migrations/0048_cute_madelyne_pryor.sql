CREATE TABLE `platform_archive_value` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`storage_class` text NOT NULL,
	`bytes` blob,
	`byte_length` integer,
	`sha256` text,
	`created_at` text,
	CONSTRAINT "platform_archive_value_ck" CHECK(("platform_archive_value"."storage_class" = 'null' AND "platform_archive_value"."bytes" IS NULL AND "platform_archive_value"."byte_length" IS NULL AND "platform_archive_value"."sha256" IS NULL) OR ("platform_archive_value"."storage_class" IN ('text','blob') AND typeof("platform_archive_value"."bytes") = 'blob' AND typeof("platform_archive_value"."byte_length") = 'integer' AND "platform_archive_value"."byte_length" = length("platform_archive_value"."bytes") AND "platform_archive_value"."sha256" IS NOT NULL AND length("platform_archive_value"."sha256") = 64 AND "platform_archive_value"."sha256" NOT GLOB '*[^0-9a-f]*'))
);
--> statement-breakpoint
CREATE TABLE `platform_collection_archive_ref` (
	`owner_id` integer NOT NULL,
	`field` text NOT NULL,
	`archive_id` integer NOT NULL,
	`sealed` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`owner_id`, `field`),
	FOREIGN KEY (`owner_id`) REFERENCES `platform_collection`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`archive_id`) REFERENCES `platform_archive_value`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "platform_collection_archive_ref_ck" CHECK("platform_collection_archive_ref"."field" IN ('rawResponse','collectionEvidence','legacyProvenance','request') AND "platform_collection_archive_ref"."sealed" IN (0,1))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `platform_collection_archive_ref_archive_id_unique` ON `platform_collection_archive_ref` (`archive_id`);--> statement-breakpoint
CREATE TABLE `platform_legacy_alias_sequence` (
	`namespace` text PRIMARY KEY NOT NULL,
	`high_water` integer NOT NULL,
	CONSTRAINT "platform_legacy_alias_sequence_ck" CHECK("platform_legacy_alias_sequence"."namespace" IN ('query','relation') AND typeof("platform_legacy_alias_sequence"."high_water") = 'integer' AND "platform_legacy_alias_sequence"."high_water" BETWEEN 0 AND 9007199254740991)
);
--> statement-breakpoint
CREATE TABLE `platform_legacy_query_alias` (
	`old_id` integer PRIMARY KEY NOT NULL,
	`collection_id` integer NOT NULL,
	FOREIGN KEY (`collection_id`) REFERENCES `platform_collection`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "platform_legacy_query_alias_id_ck" CHECK("platform_legacy_query_alias"."old_id" > 0 AND "platform_legacy_query_alias"."old_id" <= 9007199254740991)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `platform_legacy_query_alias_collection_id_unique` ON `platform_legacy_query_alias` (`collection_id`);--> statement-breakpoint
CREATE TABLE `platform_legacy_relation_alias` (
	`old_id` integer PRIMARY KEY NOT NULL,
	`observation_id` integer NOT NULL,
	FOREIGN KEY (`observation_id`) REFERENCES `platform_business_observation`(`relation_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "platform_legacy_relation_alias_id_ck" CHECK("platform_legacy_relation_alias"."old_id" > 0 AND "platform_legacy_relation_alias"."old_id" <= 9007199254740991)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `platform_legacy_relation_alias_observation_id_unique` ON `platform_legacy_relation_alias` (`observation_id`);--> statement-breakpoint
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
CREATE UNIQUE INDEX `platform_observation_archive_ref_archive_id_unique` ON `platform_observation_archive_ref` (`archive_id`);--> statement-breakpoint
CREATE TABLE `platform_version_archive_ref` (
	`owner_id` integer NOT NULL,
	`field` text NOT NULL,
	`archive_id` integer NOT NULL,
	`sealed` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`owner_id`, `field`),
	FOREIGN KEY (`owner_id`) REFERENCES `platform_business_record_version`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`archive_id`) REFERENCES `platform_archive_value`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "platform_version_archive_ref_ck" CHECK("platform_version_archive_ref"."field" = 'canonicalRawJson' AND "platform_version_archive_ref"."sealed" IN (0,1))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `platform_version_archive_ref_archive_id_unique` ON `platform_version_archive_ref` (`archive_id`);
--> statement-breakpoint
CREATE TRIGGER platform_archive_no_update BEFORE UPDATE ON platform_archive_value BEGIN SELECT RAISE(ABORT, 'immutable archive'); END;
--> statement-breakpoint
CREATE TRIGGER platform_archive_no_delete BEFORE DELETE ON platform_archive_value BEGIN SELECT RAISE(ABORT, 'immutable archive'); END;
--> statement-breakpoint
CREATE TRIGGER platform_archive_no_replace BEFORE INSERT ON platform_archive_value WHEN EXISTS (SELECT 1 FROM platform_archive_value WHERE id=NEW.id) BEGIN SELECT RAISE(ABORT, 'immutable archive collision'); END;
--> statement-breakpoint
CREATE TRIGGER platform_collection_archive_ref_no_delete BEFORE DELETE ON platform_collection_archive_ref BEGIN SELECT RAISE(ABORT, 'immutable archive binding'); END;
--> statement-breakpoint
CREATE TRIGGER platform_collection_archive_ref_seal_only BEFORE UPDATE ON platform_collection_archive_ref WHEN OLD.sealed != 0 OR NEW.sealed != 1 OR NEW.owner_id != OLD.owner_id OR NEW.field != OLD.field OR NEW.archive_id != OLD.archive_id BEGIN SELECT RAISE(ABORT, 'immutable archive binding'); END;
--> statement-breakpoint
CREATE TRIGGER platform_collection_archive_ref_no_replace BEFORE INSERT ON platform_collection_archive_ref WHEN EXISTS (SELECT 1 FROM platform_collection_archive_ref WHERE owner_id=NEW.owner_id AND (field=NEW.field OR sealed=1)) OR EXISTS (SELECT 1 FROM platform_collection_archive_ref WHERE archive_id=NEW.archive_id) OR EXISTS (SELECT 1 FROM platform_observation_archive_ref WHERE archive_id=NEW.archive_id) OR EXISTS (SELECT 1 FROM platform_version_archive_ref WHERE archive_id=NEW.archive_id) BEGIN SELECT RAISE(ABORT, 'sealed or duplicate archive binding'); END;
--> statement-breakpoint
CREATE TRIGGER platform_observation_archive_ref_no_delete BEFORE DELETE ON platform_observation_archive_ref BEGIN SELECT RAISE(ABORT, 'immutable archive binding'); END;
--> statement-breakpoint
CREATE TRIGGER platform_observation_archive_ref_seal_only BEFORE UPDATE ON platform_observation_archive_ref WHEN OLD.sealed != 0 OR NEW.sealed != 1 OR NEW.owner_id != OLD.owner_id OR NEW.field != OLD.field OR NEW.archive_id != OLD.archive_id BEGIN SELECT RAISE(ABORT, 'immutable archive binding'); END;
--> statement-breakpoint
CREATE TRIGGER platform_observation_archive_ref_no_replace BEFORE INSERT ON platform_observation_archive_ref WHEN EXISTS (SELECT 1 FROM platform_observation_archive_ref WHERE owner_id=NEW.owner_id AND (field=NEW.field OR sealed=1)) OR EXISTS (SELECT 1 FROM platform_collection_archive_ref WHERE archive_id=NEW.archive_id) OR EXISTS (SELECT 1 FROM platform_observation_archive_ref WHERE archive_id=NEW.archive_id) OR EXISTS (SELECT 1 FROM platform_version_archive_ref WHERE archive_id=NEW.archive_id) BEGIN SELECT RAISE(ABORT, 'sealed or duplicate archive binding'); END;
--> statement-breakpoint
CREATE TRIGGER platform_version_archive_ref_no_delete BEFORE DELETE ON platform_version_archive_ref BEGIN SELECT RAISE(ABORT, 'immutable archive binding'); END;
--> statement-breakpoint
CREATE TRIGGER platform_version_archive_ref_seal_only BEFORE UPDATE ON platform_version_archive_ref WHEN OLD.sealed != 0 OR NEW.sealed != 1 OR NEW.owner_id != OLD.owner_id OR NEW.field != OLD.field OR NEW.archive_id != OLD.archive_id BEGIN SELECT RAISE(ABORT, 'immutable archive binding'); END;
--> statement-breakpoint
CREATE TRIGGER platform_version_archive_ref_no_replace BEFORE INSERT ON platform_version_archive_ref WHEN EXISTS (SELECT 1 FROM platform_version_archive_ref WHERE owner_id=NEW.owner_id AND (field=NEW.field OR sealed=1)) OR EXISTS (SELECT 1 FROM platform_collection_archive_ref WHERE archive_id=NEW.archive_id) OR EXISTS (SELECT 1 FROM platform_observation_archive_ref WHERE archive_id=NEW.archive_id) OR EXISTS (SELECT 1 FROM platform_version_archive_ref WHERE archive_id=NEW.archive_id) BEGIN SELECT RAISE(ABORT, 'sealed or duplicate archive binding'); END;
--> statement-breakpoint
CREATE TRIGGER platform_legacy_query_alias_no_update BEFORE UPDATE ON platform_legacy_query_alias BEGIN SELECT RAISE(ABORT, 'immutable alias'); END;
--> statement-breakpoint
CREATE TRIGGER platform_legacy_query_alias_no_delete BEFORE DELETE ON platform_legacy_query_alias BEGIN SELECT RAISE(ABORT, 'immutable alias'); END;
--> statement-breakpoint
CREATE TRIGGER platform_legacy_query_alias_no_replace BEFORE INSERT ON platform_legacy_query_alias WHEN EXISTS (SELECT 1 FROM platform_legacy_query_alias WHERE old_id=NEW.old_id OR collection_id=NEW.collection_id) BEGIN SELECT RAISE(ABORT, 'immutable alias collision'); END;
--> statement-breakpoint
CREATE TRIGGER platform_legacy_relation_alias_no_update BEFORE UPDATE ON platform_legacy_relation_alias BEGIN SELECT RAISE(ABORT, 'immutable alias'); END;
--> statement-breakpoint
CREATE TRIGGER platform_legacy_relation_alias_no_delete BEFORE DELETE ON platform_legacy_relation_alias BEGIN SELECT RAISE(ABORT, 'immutable alias'); END;
--> statement-breakpoint
CREATE TRIGGER platform_legacy_relation_alias_no_replace BEFORE INSERT ON platform_legacy_relation_alias WHEN EXISTS (SELECT 1 FROM platform_legacy_relation_alias WHERE old_id=NEW.old_id OR observation_id=NEW.observation_id) BEGIN SELECT RAISE(ABORT, 'immutable alias collision'); END;
--> statement-breakpoint
CREATE TRIGGER platform_legacy_relation_alias_owner BEFORE INSERT ON platform_legacy_relation_alias WHEN NOT EXISTS (SELECT 1 FROM platform_business_observation o JOIN platform_relation r ON r.id=o.relation_id JOIN platform_legacy_query_alias q ON q.old_id=r.query_id WHERE o.relation_id=NEW.observation_id) BEGIN SELECT RAISE(ABORT, 'unmapped transitional observation collection'); END;
--> statement-breakpoint
CREATE TRIGGER platform_alias_sequence_no_delete BEFORE DELETE ON platform_legacy_alias_sequence BEGIN SELECT RAISE(ABORT, 'immutable sequence'); END;
--> statement-breakpoint
CREATE TRIGGER platform_alias_sequence_monotone BEFORE UPDATE ON platform_legacy_alias_sequence WHEN NEW.namespace != OLD.namespace OR NEW.high_water < OLD.high_water BEGIN SELECT RAISE(ABORT, 'sequence cannot rewind'); END;
--> statement-breakpoint
CREATE TRIGGER platform_alias_sequence_no_replace BEFORE INSERT ON platform_legacy_alias_sequence WHEN EXISTS (SELECT 1 FROM platform_legacy_alias_sequence WHERE namespace=NEW.namespace) BEGIN SELECT RAISE(ABORT, 'sequence already initialized'); END;
