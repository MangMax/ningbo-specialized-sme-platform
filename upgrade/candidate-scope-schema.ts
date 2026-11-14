/** A additive successor; schema infrastructure, no ordinary startup migration. */
import type Database from 'better-sqlite3'
import { candidateScopeCheck, candidateScopeColumns } from './frozen/candidate-scope-schema'
export function installCandidateScopeSchema(t: Database.Database) {
  if (!t.inTransaction || t.pragma('foreign_keys',{simple:true}) !== 1) throw new Error('Candidate schema requires FK ON transaction')
  for (const ddl of [
    'candidate_scope_mask INTEGER', 'candidate_scope_rule TEXT',
    'candidate_scope_archive_id INTEGER REFERENCES platform_archive_value(id) ON DELETE RESTRICT',
    'candidate_scope_rdjb TEXT', 'candidate_scope_title_code TEXT', 'candidate_scope_sequence_no INTEGER',
    "candidate_scope_error TEXT DEFAULT 'not_captured'",
    `candidate_scope_state TEXT NOT NULL DEFAULT 'uncaptured' CONSTRAINT platform_candidate_scope_ck CHECK(${candidateScopeCheck})`,
  ]) t.exec('ALTER TABLE platform_business_observation ADD COLUMN '+ddl)
}
export function installCandidateScopeBarriers(t: Database.Database) {
  if (!t.inTransaction || t.pragma('foreign_keys',{simple:true}) !== 1) throw new Error('Candidate schema requires FK ON transaction')
  const binding = `NEW.candidate_scope_state<>'uncaptured' AND (NEW.candidate_scope_sequence_no IS NOT NEW.sequence_no OR
    NOT EXISTS(SELECT 1 FROM platform_collection c JOIN platform_collection_archive_ref r ON r.owner_id=c.id
      WHERE c.id=NEW.collection_id AND c.rdjb IS NEW.candidate_scope_rdjb AND c.title_code IS NEW.candidate_scope_title_code
        AND r.field='collectionEvidence' AND r.sealed=1 AND r.archive_id=NEW.candidate_scope_archive_id))`
  t.exec(`CREATE TRIGGER platform_candidate_scope_insert BEFORE INSERT ON platform_business_observation WHEN
    EXISTS(SELECT 1 FROM platform_business_observation WHERE id=NEW.id) OR (${binding})
    BEGIN SELECT RAISE(ABORT,'candidate capture context conflict'); END;
  CREATE TRIGGER platform_candidate_scope_update BEFORE UPDATE ON platform_business_observation WHEN
    ${[...candidateScopeColumns,'id','collection_id','sequence_no'].map(n=>`NEW.${n} IS NOT OLD.${n}`).join(' OR ')}
    BEGIN SELECT RAISE(ABORT,'immutable candidate capture'); END;
  CREATE TRIGGER platform_candidate_scope_delete BEFORE DELETE ON platform_business_observation
    BEGIN SELECT RAISE(ABORT,'immutable candidate capture'); END;
  CREATE TRIGGER platform_candidate_collection_update BEFORE UPDATE ON platform_collection WHEN
    (NEW.id IS NOT OLD.id OR NEW.rdjb IS NOT OLD.rdjb OR NEW.title_code IS NOT OLD.title_code)
    AND EXISTS(SELECT 1 FROM platform_business_observation WHERE collection_id=OLD.id)
    BEGIN SELECT RAISE(ABORT,'immutable candidate collection context'); END;`)
}
