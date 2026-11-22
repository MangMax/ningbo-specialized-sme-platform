LOCK TABLE platform_archive_value IN ACCESS EXCLUSIVE MODE;
ALTER TABLE platform_archive_value DISABLE TRIGGER platform_archive_append_only;

-- Resolve the owner, both sealed references, and retained SHA pins before reading any TOAST bytes.
CREATE TEMP TABLE compact_platform_snapshot ON COMMIT DROP AS
WITH eligible AS MATERIALIZED (
  SELECT s.archive_id AS snapshot_id, r.archive_id AS raw_id
  FROM platform_observation_archive_ref s
  JOIN platform_observation_archive_ref r ON r.owner_id = s.owner_id AND r.field = 'rawFields' AND r.sealed = 1
  WHERE s.field = 'legacyRowSnapshot' AND s.sealed = 1
    AND NOT EXISTS (
      SELECT 1 FROM platform_recognized_projection p WHERE p.exact_title_archive_id = s.archive_id
    )
)
SELECT e.snapshot_id AS id, packed.bytes, length(packed.bytes) AS byte_length,
  encode(pg_catalog.sha256(packed.bytes), 'hex') AS sha256
FROM eligible e
JOIN platform_archive_value saved ON saved.id = e.snapshot_id AND saved.storage_class = 'blob'
JOIN platform_archive_value raw ON raw.id = e.raw_id AND raw.storage_class IN ('text','blob') AND raw.byte_length > 5
CROSS JOIN LATERAL (
  SELECT convert_to('{"name":"raw_fields","storageClass":"' || raw.storage_class || '","hex":"', 'UTF8') AS prefix,
    encode(raw.bytes, 'hex') AS hex
  OFFSET 0
) source
CROSS JOIN LATERAL (
  SELECT source.prefix || convert_to(upper(source.hex) || '"}', 'UTF8') AS upper_cell,
    source.prefix || convert_to(source.hex || '"}', 'UTF8') AS lower_cell
  OFFSET 0
) cells
CROSS JOIN LATERAL (
  SELECT position(cells.upper_cell IN saved.bytes) AS upper_start
  OFFSET 0
) first_match
CROSS JOIN LATERAL (
  SELECT CASE WHEN first_match.upper_start > 0 THEN first_match.upper_start ELSE position(cells.lower_cell IN saved.bytes) END AS start_at,
    CASE WHEN first_match.upper_start > 0 THEN cells.upper_cell ELSE cells.lower_cell END AS inline_cell,
    source.prefix || convert_to(CASE WHEN first_match.upper_start > 0 THEN '@raw-upper"}' ELSE '@raw-lower"}' END, 'UTF8') AS marker
  OFFSET 0
) matched
CROSS JOIN LATERAL (
  SELECT CASE WHEN matched.start_at > 0 THEN overlay(saved.bytes PLACING matched.marker
    FROM matched.start_at FOR length(matched.inline_cell)) END AS bytes
  OFFSET 0
) packed
WHERE packed.bytes IS NOT NULL
  AND position(convert_to('"hex":"@raw-', 'UTF8') IN saved.bytes) = 0
  AND overlay(packed.bytes PLACING matched.inline_cell FROM matched.start_at FOR length(matched.marker)) = saved.bytes;

-- Collect real cardinality before choosing the UPDATE join. No archive lookup or decoding runs in the update.
ALTER TABLE compact_platform_snapshot ADD PRIMARY KEY (id);
ANALYZE compact_platform_snapshot;

UPDATE platform_archive_value a
SET bytes = c.bytes, byte_length = c.byte_length, sha256 = c.sha256
FROM compact_platform_snapshot c
WHERE c.id = a.id;

ALTER TABLE platform_archive_value ENABLE TRIGGER platform_archive_append_only;
