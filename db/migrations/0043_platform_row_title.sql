-- Row-owned rdjb only. Never change source JSON, content hashes or projection rules.
-- Explicit ECMAScript trim characters keep SQL backfill identical to JS String.trim().
ALTER TABLE platform_apply_projection ADD COLUMN title_raw TEXT;
--> statement-breakpoint
ALTER TABLE platform_business_projection ADD COLUMN title_raw TEXT;
--> statement-breakpoint
ALTER TABLE platform_relation ADD COLUMN title_raw TEXT;
--> statement-breakpoint
UPDATE platform_apply_projection SET title_raw = (
  SELECT CASE WHEN json_valid(v.canonical_raw_json) THEN CASE WHEN json_type(v.canonical_raw_json) = 'object' AND json_type(v.canonical_raw_json, '$.rdjb') = 'text' THEN nullif(trim(json_extract(v.canonical_raw_json, '$.rdjb'), char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279)), '') END END
  FROM platform_business_record_version v WHERE v.id = version_id
);
--> statement-breakpoint
UPDATE platform_business_projection SET title_raw = (
  SELECT CASE WHEN json_valid(v.canonical_raw_json) THEN CASE WHEN json_type(v.canonical_raw_json) = 'object' AND json_type(v.canonical_raw_json, '$.rdjb') = 'text' THEN nullif(trim(json_extract(v.canonical_raw_json, '$.rdjb'), char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279)), '') END END
  FROM platform_business_record_version v WHERE v.id = version_id
);
--> statement-breakpoint
UPDATE platform_relation SET title_raw = CASE WHEN json_valid(raw_fields) THEN CASE WHEN json_type(raw_fields) = 'object' AND json_type(raw_fields, '$.rdjb') = 'text' THEN nullif(trim(json_extract(raw_fields, '$.rdjb'), char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279)), '') END END;
--> statement-breakpoint
CREATE TRIGGER platform_relation_title_insert
AFTER INSERT ON platform_relation
BEGIN
  UPDATE platform_relation SET title_raw = CASE WHEN json_valid(NEW.raw_fields) THEN CASE WHEN json_type(NEW.raw_fields) = 'object' AND json_type(NEW.raw_fields, '$.rdjb') = 'text' THEN nullif(trim(json_extract(NEW.raw_fields, '$.rdjb'), char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279)), '') END END WHERE id = NEW.id;
END;
--> statement-breakpoint
CREATE TRIGGER platform_relation_title_raw_update
AFTER UPDATE OF raw_fields ON platform_relation
BEGIN
  UPDATE platform_relation SET title_raw = CASE WHEN json_valid(NEW.raw_fields) THEN CASE WHEN json_type(NEW.raw_fields) = 'object' AND json_type(NEW.raw_fields, '$.rdjb') = 'text' THEN nullif(trim(json_extract(NEW.raw_fields, '$.rdjb'), char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279)), '') END END WHERE id = NEW.id;
END;
--> statement-breakpoint
CREATE INDEX platform_apply_projection_title_version_idx ON platform_apply_projection(title_raw, version_id);
--> statement-breakpoint
CREATE INDEX platform_business_projection_title_version_idx ON platform_business_projection(title_raw, version_id);
--> statement-breakpoint
CREATE INDEX platform_recognized_projection_title_version_idx ON platform_recognized_projection(title_raw, version_id);
--> statement-breakpoint
CREATE INDEX platform_relation_title_query_idx ON platform_relation(title_raw, query_id);
