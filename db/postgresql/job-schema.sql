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
