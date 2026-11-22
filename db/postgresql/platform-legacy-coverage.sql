CREATE OR REPLACE FUNCTION pg_temp.platform_coverage_document(payload bytea, archive_kind text)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  cursor_pos integer := octet_length(convert_to('T04-PROVENANCE' || chr(10), 'UTF8')) + 1;
  cell_name text;
  header_length integer;
  header text[];
  value_length integer;
  document text;
BEGIN
  IF payload IS NULL THEN RETURN NULL; END IF;
  IF archive_kind = 't04_envelope' THEN
    IF substring(payload FOR cursor_pos - 1) <> convert_to('T04-PROVENANCE' || chr(10), 'UTF8') THEN
      RAISE EXCEPTION 'Invalid offline platform envelope prefix';
    END IF;
    FOREACH cell_name IN ARRAY ARRAY['query_id','source_identity','source_sha256','segment_index','collection'] LOOP
      header_length := position(decode('0a','hex') IN substring(payload FROM cursor_pos FOR 128));
      IF header_length = 0 THEN RAISE EXCEPTION 'Missing offline platform envelope header'; END IF;
      header := regexp_match(convert_from(substring(payload FROM cursor_pos FOR header_length - 1), 'UTF8'),
        '^([a-z0-9_]+) (null|text|blob|integer|real) ([0-9]+)$');
      IF header IS NULL OR header[1] <> cell_name THEN
        RAISE EXCEPTION 'Invalid offline platform envelope cell %', cell_name;
      END IF;
      value_length := header[3]::integer;
      cursor_pos := cursor_pos + header_length;
      IF substring(payload FROM cursor_pos + value_length FOR 1) <> decode('0a','hex') THEN
        RAISE EXCEPTION 'Truncated offline platform envelope cell %', cell_name;
      END IF;
      IF cell_name = 'collection' THEN
        IF header[2] = 'null' THEN RETURN NULL; END IF;
        document := convert_from(substring(payload FROM cursor_pos FOR value_length), 'UTF8');
      END IF;
      cursor_pos := cursor_pos + value_length + 1;
    END LOOP;
  ELSE
    document := convert_from(payload, 'UTF8');
  END IF;
  IF pg_input_is_valid(document,'jsonb') THEN
    RETURN document::jsonb - ARRAY['rows','dataRows','rawData'];
  END IF;
  RETURN NULL;
END;
$$;

WITH supplemental AS MATERIALIZED (
  SELECT provenance.collection_id, pg_temp.platform_coverage_document(archive.bytes,provenance.origin) AS evidence
  FROM platform_collection_legacy_provenance provenance
  JOIN platform_archive_value archive ON archive.id=provenance.archive_id
)
UPDATE platform_collection c SET source_coverage=supplemental.evidence
FROM supplemental WHERE c.id=supplemental.collection_id AND c.source_coverage IS NULL
  AND jsonb_typeof(supplemental.evidence)='object';
