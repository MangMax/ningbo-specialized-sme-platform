\set ON_ERROR_STOP on
BEGIN ISOLATION LEVEL REPEATABLE READ;
CREATE SCHEMA runtime_logs;
SET LOCAL search_path TO runtime_logs, pg_catalog;

\ir ../../../db/postgresql/runtime-log-schema.sql

INSERT INTO log_policy (id, "retentionDays", "maxBytes", pruned, cleared)
SELECT id, "retentionDays", "maxBytes", pruned, cleared FROM :"staging".log_policy;
INSERT INTO log_collection (id, collection, revision)
SELECT id, collection, revision FROM :"staging".log_collection;

-- Historical stores without the module column have no recorded module.
SELECT CASE WHEN EXISTS (
  SELECT 1 FROM pg_attribute
  WHERE attrelid = to_regclass(format('%I.log_events', :'staging'))
    AND attname = 'module' AND NOT attisdropped
) THEN 'module' ELSE 'NULL::text' END AS module_projection
\gset
INSERT INTO log_events (
  seq, id, timestamp, level, source, module, operation, outcome, "requestId", "traceId",
  "taskId", "fileId", "batchId", "resourceId", detail
)
SELECT seq, id, timestamp, level, source, :module_projection, operation, outcome, "requestId", "traceId",
  "taskId", "fileId", "batchId", "resourceId", detail
FROM :"staging".log_events;

UPDATE log_policy SET logical_bytes = (
  SELECT coalesce(sum(octet_length(detail)::bigint), 0)
  FROM log_events
);

-- Deleted events can leave a high-water mark above the maximum retained seq.
WITH sequence_highs AS (
  SELECT CASE WHEN to_jsonb(s)->>'seq_sqlite_storage' = 'integer'
      THEN ('x' || substr(seq::text, 3))::bit(64)::bigint
      ELSE seq::text::bigint END AS seq
  FROM :"staging".sqlite_sequence s WHERE name = 'log_events'
  UNION ALL
  SELECT max(seq) FROM log_events
), sequence_high AS (
  SELECT max(seq) AS seq FROM sequence_highs
)
SELECT setval(pg_get_serial_sequence('runtime_logs.log_events', 'seq'),
              greatest(seq, 1), coalesce(seq >= 1, false))
FROM sequence_high;

\ir ../../../db/postgresql/runtime-log-indexes.sql

ANALYZE log_policy, log_collection, log_events;
COMMIT;
