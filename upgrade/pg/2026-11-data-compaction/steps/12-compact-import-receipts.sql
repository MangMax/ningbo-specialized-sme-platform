\set ON_ERROR_STOP on
BEGIN;
SET LOCAL search_path TO business, pg_catalog;
LOCK TABLE import_receipt IN ACCESS EXCLUSIVE MODE;
ALTER TABLE import_receipt ADD COLUMN IF NOT EXISTS historical_projection boolean NOT NULL DEFAULT false;

SELECT EXISTS (
  SELECT 1 FROM pg_attribute
  WHERE attrelid = 'business.import_receipt'::regclass AND attname = 'request_body' AND NOT attisdropped
) AS has_request_body
\gset
\if :has_request_body
\ir support/classify-import-receipt.sql
UPDATE import_receipt AS receipt SET historical_projection = classified.historical_projection
FROM (
  SELECT r.id, pg_temp.import_historical_projection(coalesce(owner.request_body, r.request_body)) AS historical_projection
  FROM import_receipt r
  JOIN import_batch batch ON batch.id = r.batch_id
  LEFT JOIN import_receipt owner ON owner.id = r.body_receipt_id
  WHERE batch.source_kind = 'platform_archive'
) classified
WHERE receipt.id = classified.id AND receipt.historical_projection IS DISTINCT FROM classified.historical_projection;
ALTER TABLE import_receipt DROP COLUMN body_receipt_id, DROP COLUMN request_body;
\endif
COMMIT;
