import { expect, it } from 'vitest'
import { platformBusinessFact, sourceDate, periodContains } from '../../../lib/roster/platform-qualification'

it('retains day boundaries and exact business timestamps without fabricating precision', () => {
  expect(sourceDate('2026-12-28')).toEqual({ raw: '2026-12-28', value: '2026-12-28', precision: 'day' })
  expect(sourceDate('2023-12-28 08:50:25')).toEqual({ raw: '2023-12-28 08:50:25', value: '2023-12-28T08:50:25', precision: 'second' })
  expect(periodContains(sourceDate('2023-12-28 08:50:25'), sourceDate('2026-12-28'), '2026-12-28T23:59:59')).toBe(true)
  expect(periodContains(sourceDate('2023-12-28 08:50:25'), sourceDate('2026-12-28'), '2026-12-29T00:00:00')).toBe(false)
  expect(periodContains(sourceDate('2023-12-28 08:50:25'), sourceDate('2026-12-28'), '2023-12-28T08:50:24')).toBe(false)
  expect(periodContains(sourceDate('2023-12-28 08:50:25'), sourceDate('2026-12-28'), '2023-12-28T08:50:25')).toBe(true)
  expect(sourceDate('2026-02-30')).toEqual({ raw: '2026-02-30', value: null, precision: 'unknown' })
})

it('interprets archived businessList final review without inventing its missing year', () => {
  // Archived SQ332024082317756: year is empty, sqsj is submission time.
  expect(platformBusinessFact('business_list', { declareKind: 'review', status: '终审通过', year: null, appliedAt: '2024-09-14 13:59:23' })).toMatchObject({ matter: 'review', conclusion: 'passed', businessYear: null, periodReason: 'period_unknown' })
})
it('interprets queryList explicit year separately from intermediate provincial review', () => {
  expect(platformBusinessFact('apply_list', { declareKind: 'apply', status: '终审通过', year: 2021, appliedAt: '2021-05-03 08:06:00' })).toMatchObject({ matter: 'apply', conclusion: 'passed', businessYear: 2021, periodReason: 'explicit_business_year' })
  expect(platformBusinessFact('apply_list', { declareKind: 'review', status: '省已审', year: 2024, appliedAt: null })).toMatchObject({ conclusion: 'processing', statusRaw: '省已审' })
})
it('retains unknown source status and never renews from an update or submission time', () => {
  expect(platformBusinessFact('business_list', { declareKind: 'update', status: '终审通过', year: 2026, appliedAt: '2026-01-01' })).toMatchObject({ matter: 'update', conclusion: 'passed', businessYear: 2026, periodReason: 'update_does_not_renew' })
  expect(platformBusinessFact('apply_list', { declareKind: '新事项', status: '新状态 ', year: null, appliedAt: '2026-01-01' })).toMatchObject({ matter: 'unknown', conclusion: 'unknown', statusRaw: '新状态 ', matterRaw: '新事项', businessYear: null })
})

import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { createRuntimeSchema } from '../../../db/create-runtime'
import { targetSchema } from '../../../lib/platform/target-schema'
import { writeNewCollectionTarget, type NewCollectionTargetCommand } from '../../../lib/platform/collection-target-command'
import { platformResultToImport } from '../../../lib/platform/recognized-evidence'
import type { PlatformRawRow } from '../../../lib/platform/types'
import type { PlatformLiveQueryResult } from '../../../lib/platform/live-query'
import { processFactsFromRow } from '../../../lib/platform/identity'
import { readPlatformQualificationFacts } from '../../../lib/roster/platform-qualification'
function collectionCommand(row: PlatformRawRow, queriedAt: string, source: PlatformLiveQueryResult['source'] = 'queryBusList'): NewCollectionTargetCommand {
  const evidence: PlatformLiveQueryResult = {
    source, status: 'success', effectiveConditions: source === 'businessList' ? { uscc: String(row.tyshxydm), combination: 'and' } : { name: 'Example', combination: 'and' },
    titleScope: source === 'queryList' ? { mode: 'source_default', rdjb: [] } : { mode: 'selected', rdjb: [String(row.rdjb ?? '2')] }, queriedAt, completedAt: queriedAt,
    rows: [Object.fromEntries(Object.entries(row).map(([key, value]) => [key, value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value)]))], dataRows: [row], pages: [{ source, rdjb: source === 'queryList' ? null : String(row.rdjb ?? '2'), page: 1, maxPage: 1, status: 'success', fetchedCount: 1, declaredTotal: 1, error: null }],
    fetchedCount: 1, declaredTotal: 1, completeness: 'complete', fullRange: true, unfinished: [], error: null,
    limits: { maxRequests: 100, maxRows: 5000, maxDurationMs: 60000, pageSize: 50 },
  }
  const query = platformResultToImport(evidence)
  if (source !== 'queryBusList') query.relations = query.relations?.map(r => ({ ...r, ...processFactsFromRow(evidence.rows[0]!) }))
  return { queryText: JSON.stringify(query), evidenceText: JSON.stringify(evidence), createdAt: queriedAt, assignments: (query.relations ?? []).map(r => ({ enterpriseId: null, matchBasis: 'none', verificationStatus: 'pending', nameRaw: r.nameRaw ?? null, usccRaw: r.usccRaw ?? null, origin: 'command', actor: { type: 'agent', id: 'fact-reader-test' }, basis: 'source capture', recordedAt: null })) }
}

it('automatically groups four archived periods by code without assignments or moved-in decisions', () => {
  const sqlite = new Database(':memory:')
  try {
    sqlite.pragma('foreign_keys=ON'); createRuntimeSchema(sqlite)
    const db = drizzle(sqlite, { schema: targetSchema })
    // Literal period values independently transcribed from the four verified archives.
    const samples = [
      ['91310115MA1H7KUG93', '2026-03-06 00:00:00', '2029-03-05 23:59:59'],
      ['91310114MA1GYDE2XE', '2024-02-19 00:00:00', '2027-02-18 23:59:59'],
      ['91440300MA5G2DGE3R', '2024-01-17 16:01:06', '2027-01-17'],
      ['91330110MA2GMDFH58', '2023-12-28 08:50:25', '2026-12-28'],
    ] as const
    samples.forEach(([code, from, until], i) => writeNewCollectionTarget(db, collectionCommand({ id: `recognized-${i}`, tyshxydm: code, qymc: '原平台名', rdjb: '2', rdtime: from, rddqrq: until, sfyx: '1', szsmc: '宁波市', whpc: '2023-7' }, `2026-11-16T00:00:0${i}Z`)))
    const subjects = samples.map(([uscc], i) => ({ enterpriseId: i + 1, uscc }))
    const facts = readPlatformQualificationFacts(db, subjects)
    expect(facts.map(f => [f.enterpriseId, f.title, f.period.from.raw, f.period.until.raw, f.location.city])).toEqual([
      [1, 'specialized_sme', '2026-03-06 00:00:00', '2029-03-05 23:59:59', '宁波市'],
      [2, 'specialized_sme', '2024-02-19 00:00:00', '2027-02-18 23:59:59', '宁波市'],
      [3, 'specialized_sme', '2024-01-17 16:01:06', '2027-01-17', '宁波市'],
      [4, 'specialized_sme', '2023-12-28 08:50:25', '2026-12-28', '宁波市'],
    ])
    expect(facts.every(f => f.platformName === '原平台名' && f.businessYear === null)).toBe(true)
    const ambiguous = readPlatformQualificationFacts(db, [...subjects, { enterpriseId: 99, uscc: samples[0][0] }])
    expect(ambiguous[0]).toMatchObject({ enterpriseId: null, reasons: ['identity_ambiguous'] })
  } finally { sqlite.close() }
})
it('deduplicates observations and uses latest content including a negative version', () => {
  const sqlite = new Database(':memory:')
  try {
    sqlite.pragma('foreign_keys=ON'); createRuntimeSchema(sqlite)
    const db = drizzle(sqlite, { schema: targetSchema })
    const row = { id: 'stable', tyshxydm: '91330110MA2GMDFH58', qymc: '原名', rdjb: '2', rdtime: '2023-12-28 08:50:25', rddqrq: '2026-12-28', sfyx: '1' }
    const first = writeNewCollectionTarget(db, collectionCommand(row, '2026-11-16T00:00:00Z')).observations[0]!
    writeNewCollectionTarget(db, collectionCommand(row, '2026-11-16T01:00:00Z'))
    const subjects = [{ enterpriseId: 7, uscc: row.tyshxydm }]
    expect(readPlatformQualificationFacts(db, subjects)).toHaveLength(1)
    const changed = writeNewCollectionTarget(db, collectionCommand({ ...row, sfyx: '0', sxsj: '2026-11-16', sxyy: '取消' }, '2026-11-16T02:00:00Z')).observations[0]!
    expect(changed.versionId).not.toBe(first.versionId)
    expect(readPlatformQualificationFacts(db, subjects)).toMatchObject([{ enterpriseId: 7, versionId: changed.versionId, conclusion: 'invalid', invalidationReason: '取消' }])
    // A transport failure has no source rows; the last business version remains selected.
    const failed = collectionCommand(row, '2026-11-16T03:00:00Z')
    const evidence: PlatformLiveQueryResult = JSON.parse(failed.evidenceText!)
    evidence.rows = []; evidence.dataRows = []; evidence.fetchedCount = 0; evidence.declaredTotal = null
    evidence.status = 'failed'; evidence.completeness = 'partial'
    evidence.unfinished = [{ source: 'queryBusList', rdjb: '2', page: 1 }]
    evidence.error = { code: 'upstream_failed', message: 'transport failed' }
    evidence.pages = [{ source: 'queryBusList', rdjb: '2', page: 1, fetchedCount: 0, declaredTotal: null, status: 'failed', error: evidence.error }]
    writeNewCollectionTarget(db, { queryText: JSON.stringify(platformResultToImport(evidence)), evidenceText: JSON.stringify(evidence), assignments: [], createdAt: evidence.queriedAt })
    expect(readPlatformQualificationFacts(db, subjects)).toMatchObject([{ versionId: changed.versionId, conclusion: 'invalid' }])
    writeNewCollectionTarget(db, collectionCommand({ ...row, sfyx: '新状态' }, '2026-11-16T04:00:00Z'))
    expect(readPlatformQualificationFacts(db, subjects)).toMatchObject([{ conclusion: 'unknown', statusRaw: '新状态', reasons: ['status_unknown'] }])
  } finally { sqlite.close() }
})

it('reads source-specific process projections in the same batch and preserves unknown results', () => {
  const sqlite = new Database(':memory:')
  try {
    sqlite.pragma('foreign_keys=ON'); createRuntimeSchema(sqlite)
    const db = drizzle(sqlite, { schema: targetSchema })
    const base = { tyshxydm: '91330200780449027G', qymc: '原平台名', rdjb: '3', szsfmc: '宁波市' }
    writeNewCollectionTarget(db, collectionCommand({ ...base, id: 'review', sblx: '复核', cszt: '终审通过', year: '', sqsj: '2024-09-14 13:59:23' }, '2026-11-16T00:00:00Z', 'businessList'))
    writeNewCollectionTarget(db, collectionCommand({ ...base, id: 'award', sblx: '申请', cszt: '终审通过', year: '2021', sqsj: '2021-05-03 08:06:00' }, '2026-11-16T01:00:00Z', 'queryList'))
    writeNewCollectionTarget(db, collectionCommand({ ...base, id: 'unknown', sblx: '更新', cszt: '未知原状态', year: '', sqsj: '' }, '2026-11-16T02:00:00Z', 'queryList'))
    expect(readPlatformQualificationFacts(db, [{ enterpriseId: 1, uscc: base.tyshxydm }])).toMatchObject([
      { source: 'business_list', matter: 'review', conclusion: 'passed', businessYear: null, periodReason: 'period_unknown' },
      { source: 'apply_list', matter: 'apply', conclusion: 'passed', businessYear: 2021, periodReason: 'explicit_business_year' },
      { source: 'apply_list', matter: 'update', conclusion: 'unknown', statusRaw: '未知原状态', periodReason: 'update_does_not_renew' },
    ])
  } finally { sqlite.close() }
})

it('selects normalized raw keys across sources and suppresses old identity before restoring a reobserved version', () => {
  const sqlite = new Database(':memory:')
  try {
    sqlite.pragma('foreign_keys=ON'); createRuntimeSchema(sqlite)
    const db = drizzle(sqlite, { schema: targetSchema })
    const subjects = [{ enterpriseId: 7, uscc: '91330110MA2GMDFH58' }]
    const row = { id: 'identity-change', tyshxydm: ' 91330110ma2g\u200bdmfh58\u00a0', qymc: '原名', rdjb: '2', rdtime: '2023-12-28 08:50:25', rddqrq: '2026-12-28', sfyx: '1' }
    const first = writeNewCollectionTarget(db, collectionCommand(row, '2026-11-16T00:00:00Z')).observations[0]!
    const original = readPlatformQualificationFacts(db, subjects)
    expect(original).toMatchObject([{ enterpriseId: 7, uscc: '91330110MA2GMDFH58', versionId: first.versionId, observationId: first.observationId, conclusion: 'passed' }])
    // Same timestamp: observation id decides, even though the new identity is outside scope.
    writeNewCollectionTarget(db, collectionCommand({ ...row, tyshxydm: '91310115MA1H7KUG93', rdjb: '3' }, '2026-11-16T00:00:00Z'))
    expect(readPlatformQualificationFacts(db, subjects)).toEqual([])
    const restored = writeNewCollectionTarget(db, collectionCommand(row, '2026-11-16T01:00:00Z')).observations[0]!
    expect(restored.versionId).toBe(first.versionId)
    expect(readPlatformQualificationFacts(db, subjects)).toEqual(original.map(f => ({ ...f, observationId: restored.observationId, collectedAt: '2026-11-16T01:00:00Z' })))
    for (const source of ['businessList', 'queryList'] as const) {
      writeNewCollectionTarget(db, collectionCommand({ ...row, id: source, sblx: '申请', cszt: '终审通过', year: '2021' }, '2026-11-16T02:00:00Z', source))
    }
    expect(readPlatformQualificationFacts(db, subjects).map(f => [f.source, f.uscc, f.conclusion])).toEqual([
      ['recognized_list', '91330110MA2GMDFH58', 'passed'], ['business_list', '91330110MA2GMDFH58', 'passed'], ['apply_list', '91330110MA2GMDFH58', 'passed'],
    ])
  } finally { sqlite.close() }
})

it('uses actual Drizzle raw-key plans while unrelated observations leave typed results unchanged', () => {
  const sqlite = new Database(':memory:')
  try {
    sqlite.pragma('foreign_keys=ON'); createRuntimeSchema(sqlite)
    const queries: { sql: string; params: unknown[] }[] = []
    const db = drizzle(sqlite, { schema: targetSchema, logger: { logQuery(sql, params) { queries.push({ sql, params }) } } })
    const row = { id: 'scoped', tyshxydm: '91330110MA2GMDFH58', qymc: '原名', rdjb: '2', sfyx: '1' }
    for (const source of ['queryBusList', 'businessList', 'queryList'] as const) {
      writeNewCollectionTarget(db, collectionCommand(row, '2026-11-16T00:00:00Z', source))
    }
    const subjects = [{ enterpriseId: 7, uscc: row.tyshxydm }]
    const before = readPlatformQualificationFacts(db, subjects)
    expect(before.map(f => f.source)).toEqual(['recognized_list', 'business_list', 'apply_list'])
    for (let i = 0; i < 40; i++) {
      for (const source of ['queryBusList', 'businessList', 'queryList'] as const) {
        writeNewCollectionTarget(db, collectionCommand({ ...row, id: `unrelated-${i}`, tyshxydm: '91310115MA1H7KUG93' }, `2026-11-16T00:01:${String(i).padStart(2, '0')}Z`, source))
      }
    }
    queries.length = 0
    expect(readPlatformQualificationFacts(db, subjects)).toEqual(before)
    // EXPLAIN the SQL emitted by the real reader, never a manually rewritten equivalent.
    const reads = queries.filter(q => q.sql.startsWith('select'))
    expect(reads).toHaveLength(6)
    for (const query of reads) {
      const plan = sqlite.prepare(`EXPLAIN QUERY PLAN ${query.sql}`).all(...query.params) as { detail: string }[]
      const details = plan.map(p => p.detail).join('\n')
      if (query.sql.startsWith('select distinct')) {
        expect(details).toMatch(/COVERING INDEX platform_.*_projection_uscc_idx/)
        expect(details).not.toContain('TEMP B-TREE')
      } else {
        expect(query.params).toContain(row.tyshxydm)
        expect(details).toMatch(/SEARCH .*USING INDEX platform_.*_projection_uscc_idx/)
        expect(details).not.toMatch(/SCAN platform_business_observation/)
      }
    }
  } finally { sqlite.close() }
})
