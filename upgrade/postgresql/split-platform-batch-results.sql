DO $$
DECLARE
  previous record;
  snapshot json;
  items json;
  summary json;
BEGIN
  FOR previous IN
    SELECT id, result
    FROM business.job
    WHERE kind = 'platform-query-batch' AND result IS NOT NULL
  LOOP
    -- json traversal rejects escaped NUL and lone surrogates. Protect all Unicode
    -- escape prefixes and reverse the substitution on the original JSON values.
    snapshot := replace(previous.result, '\u', '\u005cu')::json;
    items := snapshot -> 'items';
    IF json_typeof(items) IS DISTINCT FROM 'array' THEN
      CONTINUE;
    END IF;
    IF NOT EXISTS (SELECT FROM json_array_elements(items) AS item WHERE item -> 'segments' IS NOT NULL) THEN
      CONTINUE;
    END IF;

    INSERT INTO business.platform_batch_segment (job_id, item_id, segment_index, payload)
    SELECT previous.id, item ->> 'itemId', ordinal - 1, replace(segment::text, '\u005cu', '\u')
    FROM json_array_elements(items) AS item
    CROSS JOIN LATERAL json_array_elements(item -> 'segments') WITH ORDINALITY AS saved(segment, ordinal);

    SELECT json_agg(json_build_object(
      'itemId', item -> 'itemId',
      'status', item -> 'status',
      'completeness', item -> 'completeness',
      'unfinished', item -> 'unfinished',
      'error', item -> 'segments' -> -1 -> 'error'
    ) ORDER BY ordinal)
    INTO summary
    FROM json_array_elements(items) WITH ORDINALITY AS entries(item, ordinal);

    UPDATE business.job
    SET result = (
      SELECT replace(json_object_agg(key, CASE WHEN key = 'items' THEN summary ELSE value END)::text, '\u005cu', '\u')
      FROM json_each(snapshot)
    )
    WHERE id = previous.id;
  END LOOP;
END
$$;
