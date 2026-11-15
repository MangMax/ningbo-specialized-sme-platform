import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { rosterImportMcpPayloadSchema } from '../../../server/utils/roster-import-schema'

function payloads() {
  return [z.toJSONSchema(rosterImportMcpPayloadSchema, { io: 'input' }), ...['preflight', 'commit'].map(action => {
    const source = readFileSync(new URL(`../../../server/api/roster/import/${action}.post.ts`, import.meta.url), 'utf8')
    return JSON.parse(source.match(/payload: (\{\n[\s\S]*?\n\}),/)![1]!)
  })] as any[]
}

describe('legacy alias import discovery', () => {
  it('discovers alias required facts and natural relation identity independently on both transports', () => {
    for (const payload of payloads()) {
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
  for (const payload of payloads()) {
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
