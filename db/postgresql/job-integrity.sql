ALTER TABLE business.job ALTER COLUMN claim_token SET DEFAULT gen_random_uuid();

CREATE INDEX job_kind_idx ON business.job (kind);
CREATE INDEX job_state_idx ON business.job (state);
CREATE INDEX job_created_at_idx ON business.job (created_at DESC, id DESC);
\ir ../../upgrade/postgresql/job-request-index.sql

CREATE UNIQUE INDEX job_request_key_uq ON business.job (kind, request_key) WHERE request_key IS NOT NULL;

\ir ../../upgrade/postgresql/job-notifications.sql
