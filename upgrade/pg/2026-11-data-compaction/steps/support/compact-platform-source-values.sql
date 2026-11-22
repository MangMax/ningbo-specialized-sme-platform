ALTER TABLE platform_business_observation
  ADD COLUMN IF NOT EXISTS source_values jsonb,
  ADD COLUMN IF NOT EXISTS source_created_at text;

CREATE FUNCTION pg_temp.compact_source_cell(bytes bytea, storage text) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  bits bit(64);
  exponent integer;
  fraction bigint;
BEGIN
  IF bytes IS NULL THEN RETURN 'null'::jsonb; END IF;
  CASE storage
    WHEN 'text' THEN
      IF position(decode('00','hex') IN bytes) = 0 THEN
        RETURN to_jsonb(convert_from(bytes, 'UTF8'));
      END IF;
      RETURN jsonb_build_object('base64', replace(encode(bytes, 'base64'), chr(10), ''), 'storage', 'text');
    WHEN 'blob' THEN
      RETURN jsonb_build_object('base64', replace(encode(bytes, 'base64'), chr(10), ''));
    WHEN 'integer' THEN
      RETURN to_jsonb(('x' || encode(bytes, 'hex'))::bit(64)::bigint);
    WHEN 'real' THEN
      bits := ('x' || encode(bytes, 'hex'))::bit(64);
      exponent := substring(bits, 2, 11)::integer;
      fraction := substring(bits, 13, 52)::bigint;
      IF exponent = 2047 THEN RAISE EXCEPTION 'Non-finite observation source cell'; END IF;
      RETURN to_jsonb((CASE WHEN get_bit(bits, 0) = 1 THEN -1 ELSE 1 END)
        * ((fraction::float8 / 4503599627370496::float8) + CASE WHEN exponent = 0 THEN 0 ELSE 1 END)
        * power(2::float8, greatest(exponent, 1) - 1023));
    ELSE RAISE EXCEPTION 'Unexpected observation source cell type: %', storage;
  END CASE;
END $$;

WITH values_by_observation AS (
  SELECT o.id, o.relation_facts->>'createdAt' AS created_at,
    CASE c.interface
      WHEN 'apply_list' THEN a.exact_stored_state = 'captured' AND a.sql_fact_title_state = 'captured'
      WHEN 'business_list' THEN b.exact_stored_state = 'captured' AND b.sql_fact_title_state = 'captured'
        AND b.exact_stored_rule = 'process-stored-cells-v1' AND b.sql_fact_title_rule = 'process-legacy-sql-fact-title-v1'
      WHEN 'recognized_list' THEN r.exact_title_state = 'captured'
    END AS captured,
    CASE c.interface
      WHEN 'apply_list' THEN jsonb_build_object(
        'titleRaw', pg_temp.compact_source_cell(a.exact_title_raw, a.exact_title_raw_sqlite_storage),
        'status', pg_temp.compact_source_cell(a.exact_status, a.exact_status_sqlite_storage),
        'declareKind', pg_temp.compact_source_cell(a.exact_declare_kind, a.exact_declare_kind_sqlite_storage),
        'appliedAt', pg_temp.compact_source_cell(a.exact_applied_at, a.exact_applied_at_sqlite_storage),
        'year', pg_temp.compact_source_cell(a.exact_year, a.exact_year_sqlite_storage),
        'batch', a.stored_batch, 'awardBatchLabel', a.stored_award_batch_label, 'province', a.stored_province)
      WHEN 'business_list' THEN jsonb_build_object(
        'titleRaw', pg_temp.compact_source_cell(b.exact_title_raw, b.exact_title_raw_sqlite_storage),
        'status', pg_temp.compact_source_cell(b.exact_status, b.exact_status_sqlite_storage),
        'declareKind', pg_temp.compact_source_cell(b.exact_declare_kind, b.exact_declare_kind_sqlite_storage),
        'appliedAt', pg_temp.compact_source_cell(b.exact_applied_at, b.exact_applied_at_sqlite_storage),
        'year', pg_temp.compact_source_cell(b.exact_year, b.exact_year_sqlite_storage),
        'batch', pg_temp.compact_source_cell(b.exact_batch, b.exact_batch_sqlite_storage),
        'awardBatchLabel', pg_temp.compact_source_cell(b.exact_award_batch_label, b.exact_award_batch_label_sqlite_storage),
        'province', pg_temp.compact_source_cell(b.exact_province, b.exact_province_sqlite_storage))
      WHEN 'recognized_list' THEN jsonb_build_object(
        'titleRaw', pg_temp.compact_source_cell(r.exact_title_raw, r.exact_title_raw_sqlite_storage),
        'status', r.stored_status, 'year', r.stored_year, 'batch', r.stored_batch,
        'declareKind', r.stored_declare_kind, 'appliedAt', r.stored_applied_at,
        'awardBatchLabel', r.stored_award_batch_label, 'province', r.stored_province)
    END AS observed,
    jsonb_strip_nulls(CASE c.interface
      WHEN 'apply_list' THEN jsonb_build_object('titleRaw', av.title_raw, 'status', av.status,
        'declareKind', av.declare_kind, 'appliedAt', av.applied_at, 'year', av.declaration_year)
      WHEN 'business_list' THEN jsonb_build_object('titleRaw', bv.title_raw, 'status', bv.status,
        'declareKind', bv.declare_kind, 'appliedAt', bv.applied_at, 'year', bv.business_year,
        'batch', bv.batch, 'awardBatchLabel', bv.award_batch_label, 'province', bv.province)
      WHEN 'recognized_list' THEN jsonb_build_object('titleRaw', rv.title_raw)
    END) AS inherited
  FROM platform_business_observation o
  JOIN platform_collection c ON c.id = o.collection_id
  LEFT JOIN platform_apply_projection a ON a.observation_id = o.id
  LEFT JOIN platform_business_projection b ON b.observation_id = o.id
  LEFT JOIN platform_recognized_projection r ON r.observation_id = o.id
  LEFT JOIN platform_apply_projection av ON av.version_id = o.version_id
  LEFT JOIN platform_business_projection bv ON bv.version_id = o.version_id
  LEFT JOIN platform_recognized_projection rv ON rv.version_id = o.version_id
)
UPDATE platform_business_observation o
SET source_values = CASE WHEN f.captured THEN COALESCE((
  SELECT jsonb_object_agg(cell.key, cell.value)
  FROM jsonb_each(f.observed) cell
  WHERE cell.value IS DISTINCT FROM COALESCE(f.inherited->cell.key, 'null'::jsonb)
), '{}'::jsonb) END,
source_created_at = f.created_at
FROM values_by_observation f WHERE f.id = o.id AND o.source_values IS NULL;
