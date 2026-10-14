ALTER TABLE `stored_file_part` ADD `origin` text DEFAULT 'derived' NOT NULL;--> statement-breakpoint
ALTER TABLE `stored_file_part` ADD `has_conflict` integer DEFAULT false NOT NULL;--> statement-breakpoint
-- Before this migration, save_parse_result replaced the file's part set and set parse_state.
-- Conservatively keep those existing rows agent-owned so a later evidence backfill cannot erase them.
UPDATE `stored_file_part`
SET `origin` = 'agent'
WHERE `file_id` IN (
  SELECT `id` FROM `stored_file` WHERE `parse_state` IN ('parsed', 'failed')
);--> statement-breakpoint
CREATE UNIQUE INDEX `stored_file_part_coordinate_uq`
ON `stored_file_part` (
  `file_id`, `title_code`, `event_kind`,
  (`year` IS NULL), coalesce(`year`, 0),
  (`batch` IS NULL), coalesce(`batch`, 0),
  (`attachment` IS NULL), coalesce(`attachment`, '')
);
