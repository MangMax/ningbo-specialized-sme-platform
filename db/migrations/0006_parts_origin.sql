ALTER TABLE `stored_file_part` ADD `origin` text DEFAULT 'derived' NOT NULL;--> statement-breakpoint
ALTER TABLE `stored_file_part` ADD `has_conflict` integer DEFAULT false NOT NULL;--> statement-breakpoint
-- Before this migration the table did not record its writer; parse_state could also be updated alone.
-- Keep those rows explicitly unclassified until an evidence backfill can verify exact matches.
UPDATE `stored_file_part`
SET `origin` = 'legacy';--> statement-breakpoint
CREATE UNIQUE INDEX `stored_file_part_coordinate_uq`
ON `stored_file_part` (
  `file_id`, `title_code`, `event_kind`,
  (`year` IS NULL), coalesce(`year`, 0),
  (`batch` IS NULL), coalesce(`batch`, 0),
  (`attachment` IS NULL), coalesce(`attachment`, '')
);
