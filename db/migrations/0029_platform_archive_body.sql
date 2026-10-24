-- #278: additive only. No legacy columns, values, guards or business readers change.
CREATE TABLE platform_body_leaf (
  id INTEGER PRIMARY KEY,
  digest TEXT NOT NULL UNIQUE,
  byte_length INTEGER NOT NULL CHECK(typeof(byte_length) = 'integer' AND byte_length >= 0),
  encoding TEXT NOT NULL DEFAULT 'utf8-v1' CHECK(encoding = 'utf8-v1'),
  bytes BLOB NOT NULL CHECK(typeof(bytes) = 'blob' AND length(bytes) = byte_length)
);
--> statement-breakpoint
CREATE TABLE platform_body_root (
  id INTEGER PRIMARY KEY,
  digest TEXT NOT NULL UNIQUE,
  byte_length INTEGER NOT NULL CHECK(typeof(byte_length) = 'integer' AND byte_length >= 0),
  encoding TEXT NOT NULL DEFAULT 'utf8-v1' CHECK(encoding = 'utf8-v1'),
  sealed INTEGER NOT NULL DEFAULT 0 CHECK(sealed IN (0,1))
);
--> statement-breakpoint
CREATE TABLE platform_body_part (
  root_id INTEGER NOT NULL REFERENCES platform_body_root(id) ON DELETE RESTRICT,
  logical_start INTEGER NOT NULL CHECK(typeof(logical_start) = 'integer' AND logical_start >= 0),
  leaf_id INTEGER NOT NULL REFERENCES platform_body_leaf(id) ON DELETE RESTRICT,
  byte_length INTEGER NOT NULL CHECK(typeof(byte_length) = 'integer' AND byte_length >= 0),
  PRIMARY KEY(root_id, logical_start)
);
--> statement-breakpoint
CREATE TRIGGER platform_body_leaf_no_update BEFORE UPDATE ON platform_body_leaf BEGIN SELECT RAISE(ABORT, 'platform_body_immutable'); END;
--> statement-breakpoint
CREATE TRIGGER platform_body_leaf_no_delete BEFORE DELETE ON platform_body_leaf BEGIN SELECT RAISE(ABORT, 'platform_body_immutable'); END;
--> statement-breakpoint
CREATE TRIGGER platform_body_root_no_delete BEFORE DELETE ON platform_body_root BEGIN SELECT RAISE(ABORT, 'platform_body_immutable'); END;
--> statement-breakpoint
CREATE TRIGGER platform_body_root_insert BEFORE INSERT ON platform_body_root WHEN NEW.sealed <> 0 BEGIN SELECT RAISE(ABORT, 'platform_body_unsealed_required'); END;
--> statement-breakpoint
CREATE TRIGGER platform_body_part_insert BEFORE INSERT ON platform_body_part BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM platform_body_root r JOIN platform_body_leaf l ON l.id = NEW.leaf_id
    WHERE r.id = NEW.root_id AND r.sealed = 0 AND (SELECT count(*) FROM platform_body_part WHERE root_id = r.id) < 64 AND l.byte_length = NEW.byte_length
      AND NEW.logical_start = COALESCE((SELECT max(logical_start + byte_length) FROM platform_body_part WHERE root_id = r.id), 0)
      AND NEW.logical_start + NEW.byte_length <= r.byte_length
      AND (NEW.byte_length > 0 OR (r.byte_length = 0 AND NEW.logical_start = 0))
  ) THEN RAISE(ABORT, 'platform_body_invalid_part') END;
END;
--> statement-breakpoint
CREATE TRIGGER platform_body_part_no_update BEFORE UPDATE ON platform_body_part BEGIN SELECT RAISE(ABORT, 'platform_body_immutable'); END;
--> statement-breakpoint
CREATE TRIGGER platform_body_part_no_delete BEFORE DELETE ON platform_body_part BEGIN SELECT RAISE(ABORT, 'platform_body_immutable'); END;
--> statement-breakpoint
CREATE TRIGGER platform_body_root_seal BEFORE UPDATE ON platform_body_root BEGIN
  SELECT CASE WHEN OLD.sealed <> 0 OR NEW.sealed <> 1 OR NEW.id <> OLD.id OR NEW.digest <> OLD.digest
    OR NEW.byte_length <> OLD.byte_length OR NEW.encoding <> OLD.encoding
    OR NOT EXISTS (SELECT 1 FROM platform_body_part WHERE root_id = OLD.id)
    OR NEW.byte_length <> (SELECT sum(byte_length) FROM platform_body_part WHERE root_id = OLD.id)
  THEN RAISE(ABORT, 'platform_body_invalid_seal') END;
END;
--> statement-breakpoint
CREATE TABLE platform_relation_body_ref (
  owner_id INTEGER NOT NULL REFERENCES platform_relation(id) ON DELETE RESTRICT,
  field TEXT NOT NULL CHECK(field IN ('rawFields','sourceText')),
  root_id INTEGER NOT NULL REFERENCES platform_body_root(id) ON DELETE RESTRICT,
  PRIMARY KEY(owner_id, field)
);
--> statement-breakpoint
CREATE TABLE platform_query_body_ref (
  owner_id INTEGER NOT NULL REFERENCES platform_query(id) ON DELETE RESTRICT,
  field TEXT NOT NULL CHECK(field IN ('rawResponse','collectionEvidence')),
  root_id INTEGER NOT NULL REFERENCES platform_body_root(id) ON DELETE RESTRICT,
  PRIMARY KEY(owner_id, field)
);
--> statement-breakpoint
CREATE TABLE platform_version_body_ref (
  owner_id INTEGER NOT NULL REFERENCES platform_business_record_version(id) ON DELETE RESTRICT,
  field TEXT NOT NULL CHECK(field = 'canonicalRawJson'),
  root_id INTEGER NOT NULL REFERENCES platform_body_root(id) ON DELETE RESTRICT,
  PRIMARY KEY(owner_id, field)
);
--> statement-breakpoint
CREATE TRIGGER platform_relation_body_ref_insert BEFORE INSERT ON platform_relation_body_ref WHEN NOT EXISTS (SELECT 1 FROM platform_body_root WHERE id = NEW.root_id AND sealed = 1) BEGIN SELECT RAISE(ABORT, 'platform_body_bad_reference'); END;
--> statement-breakpoint
CREATE TRIGGER platform_relation_body_ref_update BEFORE UPDATE ON platform_relation_body_ref WHEN NOT EXISTS (SELECT 1 FROM platform_body_root WHERE id = NEW.root_id AND sealed = 1) BEGIN SELECT RAISE(ABORT, 'platform_body_bad_reference'); END;
--> statement-breakpoint
CREATE TRIGGER platform_query_body_ref_insert BEFORE INSERT ON platform_query_body_ref WHEN NOT EXISTS (SELECT 1 FROM platform_body_root WHERE id = NEW.root_id AND sealed = 1) BEGIN SELECT RAISE(ABORT, 'platform_body_bad_reference'); END;
--> statement-breakpoint
CREATE TRIGGER platform_query_body_ref_update BEFORE UPDATE ON platform_query_body_ref WHEN NOT EXISTS (SELECT 1 FROM platform_body_root WHERE id = NEW.root_id AND sealed = 1) BEGIN SELECT RAISE(ABORT, 'platform_body_bad_reference'); END;
--> statement-breakpoint
CREATE TRIGGER platform_version_body_ref_insert BEFORE INSERT ON platform_version_body_ref WHEN NOT EXISTS (SELECT 1 FROM platform_body_root WHERE id = NEW.root_id AND sealed = 1) BEGIN SELECT RAISE(ABORT, 'platform_body_bad_reference'); END;
--> statement-breakpoint
CREATE TRIGGER platform_version_body_ref_update BEFORE UPDATE ON platform_version_body_ref WHEN NOT EXISTS (SELECT 1 FROM platform_body_root WHERE id = NEW.root_id AND sealed = 1) BEGIN SELECT RAISE(ABORT, 'platform_body_bad_reference'); END;
