import { expect, it } from 'vitest'
import { enterpriseBusinessTimeline } from '../../../layers/sme-roster/lib/roster/enterprise-business-timeline'
import { sourceDate, type PlatformQualificationFact } from '../../../layers/sme-roster/lib/roster/platform-qualification'

const fact: PlatformQualificationFact = {
  enterpriseId: 7, uscc: '91310115MA1H7KUG93', title: 'specialized_sme', source: 'recognized_list',
  platformName: '平台名称', recordId: 1, versionId: 2, observationId: 3, collectedAt: '2026-11-16T00:00:00Z',
  matter: 'recognition', matterRaw: null, conclusion: 'passed', statusRaw: '1',
  businessTime: sourceDate('2026-03-06'), businessTimeKind: 'recognition', businessYear: null,
  period: { from: sourceDate('2026-03-06'), until: sourceDate('2029-03-05') }, periodReason: 'explicit_period',
  location: { province: null, city: '宁波市', district: null }, invalidatedAt: sourceDate(null), invalidationReason: null, reasons: [],
}
it('shows platform recognition without a published event or confirmed correspondence and collapses repeat collection', () => {
  const timeline = enterpriseBusinessTimeline(7, [], [], [fact, { ...fact, observationId: 4, collectedAt: '2026-11-17T00:00:00Z' }], [])
  expect(timeline.sources.map(s => [s.source, s.events.length])).toEqual([['publication', 0], ['recognized_list', 1], ['business_list', 0], ['apply_list', 0]])
  expect(timeline.sources[1]!.events[0]).toMatchObject({ title: 'specialized_sme', matter: 'recognition', businessTime: { value: '2026-03-06', precision: 'day' }, collectedAt: '2026-11-17T00:00:00Z', period: { until: { value: '2029-03-05' } } })
  expect(timeline.sources[1]!.events[0]!.platformName).toBe('平台名称')
  expect(JSON.stringify(timeline)).not.toMatch(/versionId|observationId|uscc/)
})
it('keeps all source outcomes and failed collection separate from retained business facts', () => {
  const timeline = enterpriseBusinessTimeline(7, [], [], [fact,
    { ...fact, source: 'business_list', recordId: 5, matter: 'review', conclusion: 'processing', businessTime: sourceDate(null), businessYear: null, period: { from: sourceDate(null), until: sourceDate(null) } },
    { ...fact, source: 'apply_list', recordId: 6, matter: 'apply' },
  ], [{ id: 9, interface: 'recognized_list', status: 'failed', queriedAt: '2026-11-18T00:00:00Z' }])
  expect(timeline.sources.map(s => [s.source, s.collectionStatus, s.events.length])).toEqual([
    ['publication', 'not_applicable', 0], ['recognized_list', 'failed', 1], ['business_list', 'not_collected', 1], ['apply_list', 'not_collected', 1],
  ])
  expect(timeline.sources[2]!.events[0]).toMatchObject({ conclusion: 'processing', businessTime: { value: null, precision: 'unknown' }, businessYear: null })
  expect(timeline.sources[1]!.events[0]!.businessTime.value).toBe('2026-03-06')
})
it('groups only explicit equal period starts and preserves original review year versus result year', () => {
  const timeline = enterpriseBusinessTimeline(7, [{ id: 10, titleCode: 'specialized_sme' }], [
    { id: 11, recordId: 10, eventType: 'award', year: 2026, decidedYear: null, batchSeq: 1, reviewOutcome: null,
      formalValidity: { evidenceId: 1, sourceSha256: 'a'.repeat(64), statementPages: [1], interval: { validFrom: '2026-03-06', validThrough: '2029-03-05' } } },
    { id: 12, recordId: 10, eventType: 'review', year: 2023, decidedYear: null, batchSeq: 1, reviewOutcome: 'failed' },
  ], [fact], [])
  expect(timeline.sources[0]!.events[0]).toMatchObject({ key: 'publication:11', businessTime: { value: '2026', precision: 'year' }, period: { until: { value: '2029-03-05', precision: 'day' } }, collectedAt: null })
  expect(timeline.sources[0]!.events[1]).toMatchObject({ conclusion: 'invalid', businessTime: { value: null, precision: 'unknown' } })
})
it('empty sources remain explicit and another enterprise cannot enter the timeline', () => {
  expect(enterpriseBusinessTimeline(7, [], [], [{ ...fact, enterpriseId: 8 }], []).sources.map(s => s.events)).toEqual([[], [], [], []])
})

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initializeDb } from '../../../db/client'
import * as schema from '../../../db/schema'
import { getRosterEnterpriseDetail } from '../../../layers/sme-roster/lib/roster/enterprise-roster-sqlite'

it('detail binds the timeline and qualification summary to the requested snapshot day', () => {
  const dir = mkdtempSync(join(tmpdir(), 'detail-813-'))
  const db = initializeDb({ create: true, dbPath: join(dir, 'fixture.sqlite') })
  try {
    const enterprise = db.insert(schema.enterprise).values({ name: '详情快照企业', nameNorm: '详情快照企业', usccNorm: fact.uscc }).returning().get()
    const record = db.insert(schema.record).values({ enterpriseId: enterprise.id, titleCode: 'specialized_sme', source: 'jxj', nameRaw: '详情快照企业' }).returning().get()
    db.insert(schema.recordEvent).values({ recordId: record.id, eventType: 'award', year: 2026, batchSeq: 1 }).run()
    const detail = getRosterEnterpriseDetail(db, enterprise.id, Date.parse('2026-11-16T00:00:00Z'))!
    expect(detail.businessTimeline.asOf).toBe('2026-11-16T00:00:00.000Z')
    expect(detail.qualificationAssessment.asOf).toBe('2026-11-16T00:00:00.000Z')
    expect(detail.businessTimeline.sources[0]!.events).toHaveLength(1)
    expect(detail.businessTimeline.sources[0]!.events[0]).toMatchObject({ matter: 'award', title: 'specialized_sme', businessTime: { value: '2026', precision: 'year' } })
    expect(detail.businessTimeline.sources.slice(1).map(s => [s.collectionStatus, s.events])).toEqual([['not_collected', []], ['not_collected', []], ['not_collected', []]])
  } finally { db.$client.close(); rmSync(dir, { recursive: true, force: true }) }
})

import { submitSyntheticRecognizedCollection } from '../fixtures/recognized-source'
it('detail shares the directory fact with qualification without publication or correspondence after repeated capture', () => {
  const dir = mkdtempSync(join(tmpdir(), 'detail-813-directory-'))
  const db = initializeDb({ create: true, dbPath: join(dir, 'fixture.sqlite') })
  try {
    const enterprise = db.insert(schema.enterprise).values({ name: '目录独立企业', nameNorm: '目录独立企业', usccNorm: fact.uscc }).returning().get()
    const raw = { id: 'DIR-813', tyshxydm: fact.uscc, qymc: '平台原名称', rdjb: '2', rdtime: '2026-03-06', rddqrq: '2029-03-05', sfyx: '1', szsmc: '宁波市' }
    for (const queriedAt of ['2026-11-14T00:00:00Z', '2026-11-15T00:00:00Z']) {
      submitSyntheticRecognizedCollection(db, { rdjb: '2', queriedAt, conditions: { uscc: fact.uscc }, rows: [{ raw, enterpriseId: null }] })
    }
    const detail = getRosterEnterpriseDetail(db, enterprise.id, Date.parse('2026-11-16T00:00:00Z'))!
    expect(detail.events).toEqual([])
    expect(detail.businessTimeline.asOf).toBe(detail.qualificationAssessment.asOf)
    expect(detail.businessTimeline.sources.map(s => s.events.length)).toEqual([0, 1, 0, 0])
    expect(detail.businessTimeline.sources[1]!.events[0]).toMatchObject({ matter: 'recognition', conclusion: 'passed', businessTime: { value: '2026-03-06' }, period: { from: { value: '2026-03-06' }, until: { value: '2029-03-05' } }, collectedAt: '2026-11-15T00:00:00Z' })
    const summary = detail.qualificationAssessment.titles.find(t => t.titleCode === 'specialized_sme')!
    expect(summary.effectiveQualification).toMatchObject({ status: 'effective', source: { source: 'recognized_list', businessTime: { value: '2026-03-06' }, period: { from: { value: '2026-03-06' }, until: { value: '2029-03-05' } } } })
    submitSyntheticRecognizedCollection(db, { rdjb: '2', queriedAt: '2026-11-16T01:00:00Z', conditions: { uscc: fact.uscc }, rows: [{ raw: { ...raw, qymc: '平台更正名称', rddqrq: '2030-03-05' }, enterpriseId: null }] })
    const refreshed = getRosterEnterpriseDetail(db, enterprise.id, Date.parse('2026-11-16T00:00:00Z'))!
    expect(refreshed.businessTimeline.sources[1]!.events[0]).toMatchObject({ platformName: '平台更正名称', period: { until: { value: '2030-03-05' } } })
    expect(refreshed.qualificationAssessment.titles.find(t => t.titleCode === 'specialized_sme')!.effectiveQualification).toMatchObject({ status: 'effective', source: { platformName: '平台更正名称', period: { until: { value: '2030-03-05' } } } })
    expect(detail.businessTimeline.sources[1]!.events[0]!.period.until.value).toBe('2029-03-05')
  } finally { db.$client.close(); rmSync(dir, { recursive: true, force: true }) }
})
