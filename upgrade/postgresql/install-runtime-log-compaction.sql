\set ON_ERROR_STOP on
BEGIN;
SET LOCAL search_path TO runtime_logs, pg_catalog;

SELECT id FROM log_policy WHERE id = 1 FOR UPDATE;

WITH settings AS (
  SELECT collection::jsonb AS value
  FROM log_collection WHERE id = 1 AND revision = 0
), rules AS (
  SELECT value, dimension, jsonb_object_agg(key, CASE WHEN rule->>'minLevel' = 'debug'
      THEN jsonb_set(rule, '{minLevel}', '"info"')
      ELSE rule END) AS entries
  FROM settings
  CROSS JOIN (VALUES ('sources'), ('integrations')) AS dimensions(dimension)
  CROSS JOIN LATERAL jsonb_each(value->'collection'->dimension) AS rules(key, rule)
  GROUP BY value, dimension
), policy AS (
  SELECT value, jsonb_set(value, '{collection}', jsonb_object_agg(dimension, entries)) AS updated
  FROM rules GROUP BY value
)
UPDATE log_collection SET collection = updated::text, revision = revision + 1
FROM policy WHERE id = 1 AND value IS DISTINCT FROM updated;

WITH removed AS (
  DELETE FROM log_events AS logs
  USING log_policy AS policy
  WHERE policy.id = 1 AND (
    logs.timestamp < to_char((now() AT TIME ZONE 'UTC') - make_interval(days => policy."retentionDays"::integer),
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    OR (logs.level = 'debug' AND logs.operation = 'db.query.select'
      AND logs.detail::json->'origin'->>'integration' = 'drizzle')
    OR (logs.source = 'http' AND logs.operation = 'http.request' AND logs.outcome = 'success' AND (
      (logs.detail::json->>'httpRoute' = '/api/health' AND logs.detail::json->>'httpMethod' IN ('GET', 'HEAD'))
      OR (logs.detail::json->>'httpMethod' = 'GET' AND logs.detail::json->>'httpRoute' IN (
        '/api/jobs', '/api/jobs/:id', '/api/task-center', '/api/task-center/:id', '/api/task-center/events'
      ))
    ))
  )
  RETURNING 1
)
UPDATE log_policy SET pruned = pruned + (SELECT count(*) FROM removed) WHERE id = 1;

UPDATE log_policy SET logical_bytes = (SELECT coalesce(sum(octet_length(detail)::bigint), 0) FROM log_events)
WHERE id = 1;
ALTER TABLE log_events DROP COLUMN IF EXISTS summary;
DROP INDEX IF EXISTS log_module, log_outcome, "log_traceId", "log_taskId", "log_fileId", "log_batchId", "log_resourceId";
COMMIT;
