CREATE TABLE `enterprise_profile_audit` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `enterprise_id` integer NOT NULL,
  `idempotency_key` text NOT NULL,
  `request_hash` text NOT NULL,
  `before_version` text NOT NULL,
  `after_version` text NOT NULL,
  `before` text NOT NULL,
  `after` text NOT NULL,
  `actor` text NOT NULL,
  `basis` text NOT NULL,
  `retained_alias_id` integer,
  `alias_created` integer DEFAULT 0 NOT NULL,
  `created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `enterprise_profile_audit_key_uq` ON `enterprise_profile_audit` (`idempotency_key`);
--> statement-breakpoint
CREATE INDEX `enterprise_profile_audit_enterprise_idx` ON `enterprise_profile_audit` (`enterprise_id`, `id`);
