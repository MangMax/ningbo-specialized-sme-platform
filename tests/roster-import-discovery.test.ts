import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { rosterImportMcpPayloadSchema } from '../server/utils/roster-import-schema'

function httpPayload(action: string) {
  const source = readFileSync(new URL(`../server/api/roster/import/${action}.post.ts`, import.meta.url), 'utf8')
  return JSON.parse(source.match(/payload: (\{\n[\s\S]*?\n\}),/)![1]!)
}
const discovery = z.toJSONSchema(rosterImportMcpPayloadSchema, { io: 'input' })

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
