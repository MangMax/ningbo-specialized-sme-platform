CREATE INDEX `platform_query_status_time_idx` ON `platform_query` (`status`,`queried_at`,`id`);--> statement-breakpoint
CREATE INDEX `platform_query_time_idx` ON `platform_query` (`queried_at`,`id`);--> statement-breakpoint
CREATE INDEX `platform_relation_uscc_query_idx` ON `platform_relation` (`uscc_raw`,`query_id`);