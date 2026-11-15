import '../../support/compiled-enterprise-reader'
import { initializeDb } from '../../../db/client'
import { decodeJsonRead } from '../../support/json-read'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { schema, useDb } from '../../../db'

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
  qualityFlags: ['uscc_missing'],
}
const record = {
  id: 101,
  enterpriseId: enterprise.id,
  titleCode: 'specialized_sme',
  source: 'jxj' as const,
  district: '海曙区',
  usccRaw: null,
  nameRaw: enterprise.name,
  qualityFlags: [],
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
let db: ReturnType<typeof useDb>
const tempDir = mkdtempSync(join(tmpdir(), 'roster-enterprise-legacy-api-'))

beforeAll(async () => {
  db = initializeDb({ create: true, dbPath: join(tempDir, 'roster.db') })
  db.insert(schema.enterprise).values(enterprise).run()
  db.insert(schema.record).values(record).run()
  db.insert(schema.recordEvent).values(event).run()
  db.insert(schema.recordEvidence).values(legacyEvidence).run()

  vi.stubGlobal('setHeader', () => {})
  vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
  vi.stubGlobal('defineRouteMeta', vi.fn())
  vi.stubGlobal('getQuery', () => ({}))
  vi.stubGlobal('getRouterParam', () => String(enterprise.id))
  vi.doMock('@db', () => ({ useDb: () => db }))

  listHandler = decodeJsonRead((await import('../../../server/api/roster/enterprises.get')).default) as unknown as typeof listHandler
  detailHandler = decodeJsonRead((await import('../../../server/api/roster/enterprises/[id].get')).default) as unknown as typeof detailHandler
})

afterAll(() => {
  vi.doUnmock('@db')
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

    // The SQLite legacy rows remain untouched; normalization belongs to the read projection.
    expect(db.select({ page: schema.recordEvidence.page }).from(schema.recordEvidence).all().map((item) => item.page)).toEqual([12, 12])
  })
})
