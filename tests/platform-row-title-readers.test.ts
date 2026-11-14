import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp, toWebHandler, defineEventHandler, createError } from 'h3'
import { initializeDb } from '../db/client'
import * as schema from '../db/schema'
import { listPlatformDeclarations, getPlatformDeclaration } from '../upgrade/frozen/server/platform-declarations'
import { listPlatformBusinessProcesses, getPlatformBusinessProcess } from '../upgrade/frozen/server/platform-business-processes'
import { listPlatformRecognizedDirectory, getPlatformRecognizedRecord } from '../upgrade/frozen/server/platform-recognized-directory'
import { readPlatformFilterOptions } from '../upgrade/frozen/server/platform-filter-options'
import { declarationFilterFromQuery, declarationFilterSchema } from '../lib/platform/declarations'
import { businessProcessFilterFromQuery, businessProcessFilterSchema } from '../lib/platform/business-processes'
import { recognizedDirectoryFilterFromQuery, recognizedDirectoryFilterSchema } from '../lib/platform/recognized-directory'

vi.mock('@nuxtjs/mcp-toolkit/server', () => ({ defineMcpTool: (tool: unknown) => tool }))
const dir = mkdtempSync(join(tmpdir(), 'platform-row-title-readers-'))
const db = initializeDb({ create: true, dbPath: join(dir, 'test.db') })
let seq = 0
const cases = [
  { source: 'declarations', interface: 'apply_list', read: listPlatformDeclarations, detail: getPlatformDeclaration, parse: declarationFilterFromQuery, filter: declarationFilterSchema },
  { source: 'business-processes', interface: 'business_list', read: listPlatformBusinessProcesses, detail: getPlatformBusinessProcess, parse: businessProcessFilterFromQuery, filter: businessProcessFilterSchema },
  { source: 'recognized-directory', interface: 'recognized_list', read: listPlatformRecognizedDirectory, detail: getPlatformRecognizedRecord, parse: recognizedDirectoryFilterFromQuery, filter: recognizedDirectoryFilterSchema },
] as const
function record(source: typeof cases[number]['interface'], key: string) {
  return db.insert(schema.platformBusinessRecord).values({ interface: source, platformKey: key, identityRuleVersion: 'test' }).returning().get()
}
function observed(source: typeof cases[number]['interface'], titleRaw: string | null, owner?: ReturnType<typeof record>, scope = '2', year = 2024) {
  const id = ++seq
  const query = db.insert(schema.platformQuery).values({ interface: source, queryKey: `q-${id}`, rdjb: scope, queriedAt: `2026-11-01T00:00:${String(id).padStart(2, '0')}Z`, status: 'success' }).returning().get()
  const relation = db.insert(schema.platformRelation).values({ queryId: query.id, sequenceNo: 1, relationKey: owner?.platformKey, titleRaw, rawFields: titleRaw === null ? {} : { rdjb: titleRaw } }).returning().get()
  let versionId: number | null = null
  if (owner) {
    const version = db.insert(schema.platformBusinessRecordVersion).values({ recordId: owner.id, hashAlgorithm: 'test', contentHash: `hash-${id}`, canonicalRawJson: '{"rdjb":"raw-decoy"}' }).returning().get()
    versionId = version.id
    const common = { recordId: owner.id, versionId, titleRaw, ruleVersion: 'test' }
    if (source === 'apply_list') db.insert(schema.platformApplyProjection).values({ ...common, declarationYear: year, appliedAt: `${year}-01-01` }).run()
    else if (source === 'business_list') db.insert(schema.platformBusinessProjection).values({ ...common, businessYear: year, appliedAt: `${year}-01-01` }).run()
    else db.insert(schema.platformRecognizedProjection).values({ ...common, maintenanceYear: year }).run()
  }
  db.insert(schema.platformBusinessObservation).values({ relationId: relation.id, recordId: owner?.id ?? null, versionId, identityState: owner ? 'resolved' : 'missing_key', contentState: owner ? 'verified' : 'unverifiable', keySource: owner ? 'relation_key' : 'none', projectionRuleVersion: 'test', inputFingerprint: `fp-${id}` }).run()
  return { relationId: relation.id, versionId }
}
beforeAll(() => {
  vi.stubGlobal('defineEventHandler', defineEventHandler)
  vi.stubGlobal('createError', createError)
  vi.doMock('@db', () => ({ useDb: () => db }))

})
afterAll(() => { vi.doUnmock('@db'); vi.unstubAllGlobals(); db.$client.close(); rmSync(dir, { recursive: true, force: true }) })

for (const target of cases) {
  it(`${target.source} uses literal row title independent of query scope and preserves unknown or missing titles`, () => {
    const owner = record(target.interface, `${target.source}-versions`)
    const old = observed(target.interface, '1', owner, '2', 2023)
    observed(target.interface, '3', owner, '1', 2024)
    const missing = record(target.interface, `${target.source}-missing`)
    observed(target.interface, null, missing)
    const unknown = record(target.interface, `${target.source}-unknown`)
    observed(target.interface, ' strange-title ', unknown)
    const filter = { titleRaw: '1', pageSize: 1 }
    const result = target.read(filter, db)
    expect(result).toMatchObject({ total: 1, page: 1, pageSize: 1 })
    expect(result.rows).toHaveLength(1)
    expect(result.rows[0]).toMatchObject({ record: { id: owner.id }, matchedVersion: { versionId: old.versionId, titleRaw: '1' }, matchedVersionCount: 1, versionCount: 2 })
    expect(target.read({ ...filter, page: 2 }, db)).toMatchObject({ total: 1, rows: [] })
    expect(target.read({ titleRaw: ' strange-title ' }, db).rows[0]).toMatchObject({ record: { id: unknown.id }, matchedVersion: { titleRaw: ' strange-title ' } })
    expect(target.read({ titleRaw: 'strange-title' }, db).total).toBe(0)
    expect(target.read({ platformKey: missing.platformKey }, db).rows[0]).toMatchObject({ matchedVersion: { titleRaw: null } })
    const yearKey = target.source === 'recognized-directory' ? 'whpcyear' : 'year'
    expect(target.read({ titleRaw: '1', [yearKey]: 2024 }, db)).toMatchObject({ total: 0, rows: [] })
    if (target.source !== 'declarations') {
      expect(target.read({ titleRaw: '1', rdjb: '2' }, db).total).toBe(1)
      expect(target.read({ titleRaw: '1', rdjb: '1' }, db)).toMatchObject({ total: 0, rows: [] })
    }
    expect(target.detail(db, owner.id).versions.map(v => v.titleRaw).sort()).toEqual(['1', '3'])
    const isolated = observed(target.interface, 'outside-dictionary')
    const empty = observed(target.interface, null)
    const isolatedResult = target.read({ view: 'isolated', titleRaw: 'outside-dictionary' }, db)
    expect(isolatedResult).toMatchObject({ total: 1, rows: [{ relationId: isolated.relationId, titleRaw: 'outside-dictionary' }] })
    expect(target.read({ view: 'isolated' }, db).rows.find(row => row.kind === 'observation' && row.relationId === empty.relationId)).toMatchObject({ titleRaw: null })
    expect(readPlatformFilterOptions({ source: target.source }, db).titles).toEqual([' strange-title ', '1', '3'])
    const options = readPlatformFilterOptions({ source: target.source, view: 'isolated' }, db)
    expect(options.titles).toEqual(['outside-dictionary'])
    if (target.source === 'recognized-directory') expect(options).toEqual({ titles: ['outside-dictionary'], declareKinds: [], years: [], statuses: [], batches: [], districts: [], validityDates: [] })
  })

  it(`${target.source} HTTP and MCP preserve title validation and their required schema phase`, async () => {
    const route = target.source === 'declarations' ? await import('../server/api/platform/declarations.get') : target.source === 'business-processes' ? await import('../server/api/platform/business-processes.get') : await import('../server/api/platform/recognized-directory.get')
    const tool = target.source === 'declarations' ? await import('../server/mcp/tools/list_platform_declarations') : target.source === 'business-processes' ? await import('../server/mcp/tools/list_platform_business_processes') : await import('../server/mcp/tools/list_platform_recognized_directory')
    const request = toWebHandler(createApp().use('/', route.default))
    for (const view of ['records', 'isolated']) {
      const titleRaw = view === 'records' ? ' strange-title ' : 'outside-dictionary'
      const input = target.parse({ view, titleRaw })
      expect(input.titleRaw).toBe(titleRaw)
      const expected = target.read(input, db)
      expect(expected.total).toBe(1)
      const response = await request(new Request(`http://localhost/?${new URLSearchParams({ view, titleRaw })}`))
      expect(response.headers.get('cache-control')).toBe('no-store')
      if (target.source === 'declarations') {
        // Declarations is target-only now. The actual 71608 HTTP/MCP DTO oracle
        // lives in platform-declarations-target-http.test.ts; expand cannot fallback.
        expect(response.status).toBe(409)
        await expect(Reflect.apply(tool.default.handler!, undefined, [input])).rejects.toMatchObject({ statusCode: 409, code: 'apply_target_phase' })
        continue
      }
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual(expected)
      const mcp = await tool.default.handler(input as never, {} as never) as any
      expect(mcp.structuredContent).toEqual(expected)
      expect(JSON.parse(mcp.content[0].text)).toEqual(expected)
    }
    for (const titleRaw of ['', 1, ['1'], null, 'x'.repeat(201)]) {
      expect(target.filter.safeParse({ titleRaw }).success).toBe(false)
      expect(() => target.parse({ titleRaw })).toThrow()
    }
    for (const query of ['titleRaw=', 'titleRaw=1&titleRaw=2', `titleRaw=${'x'.repeat(201)}`]) expect((await request(new Request(`http://localhost/?${query}`))).status).toBe(400)
  })
}
