import { mkdtempSync,rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll,beforeAll,expect,it,vi } from 'vitest'
import { schema } from '../../../db'
import { initializeDb } from '../../../db/client'
import { getTargetRecognizedRecord,listTargetRecognizedDirectory } from '../../../layers/sme-roster/server/utils/platform-recognized-target'
import { submitNativePlatformQuery } from '../fixtures/native-query'

vi.mock('@nuxtjs/mcp-toolkit/server', () => ({ defineMcpTool: (tool: unknown) => tool }))

const dir = mkdtempSync(join(tmpdir(), 'recognized-directory-mcp-'))
const dbPath = join(dir, 'recognized.sqlite')
vi.stubEnv('NUXT_DB_PATH', dbPath)
const db = initializeDb({ create: true, dbPath })
let listTool: typeof import('../../../layers/sme-roster/server/mcp/tools/list_platform_recognized_directory').default
let detailTool: typeof import('../../../layers/sme-roster/server/mcp/tools/get_platform_recognized_record').default
let recordId = 0
let relationId = 0

beforeAll(async () => {
  vi.stubGlobal('createError', (input: unknown) => Object.assign(new Error('fixture'), input))
  const enterprise = db.insert(schema.enterprise).values({ name: 'MCP 目录企业', nameNorm: 'MCP 目录企业', usccNorm: '91330211DDDDDDDD4X' }).returning().get()
  const queriedAt = '2026-10-01T00:00:00Z'
  const raw = { id: 'DIR-MCP-READ', qymc: enterprise.name, tyshxydm: enterprise.usccNorm!, rdjb: '2', rddqrq: '2027-12-31', whpcyear: '2024', whpc: '2024-2', szq: '33020000', rdxx: '原认定说明', unknownSensitiveField: 'PRIVATE-MCP-MARKER' }
  const written = submitNativePlatformQuery(db, {
    interface: 'recognized_list', queryKey: enterprise.usccNorm!, rdjb: '2', titleCode: 'specialized_sme', queriedAt, status: 'success',
    collectionEvidence: {
      source: 'queryBusList', status: 'success', effectiveConditions: { combination: 'and' }, titleScope: { mode: 'selected', rdjb: ['2'] },
      queriedAt, completedAt: queriedAt, rows: [raw],
      pages: [{ source: 'queryBusList', rdjb: '2', page: 1, status: 'success', fetchedCount: 1, declaredTotal: 1, maxPage: 1, error: null }],
      fetchedCount: 1, declaredTotal: 1, completeness: 'complete', fullRange: true, unfinished: [], error: null,
      limits: { maxRequests: 1, maxRows: 50, maxDurationMs: 1000, pageSize: 50 },
    },
    relations: [{ sequenceNo: 1, relationKey: raw.id, enterpriseId: enterprise.id, usccRaw: raw.tyshxydm, nameRaw: raw.qymc, rawFields: raw, matchBasis: 'uscc' }],
  })
  recordId = written.observations[0]!.recordId!
  relationId = written.relationIds[0]!
  listTool = (await import('../../../layers/sme-roster/server/mcp/tools/list_platform_recognized_directory')).default
  detailTool = (await import('../../../layers/sme-roster/server/mcp/tools/get_platform_recognized_record')).default
})
afterAll(() => {
  vi.unstubAllGlobals(); vi.unstubAllEnvs(); db.$client.close(); rmSync(dir, { recursive: true, force: true })
})

it('exposes the same recognized directory contract over MCP as the shared domain service', async () => {
  expect(listTool.name).toBe('list_platform_recognized_directory')
  expect(detailTool.name).toBe('get_platform_recognized_record')
  const input = { view: 'records' as const, rdjb: '2' as const, rddqrq: '2027-12-31', whpcyear: 2024, whpc: '2024-2', szq: '33020000', page: 1, pageSize: 25 }
  const listed = await listTool.handler(input as never, {} as never) as { structuredContent: unknown; content: { text: string }[] }
  const expected = listTargetRecognizedDirectory(input, db)
  expect(listed.structuredContent).toEqual(expected)
  expect(JSON.parse(listed.content[0]!.text)).toEqual(expected)
  expect(expected.rows[0]).toMatchObject({
    kind: 'record',
    matchedVersion: { validityDateRaw: '2027-12-31', maintenanceYear: 2024, maintenanceBatch: '2024-2', district: '33020000', titleRaw: '2' },
    titleScopes: ['2'],
  })

  const detail = await detailTool.handler({ recordId }, {} as never) as { structuredContent: unknown; content: { text: string }[] }
  const expectedDetail = getTargetRecognizedRecord(db, recordId)
  expect(detail.structuredContent).toEqual(expectedDetail)
  expect(JSON.parse(detail.content[0]!.text)).toEqual(expectedDetail)
  expect(expectedDetail.observations[0]).toMatchObject({ relationId, titleConflict: false })
  expect(JSON.stringify(expectedDetail)).not.toContain('unknownSensitiveField')

  const isolated = await listTool.handler({ view: 'isolated', pageSize: 25 } as never, {} as never) as { structuredContent: { rows: unknown[] } }
  expect(isolated.structuredContent).toEqual(listTargetRecognizedDirectory({ view: 'isolated' }, db))
})
