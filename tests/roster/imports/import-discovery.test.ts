import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { rosterImportMcpPayloadSchema } from '../../../layers/sme-roster/server/utils/roster-import-schema'

const httpPayloadCache = new Map<string, any>()
function httpPayload(action: string) {
  if (httpPayloadCache.has(action)) return httpPayloadCache.get(action)
  const source = readFileSync(new URL(`../../../server/api/roster/import/${action}.post.ts`, import.meta.url), 'utf8')
  const payload = JSON.parse(source.match(/payload: (\{\n[\s\S]*?\n\}),/)![1]!)
  httpPayloadCache.set(action, payload)
  return payload
}
const discovery = z.toJSONSchema(rosterImportMcpPayloadSchema, { io: 'input' })
const allPayloads: any[] = [discovery, ...['preflight', 'commit'].map(httpPayload)]

// Independent literal expectations pin discoverable commands, not an inferred database rowset.
describe('roster import announcement discovery', () => {
  it('discovers announcement records, event vocabulary and published source identity', () => {
    const announcement = discovery.properties!.announcement as any
    expect(announcement.required).toEqual(['sourceDocument', 'records'])
    expect(announcement.additionalProperties).toEqual({})
    expect(announcement.properties.sourceDocument.properties.source.enum).toEqual(['jxj', 'miit'])
    const record = announcement.properties.records.items
    expect(record.required).toEqual(['enterprise', 'titleCode'])
    expect(record.properties.titleCode.enum).toEqual(['little_giant', 'specialized_sme', 'innovative_sme'])
    const event = record.properties.events.items
    expect(event.required).toEqual(['eventType'])
    expect(event.properties.eventType.enum).toEqual(['award', 'review', 'maintain', 'nurture'])
    const evidence = event.properties.evidence.items
    expect(evidence.required).toEqual(['sourceFile'])
    expect(evidence.properties.page.anyOf).toEqual(expect.arrayContaining([{ type: 'null' }]))
    const published = evidence.properties.publishedRow
    expect(published.additionalProperties).toBe(false)
    expect(published.required).toEqual(expect.arrayContaining(['nameRaw', 'declaration', 'sourceBindingKnown', 'actor', 'basis']))
    expect(published.properties.declaration.oneOf.map((branch: any) => branch.properties.kind.const)).toEqual(['existing', 'independent'])
    expect(discovery.required ?? []).not.toContain('announcement')
  })

  it.each(['preflight', 'commit'])('publishes the shared A command models as literal HTTP %s metadata', action => {
    const payload = httpPayload(action)
    for (const key of ['announcement', 'officialEvidenceAppends', 'officialEvidenceCorrections', 'officialEvidencePlanHash']) {
      expect(payload.properties[key]).toEqual(discovery.properties![key])
    }
    expect(payload.additionalProperties).toBe(true)
    expect(payload.properties.officialEvidenceAppends).toMatchObject({ minItems: 1, maxItems: 100 })
    expect(payload.properties.officialEvidenceCorrections.properties.operations).toMatchObject({ minItems: 1, maxItems: 100 })
    expect(payload.properties.officialEvidencePlanHash.pattern).toBe('^[a-f0-9]{64}$')
  })

  it.each([
    null,
    { sourceDocument: { source: 'unknown', title: null }, records: [] },
    { sourceDocument: { source: 'jxj' }, records: [{ enterprise: { name: '兼容测试', uscc: null }, titleCode: 'bad', events: [{ eventType: 'bad', year: 2021.9, evidence: [{ sourceFile: 'a.pdf', page: '2', extra: 7 }] }] }] },
  ])('passes legacy announcement values unchanged to domain validation', announcement => {
    const payload = { announcement, unknownExtra: { raw: null }, aliases: null }
    expect(rosterImportMcpPayloadSchema.parse(payload)).toEqual(payload)
  })

  it('retains omitted fields and strict official command bounds', () => {
    expect(rosterImportMcpPayloadSchema.parse({})).toEqual({})
    expect(rosterImportMcpPayloadSchema.safeParse({ officialEvidenceAppends: [] }).success).toBe(false)
    expect(rosterImportMcpPayloadSchema.safeParse({ officialEvidenceAppends: Array(101).fill({}) }).success).toBe(false)
    expect(rosterImportMcpPayloadSchema.safeParse({ officialEvidencePlanHash: null }).success).toBe(false)
    expect(rosterImportMcpPayloadSchema.safeParse({ officialEvidencePlanHash: 'wrong' }).success).toBe(false)
    expect(rosterImportMcpPayloadSchema.parse({ officialEvidencePlanHash: 'a'.repeat(64) })).toEqual({ officialEvidencePlanHash: 'a'.repeat(64) })
  })

  it('discovers explicit published row and revision requirements for every import correction without tightening legacy parsing', () => {
    for (const payload of [discovery, httpPayload('preflight'), httpPayload('commit')]) {
      const operation = (payload.properties!.officialEvidenceCorrections as any).properties.operations.items
      expect(operation.required).toEqual(expect.arrayContaining(['publishedRow', 'expectedRowRevision']))
    }
    const command = { actor: { type: 'agent', id: 'discovery-test' }, basis: 'Coordinate-only legacy command', operations: [{ evidenceId: 1, eventId: 1, recordId: 1, enterpriseId: 1, expectedVersion: 'a'.repeat(64), coordinate: { sourceFile: 'notice.txt', attachment: null, listNo: 1, page: null } }] }
    expect(rosterImportMcpPayloadSchema.parse({ officialEvidenceCorrections: command })).toEqual({ officialEvidenceCorrections: command })
  })
})

describe('legacy alias import discovery', () => {
  it('discovers alias required facts and natural relation identity independently on both transports', () => {
    for (const payload of allPayloads) {
      const aliases = payload.properties.aliases
      expect(aliases.type).toBe('array')
      expect(aliases.minItems).toBeUndefined()
      expect(aliases.maxItems).toBeUndefined()
      const alias = aliases.items
      expect(alias.required).toEqual(['name', 'sourceKind'])
      expect(alias.anyOf).toEqual([{ required: ['enterpriseName'] }, { required: ['uscc'] }])
      expect(alias.properties.sourceKind.enum).toEqual(['platform_business', 'platform_apply', 'announcement', 'manual'])
      expect(alias.properties.verificationStatus.anyOf[0].enum).toEqual(['confirmed', 'pending', 'withdrawn'])
      expect(alias.properties.sourceRelationRef.anyOf[0].required).toEqual(['interface', 'queryKey', 'sequenceNo'])
      expect(Object.keys(alias.properties)).toEqual(expect.arrayContaining(['enterpriseName', 'uscc', 'sourceRefId', 'sourceRelationRef', 'validFrom', 'validTo', 'note']))
      expect(payload.required ?? []).not.toContain('aliases')
    }
  })

  it.each([null, false, {}, [], [null], [{ name: '  旧名  ', sourceKind: 'unknown', sourceRefId: 2.9, verificationStatus: null, extra: { raw: null } }]])('keeps legacy alias values unchanged for core validation', aliases => {
    const payload = { aliases, unrelated: { raw: null } }
    expect(rosterImportMcpPayloadSchema.parse(payload)).toEqual(payload)
  })
})

it('discovers export snapshot identity and source row fields without inventing batch limits', () => {
  for (const payload of allPayloads) {
    const snapshot = payload.properties.exportSnapshot
    expect(snapshot.required).toEqual(['titleCode', 'year', 'collectedOn', 'originalFilename', 'sha256'])
    expect(snapshot.properties.titleCode.enum).toEqual(['little_giant', 'specialized_sme', 'innovative_sme'])
    expect(snapshot.properties.sha256.pattern).toBeUndefined()
    expect(snapshot.properties.rows.items.required).toEqual(['sourceRowNo'])
    expect(Object.keys(snapshot.properties.rows.items.properties)).toEqual(['sourceRowNo', 'usccRaw', 'nameRaw', 'district', 'province', 'city', 'regStatus', 'rawFields'])
    expect(snapshot.properties.rows.maxItems).toBeUndefined()
  }
})

it.each([null, false, {}, { titleCode: 'bad', year: 2026.9, rows: [null], extra: null }])('keeps legacy snapshot values unchanged for core validation', exportSnapshot => {
  expect(rosterImportMcpPayloadSchema.parse({ exportSnapshot })).toEqual({ exportSnapshot })
})

it('discovers four remaining commands with independent required fields and domain vocabularies', () => {
  const models = allPayloads
  for (const model of models) {
    const p = model.properties
    for (const [family, required] of Object.entries({ platformQueries: ['interface', 'queryKey', 'queriedAt'], differences: ['titleCode', 'direction', 'recordedAt'], usccBackfills: ['uscc', 'source'], merges: ['intoUscc'] })) {
      expect(p[family].type).toBe('array')
      expect(p[family].items.required).toEqual(required)
      expect(p[family].maxItems).toBeUndefined()
      expect(p[family].items.additionalProperties).toEqual({})
    }
    expect(p.platformQueries.items.allOf).toEqual([{ if: { properties: { interface: { const: 'recognized_list' } }, required: ['interface'], not: { properties: { reuseExisting: { const: true } }, required: ['reuseExisting'] } }, then: { required: ['collectionEvidence'], properties: { collectionEvidence: { type: 'object' } } } }])
    const q = p.platformQueries.items.properties
    expect(q.interface.enum).toEqual(['business_list', 'apply_list', 'recognized_list'])
    expect(q.status.enum).toEqual(['success', 'failed', 'no_record', 'not_queried', 'partial'])
    expect(q.reuseExisting.const).toBe(true)
    expect(q.relations.items.required).toEqual(['sequenceNo'])
    expect(q.relations.items.properties.matchBasis.enum).toEqual(['uscc', 'alias', 'manual', 'none'])
    const e = q.collectionEvidence.anyOf[0]
    expect(e.required).toEqual(['source', 'status', 'effectiveConditions', 'titleScope', 'queriedAt', 'completedAt', 'rows', 'pages', 'fetchedCount', 'declaredTotal', 'completeness', 'fullRange', 'unfinished', 'error', 'limits'])
    expect(e.properties.source.enum).toEqual(['queryList', 'businessList', 'queryBusList'])
    expect(e.properties.rawData.properties.version.const).toBe(1)
    expect(e.properties.rawData.properties.pages.items.required).toEqual(['source', 'rdjb', 'page', 'format', 'body'])
    expect(e.properties.completeness.enum).toEqual(['complete', 'partial', 'not_queried'])
    const d = p.differences.items
    expect(d.anyOf).toEqual([{ required: ['enterpriseName'] }, { required: ['uscc'] }])
    expect(d.properties.direction.enum).toEqual(['missing_in_miit', 'extra_in_miit'])
    expect(d.properties.status.enum).toEqual(['not_queried', 'query_failed', 'no_record', 'confirmed_no_diff', 'confirmed_reason', 'needs_review'])
    expect(d.properties.reasonCode.anyOf[0].enum).toEqual(['moved_out', 'deregistered', 'renamed', 'platform_stale', 'pending_review', 'moved_in', 'other'])
    expect(d.properties.measureCode.anyOf[0].enum).toEqual(['keep_history', 'mark_platform_snapshot', 'follow_review', 'mark_moved_out', 'mark_deregistered', 'update_current_name', 'record_moved_in', 'manual_review', 'none'])
    expect(d.properties.evidenceRelationRef.required).toEqual(['interface', 'queryKey', 'sequenceNo'])
    expect(p.usccBackfills.items.properties.source.required).toEqual(['url', 'checkedOn', 'basis', 'name'])
    expect(p.usccBackfills.items.anyOf).toEqual([{ required: ['enterpriseId'] }, { required: ['enterpriseName'] }])
    expect(p.merges.items.anyOf).toEqual([{ required: ['fromEnterpriseId'] }, { required: ['fromEnterpriseName'] }])
    expect(p.merges.items.properties.sourceRelationRef.required).toEqual(['interface', 'queryKey', 'sequenceNo'])
  }
})

it.each(['platformQueries', 'differences', 'usccBackfills', 'merges'])('preserves every legacy value for %s without coercion stripping or validation', family => {
  for (const value of [null, false, {}, [], [null], [{ sequenceNo: '3.9', enterpriseId: 2.9, source: null, rawResponse: 'null', reuseExisting: false, extra: { sentinel: null } }]]) {
    const payload = { [family]: value, extra: true }
    expect(rosterImportMcpPayloadSchema.parse(payload)).toEqual(payload)
  }
  expect(rosterImportMcpPayloadSchema.parse({})).toEqual({})
})
