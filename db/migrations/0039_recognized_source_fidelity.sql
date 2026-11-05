-- Additive capture only. Existing rows remain unknown until the source owner
-- rereads fingerprint-verified originals via a NEW relationId import command.
ALTER TABLE platform_recognized_projection ADD COLUMN source_validity_date TEXT;
--> statement-breakpoint
ALTER TABLE platform_recognized_projection ADD COLUMN source_maintenance_batch TEXT;
--> statement-breakpoint
ALTER TABLE platform_recognized_projection ADD COLUMN source_maintenance_year_absent INTEGER CHECK (source_maintenance_year_absent IN (0, 1));
