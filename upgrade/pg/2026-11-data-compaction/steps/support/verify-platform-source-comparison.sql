CREATE FUNCTION pg_temp.compact_comparison_value(cell jsonb, field text, interface text, parsed boolean)
RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT coalesce(CASE
    WHEN field = 'year' AND NOT parsed AND jsonb_typeof(cell) = 'number'
      AND (cell #>> '{}')::numeric = trunc((cell #>> '{}')::numeric) THEN cell
    WHEN field = 'year' AND parsed AND jsonb_typeof(cell) IN ('number', 'string') AND pg_input_is_valid(value, 'numeric')
      THEN CASE WHEN value::numeric BETWEEN 1 AND 9007199254740991
        AND value::numeric = trunc(value::numeric) THEN to_jsonb(value::numeric) END
    WHEN field = 'status' AND NOT parsed AND interface = 'business_list' AND jsonb_typeof(cell) = 'object' THEN cell
    WHEN field <> 'year' AND jsonb_typeof(cell) = 'string' THEN to_jsonb(CASE
      WHEN field = 'declareKind' AND interface <> 'recognized_list' THEN CASE value
        WHEN '申请' THEN 'apply' WHEN '更新' THEN 'update' WHEN '复核' THEN 'review' ELSE value END
      ELSE value END)
  END, 'null'::jsonb)
  FROM (VALUES (nullif(btrim(cell #>> '{}', U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF'), ''))) AS trimmed(value)
$$;

CREATE TEMP TABLE platform_source_comparison_gaps ON COMMIT DROP AS
WITH capture AS MATERIALIZED (
  SELECT o.id, o.source_values, c.interface, coalesce(v.business_fields, o.business_fields) AS business_fields,
    CASE c.interface
      WHEN 'apply_list' THEN to_jsonb(a)
      WHEN 'business_list' THEN to_jsonb(b) || jsonb_build_object(
        'stored_status', pg_temp.compact_source_cell(b.stored_status, b.stored_status_sqlite_storage))
      WHEN 'recognized_list' THEN to_jsonb(r)
    END AS projection,
    CASE c.interface
      WHEN 'apply_list' THEN jsonb_build_object('titleRaw', av.title_raw, 'status', av.status,
        'declareKind', av.declare_kind, 'appliedAt', av.applied_at, 'year', av.declaration_year)
      WHEN 'business_list' THEN jsonb_build_object('titleRaw', bv.title_raw, 'status', bv.status,
        'declareKind', bv.declare_kind, 'appliedAt', bv.applied_at, 'year', bv.business_year,
        'batch', bv.batch, 'awardBatchLabel', bv.award_batch_label, 'province', bv.province)
      WHEN 'recognized_list' THEN jsonb_build_object('titleRaw', rv.title_raw)
    END AS inherited
  FROM platform_business_observation o
  JOIN platform_collection c ON c.id = o.collection_id
  LEFT JOIN platform_business_record_version v ON v.id = o.version_id
  LEFT JOIN platform_apply_projection a ON a.observation_id = o.id
  LEFT JOIN platform_business_projection b ON b.observation_id = o.id
  LEFT JOIN platform_recognized_projection r ON r.observation_id = o.id
  LEFT JOIN platform_apply_projection av ON av.version_id = o.version_id
  LEFT JOIN platform_business_projection bv ON bv.version_id = o.version_id
  LEFT JOIN platform_recognized_projection rv ON rv.version_id = o.version_id
), operands AS (
  SELECT cap.*, comparison.stored, comparison.parsed,
    CASE cap.projection->>'source_title_kind'
      WHEN 'text' THEN cap.projection->'source_title_text'
      WHEN 'number' THEN to_jsonb((cap.projection->>'source_title_number_text')::double precision)
      ELSE 'null'::jsonb
    END AS source_title,
    CASE WHEN jsonb_typeof(cap.business_fields->'rdjb') IN ('string', 'number') THEN cap.business_fields->'rdjb'
      ELSE 'null'::jsonb END AS business_title,
    coalesce(cap.source_values->'titleRaw', cap.inherited->'titleRaw', 'null'::jsonb) AS exact_title
  FROM capture cap
  CROSS JOIN LATERAL (
    SELECT
      bool_or(actual.stored IS DISTINCT FROM baseline.stored) AS stored,
      bool_or(actual.parsed IS DISTINCT FROM baseline.parsed) AS parsed
    FROM (VALUES
      ('province', 'province', 'szsfmc'), ('status', 'status', 'cszt'), ('batch', 'batch', 'whpc'),
      ('declareKind', 'declare_kind', 'sblx'), ('appliedAt', 'applied_at', 'sqsj'),
      ('awardBatchLabel', 'award_batch_label', 'personuuid'), ('year', 'year', 'year')
    ) AS field(key, column_name, raw_name)
    CROSS JOIN LATERAL (SELECT
      coalesce(cap.projection->('stored_' || field.column_name), 'null'::jsonb) AS stored,
      coalesce(cap.projection->('parsed_' || field.column_name), 'null'::jsonb) AS parsed
    ) actual
    CROSS JOIN LATERAL (SELECT
      pg_temp.compact_comparison_value(CASE WHEN cap.source_values IS NOT NULL
        THEN coalesce(cap.source_values->field.key, cap.inherited->field.key) END, field.key, cap.interface, false) AS stored,
      pg_temp.compact_comparison_value(CASE WHEN cap.interface <> 'recognized_list'
        THEN cap.business_fields->field.raw_name END, field.key, cap.interface, true) AS parsed
    ) baseline
  ) comparison
  WHERE cap.projection IS NOT NULL
)
SELECT id FROM operands
WHERE stored OR parsed
  OR source_title IS DISTINCT FROM business_title
  OR (interface <> 'recognized_list' AND projection->'sql_fact_title' IS DISTINCT FROM
    CASE WHEN jsonb_typeof(exact_title) = 'string' THEN exact_title ELSE 'null'::jsonb END);

DO $$
DECLARE gaps bigint;
BEGIN
  SELECT count(*) INTO gaps FROM platform_source_comparison_gaps;
  IF gaps > 0 THEN
    RAISE EXCEPTION 'Cannot derive platform comparison facts for % stored observations', gaps;
  END IF;
END;
$$;
