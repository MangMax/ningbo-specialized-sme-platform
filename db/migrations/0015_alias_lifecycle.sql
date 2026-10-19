ALTER TABLE enterprise_alias ADD COLUMN version integer NOT NULL DEFAULT 1;
--> statement-breakpoint
ALTER TABLE enterprise_alias ADD COLUMN original_name text;
--> statement-breakpoint
ALTER TABLE enterprise_alias ADD COLUMN original_source_kind text;
--> statement-breakpoint
ALTER TABLE enterprise_alias ADD COLUMN original_source_ref_id integer;
--> statement-breakpoint
UPDATE enterprise_alias SET original_name=name, original_source_kind=source_kind, original_source_ref_id=source_ref_id;
--> statement-breakpoint
CREATE INDEX enterprise_alias_status_page_idx ON enterprise_alias(enterprise_id, verification_status, id);
--> statement-breakpoint
CREATE TABLE enterprise_alias_audit (
 id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
 alias_id integer NOT NULL REFERENCES enterprise_alias(id),
 enterprise_id integer NOT NULL,
 action text NOT NULL, actor text NOT NULL, basis text NOT NULL,
 idempotency_key text NOT NULL, request_hash text NOT NULL,
 before text NOT NULL, after text NOT NULL, created_at text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX enterprise_alias_audit_request_uq ON enterprise_alias_audit(alias_id,idempotency_key);
--> statement-breakpoint
CREATE INDEX enterprise_alias_audit_page_idx ON enterprise_alias_audit(alias_id,id);
