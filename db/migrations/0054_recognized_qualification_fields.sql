ALTER TABLE platform_recognized_projection ADD COLUMN source_recognized_at text;
--> statement-breakpoint
ALTER TABLE platform_recognized_projection ADD COLUMN source_valid_flag blob;
--> statement-breakpoint
ALTER TABLE platform_recognized_projection ADD COLUMN source_invalidated_at text;
--> statement-breakpoint
ALTER TABLE platform_recognized_projection ADD COLUMN source_invalidation_reason text;
--> statement-breakpoint
ALTER TABLE platform_recognized_projection ADD COLUMN source_province_name text;
--> statement-breakpoint
ALTER TABLE platform_recognized_projection ADD COLUMN source_city_name text;
--> statement-breakpoint
ALTER TABLE platform_recognized_projection ADD COLUMN source_district_name text;
--> statement-breakpoint
ALTER TABLE platform_recognized_projection ADD COLUMN qualification_fields_rule text;
