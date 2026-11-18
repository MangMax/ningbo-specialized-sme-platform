import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { expect, it } from 'vitest'
import { createRuntimeSchema } from '../../../db/create-runtime'
import { targetSchema } from '../../../layers/sme-roster/lib/platform/target-schema'
import { parseRecognizedQualificationFields } from '../../../layers/sme-roster/lib/platform/recognized-projection'
import { ensureRecognizedTargetContent } from '../../../layers/sme-roster/lib/platform/recognized-target-writer'
import { planPlatformObservation } from '../../../layers/sme-roster/lib/platform/observation-plan'

const raw = { id: 'recognized-808', rdtime: '2023-12-28 08:50:25', rddqrq: '2026-12-28', sfyx: '1', sxsj: '', sxyy: '', szsfmc: '浙江省', szsmc: '宁波市', szqmc: '海曙区', szq: '133020300' }
const expected = { sourceRecognizedAt: '2023-12-28 08:50:25', sourceValidFlag: '1', sourceInvalidatedAt: '', sourceInvalidationReason: '', sourceProvinceName: '浙江省', sourceCityName: '宁波市', sourceDistrictName: '海曙区', qualificationFieldsRule: 'recognized-qualification-fields-v1' }
it('preserves recognized dates flags and geographic names verbatim', () => {
  expect(parseRecognizedQualificationFields(raw)).toEqual(expected)
  expect(parseRecognizedQualificationFields({ rdtime: ' 2026-03-06 ', sfyx: 0, sxsj: '2026-11-16 12:00:01', sxyy: ' 取消 ', szq: '133020300' })).toEqual({ sourceRecognizedAt: ' 2026-03-06 ', sourceValidFlag: 0, sourceInvalidatedAt: '2026-11-16 12:00:01', sourceInvalidationReason: ' 取消 ', sourceProvinceName: null, sourceCityName: null, sourceDistrictName: null, qualificationFieldsRule: 'recognized-qualification-fields-v1' })
})
it('retains day and instant precision without inventing missing fields', () => {
  expect(parseRecognizedQualificationFields({ rdtime: '2026-03-06' }).sourceRecognizedAt).toBe('2026-03-06')
  expect(parseRecognizedQualificationFields(null)).toEqual({ sourceRecognizedAt: null, sourceValidFlag: null, sourceInvalidatedAt: null, sourceInvalidationReason: null, sourceProvinceName: null, sourceCityName: null, sourceDistrictName: null, qualificationFieldsRule: 'recognized-qualification-fields-v1' })
})
it('completes an existing content version on recollection without replacing identity or archived bytes', () => {
  const sqlite = new Database(':memory:')
  try {
    sqlite.pragma('foreign_keys=ON'); createRuntimeSchema(sqlite)
    const db = drizzle(sqlite, { schema: targetSchema })
    const plan = planPlatformObservation({ interface: 'recognized_list', relationKey: raw.id, rawFields: raw })
    const first = db.transaction(tx => ensureRecognizedTargetContent(tx, plan))
    expect(sqlite.prepare('SELECT source_recognized_at, source_valid_flag, source_city_name, source_validity_date FROM platform_recognized_projection WHERE version_id=?').get(first.versionId)).toEqual({ source_recognized_at: '2023-12-28 08:50:25', source_valid_flag: '1', source_city_name: '宁波市', source_validity_date: '2026-12-28' })
    const before = sqlite.prepare('SELECT * FROM platform_business_record_version').all()
    // An earlier capture legitimately predates the additive fields.
    sqlite.prepare('UPDATE platform_recognized_projection SET qualification_fields_rule=NULL, source_recognized_at=NULL, source_valid_flag=NULL, source_invalidated_at=NULL, source_invalidation_reason=NULL, source_province_name=NULL, source_city_name=NULL, source_district_name=NULL').run()
    const second = db.transaction(tx => ensureRecognizedTargetContent(tx, plan))
    expect(second).toMatchObject({ recordId: first.recordId, versionId: first.versionId })
    expect(sqlite.prepare('SELECT source_recognized_at, source_city_name, qualification_fields_rule FROM platform_recognized_projection').get()).toEqual({ source_recognized_at: '2023-12-28 08:50:25', source_city_name: '宁波市', qualification_fields_rule: 'recognized-qualification-fields-v1' })
    expect(sqlite.prepare('SELECT * FROM platform_business_record_version').all()).toEqual(before)
    expect(sqlite.pragma('foreign_key_check')).toEqual([])
  } finally { sqlite.close() }
})

import { writeNewCollectionTarget, type NewCollectionTargetCommand } from '../../../layers/sme-roster/lib/platform/collection-target-command'
import { writeRecognizedTarget, type RecognizedTargetInput } from '../../../layers/sme-roster/lib/platform/recognized-target-writer'
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
it('preserves new and repeated observations and records a changed source version independently', () => {
  const sqlite = new Database(':memory:')
  try {
    sqlite.pragma('foreign_keys=ON'); createRuntimeSchema(sqlite)
    const db = drizzle(sqlite, { schema: targetSchema })
    const row = { ...raw, qymc: 'Example', rdjb: '2' }
    const a = writeNewCollectionTarget(db, collectionCommand(row, '2026-11-16T00:00:00Z')).observations[0]!
    const b = writeNewCollectionTarget(db, collectionCommand(row, '2026-11-16T01:00:00Z')).observations[0]!
    expect(b.versionId).toBe(a.versionId)
    expect(b.observationId).not.toBe(a.observationId)
    expect(sqlite.prepare('SELECT source_recognized_at, source_validity_date, source_valid_flag, source_invalidated_at, source_invalidation_reason, source_province_name, source_city_name, source_district_name, qualification_fields_rule FROM platform_recognized_projection ORDER BY id').all()).toEqual([1, 2, 3].map(() => ({ source_recognized_at: '2023-12-28 08:50:25', source_validity_date: '2026-12-28', source_valid_flag: '1', source_invalidated_at: '', source_invalidation_reason: '', source_province_name: '浙江省', source_city_name: '宁波市', source_district_name: '海曙区', qualification_fields_rule: 'recognized-qualification-fields-v1' })))
    // Retry the exact captured command, as opposed to a newly collected observation.
    const input = sqlite.prepare('SELECT v.bytes FROM platform_observation_fingerprint_basis f JOIN platform_archive_value v ON v.id=f.input_archive_id WHERE f.observation_id=?').get(a.observationId) as { bytes: Buffer }
    const command = JSON.parse(input.bytes.toString()) as RecognizedTargetInput
    sqlite.prepare('UPDATE platform_recognized_projection SET qualification_fields_rule=NULL,source_city_name=NULL WHERE observation_id=? OR version_id=?').run(a.observationId, a.versionId)
    expect(writeRecognizedTarget(db, command)).toMatchObject({ observationId: a.observationId, versionId: a.versionId, reused: true })
    expect(sqlite.prepare('SELECT source_city_name FROM platform_recognized_projection WHERE observation_id=? OR version_id=?').all(a.observationId, a.versionId)).toEqual([{ source_city_name: '宁波市' }, { source_city_name: '宁波市' }])
    const c = writeNewCollectionTarget(db, collectionCommand({ ...row, sfyx: '0', sxsj: '2026-11-16 12:00:01', sxyy: '取消' }, '2026-11-16T13:00:00Z')).observations[0]!
    expect(c.recordId).toBe(a.recordId); expect(c.versionId).not.toBe(a.versionId)
    expect(sqlite.prepare('SELECT source_valid_flag,source_invalidated_at,source_invalidation_reason FROM platform_recognized_projection WHERE observation_id=?').get(c.observationId)).toEqual({ source_valid_flag: '0', source_invalidated_at: '2026-11-16 12:00:01', source_invalidation_reason: '取消' })
    expect(sqlite.pragma('foreign_key_check')).toEqual([])
  } finally { sqlite.close() }
})

it('rejects conflicting retry content and rolls back an aborted collection transaction', () => {
  const sqlite = new Database(':memory:')
  try {
    sqlite.pragma('foreign_keys=ON'); createRuntimeSchema(sqlite)
    const db = drizzle(sqlite, { schema: targetSchema })
    const a = writeNewCollectionTarget(db, collectionCommand({ ...raw, qymc: 'Example', rdjb: '2' }, '2026-11-16T00:00:00Z')).observations[0]!
    const input = sqlite.prepare('SELECT v.bytes FROM platform_observation_fingerprint_basis f JOIN platform_archive_value v ON v.id=f.input_archive_id WHERE f.observation_id=?').get(a.observationId) as { bytes: Buffer }
    const command = JSON.parse(input.bytes.toString()) as RecognizedTargetInput
    const before = sqlite.serialize()
    command.row.rawFields = { ...command.row.rawFields, sfyx: '0' }
    expect(() => writeRecognizedTarget(db, command)).toThrow('observation_payload_conflict')
    expect(sqlite.serialize().equals(before), 'database bytes remain unchanged').toBe(true)
    const newCollection = collectionCommand({ ...raw, id: 'recognized-808-new', qymc: 'Example', rdjb: '2' }, '2026-11-16T01:00:00Z')
    expect(() => db.transaction(tx => {
      writeNewCollectionTarget(tx, newCollection)
      throw new Error('caller aborted transaction')
    })).toThrow('caller aborted transaction')
    expect(sqlite.serialize().equals(before), 'database bytes remain unchanged').toBe(true)
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM platform_business_record').get()).toEqual({ n: 1 })
    expect(sqlite.pragma('foreign_key_check')).toEqual([])
  } finally { sqlite.close() }
})
