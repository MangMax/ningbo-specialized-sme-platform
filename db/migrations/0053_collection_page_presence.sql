ALTER TABLE `platform_collection_page` ADD COLUMN `max_page_present` integer DEFAULT 0 NOT NULL CHECK (`max_page_present` IN (0,1));
