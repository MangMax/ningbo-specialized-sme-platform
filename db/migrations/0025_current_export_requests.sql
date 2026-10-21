-- The retired spec116 export migration shared main #113's timestamp. Drizzle
-- skips that timestamp on those databases. Replay #113's unchanged definitions
-- idempotently here so both lineages converge without rewriting migration history.
CREATE TABLE IF NOT EXISTS evidence_revision_113 (
 id integer PRIMARY KEY AUTOINCREMENT NOT NULL, source_kind text NOT NULL, source_key text NOT NULL, source_version text NOT NULL,
 enterprise_id integer, title_code text, direction text, event_id integer,
 coverage_digest text NOT NULL, fact_digest text NOT NULL, coverage_changed integer NOT NULL, fact_changed integer NOT NULL, query_executed integer NOT NULL DEFAULT 0,
 metadata text NOT NULL, max_decision_id integer NOT NULL, created_at text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS evidence_revision_source_113_uq ON evidence_revision_113(source_kind,source_key,source_version);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS evidence_revision_scope_113_idx ON evidence_revision_113(enterprise_id,title_code,id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS evidence_semantic_head_113 (source_key text PRIMARY KEY NOT NULL, coverage_digest text NOT NULL, fact_digest text NOT NULL, latest_revision_id integer NOT NULL);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS evidence_impact_progress_113 (revision_id integer PRIMARY KEY NOT NULL REFERENCES evidence_revision_113(id), cursor integer NOT NULL DEFAULT 0, done integer NOT NULL DEFAULT 0);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS evidence_impact_pending_113_idx ON evidence_impact_progress_113(done,revision_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS explanation_impact_113 (
 id integer PRIMARY KEY AUTOINCREMENT NOT NULL, enterprise_id integer NOT NULL, title_code text NOT NULL, direction text NOT NULL, decision_id integer NOT NULL,
 latest_revision_id integer NOT NULL, pending_since_revision_id integer NOT NULL, reviewed_revision_id integer, classification text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS explanation_impact_coordinate_113_uq ON explanation_impact_113(enterprise_id,title_code,direction,decision_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS explanation_impact_enterprise_113_idx ON explanation_impact_113(enterprise_id,id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS explanation_impact_decision_113_idx ON explanation_impact_113(decision_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS evidence_impact_link_113 (revision_id integer NOT NULL REFERENCES evidence_revision_113(id), impact_id integer NOT NULL REFERENCES explanation_impact_113(id), classification text NOT NULL);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS evidence_impact_link_113_uq ON evidence_impact_link_113(revision_id,impact_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS evidence_impact_link_state_113_idx ON evidence_impact_link_113(impact_id,revision_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS difference_reason_impact_head_113_idx ON difference_reason(enterprise_id,title_code,direction,recorded_at,id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS platform_export_row_identity_113_idx ON platform_export_row(batch_id,upper(trim(uscc_raw)),name_raw);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS evidence_revision_event_113 (revision_id integer NOT NULL REFERENCES evidence_revision_113(id), event_id integer NOT NULL, enterprise_id integer NOT NULL, title_code text NOT NULL);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS evidence_revision_event_113_uq ON evidence_revision_event_113(revision_id,event_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS evidence_revision_event_scope_113_idx ON evidence_revision_event_113(revision_id,enterprise_id,title_code,event_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS difference_reason_impact_title_113_idx ON difference_reason(title_code,id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS evidence_scope_version_113 (scope_key text PRIMARY KEY NOT NULL, latest_revision_id integer NOT NULL, pending_count integer NOT NULL);

--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS job_export_request_uq ON job(kind, json_extract(params, '$.clientRequestId')) WHERE kind = 'current-roster-export';
