CREATE TABLE file_declaration_669 (
  declaration_id TEXT PRIMARY KEY NOT NULL,
  file_id INTEGER NOT NULL REFERENCES stored_file(id),
  revision INTEGER NOT NULL CHECK (revision > 0),
  active INTEGER NOT NULL CHECK (active IN (0,1)),
  sha256 TEXT NOT NULL,
  content_version TEXT,
  part TEXT NOT NULL,
  page_ranges TEXT
);
--> statement-breakpoint
CREATE INDEX file_declaration_669_file_idx ON file_declaration_669(file_id);
