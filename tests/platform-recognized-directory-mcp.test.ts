import { initializeDb } from '../db/client'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { useDb, schema } from '../db'
import { ensurePlatformObservation } from '../server/utils/platform-business-record'
import { getPlatformRecognizedRecord, listPlatformRecognizedDirectory } from '../server/utils/platform-recognized-directory'

vi.mock('@nuxtjs/mcp-toolkit/server', () => ({ defineMcpTool: (tool: unknown) => tool }))

const dir = mkdtempSync(join(tmpdir(), 'recognized-directory-mcp-'))
const dbPath = join(dir, 'recognized.sqlite')
vi.stubEnv('NUXT_DB_PATH', dbPath)
const db = initializeDb({ create: true, dbPath })
let listTool: typeof import('../server/mcp/tools/list_platform_recognized_directory').default
let detailTool: typeof import('../server/mcp/tools/get_platform_recognized_record').default
let recordId = 0
let relationId = 0

beforeAll(async () => {
  vi.stubGlobal('createError', (input: unknown) => Object.assign(new Error('fixture'), input))
  const enterprise = db.insert(schema.enterprise).values({ name: 'MCP 目录企业', nameNorm: 'MCP 目录企业', usccNorm: '91330211DDDDDDDD4X' }).returning().get()
  const query = db.insert(schema.platformQuery).values({ interface: 'recognized_list', queryKey: enterprise.usccNorm!, rdjb: '2', queriedAt: '2026-10-01T00:00:00Z', status: 'success' }).returning().get()
  db.insert(schema.platformQueryTitleScope).values({ queryId: query.id, rdjb: '2' }).run()
  const relation = db.insert(schema.platformRelation).values({
    queryId: query.id, sequenceNo: 1, relationKey: 'DIR-MCP-READ', enterpriseId: enterprise.id,
    usccRaw: enterprise.usccNorm, nameRaw: enterprise.name,
    rawFields: { id: 'DIR-MCP-READ', qymc: enterprise.name, tyshxydm: enterprise.usccNorm, rdjb: '2', rddqrq: '2027-12-31', whpcyear: '2024', whpc: '2024-2', szq: '33020000', rdxx: '原认定说明' },
  }).returning().get()
  const projection = ensurePlatformObservation(db, relation.id)
  recordId = projection.recordId!
  relationId = relation.id
  listTool = (await import('../server/mcp/tools/list_platform_recognized_directory')).default
  detailTool = (await import('../server/mcp/tools/get_platform_recognized_record')).default
})
afterAll(() => {
  vi.unstubAllGlobals(); vi.unstubAllEnvs(); db.$client.close(); rmSync(dir, { recursive: true, force: true })
})

it('exposes the same recognized directory contract over MCP as the shared domain service', async () => {
  expect(listTool.name).toBe('list_platform_recognized_directory')
  expect(detailTool.name).toBe('get_platform_recognized_record')
  const input = { view: 'records' as const, rdjb: '2' as const, rddqrq: '2027-12-31', whpcyear: 2024, whpc: '2024-2', szq: '33020000', page: 1, pageSize: 25 }
  const listed = await listTool.handler(input as never, {} as never) as { structuredContent: unknown; content: { text: string }[] }
  const expected = listPlatformRecognizedDirectory(input, db)
  expect(listed.structuredContent).toEqual(expected)
  expect(JSON.parse(listed.content[0]!.text)).toEqual(expected)
  expect(expected.rows[0]).toMatchObject({
    kind: 'record',
    matchedVersion: { validityDateRaw: '2027-12-31', maintenanceYear: 2024, maintenanceBatch: '2024-2', district: '33020000', titleRaw: '2' },
    titleScopes: ['2'],
  })

  const detail = await detailTool.handler({ recordId }, {} as never) as { structuredContent: unknown; content: { text: string }[] }
  const expectedDetail = getPlatformRecognizedRecord(db, recordId)
  expect(detail.structuredContent).toEqual(expectedDetail)
  expect(JSON.parse(detail.content[0]!.text)).toEqual(expectedDetail)
  expect(expectedDetail.observations[0]).toMatchObject({ relationId, titleConflict: false })
  expect(JSON.stringify(expectedDetail)).not.toContain('unknownSensitiveField')

  const isolated = await listTool.handler({ view: 'isolated', pageSize: 25 } as never, {} as never) as { structuredContent: { rows: unknown[] } }
  expect(isolated.structuredContent).toEqual(listPlatformRecognizedDirectory({ view: 'isolated' }, db))
})
