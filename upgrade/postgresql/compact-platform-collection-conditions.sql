\set ON_ERROR_STOP on
\if :{?target}
\else
\set target business
\endif

-- Keep all witness cells and distinguish a stored empty set from a missing set.
WITH classified AS (
  SELECT collection_id, name,
    value_kind = 'absent' AND witness_kind IS NULL AND witness_value_sqlite_storage = 'null' AS redundant
  FROM :"target".platform_collection_condition
), ranked AS (
  SELECT collection_id, name, redundant,
    row_number() OVER (PARTITION BY collection_id ORDER BY redundant, name <> 'name', name COLLATE "C") AS position
  FROM classified
)
DELETE FROM :"target".platform_collection_condition condition
USING ranked
WHERE condition.collection_id = ranked.collection_id AND condition.name = ranked.name
  AND ranked.redundant AND ranked.position > 1;
