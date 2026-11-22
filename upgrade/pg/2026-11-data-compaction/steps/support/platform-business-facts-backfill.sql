-- Keep V1 evidence only until the native refresh transition verifies stored decisions.
ALTER TABLE platform_collection ADD COLUMN IF NOT EXISTS refresh_metadata jsonb;
ALTER TABLE platform_business_observation ADD COLUMN IF NOT EXISTS refresh_facts jsonb;

-- Project only the historically hashed fields. Preserve the first duplicate key and JSON token values.
CREATE OR REPLACE FUNCTION pg_temp.platform_refresh_tokens(payload bytea)
RETURNS TABLE(raw text, document json, quoted boolean) LANGUAGE sql AS $body$
  SELECT raw,
    CASE WHEN raw IS JSON THEN
      CASE WHEN quoted THEN regexp_replace(raw,
        $rx$\\\\|\\(u(?:0000|[dD][89a-fA-F][0-9a-fA-F]{2}))$rx$,
        $rx$\\\\|\1|$rx$, 'g')::json ELSE raw::json END
    END,
    quoted
  FROM (VALUES (CASE WHEN position(decode('00','hex') IN payload)>0 THEN '{' ELSE convert_from(payload,'UTF8') END)) input(raw)
  CROSS JOIN LATERAL (SELECT raw ~ $rx$\\u(?:0000|[dD][89a-fA-F][0-9a-fA-F]{2})$rx$ AS quoted) flags
$body$;

CREATE OR REPLACE FUNCTION pg_temp.platform_refresh_fields(document json, names text[])
RETURNS TABLE(key text, value json) LANGUAGE sql AS $body$
  SELECT DISTINCT ON (key COLLATE "C") key, value
  FROM json_each(CASE WHEN json_typeof(document)='object' THEN document ELSE '{}'::json END)
    WITH ORDINALITY fields(key, value, ordinal)
  WHERE key COLLATE "C"=ANY(names)
  ORDER BY key COLLATE "C", ordinal
$body$;

WITH captured AS MATERIALIZED (
  SELECT c.id, r.archive_id, a.sha256, r.sealed,
    coalesce(a.byte_length, 0) + coalesce(response.byte_length, 0) AS source_bytes,
    jsonb_build_object('json', CASE WHEN a.storage_class IS NULL OR a.storage_class='null' THEN NULL
      WHEN input.document IS NULL THEN '{' WHEN json_typeof(input.document)='null' THEN 'null'
      ELSE metadata.body END, 'quoted', input.quoted) AS refresh
  FROM platform_collection c
  LEFT JOIN platform_collection_archive_ref r ON r.owner_id=c.id AND r.field='collectionEvidence'
  LEFT JOIN platform_archive_value a ON a.id=r.archive_id
  LEFT JOIN platform_collection_archive_ref rr ON rr.owner_id=c.id AND rr.field='rawResponse'
  LEFT JOIN platform_archive_value response ON response.id=rr.archive_id
  CROSS JOIN LATERAL pg_temp.platform_refresh_tokens(a.bytes) input
  CROSS JOIN LATERAL (
    SELECT coalesce(json_object_agg(key, CASE WHEN key='pages' THEN
      CASE WHEN json_typeof(value)='array' THEN (
        SELECT coalesce(json_agg(CASE WHEN json_typeof(page)='null' THEN page
          ELSE json_build_object('rdjb',page->'rdjb','status',page->'status','declaredTotal',page->'declaredTotal') END
          ORDER BY ordinal),'[]'::json)
        FROM json_array_elements(value) WITH ORDINALITY pages(page,ordinal))
        ELSE 'null'::json END ELSE value END),'{}'::json)::text AS body
    FROM pg_temp.platform_refresh_fields(input.document, ARRAY['source','status','effectiveConditions','titleScope','completeness','fullRange','pages'])
  ) metadata
  WHERE c.refresh_metadata IS NULL
)
UPDATE platform_collection c SET evidence_archive_id=captured.archive_id, evidence_sha256=captured.sha256,
  evidence_sealed=captured.sealed, source_archive_bytes=captured.source_bytes, refresh_metadata=captured.refresh
FROM captured WHERE captured.id=c.id;

WITH retained AS MATERIALIZED (
  SELECT o.id, snapshot.bytes AS snapshot_bytes, src.bytes AS source_text, coalesce(raw.byte_length,0) AS source_bytes
  FROM platform_business_observation o
  LEFT JOIN platform_observation_archive_ref sr ON sr.owner_id=o.id AND sr.field='legacyRowSnapshot'
  LEFT JOIN platform_archive_value snapshot ON snapshot.id=sr.archive_id
  LEFT JOIN platform_observation_archive_ref tr ON tr.owner_id=o.id AND tr.field='sourceText'
  LEFT JOIN platform_archive_value src ON src.id=tr.archive_id
  LEFT JOIN platform_observation_archive_ref rr ON rr.owner_id=o.id AND rr.field='rawFields'
  LEFT JOIN platform_archive_value raw ON raw.id=rr.archive_id
  WHERE o.refresh_facts IS NULL
), captured AS MATERIALIZED (
  SELECT r.id, r.source_bytes,
    coalesce(position(convert_to('转写','UTF8') IN r.source_text)>0 AND
      (position(convert_to('名称','UTF8') IN r.source_text)>0 OR encode(r.source_text,'escape') ILIKE '%qymc%')
      AND encode(r.source_text,'escape') ILIKE '%platform-verify-aclass%',false) AS identity_only,
    CASE WHEN r.snapshot_bytes IS NULL THEN NULL ELSE jsonb_build_object(
      'fields', coalesce(cells.selected,'[]'::json),
      'business', CASE WHEN input.raw IS NULL THEN NULL
        WHEN input.document IS NULL OR json_typeof(input.document)='null' THEN '{' ELSE business.body END,
      'quoted', input.quoted) END AS refresh
  FROM retained r
  CROSS JOIN LATERAL (
    SELECT json_agg(json_build_object('name',cell->>'name','storageClass',cell->>'storageClass','hex',cell->>'hex')
        ORDER BY ordinal) FILTER (WHERE cell->>'name'=ANY(ARRAY['relation_key','uscc_raw','name_raw','alias_name_raw',
        'province','status','batch','declare_kind','applied_at','award_batch_label','year'])) AS selected,
      decode(max(cell->>'hex') FILTER (WHERE cell->>'name'='raw_fields' AND cell->>'storageClass'<>'null'),'hex') AS raw_bytes
    FROM json_array_elements(convert_from(platform_observation_snapshot(r.id,r.snapshot_bytes),'UTF8')::json->'fields')
      WITH ORDINALITY entries(cell,ordinal)
  ) cells
  CROSS JOIN LATERAL pg_temp.platform_refresh_tokens(cells.raw_bytes) input
  CROSS JOIN LATERAL (
    SELECT coalesce(json_object_agg(key,value),'{}'::json)::text AS body
    FROM pg_temp.platform_refresh_fields(input.document, ARRAY['id','rdjb','rddqrq','whpcyear','whpc','cszt','year','sqsj','sblx',
      'personuuid','szsfmc','szq','rdxx','qymc','tyshxydm'])
  ) business
)
UPDATE platform_business_observation o SET identity_only_source=captured.identity_only,
  source_raw_bytes=captured.source_bytes, refresh_facts=captured.refresh
FROM captured WHERE captured.id=o.id;
