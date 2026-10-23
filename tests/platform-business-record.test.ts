import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { schema, useDb } from '../db'
import { canonicalPlatformJson, ensurePlatformObservation, planPlatformObservation } from '../server/utils/platform-business-record'
import { rosterImportMcpPayloadSchema } from '../server/utils/roster-import-schema'
const dirs: string[] = []
afterAll(() => dirs.forEach(dir => rmSync(dir, { recursive: true, force: true })))

it('canonicalizes nested JSON objects only and preserves every JSON value partition', () => {
  expect(canonicalPlatformJson({ z: [{ b: true, a: null }], a: '' })).toBe('{"a":"","z":[{"a":null,"b":true}]}')
  const values = [null, false, 0, '', '0', [], {}, { a: null }, { a: false }, { a: 0 }, { a: '' }, [1, 2], [2, 1]]
  expect(new Set(values.map(canonicalPlatformJson)).size).toBe(values.length)
  for (const value of [undefined, NaN, Infinity, () => 1, { a: undefined }, [undefined], new Date()]) expect(() => canonicalPlatformJson(value)).toThrow('platform_raw_not_json')
})

it('uses case-sensitive interface keys without numeric or name identity guesses', () => {
  expect(planPlatformObservation({ interface: 'recognized_list', relationKey: null, rawFields: { id: '550e8400-e29b-41d4-a716-446655440000' } })).toMatchObject({ platformKey: '550e8400-e29b-41d4-a716-446655440000', identityState: 'resolved', keySource: 'raw_id' })
  for (const id of [null, 42, {}, [], ' ', false]) expect(planPlatformObservation({ interface: 'business_list', relationKey: null, rawFields: { id, qymc: 'same', tyshxydm: 'same' } })).toMatchObject({ platformKey: null, canonicalRawJson: null, identityState: 'missing_key' })
  expect(planPlatformObservation({ interface: 'apply_list', relationKey: 'SQ1', rawFields: { id: 'sq1' } })).toMatchObject({ identityState: 'conflict', canonicalRawJson: null })
  expect(planPlatformObservation({ interface: 'apply_list', relationKey: '  001  ', rawFields: { id: '001', unknown: 1 } })).toMatchObject({ platformKey: '001', identityState: 'resolved', keySource: 'both' })
})

it('database constraints prevent mismatched versions orphan mappings and deletion of old evidence', () => {
  const dir = mkdtempSync(join(tmpdir(), 'identity244-fk-')); dirs.push(dir)
  const db = useDb({ dbPath: join(dir, 'roster.db') })
  const queryId = db.insert(schema.platformQuery).values({ interface: 'business_list', queryKey: 'test', queriedAt: 'test' }).returning().get().id
  for (const [sequenceNo, id] of [[1, 'one'], [2, 'two']] as const) db.insert(schema.platformRelation).values({ queryId, sequenceNo, relationKey: id, rawFields: { id } }).run()
  const first = db.transaction(tx => ensurePlatformObservation(tx, 1)), second = db.transaction(tx => ensurePlatformObservation(tx, 2))
  expect(() => db.$client.prepare('UPDATE platform_business_observation SET version_id=? WHERE relation_id=1').run(second.versionId)).toThrow(/FOREIGN KEY/)
  expect(() => db.$client.prepare('UPDATE platform_business_observation SET record_id=NULL WHERE relation_id=1').run()).toThrow(/CHECK/)
  expect(() => db.$client.prepare('DELETE FROM platform_relation WHERE id=1').run()).toThrow(/FOREIGN KEY/)
  expect(() => db.$client.prepare('DELETE FROM platform_query WHERE id=?').run(queryId)).toThrow(/FOREIGN KEY/)
  expect(() => db.$client.prepare('DELETE FROM platform_business_record_version WHERE id=?').run(first.versionId)).toThrow(/FOREIGN KEY/)
  expect(() => db.insert(schema.platformBusinessRecord).values({ interface: 'business_list', platformKey: 'one', identityRuleVersion: 'v1' }).run()).toThrow(/UNIQUE/)
  expect(db.all(sql`PRAGMA foreign_key_check`)).toEqual([])
  expect(db.get(sql`SELECT count(*) n FROM platform_relation`)).toEqual({ n: 2 })
  db.run(sql`UPDATE platform_relation SET year=2026, verification_status='confirmed', source_text='local wrapper' WHERE id=1`)
  const reused = db.transaction(tx => ensurePlatformObservation(tx, 1))
  expect(reused).toMatchObject({ recordId: first.recordId, versionId: first.versionId, inputFingerprint: first.inputFingerprint, observationCreated: false, versionCreated: false })
})

it('MCP schema rejects malformed projection items and preserves legacy payload fields', () => {
  expect(rosterImportMcpPayloadSchema.parse({ aliases: [{ name: 'legacy' }], platformRecordObservations: [{ relationId: 1 }] })).toEqual({ aliases: [{ name: 'legacy' }], platformRecordObservations: [{ relationId: 1 }] })
  for (const rows of [null, {}, [], [{ relationId: 0 }], [{ relationId: 1.1 }], [{ relationId: '1' }], [{ relationId: Number.MAX_SAFE_INTEGER + 1 }], [{ relationId: 1, rawFields: {} }], [{ relationId: 1 }, { relationId: 1 }], Array.from({ length: 101 }, (_, i) => ({ relationId: i + 1 }))]) expect(rosterImportMcpPayloadSchema.safeParse({ platformRecordObservations: rows }).success).toBe(false)
})
