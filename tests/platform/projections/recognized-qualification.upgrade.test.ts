import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { expect, it } from 'vitest'
import { createRuntimeSchema } from '../../../db/create-runtime'
import { targetSchema } from '../../../layers/sme-roster/lib/platform/target-schema'
import { ensureRecognizedTargetContent } from '../../../layers/sme-roster/lib/platform/recognized-target-writer'
import { planPlatformObservation } from '../../../layers/sme-roster/lib/platform/observation-plan'
import { upgradeRecognizedQualification } from '../../../upgrade/recognized-qualification'
import { captureFingerprintBasis } from '../../../layers/sme-roster/lib/platform/fingerprint-capture'

function fixture() {
  const s = new Database(':memory:')
  s.pragma('foreign_keys=ON'); createRuntimeSchema(s)
  const db = drizzle(s, { schema: targetSchema })
  for (const [id, raw] of [
    ['one', { rdtime: '2023-12-28 08:50:25', sfyx: '1', szsmc: '宁波市', sxsj: '' }],
    ['two', { rdtime: ' 2026-03-06 ', sfyx: 0 }],
  ] as const) db.transaction(tx => ensureRecognizedTargetContent(tx, planPlatformObservation({ interface: 'recognized_list', relationKey: id, rawFields: { id, ...raw } })))
  for (const name of ['source_recognized_at','source_valid_flag','source_invalidated_at','source_invalidation_reason','source_province_name','source_city_name','source_district_name','qualification_fields_rule']) s.exec(`ALTER TABLE platform_recognized_projection DROP COLUMN ${name}`)
  return s
}
function originals(s: Database.Database) {
  const tables = s.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name<>'platform_recognized_projection' ORDER BY name").all() as { name: string }[]
  const columns = s.prepare('PRAGMA table_info(platform_recognized_projection)').all() as { name: string }[]
  const added = ['source_recognized_at','source_valid_flag','source_invalidated_at','source_invalidation_reason','source_province_name','source_city_name','source_district_name','qualification_fields_rule']
  return [tables.map(t => s.prepare(`SELECT * FROM "${t.name}" ORDER BY rowid`).all()), s.prepare(`SELECT ${columns.map(c => c.name).filter(c => !added.includes(c)).join(',')} FROM platform_recognized_projection ORDER BY id`).all(), s.prepare('SELECT * FROM sqlite_sequence ORDER BY name').all()]
}
it('explicitly upgrades old native schema and replays bounded archived qualification capture without replacing facts', () => {
  const s = fixture()
  try {
    const before = originals(s)
    expect(upgradeRecognizedQualification(s, { batchSize: 1 })).toEqual({ captured: 2, unavailable: 0 })
    expect(s.prepare('SELECT source_recognized_at,source_valid_flag,source_city_name,source_invalidated_at,qualification_fields_rule FROM platform_recognized_projection ORDER BY id').all()).toEqual([
      { source_recognized_at: '2023-12-28 08:50:25', source_valid_flag: '1', source_city_name: '宁波市', source_invalidated_at: '', qualification_fields_rule: 'recognized-qualification-fields-v1' },
      { source_recognized_at: ' 2026-03-06 ', source_valid_flag: 0, source_city_name: null, source_invalidated_at: null, qualification_fields_rule: 'recognized-qualification-fields-v1' },
    ])
    expect(originals(s)).toEqual(before)
    expect(upgradeRecognizedQualification(s, { batchSize: 1 })).toEqual({ captured: 0, unavailable: 0 })
    expect(originals(s)).toEqual(before)
    expect(s.pragma('foreign_key_check')).toEqual([])
  } finally { s.close() }
})
it('rolls back the interrupted batch and resumes already committed batches', () => {
  const s = fixture()
  try {
    const before = originals(s)
    expect(() => upgradeRecognizedQualification(s, { batchSize: 1, beforeCommit(id) { if (id === 2) throw new Error('interrupted') } })).toThrow('interrupted')
    expect(s.prepare('SELECT qualification_fields_rule FROM platform_recognized_projection ORDER BY id').all()).toEqual([{ qualification_fields_rule: 'recognized-qualification-fields-v1' }, { qualification_fields_rule: null }])
    expect(upgradeRecognizedQualification(s, { batchSize: 1 })).toEqual({ captured: 1, unavailable: 0 })
    expect(originals(s)).toEqual(before)
  } finally { s.close() }
})
import { writeNewCollectionTarget, type NewCollectionTargetCommand } from '../../../layers/sme-roster/lib/platform/collection-target-command'
import { platformResultToImport } from '../../../layers/sme-roster/lib/platform/recognized-evidence'
import type { PlatformRawRow } from '../../../layers/sme-roster/lib/platform/types'
import type { PlatformLiveQueryResult } from '../../../layers/sme-roster/lib/platform/live-query'
function collectionCommand(row: PlatformRawRow, queriedAt: string): NewCollectionTargetCommand {
  const evidence: PlatformLiveQueryResult = {
    source: 'queryBusList', status: 'success', effectiveConditions: { name: 'Example', combination: 'and' },
    titleScope: { mode: 'selected', rdjb: ['2'] }, queriedAt, completedAt: queriedAt,
    rows: [Object.fromEntries(Object.entries(row).map(([key, value]) => [key, value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value)]))], dataRows: [row], pages: [{ source: 'queryBusList', rdjb: '2', page: 1, maxPage: 1, status: 'success', fetchedCount: 1, declaredTotal: 1, error: null }],
    fetchedCount: 1, declaredTotal: 1, completeness: 'complete', fullRange: true, unfinished: [], error: null,
    limits: { maxRequests: 100, maxRows: 5000, maxDurationMs: 60000, pageSize: 50 },
  }
  const query = platformResultToImport(evidence)
  return { queryText: JSON.stringify(query), evidenceText: JSON.stringify(evidence), createdAt: queriedAt, assignments: (query.relations ?? []).map(r => ({ enterpriseId: null, matchBasis: 'none', verificationStatus: 'pending', nameRaw: r.nameRaw ?? null, origin: 'command', actor: { type: 'agent', id: 'test808' }, basis: 'source capture', recordedAt: null })) }
}
it('fills observation and version owners from their own archives', () => {
  const s = new Database(':memory:')
  try {
    s.pragma('foreign_keys=ON'); createRuntimeSchema(s)
    const db = drizzle(s, { schema: targetSchema })
    writeNewCollectionTarget(db, collectionCommand({ id: 'observed', qymc: 'Example', rdjb: '2', rdtime: '2024-02-19', sfyx: '1', szsmc: '宁波市' }, '2026-11-16T00:00:00Z'))
    writeNewCollectionTarget(db, collectionCommand({ id: 'observed', qymc: 'Example', rdjb: '2', rdtime: '2024-02-19', sfyx: '1', szsmc: '宁波市' }, '2026-11-16T01:00:00Z'))
    const before = originals(s)
    s.exec('UPDATE platform_recognized_projection SET qualification_fields_rule=NULL,source_recognized_at=NULL,source_valid_flag=NULL,source_city_name=NULL')
    expect(upgradeRecognizedQualification(s, { batchSize: 1 })).toEqual({ captured: 3, unavailable: 0 })
    expect(s.prepare('SELECT source_recognized_at,source_city_name FROM platform_recognized_projection ORDER BY id').all()).toEqual([
      { source_recognized_at: '2024-02-19', source_city_name: '宁波市' },
      { source_recognized_at: '2024-02-19', source_city_name: '宁波市' },
      { source_recognized_at: '2024-02-19', source_city_name: '宁波市' },
    ])
    expect(originals(s)).toEqual(before)
  } finally { s.close() }
})
it('reports an observation without archived raw and leaves its fields uncaptured on replay', () => {
  const s = new Database(':memory:')
  try {
    s.pragma('foreign_keys=ON'); createRuntimeSchema(s)
    // Explicit historical SQL fixture: normal collection commands require raw/evidence
    // agreement and cannot manufacture a missing original archive.
    s.transaction(() => {
    const fingerprint = captureFingerprintBasis(drizzle(s, { schema: targetSchema }), 1, 'target-command-v1', Buffer.from('{"row":{"rawFields":null}}'))
    s.exec(`INSERT INTO platform_collection(id,interface,query_key,rdjb,queried_at,created_at,status,completeness,provenance_state,parse_state,rule_version)
      VALUES(1,'recognized_list','historical','2','old','old','success','unknown','unknown','absent','old');
      INSERT INTO platform_business_observation(id,collection_id,sequence_no,position_state,identity_state,content_state,key_source,projection_rule_version,input_fingerprint,indexed_at)
      VALUES(1,1,1,'unknown','not_indexed','not_indexed',NULL,NULL,NULL,NULL);
      INSERT INTO platform_archive_value(id,storage_class,bytes,byte_length,sha256,created_at) VALUES(2,'null',NULL,NULL,NULL,'old');
      INSERT INTO platform_observation_archive_ref(owner_id,field,archive_id,sealed) VALUES(1,'rawFields',2,1);`)
    const fields: Record<string, unknown> = { observation_id: 1, basis: 'unavailable', source_archive_id: 2, parse_state: 'absent', source_title_kind: 'absent', source_title_rule_version: 'old', rule_version: 'old', created_at: 'old', exact_title_state: 'captured', exact_title_origin: 'commandInput', exact_title_archive_id: 1, exact_title_sha256: fingerprint }
    for (const name of ['province','status','batch','declare_kind','applied_at','award_batch_label','year']) Object.assign(fields, { [`stored_${name}_kind`]: 'absent', [`parsed_${name}_kind`]: 'absent', [`${name}_conflict`]: 0 })
    s.prepare(`INSERT INTO platform_recognized_projection(${Object.keys(fields).join(',')}) VALUES(${Object.keys(fields).map(() => '?').join(',')})`).run(...Object.values(fields))
    })()
    const before = originals(s), gaps: unknown[] = []
    expect(upgradeRecognizedQualification(s, { batchSize: 1, onUnavailable(id, reason) { gaps.push({ id, reason }) } })).toEqual({ captured: 0, unavailable: 1 })
    const projection = s.prepare('SELECT id,qualification_fields_rule FROM platform_recognized_projection WHERE observation_id=1').get() as {id:number;qualification_fields_rule:null}
    expect(projection.qualification_fields_rule).toBeNull()
    expect(gaps).toEqual([{ id: projection.id, reason: 'archived_raw_unavailable' }])
    expect(upgradeRecognizedQualification(s, { batchSize: 1 })).toEqual({ captured: 0, unavailable: 1 })
    expect(originals(s)).toEqual(before)
  } finally { s.close() }
})
