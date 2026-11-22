CREATE TABLE IF NOT EXISTS business.platform_batch_segment (
  job_id text COLLATE "C" NOT NULL REFERENCES business.job(id) ON DELETE CASCADE,
  item_id text COLLATE "C" NOT NULL,
  segment_index integer NOT NULL CHECK (segment_index >= 0),
  payload text NOT NULL,
  PRIMARY KEY (job_id, item_id, segment_index)
);
