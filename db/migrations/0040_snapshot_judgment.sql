CREATE TABLE snapshot_judgment (
 job_id TEXT NOT NULL REFERENCES job(id), enterprise_id INTEGER NOT NULL, title_code TEXT NOT NULL, direction TEXT NOT NULL,
 current TEXT NOT NULL, PRIMARY KEY(job_id,enterprise_id,title_code,direction)
);
--> statement-breakpoint
CREATE TABLE snapshot_judgment_operation (
 id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL REFERENCES job(id), enterprise_id INTEGER NOT NULL,
 title_code TEXT NOT NULL, direction TEXT NOT NULL, actor TEXT NOT NULL, before_value TEXT NOT NULL, after_value TEXT NOT NULL, recorded_at TEXT NOT NULL
);
