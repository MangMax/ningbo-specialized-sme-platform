\set ON_ERROR_STOP on
BEGIN;
SET LOCAL search_path TO business, public;

CREATE TABLE business.job (
  id text COLLATE "C" PRIMARY KEY,
  kind text NOT NULL,
  params text NOT NULL,
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'running', 'done', 'failed', 'cancelled')),
  progress text NOT NULL DEFAULT '{"done":0,"total":1}',
  result text,
  error text,
  created_at text COLLATE "C" NOT NULL,
  started_at text,
  finished_at text,
  claim_token uuid,
  cancel_requested boolean NOT NULL DEFAULT false,
  request_key text COLLATE "C",
  input_snapshot text
);

INSERT INTO business.job (id, kind, params, state, progress, result, error, created_at, started_at, finished_at)
SELECT id, kind, params, state, progress, result, error, created_at, started_at, finished_at
FROM :"staging".job;

-- Existing jobs have no PostgreSQL claim. New submissions receive a token.
ALTER TABLE business.job ALTER COLUMN claim_token SET DEFAULT gen_random_uuid();

CREATE INDEX job_kind_idx ON business.job (kind);
CREATE INDEX job_state_idx ON business.job (state);
CREATE INDEX job_created_at_idx ON business.job (created_at DESC, id DESC);
-- The export idempotency key is a string, and absent or null keys remain distinct.
-- Keep the complete historical JSON bytes in params, converting only in the index.
CREATE UNIQUE INDEX job_export_request_uq
  ON business.job (kind, (nullif(params::jsonb -> 'clientRequestId', 'null'::jsonb)))
  WHERE kind = 'current-roster-export';

CREATE UNIQUE INDEX job_request_key_uq ON business.job (kind, request_key) WHERE request_key IS NOT NULL;

ANALYZE business.job;
COMMIT;
