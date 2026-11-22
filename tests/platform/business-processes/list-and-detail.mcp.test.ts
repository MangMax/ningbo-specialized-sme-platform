import { postgresRuntimeFixture } from '../../support/postgres-fixture.mjs'
import { closePostgresDirectoryDb } from '../../../db/postgresql/client'
import { mkdtempSync,rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll,beforeAll,expect,it,vi } from 'vitest'
import { schema } from '../../../db'
import { initializeDb } from '../../../db/client'
import { getTargetBusinessProcess,listTargetBusinessProcesses } from '../../../layers/sme-roster/server/utils/platform-business-processes-target'
import { submitNativePlatformQuery } from '../fixtures/native-query'

vi.mock('@nuxtjs/mcp-toolkit/server', () => ({ defineMcpTool: (tool: unknown) => tool }))

const dir = mkdtempSync(join(tmpdir(), 'business-processes-mcp-'))
const dbPath = join(dir, 'business.sqlite')
const db = initializeDb({ create: true, dbPath })
let postgres: Awaited<ReturnType<typeof postgresRuntimeFixture>> | undefined
let listTool: typeof import('../../../layers/sme-roster/server/mcp/tools/list_platform_business_processes').default
let detailTool: typeof import('../../../layers/sme-roster/server/mcp/tools/get_platform_business_process').default
let recordId = 0

beforeAll(async () => {
  vi.stubGlobal('createError', (input: unknown) => Object.assign(new Error('fixture'), input))
  const enterprise = db.insert(schema.enterprise).values({ name: 'MCP 办理企业', nameNorm: 'MCP 办理企业', usccNorm: '91330211255994457P' }).returning().get()
  const written = submitNativePlatformQuery(db, {
    interface: 'business_list', queryKey: enterprise.usccNorm!, rdjb: '2', titleCode: 'specialized_sme', queriedAt: '2026-10-01T00:00:00Z', status: 'success', rawResponse: 'synthetic original business response',
    relations: [{ sequenceNo: 1, relationKey: 'SQ-MCP-READ', enterpriseId: enterprise.id, usccRaw: enterprise.usccNorm, nameRaw: enterprise.name,
      rawFields: { id: 'SQ-MCP-READ', qymc: enterprise.name, tyshxydm: enterprise.usccNorm, sblx: '复核', year: '2023', sqsj: '2023-02-01', cszt: '终审通过', whpc: '2023-2', personuuid: '第三批', szsfmc: '浙江省', unknownSensitiveField: 'PRIVATE-MCP-MARKER' } }],
  })
  recordId = written.observations[0]!.recordId!
  postgres = await postgresRuntimeFixture({ dir, sourcePath: dbPath })
  for (const [key, value] of Object.entries(postgres.env)) vi.stubEnv(key, value)
  listTool = (await import('../../../layers/sme-roster/server/mcp/tools/list_platform_business_processes')).default
  detailTool = (await import('../../../layers/sme-roster/server/mcp/tools/get_platform_business_process')).default
}, 30_000)
afterAll(async () => {
  await closePostgresDirectoryDb()
  postgres?.close()
  vi.unstubAllGlobals(); vi.unstubAllEnvs(); db.$client.close(); rmSync(dir, { recursive: true, force: true })
})

it('exposes the same list and detail contract over MCP as the shared domain service', async () => {
  expect(listTool.name).toBe('list_platform_business_processes')
  expect(detailTool.name).toBe('get_platform_business_process')
  const input = { view: 'records' as const, rdjb: '2' as const, declareKind: 'review', year: 2023, status: '终审通过', batch: '2023-2', page: 1, pageSize: 25 }
  const listed = await listTool.handler(input as never, {} as never) as { structuredContent: unknown; content: { text: string }[] }
  const expected = listTargetBusinessProcesses(input, db)
  expect(listed.structuredContent).toEqual(expected)
  expect(JSON.parse(listed.content[0]!.text)).toEqual(expected)
  expect(expected.rows[0]).toMatchObject({ kind: 'record', matchedVersion: { declareKind: 'review', businessYear: 2023, batch: '2023-2' }, titleScopes: ['2'] })

  const detail = await detailTool.handler({ recordId }, {} as never) as { structuredContent: unknown; content: { text: string }[] }
  const expectedDetail = getTargetBusinessProcess(db, recordId)
  expect(detail.structuredContent).toEqual(expectedDetail)
  expect(JSON.parse(detail.content[0]!.text)).toEqual(expectedDetail)
  expect(JSON.stringify(expectedDetail)).not.toContain('unknownSensitiveField')
})
