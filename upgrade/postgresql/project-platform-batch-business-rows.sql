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
      WHERE lower(key) NOT IN (
        'rawfields', 'rawdata', 'rawresponse', 'rawrequest', 'rawbody',
        'sourcetext', 'requestbody', 'responsebody', 'rawhtml', 'rawjson', '__proto__'
      )
    ) ELSE replace(row_value::text, $esc$\u005cu$esc$, $esc$\u$esc$)::json END
    ORDER BY row_ordinal
  ), '[]'::json)
  FROM json_array_elements(source_rows) WITH ORDINALITY AS source(row_value, row_ordinal)
$$;

DO $$
DECLARE
  previous record;
  snapshot json;
  typed_rows json;
  business_payload text;
BEGIN
  FOR previous IN
    SELECT job_id, item_id, segment_index, payload
    FROM business.platform_batch_segment
    WHERE payload ~* '"(rawFields|rawData|rawResponse|rawRequest|rawBody|sourceText|requestBody|responseBody|rawHtml|rawJson|__proto__)"[[:space:]]*:'
  LOOP
    -- Protect Unicode escapes before using PostgreSQL JSON traversal, which
    -- otherwise rejects escaped NUL and lone surrogates in legacy text.
    snapshot := replace(previous.payload, $esc$\u$esc$, $esc$\u005cu$esc$)::json;
    typed_rows := snapshot -> 'dataRows';
    IF json_typeof(typed_rows) IS DISTINCT FROM 'array' THEN
      typed_rows := snapshot -> 'rawData' -> 'rows';
    END IF;

    SELECT json_object_agg(key, value ORDER BY ordinal)::text
    INTO business_payload
    FROM (
      SELECT field.key, CASE
        WHEN field.key = 'rows' THEN pg_temp.platform_batch_business_rows(field.value)
        ELSE replace(field.value::text, $esc$\u005cu$esc$, $esc$\u$esc$)::json
      END AS value, field.ordinal
      FROM json_each(snapshot) WITH ORDINALITY AS field(key, value, ordinal)
      WHERE field.key IN (
        'source', 'status', 'effectiveConditions', 'titleScope', 'queriedAt', 'completedAt',
        'rows', 'pages', 'fetchedCount', 'declaredTotal', 'completeness', 'fullRange',
        'unfinished', 'error', 'limits'
      )
      UNION ALL
      SELECT 'dataRows', pg_temp.platform_batch_business_rows(typed_rows), 0
      WHERE json_typeof(typed_rows) = 'array'
    ) AS fields;

    UPDATE business.platform_batch_segment
    SET payload = business_payload
    WHERE job_id = previous.job_id AND item_id = previous.item_id AND segment_index = previous.segment_index
      AND payload IS DISTINCT FROM business_payload;
  END LOOP;
END
$$;
