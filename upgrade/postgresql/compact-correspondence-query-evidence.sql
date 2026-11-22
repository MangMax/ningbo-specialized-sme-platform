\set ON_ERROR_STOP on
\if :{?target}
\else
\set target business
\endif

WITH source AS MATERIALIZED (
  SELECT id, provenance::jsonb AS evidence
  FROM :"target".record_correspondence
), compacted AS (
  SELECT id, evidence #- '{relation,rawFields}' #- '{relation,sourceText}' AS evidence,
    evidence #> '{query,collectionEvidence}' AS coverage,
    evidence #> '{query,rawResponse}' AS response
  FROM source
  WHERE evidence #> '{query,rawResponse}' IS NOT NULL
    OR evidence #> '{relation,rawFields}' IS NOT NULL
    OR evidence #> '{relation,sourceText}' IS NOT NULL
    OR (evidence #> '{query,collectionEvidence}') ?| ARRAY['rows','dataRows','rawData']
), source_facts AS (
  SELECT id, response, CASE WHEN jsonb_typeof(coverage) = 'object'
    THEN jsonb_set(evidence, '{query,collectionEvidence}', coverage - ARRAY['rows','dataRows','rawData'])
    ELSE evidence END #- '{query,rawResponse}' AS evidence
  FROM compacted
)
UPDATE :"target".record_correspondence AS edge
SET provenance = (
  CASE jsonb_typeof(source_facts.response)
    WHEN 'string' THEN jsonb_set(
      source_facts.evidence, '{query,rawResponseSha256}',
      to_jsonb(encode(sha256(convert_to(source_facts.response #>> '{}', 'UTF8')), 'hex'))
    )
    ELSE source_facts.evidence
  END
)::text
FROM source_facts WHERE edge.id = source_facts.id;

WITH source AS MATERIALIZED (
  SELECT id, evidence::jsonb AS evidence
  FROM :"target".record_correspondence_audit
), compacted AS (
  SELECT id, evidence #- '{relation,rawFields}' #- '{relation,sourceText}' #- '{query,rawResponse}' AS evidence,
    evidence #> '{query,collectionEvidence}' AS coverage
  FROM source
  WHERE evidence #> '{query,rawResponse}' IS NOT NULL
    OR evidence #> '{relation,rawFields}' IS NOT NULL
    OR evidence #> '{relation,sourceText}' IS NOT NULL
    OR (evidence #> '{query,collectionEvidence}') ?| ARRAY['rows','dataRows','rawData']
)
UPDATE :"target".record_correspondence_audit AS audit
SET evidence = (CASE WHEN jsonb_typeof(compacted.coverage) = 'object'
  THEN jsonb_set(compacted.evidence, '{query,collectionEvidence}', compacted.coverage - ARRAY['rows','dataRows','rawData'])
  ELSE compacted.evidence END)::text
FROM compacted WHERE audit.id = compacted.id;
