import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { z } from 'zod'
import { rosterImportMcpPayloadSchema } from '../../../server/utils/roster-import-schema'

it('discovers four remaining commands with independent required fields and domain vocabularies', () => {
  const models: any[] = [z.toJSONSchema(rosterImportMcpPayloadSchema, { io: 'input' }), ...['preflight', 'commit'].map(action => JSON.parse(readFileSync(new URL(`../../../server/api/roster/import/${action}.post.ts`, import.meta.url), 'utf8').match(/payload: (\{\n[\s\S]*?\n\}),/)![1]!))]
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
