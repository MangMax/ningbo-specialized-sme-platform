-- Read normalized scope rows from the source schema before removing them.
SELECT 'DO $$ BEGIN RAISE EXCEPTION ''Collection scope owner missing''; END $$;'
WHERE EXISTS (
  SELECT collection_id FROM (
    SELECT collection_id FROM :"scope_source".platform_collection_condition
    UNION
    SELECT collection_id FROM :"scope_source".platform_collection_unfinished
  ) AS scope
  WHERE NOT EXISTS (SELECT FROM :"target".platform_collection c WHERE c.id=scope.collection_id)
)
\gexec

WITH conditions AS (
  SELECT collection_id,
    coalesce(jsonb_object_agg(name, jsonb_strip_nulls(jsonb_build_object('kind', value_kind, 'value',
      CASE value_kind WHEN 'text' THEN to_jsonb(text_value)
        WHEN 'integer' THEN to_jsonb(integer_value) WHEN 'boolean' THEN to_jsonb(integer_value) END)))
      FILTER (WHERE value_kind <> 'absent'), '{}'::jsonb) AS values,
    jsonb_object_agg(name, jsonb_build_object('kind', witness_kind, 'storage', witness_value_sqlite_storage,
      'bytes', replace(encode(witness_value, 'base64'), chr(10), '')))
      FILTER (WHERE witness_kind IS NOT NULL OR witness_value IS NOT NULL) AS witnesses
  FROM :"scope_source".platform_collection_condition
  GROUP BY collection_id
)
UPDATE :"target".platform_collection c SET condition_facts =
  jsonb_build_object('values', conditions.values) ||
  CASE WHEN conditions.witnesses IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('witnesses', conditions.witnesses) END
FROM conditions WHERE c.id=conditions.collection_id;

WITH remaining AS (
  SELECT collection_id, jsonb_agg(jsonb_build_object(
    'ordinal', ordinal, 'source', source, 'rdjb', rdjb, 'pageNo', page_no
  ) ORDER BY ordinal) AS positions
  FROM :"scope_source".platform_collection_unfinished
  GROUP BY collection_id
)
UPDATE :"target".platform_collection c SET unfinished_positions=remaining.positions
FROM remaining WHERE c.id=remaining.collection_id;
