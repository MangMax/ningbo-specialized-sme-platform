CREATE OR REPLACE FUNCTION pg_temp.platform_batch_business_rows(source_rows json)
RETURNS json
LANGUAGE sql
AS $$
  SELECT COALESCE(json_agg(
    CASE WHEN json_typeof(row_value) = 'object' THEN (
      SELECT ('{' || COALESCE(string_agg(
        -- json_each decodes the protected keys. Restore their original escape
        -- semantics separately from values, which retained their source spelling.
        replace(to_json(key)::text, $esc$\\u$esc$, $esc$\u$esc$) || ':' ||
          replace(value::text, $esc$\u005cu$esc$, $esc$\u$esc$), ',' ORDER BY field_ordinal
      ), '') || '}')::json
      FROM json_each(row_value) WITH ORDINALITY AS cells(key, value, field_ordinal)
      WHERE value::text NOT IN ('null', '""') AND lower(key) NOT IN (
        'rawfields', 'rawdata', 'rawresponse', 'rawrequest', 'rawbody',
        'sourcetext', 'requestbody', 'responsebody', 'rawhtml', 'rawjson', '__proto__'
      )
    ) ELSE replace(row_value::text, $esc$\u005cu$esc$, $esc$\u$esc$)::json END
    ORDER BY row_ordinal
  ), '[]'::json)
  FROM json_array_elements(source_rows) WITH ORDINALITY AS source(row_value, row_ordinal)
$$;

-- Compare the legacy projection to typed business rows before discarding it.
-- A discrepant historical projection is retained with its types still unknown.
CREATE OR REPLACE FUNCTION pg_temp.platform_batch_rows_match(legacy_rows json, typed_rows json)
RETURNS boolean
LANGUAGE sql
AS $$
  SELECT json_array_length(legacy_rows) = json_array_length(typed_rows) AND NOT EXISTS (
    SELECT
    FROM json_array_elements(replace(legacy_rows::text, $esc$\u$esc$, $esc$\u005cu$esc$)::json)
      WITH ORDINALITY AS legacy(row_value, ordinal)
    JOIN json_array_elements(replace(typed_rows::text, $esc$\u$esc$, $esc$\u005cu$esc$)::json)
      WITH ORDINALITY AS typed(row_value, ordinal) USING (ordinal)
    WHERE CASE
      WHEN json_typeof(legacy.row_value) <> 'object' OR json_typeof(typed.row_value) <> 'object' THEN true
      ELSE
        (SELECT coalesce(jsonb_object_agg(key, value), '{}'::jsonb) FROM json_each_text(legacy.row_value)) <>
        (SELECT coalesce(jsonb_object_agg(key, value), '{}'::jsonb) FROM json_each_text(typed.row_value))
    END
  )
$$;

DO $$
DECLARE
  previous record;
  snapshot json;
  typed_rows json;
  legacy_rows json;
  business_payload text;
BEGIN
  FOR previous IN
    SELECT job_id, item_id, segment_index, payload
    FROM business.platform_batch_segment
  LOOP
    -- Protect Unicode escapes before using PostgreSQL JSON traversal, which
    -- otherwise rejects escaped NUL and lone surrogates in legacy text.
    snapshot := replace(previous.payload, $esc$\u$esc$, $esc$\u005cu$esc$)::json;
    typed_rows := snapshot -> 'dataRows';
    IF json_typeof(typed_rows) IS DISTINCT FROM 'array' THEN
      typed_rows := snapshot -> 'rawData' -> 'rows';
    END IF;
    IF json_typeof(typed_rows) = 'array' THEN
      typed_rows := pg_temp.platform_batch_business_rows(typed_rows);
    ELSE
      typed_rows := NULL;
    END IF;
    legacy_rows := CASE WHEN json_typeof(snapshot -> 'rows') = 'array'
      THEN pg_temp.platform_batch_business_rows(snapshot -> 'rows') END;
    IF typed_rows IS NOT NULL AND legacy_rows IS NOT NULL
      AND pg_temp.platform_batch_rows_match(legacy_rows, typed_rows) THEN
      legacy_rows := NULL;
    END IF;

    SELECT json_object_agg(key, value ORDER BY ordinal, key)::text
    INTO business_payload
    FROM (
      SELECT field.key, replace(field.value::text, $esc$\u005cu$esc$, $esc$\u$esc$)::json AS value, field.ordinal
      FROM json_each(snapshot) WITH ORDINALITY AS field(key, value, ordinal)
      WHERE field.key IN (
        'source', 'status', 'effectiveConditions', 'titleScope', 'queriedAt', 'completedAt',
        'pages', 'fetchedCount', 'declaredTotal', 'completeness', 'fullRange',
        'unfinished', 'error', 'limits'
      )
      UNION ALL
      SELECT 'dataRows', typed_rows, 0 WHERE typed_rows IS NOT NULL
      UNION ALL
      SELECT 'rows', legacy_rows, 0 WHERE legacy_rows IS NOT NULL
    ) AS fields;

    IF business_payload IS DISTINCT FROM previous.payload THEN
      UPDATE business.platform_batch_segment
      SET payload = business_payload
      WHERE job_id = previous.job_id AND item_id = previous.item_id AND segment_index = previous.segment_index
        AND payload = previous.payload;
    END IF;
  END LOOP;
END
$$;
