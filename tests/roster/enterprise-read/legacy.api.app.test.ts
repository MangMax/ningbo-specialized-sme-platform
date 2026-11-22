import { postgresRuntimeFixture } from '../../support/postgres-fixture.mjs'
import { closePostgresDirectoryDb, usePostgresDirectoryDb } from '../../../db/postgresql/client'
import { decodeJsonRead } from '../../support/json-read'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as schema from '../fixtures/postgres-tables'

/**
 * Characterize the real GET route handlers against a read-only synthetic legacy snapshot.
 * The fixture contains old Word/Excel evidence rows with numeric pages; the test must not
 * write or migrate those rows while proving the REST projections suppress unstable pages.
 */
const enterprise = {
  id: 35,
  usccNorm: null,
  name: '宁波 legacy 出处页码测试企业有限公司',
  nameNorm: '宁波legacy出处页码测试企业有限公司',
  district: '海曙区',
  city: null,
  regStatus: null,
  qualityFlags: '["uscc_missing"]',
}
const record = {
  id: 101,
  enterpriseId: enterprise.id,
  titleCode: 'specialized_sme',
  source: 'jxj' as const,
  district: '海曙区',
  usccRaw: null,
  nameRaw: enterprise.name,
  qualityFlags: '[]',
}
const event = {
  id: 201,
  recordId: record.id,
  eventType: 'award' as const,
  year: 2024,
  batchSeq: 1,
  sortKey: 0,
  decidedYear: 2024,
  reviewOutcome: null,
}
const legacyEvidence = [
  {
    id: 301,
    recordEventId: event.id,
    sourceFile: 'synthetic/legacy/announcement.docx',
    attachment: '正文',
    listNo: 1,
    page: 12,
  },
  {
    id: 302,
    recordEventId: event.id,
    sourceFile: 'synthetic/legacy/appendix.xlsx',
    attachment: '名单',
    listNo: 2,
    page: 12,
  },
]

let listHandler: (event: unknown) => Promise<unknown>
let detailHandler: (event: unknown) => Promise<unknown>
let db: ReturnType<typeof usePostgresDirectoryDb>
const tempDir = mkdtempSync(join(tmpdir(), 'roster-enterprise-legacy-api-'))

let postgres: Awaited<ReturnType<typeof postgresRuntimeFixture>> | undefined
beforeAll(async () => {
  postgres = await postgresRuntimeFixture({ dir: tempDir })
  vi.stubEnv('NUXT_POSTGRES_DIRECTORY_URL', postgres.url)
  vi.stubEnv('NUXT_DB_READONLY', '0')
  db = usePostgresDirectoryDb()
  await db.insert(schema.enterprise).values(enterprise)
  await db.insert(schema.rosterLegacyMember).values({ enterpriseId: enterprise.id })
  await db.insert(schema.record).values(record)
  await db.insert(schema.recordEvent).values(event)
  await db.insert(schema.recordEvidence).values(legacyEvidence)

  vi.stubGlobal('setHeader', () => {})
  vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
  vi.stubGlobal('defineRouteMeta', vi.fn())
  vi.stubGlobal('getQuery', () => ({}))
  vi.stubGlobal('getRouterParam', () => String(enterprise.id))



  listHandler = decodeJsonRead((await import('../../../layers/sme-roster/server/api/roster/enterprises.get')).default) as unknown as typeof listHandler
  detailHandler = decodeJsonRead((await import('../../../layers/sme-roster/server/api/roster/enterprises/[id].get')).default) as unknown as typeof detailHandler
}, 60_000)

afterAll(async () => { await closePostgresDirectoryDb(); postgres?.close(); vi.unstubAllEnvs();
  vi.unstubAllGlobals()
  rmSync(tempDir, { recursive: true, force: true })
})

describe('legacy Word/Excel 出处页码 REST 读取', () => {
  it('总表首次认定和企业详情两种出处投影都把 DOCX/XLSX page=12 序列化为 null', async () => {
    const list = (await listHandler({})) as {
      rows: Array<{ enterpriseId: number; firstRecognition: Array<{ evidence: Array<{ sourceFile: string; page: number | null }> }> }>
    }
    const row = list.rows.find((candidate) => candidate.enterpriseId === enterprise.id)!
    expect(row.firstRecognition[0]?.evidence.map(({ sourceFile, page }) => ({ sourceFile, page }))).toEqual([
      { sourceFile: 'synthetic/legacy/announcement.docx', page: null },
      { sourceFile: 'synthetic/legacy/appendix.xlsx', page: null },
    ])

    const detail = (await detailHandler({})) as {
      evidence: Array<{ sourceFile: string; page: number | null }>
      recognitions: Array<{ evidence: Array<{ sourceFile: string; page: number | null }> }>
    }
    expect(detail.evidence.map(({ sourceFile, page }) => ({ sourceFile, page }))).toEqual([
      { sourceFile: 'synthetic/legacy/announcement.docx', page: null },
      { sourceFile: 'synthetic/legacy/appendix.xlsx', page: null },
    ])
    expect(detail.recognitions[0]?.evidence.map(({ sourceFile, page }) => ({ sourceFile, page }))).toEqual([
      { sourceFile: 'synthetic/legacy/announcement.docx', page: null },
      { sourceFile: 'synthetic/legacy/appendix.xlsx', page: null },
    ])

    // The legacy evidence rows remain untouched; normalization belongs to the read projection.
    expect((await db.select({ page: schema.recordEvidence.page }).from(schema.recordEvidence)).map((item) => item.page)).toEqual([12, 12])
  })
})
