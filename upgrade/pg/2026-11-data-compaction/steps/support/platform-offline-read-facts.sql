WITH collected AS MATERIALIZED (
  SELECT refs.owner_id,
    CASE WHEN archive.storage_class = 'text' AND pg_input_is_valid(convert_from(archive.bytes, 'UTF8'), 'jsonb')
      THEN convert_from(archive.bytes, 'UTF8')::jsonb END AS evidence
  FROM platform_collection_archive_ref refs JOIN platform_archive_value archive ON archive.id=refs.archive_id
  WHERE refs.field='collectionEvidence' AND refs.sealed=1
)
UPDATE platform_collection c SET
  source_coverage = CASE WHEN jsonb_typeof(collected.evidence)='object' THEN collected.evidence - ARRAY['rows','dataRows','rawData'] END
FROM collected WHERE c.id=collected.owner_id;

\ir ../../../../../db/postgresql/platform-legacy-coverage.sql

UPDATE platform_collection c SET raw_response_sha256 = archive.sha256
FROM platform_collection_archive_ref refs JOIN platform_archive_value archive ON archive.id=refs.archive_id
WHERE refs.field='rawResponse' AND refs.sealed=1 AND refs.owner_id=c.id;

WITH capture AS MATERIALIZED (
  SELECT ref.owner_id, archive.bytes
  FROM platform_observation_archive_ref ref JOIN platform_archive_value archive ON archive.id=ref.archive_id
  WHERE ref.field='legacyRowSnapshot' AND ref.sealed=1
), cells AS MATERIALIZED (
  SELECT capture.owner_id, cell->>'name' AS name, cell->>'storageClass' AS kind, decode(cell->>'hex', 'hex') AS bytes
  FROM capture CROSS JOIN LATERAL jsonb_array_elements(convert_from(capture.bytes, 'UTF8')::jsonb->'fields') AS cell
  WHERE cell->>'name' IN ('id','query_id','sequence_no','relation_key','enterprise_id',
    'title_raw','uscc_raw','name_raw','alias_name_raw','province','status','batch','declare_kind',
    'applied_at','award_batch_label','year','match_basis','verification_status','created_at')
), material AS (
  SELECT owner_id, jsonb_object_agg(
    lower(split_part(name,'_',1)) || substr(replace(initcap(replace(name,'_',' ')),' ',''),length(split_part(name,'_',1))+1),
    CASE WHEN kind IN ('integer','real') THEN to_jsonb(convert_from(bytes,'UTF8')::numeric)
         WHEN kind='text' AND position(decode('00','hex') IN bytes)=0 THEN to_jsonb(convert_from(bytes,'UTF8'))
         WHEN kind='blob' THEN jsonb_build_object('base64',encode(bytes,'base64')) ELSE 'null'::jsonb END
  ) AS facts FROM cells GROUP BY owner_id
)
UPDATE platform_business_observation o SET relation_facts=material.facts
FROM material WHERE o.id=material.owner_id;

CREATE TEMP TABLE projected_platform_business_fields ON COMMIT DROP AS
WITH captured AS MATERIALIZED (
  SELECT ref.owner_id, CASE WHEN archive.storage_class='text' AND pg_input_is_valid(convert_from(archive.bytes,'UTF8'),'jsonb')
    THEN convert_from(archive.bytes,'UTF8')::jsonb END AS payload
  FROM platform_observation_archive_ref ref JOIN platform_archive_value archive ON archive.id=ref.archive_id
  WHERE ref.field='rawFields' AND ref.sealed=1
), business AS (
  SELECT owner_id, jsonb_object_agg(entry.key, entry.value) AS facts
  FROM captured CROSS JOIN LATERAL jsonb_each(CASE WHEN jsonb_typeof(captured.payload)='object' THEN captured.payload ELSE '{}'::jsonb END) AS entry
  WHERE jsonb_typeof(entry.value) IN ('string','number','boolean') AND entry.value <> '""'::jsonb
  GROUP BY owner_id
)
SELECT o.id AS observation_id, o.version_id, business.facts
FROM platform_business_observation o JOIN captured ON captured.owner_id=o.id
LEFT JOIN business ON business.owner_id=o.id;

\ir ../../../../../db/postgresql/platform-version-business-fields-projection.sql
