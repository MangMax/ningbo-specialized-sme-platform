ALTER TABLE difference_reason ADD COLUMN lifecycle_action text;
--> statement-breakpoint
ALTER TABLE difference_reason ADD COLUMN previous_id integer REFERENCES difference_reason(id);
--> statement-breakpoint
ALTER TABLE difference_reason ADD COLUMN actor text;
--> statement-breakpoint
ALTER TABLE difference_reason ADD COLUMN basis text;
--> statement-breakpoint
ALTER TABLE difference_reason ADD COLUMN rule_version text;
--> statement-breakpoint
ALTER TABLE difference_reason ADD COLUMN effective_at text;
--> statement-breakpoint
ALTER TABLE difference_reason ADD COLUMN idempotency_key text;
--> statement-breakpoint
ALTER TABLE difference_reason ADD COLUMN request_hash text;
--> statement-breakpoint
CREATE UNIQUE INDEX difference_reason_command_uq ON difference_reason(idempotency_key);

--> statement-breakpoint
CREATE INDEX difference_reason_managed_idx ON difference_reason(enterprise_id,title_code,direction) WHERE lifecycle_action IS NOT NULL;
