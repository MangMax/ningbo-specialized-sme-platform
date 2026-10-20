-- Preserve the legacy json_each(json_extract(...)) second JSON parse and text-only equality.
-- Malformed historical values remain writable, with error markers replayed by title reads.
CREATE INDEX platform_query_title_code_idx ON platform_query(title_code, id);--> statement-breakpoint
CREATE TABLE platform_query_title_scope (
  query_id integer NOT NULL REFERENCES platform_query(id) ON DELETE CASCADE,
  rdjb text NOT NULL,
  PRIMARY KEY (query_id, rdjb)
);--> statement-breakpoint
CREATE INDEX platform_query_title_scope_rdjb_query_idx ON platform_query_title_scope(rdjb, query_id);--> statement-breakpoint
CREATE TABLE platform_query_title_scope_error (
  query_id integer PRIMARY KEY REFERENCES platform_query(id) ON DELETE CASCADE
);--> statement-breakpoint
INSERT OR IGNORE INTO platform_query_title_scope(query_id, rdjb)
SELECT q.id, scope.value FROM platform_query q,
  json_each(CASE WHEN json_valid(q.collection_evidence)
    THEN CASE WHEN json_valid(json_extract(q.collection_evidence, '$.titleScope.rdjb'))
      THEN json_extract(q.collection_evidence, '$.titleScope.rdjb') ELSE 'null' END
    ELSE 'null' END) scope
WHERE scope.type = 'text';--> statement-breakpoint
INSERT INTO platform_query_title_scope_error(query_id)
SELECT q.id FROM platform_query q WHERE CASE
  WHEN q.collection_evidence IS NULL THEN 0
  WHEN NOT json_valid(q.collection_evidence) THEN 1
  WHEN json_extract(q.collection_evidence, '$.titleScope.rdjb') IS NULL THEN 0
  WHEN NOT json_valid(json_extract(q.collection_evidence, '$.titleScope.rdjb')) THEN 1
  ELSE 0 END = 1;--> statement-breakpoint
CREATE TRIGGER platform_query_title_scope_insert AFTER INSERT ON platform_query BEGIN
  INSERT OR IGNORE INTO platform_query_title_scope(query_id, rdjb)
  SELECT new.id, scope.value FROM
    json_each(CASE WHEN json_valid(new.collection_evidence)
      THEN CASE WHEN json_valid(json_extract(new.collection_evidence, '$.titleScope.rdjb'))
        THEN json_extract(new.collection_evidence, '$.titleScope.rdjb') ELSE 'null' END
      ELSE 'null' END) scope
  WHERE scope.type = 'text';
  INSERT INTO platform_query_title_scope_error(query_id)
  SELECT new.id WHERE CASE
    WHEN new.collection_evidence IS NULL THEN 0
    WHEN NOT json_valid(new.collection_evidence) THEN 1
    WHEN json_extract(new.collection_evidence, '$.titleScope.rdjb') IS NULL THEN 0
    WHEN NOT json_valid(json_extract(new.collection_evidence, '$.titleScope.rdjb')) THEN 1
    ELSE 0 END = 1;
END;--> statement-breakpoint
CREATE TRIGGER platform_query_title_scope_update AFTER UPDATE OF id, collection_evidence ON platform_query BEGIN
  DELETE FROM platform_query_title_scope WHERE query_id = old.id;
  DELETE FROM platform_query_title_scope_error WHERE query_id = old.id;
  INSERT OR IGNORE INTO platform_query_title_scope(query_id, rdjb)
  SELECT new.id, scope.value FROM
    json_each(CASE WHEN json_valid(new.collection_evidence)
      THEN CASE WHEN json_valid(json_extract(new.collection_evidence, '$.titleScope.rdjb'))
        THEN json_extract(new.collection_evidence, '$.titleScope.rdjb') ELSE 'null' END
      ELSE 'null' END) scope
  WHERE scope.type = 'text';
  INSERT INTO platform_query_title_scope_error(query_id)
  SELECT new.id WHERE CASE
    WHEN new.collection_evidence IS NULL THEN 0
    WHEN NOT json_valid(new.collection_evidence) THEN 1
    WHEN json_extract(new.collection_evidence, '$.titleScope.rdjb') IS NULL THEN 0
    WHEN NOT json_valid(json_extract(new.collection_evidence, '$.titleScope.rdjb')) THEN 1
    ELSE 0 END = 1;
END;--> statement-breakpoint
CREATE TRIGGER platform_query_title_scope_delete AFTER DELETE ON platform_query BEGIN
  DELETE FROM platform_query_title_scope WHERE query_id = old.id;
  DELETE FROM platform_query_title_scope_error WHERE query_id = old.id;
END;
