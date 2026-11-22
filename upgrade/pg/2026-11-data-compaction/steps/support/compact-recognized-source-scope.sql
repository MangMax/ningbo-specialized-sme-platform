ALTER TABLE platform_collection ADD COLUMN IF NOT EXISTS recognized_scope jsonb;
ALTER TABLE platform_business_observation ADD COLUMN IF NOT EXISTS recognized_position jsonb;

-- Verify the old capture bindings while their columns still exist. Retain a
-- discovered gap for the same read path that used to raise it.
WITH pending AS MATERIALIZED (
  SELECT c.id, c.condition_facts,
    CASE
      WHEN c.witness_rule IS DISTINCT FROM 'recognized-witness-input-v1'
        THEN '{"state":"gap","reason":"unsupported_capture_rule"}'::jsonb
      WHEN c.witness_state = 'uncaptured' THEN '{"state":"uncaptured"}'::jsonb
      WHEN c.witness_archive_id IS NULL OR c.evidence_archive_id IS DISTINCT FROM c.witness_archive_id
        OR c.evidence_sealed IS DISTINCT FROM 1 OR c.witness_sha256 IS DISTINCT FROM c.evidence_sha256
        THEN '{"state":"gap","reason":"collection_binding"}'::jsonb
      WHEN c.witness_state = 'error'
        THEN jsonb_build_object('state','error','name',c.witness_error_name,'message',c.witness_error)
      WHEN c.witness_state <> 'captured' OR c.witness_gate IS NULL OR c.witness_gate NOT IN (0, 1)
        THEN '{"state":"gap","reason":"collection_state"}'::jsonb
      WHEN c.witness_gate = 0 THEN '{"state":"not_applicable"}'::jsonb
    END AS scope
  FROM platform_collection c
  WHERE c.interface = 'recognized_list' AND c.status = 'success' AND c.recognized_scope IS NULL
), cells AS MATERIALIZED (
  SELECT pending.id, field.name, value.cell->>'kind' AS kind, value.cell->>'storage' AS storage,
    value.cell IS NULL OR coalesce(jsonb_typeof(value.cell->'bytes') IN ('null','string'), false) AS bytes_valid,
    decode(value.cell->>'bytes', 'base64') AS bytes
  FROM pending
  CROSS JOIN (VALUES ('rddqrq'), ('whpcyear'), ('whpc')) AS field(name)
  CROSS JOIN LATERAL (SELECT pending.condition_facts->'witnesses'->field.name AS cell) AS value
  WHERE pending.scope IS NULL
), conditions AS (
  SELECT id,
    bool_and(bytes_valid AND coalesce(CASE kind
      WHEN 'absent' THEN bytes IS NULL
      WHEN 'null' THEN bytes IS NULL
      WHEN 'text' THEN bytes IS NOT NULL AND storage = 'text'
      WHEN 'array' THEN bytes IS NOT NULL AND storage = 'text'
      WHEN 'object' THEN bytes IS NOT NULL AND storage = 'text'
      WHEN 'integer' THEN storage IN ('integer','real') AND octet_length(bytes) >= 8
      WHEN 'real' THEN storage IN ('integer','real') AND octet_length(bytes) >= 8
      WHEN 'true' THEN (storage = 'integer' AND substring(bytes FOR 8) = decode('0000000000000001','hex'))
        OR (storage = 'real' AND substring(bytes FOR 8) = decode('3ff0000000000000','hex'))
      WHEN 'false' THEN (storage = 'integer' AND substring(bytes FOR 8) = decode('0000000000000000','hex'))
        OR (storage = 'real' AND substring(bytes FOR 8) IN (decode('0000000000000000','hex'),decode('8000000000000000','hex')))
      ELSE false
    END, false)) AS valid,
    jsonb_object_agg(CASE name WHEN 'rddqrq' THEN 'validYear' ELSE 'maintenanceYear' END, CASE
      WHEN bytes IS NULL THEN 'null'::jsonb
      WHEN storage = 'text' AND encode(bytes, 'hex') ~ '^3[1-9](3[0-9]){3}$' THEN to_jsonb(convert_from(bytes, 'UTF8'))
      ELSE 'false'::jsonb
    END) FILTER (WHERE name IN ('rddqrq', 'whpcyear')) AS years
  FROM cells
  GROUP BY id
)
UPDATE platform_collection c
SET recognized_scope = coalesce(pending.scope,
  jsonb_build_object('state','captured','conditions',CASE WHEN conditions.valid THEN conditions.years END))
FROM pending LEFT JOIN conditions USING (id)
WHERE c.id = pending.id;

UPDATE platform_business_observation o
SET recognized_position = CASE
  WHEN o.witness_rule IS DISTINCT FROM 'recognized-witness-input-v1'
    OR o.witness_collection_id IS DISTINCT FROM o.collection_id OR o.witness_sequence_no IS DISTINCT FROM o.sequence_no
    OR o.witness_archive_id IS DISTINCT FROM c.witness_archive_id OR o.witness_sha256 IS DISTINCT FROM c.witness_sha256
    THEN '{"state":"gap","reason":"position_binding"}'::jsonb
  WHEN o.witness_state = 'error'
    THEN jsonb_build_object('state','error','name',o.witness_error_name,'message',o.witness_error)
  WHEN o.witness_state IN ('unmatched','rejected') THEN jsonb_build_object('state',o.witness_state)
  WHEN o.witness_state <> 'matched' THEN '{"state":"gap","reason":"position_state"}'::jsonb
  WHEN o.witness_ordinal IS NULL OR o.witness_page_kind IS NULL
    THEN '{"state":"gap","reason":"position_metadata"}'::jsonb
  ELSE jsonb_build_object('state','matched','rdjbKey',o.witness_rdjb_key)
END
FROM platform_collection c
WHERE c.id = o.collection_id AND c.recognized_scope->>'state' = 'captured'
  AND o.recognized_position IS NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT FROM platform_collection c
    WHERE c.interface = 'recognized_list' AND c.status = 'success' AND c.recognized_scope IS NULL
  ) OR EXISTS (
    SELECT FROM platform_business_observation o JOIN platform_collection c ON c.id = o.collection_id
    WHERE c.recognized_scope->>'state' = 'captured' AND o.recognized_position IS NULL
  ) THEN
    RAISE EXCEPTION 'Recognized qualification source backfill is incomplete';
  END IF;
END;
$$;
