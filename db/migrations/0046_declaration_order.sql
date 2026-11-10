ALTER TABLE file_declaration_669 ADD COLUMN display_sequence INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
UPDATE file_declaration_669 SET display_sequence = (
 SELECT count(*) FROM file_declaration_669 d
 WHERE d.file_id = file_declaration_669.file_id AND d.rowid <= file_declaration_669.rowid
);
--> statement-breakpoint
INSERT INTO file_declaration_669 (declaration_id, file_id, revision, active, sha256, part, display_sequence)
SELECT printf('68100000-0000-4000-8000-%012x', p.id), p.file_id, 1, 1, f.sha256,
 json_object('titleCode',p.title_code,'eventKind',p.event_kind,'year',p.year,'batch',p.batch,'attachment',p.attachment,'rowCount',p.row_count),
 coalesce((SELECT max(display_sequence) FROM file_declaration_669 d WHERE d.file_id=p.file_id),0)
 + row_number() OVER (PARTITION BY p.file_id ORDER BY p.id)
FROM stored_file_part p JOIN stored_file f ON f.id=p.file_id
WHERE p.origin IN ('agent','legacy') AND NOT EXISTS (
 SELECT 1 FROM file_declaration_669 d WHERE d.file_id=p.file_id
 AND json_extract(d.part,'$.titleCode') IS p.title_code AND json_extract(d.part,'$.eventKind') IS p.event_kind
 AND json_extract(d.part,'$.year') IS p.year AND json_extract(d.part,'$.batch') IS p.batch
 AND json_extract(d.part,'$.attachment') IS p.attachment
);
--> statement-breakpoint
CREATE INDEX file_declaration_681_order_idx ON file_declaration_669(file_id, display_sequence);
