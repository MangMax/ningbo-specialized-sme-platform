/** Offline DDL only. Ordinary expand migrations never install this owner. */
import type Database from 'better-sqlite3'

export const provenanceTable = 'platform_collection_legacy_provenance'
const refs = ['platform_collection_archive_ref', 'platform_observation_archive_ref', 'platform_version_archive_ref']
export function requireProvenanceForeignKeys(t: Database.Database) {
  if (t.pragma('foreign_keys', { simple: true }) !== 1) throw new Error('Provenance indexing requires foreign_keys=ON')
}
export function installLegacyProvenance(t: Database.Database, capture = false) {
  requireProvenanceForeignKeys(t)
  t.exec(`CREATE TABLE ${provenanceTable}(
    collection_id INTEGER PRIMARY KEY NOT NULL REFERENCES platform_collection(id) ON DELETE RESTRICT
      CHECK(typeof(collection_id)='integer' AND collection_id BETWEEN 1 AND 9007199254740991),
    origin TEXT NOT NULL CHECK(typeof(origin)='text' AND origin IN ('t04_envelope','supplement')),
    source_identity TEXT NOT NULL CHECK(typeof(source_identity)='text'),
    source_sha256 TEXT NOT NULL CHECK(typeof(source_sha256)='text' AND length(source_sha256)=64 AND length(cast(source_sha256 AS blob))=64 AND source_sha256 NOT GLOB '*[^0-9a-f]*'),
    segment_index INTEGER NOT NULL CHECK(typeof(segment_index)='integer' AND segment_index BETWEEN 0 AND 9007199254740991),
    input_fingerprint TEXT NOT NULL CHECK(typeof(input_fingerprint)='text' AND length(input_fingerprint)=64 AND length(cast(input_fingerprint AS blob))=64 AND input_fingerprint NOT GLOB '*[^0-9a-f]*'),
    import_batch_id INTEGER NOT NULL REFERENCES import_batch(id) ON DELETE RESTRICT
      CHECK(typeof(import_batch_id)='integer' AND import_batch_id BETWEEN 1 AND 9007199254740991),
    created_at TEXT NOT NULL CHECK(typeof(created_at)='text'),
    archive_id INTEGER NOT NULL UNIQUE REFERENCES platform_archive_value(id) ON DELETE RESTRICT
      CHECK(typeof(archive_id)='integer' AND archive_id BETWEEN 1 AND 9007199254740991),
    UNIQUE(source_sha256,segment_index)
  );
  CREATE TRIGGER collection_provenance_no_update BEFORE UPDATE ON ${provenanceTable}
    BEGIN SELECT RAISE(ABORT,'immutable collection provenance'); END;
  CREATE TRIGGER collection_provenance_no_delete BEFORE DELETE ON ${provenanceTable}
    BEGIN SELECT RAISE(ABORT,'immutable collection provenance'); END;
  CREATE TRIGGER collection_provenance_insert BEFORE INSERT ON ${provenanceTable} BEGIN
    SELECT CASE WHEN EXISTS(SELECT 1 FROM ${provenanceTable} WHERE collection_id=NEW.collection_id OR archive_id=NEW.archive_id OR (source_sha256=NEW.source_sha256 AND segment_index=NEW.segment_index))
      THEN RAISE(ABORT,'collection provenance overwrite or source collision') END;
    -- Count JS UTF-16 code units, including NUL, without trimming original text.
    SELECT CASE WHEN (WITH RECURSIVE chars(n,c) AS (
      SELECT 1,replace(NEW.source_identity,char(0),'x')
      UNION ALL SELECT n+1,c FROM chars WHERE n<length(c)
    ) SELECT coalesce(sum(CASE WHEN unicode(substr(c,n,1))>65535 THEN 2 ELSE 1 END),0) FROM chars WHERE length(c)>0) NOT BETWEEN 1 AND 2000
      THEN RAISE(ABORT,'invalid source identity length') END;
    SELECT CASE WHEN NEW.origin='t04_envelope' AND NOT EXISTS(
      SELECT 1 FROM platform_collection_archive_ref r JOIN platform_archive_value a ON a.id=r.archive_id
        JOIN platform_collection c ON c.id=r.owner_id AND c.rule_version${capture ? " IN ('t04-collection-v1','t04-collection-reconcile-slot-v2')" : "='t04-collection-v1'"}
      WHERE r.owner_id=NEW.collection_id AND r.field='legacyProvenance' AND r.sealed=1 AND r.archive_id=NEW.archive_id
        AND a.storage_class='blob' AND typeof(a.bytes)='blob')
      THEN RAISE(ABORT,'T04 provenance requires exact sealed owner') END;
    SELECT CASE WHEN NEW.origin='supplement' AND (
      NOT EXISTS(SELECT 1 FROM platform_collection_archive_ref WHERE owner_id=NEW.collection_id)
      OR EXISTS(SELECT 1 FROM platform_collection_archive_ref WHERE owner_id=NEW.collection_id AND (field='legacyProvenance' OR sealed<>1))
      OR NOT EXISTS(SELECT 1 FROM platform_archive_value WHERE id=NEW.archive_id AND storage_class='text' AND typeof(bytes)='blob' AND json_valid(cast(bytes AS text)) AND json_type(cast(bytes AS text))='object'))
      THEN RAISE(ABORT,'supplement requires independent TEXT JSON archive') END;
    SELECT CASE WHEN EXISTS(SELECT 1 FROM platform_observation_fingerprint_basis WHERE input_archive_id=NEW.archive_id)
      ${refs.map(ref => `OR EXISTS(SELECT 1 FROM ${ref} r WHERE r.archive_id=NEW.archive_id${ref === refs[0] ? " AND NOT (NEW.origin='t04_envelope' AND r.owner_id=NEW.collection_id AND r.field='legacyProvenance' AND r.sealed=1)" : ''})`).join('\n')}
      THEN RAISE(ABORT,'collection provenance archive collision') END;
  END;`)
  for (const ref of refs) t.exec(`CREATE TRIGGER ${ref}_provenance_exclusive BEFORE INSERT ON ${ref}
    WHEN EXISTS(SELECT 1 FROM ${provenanceTable} p WHERE p.archive_id=NEW.archive_id${ref === refs[0] ? " AND NOT (p.origin='t04_envelope' AND p.collection_id=NEW.owner_id AND NEW.field='legacyProvenance' AND NEW.sealed=1)" : ''})
    BEGIN SELECT RAISE(ABORT,'collection provenance archive exclusive'); END;`)
  t.exec(`CREATE TRIGGER fingerprint_basis_provenance_exclusive BEFORE INSERT ON platform_observation_fingerprint_basis
    WHEN EXISTS(SELECT 1 FROM ${provenanceTable} WHERE archive_id=NEW.input_archive_id)
    BEGIN SELECT RAISE(ABORT,'collection provenance archive exclusive'); END;`)
}
