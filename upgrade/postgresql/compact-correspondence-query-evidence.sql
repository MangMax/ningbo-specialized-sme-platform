\set ON_ERROR_STOP on
\if :{?target}
\else
\set target business
\endif

WITH source AS MATERIALIZED (
  SELECT id, provenance::jsonb AS evidence
  FROM :"target".record_correspondence
  WHERE provenance::jsonb #> '{query,rawResponse}' IS NOT NULL
)
UPDATE :"target".record_correspondence AS edge
SET provenance = (
  CASE jsonb_typeof(source.evidence #> '{query,rawResponse}')
    WHEN 'string' THEN jsonb_set(
      source.evidence #- '{query,rawResponse}', '{query,rawResponseSha256}',
      to_jsonb(encode(sha256(convert_to(source.evidence #>> '{query,rawResponse}', 'UTF8')), 'hex'))
    )
    ELSE source.evidence #- '{query,rawResponse}'
  END
)::text
FROM source WHERE edge.id = source.id;

UPDATE :"target".record_correspondence_audit
SET evidence = (evidence::jsonb #- '{query,rawResponse}')::text
WHERE evidence::jsonb #> '{query,rawResponse}' IS NOT NULL;
