\set ON_ERROR_STOP on
BEGIN;

ALTER TABLE business.job ADD COLUMN IF NOT EXISTS cancel_requested boolean NOT NULL DEFAULT false;
ALTER TABLE business.job ADD COLUMN IF NOT EXISTS request_key text COLLATE "C";
CREATE UNIQUE INDEX IF NOT EXISTS job_request_key_uq
  ON business.job (kind, request_key) WHERE request_key IS NOT NULL;

COMMIT;
