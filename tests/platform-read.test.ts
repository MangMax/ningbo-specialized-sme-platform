import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { schema, useDb } from '../db'
import { listPlatformQueries } from '../lib/platform/read'

const dir = mkdtempSync(join(tmpdir(), 'spztx-platform-read-'))
const db = useDb({ dbPath: join(dir, 'read.db') })

const USCC = '91330211255994457P'
const OTHER_USCC = '91330211000000009W'

const shanghang = db
  .insert(schema.enterprise)
  .values({ name: '宁波上航测绘股份有限公司', nameNorm: '宁波上航测绘股份有限公司', usccNorm: USCC })
  .returning({ id: schema.enterprise.id })
  .get().id

function query(values: Partial<typeof schema.platformQuery.$inferInsert>) {
  return db
    .insert(schema.platformQuery)
    .values({
      interface: 'business_list',
      queryKey: USCC,
      queriedAt: '2026-10-15T17:11:21.514Z',
      status: 'success',
      ...values,
    })
    .returning({ id: schema.platformQuery.id })
    .get().id
}

function relation(queryId: number, sequenceNo: number, values: Partial<typeof schema.platformRelation.$inferInsert> = {}) {
  return db
    .insert(schema.platformRelation)
    .values({
      queryId,
      sequenceNo,
      usccRaw: USCC,
      nameRaw: '宁波上航测绘股份有限公司',
      enterpriseId: shanghang,
      matchBasis: 'uscc',
      verificationStatus: 'confirmed',
      ...values,
    })
    .returning({ id: schema.platformRelation.id })
    .get().id
}

const NAMES_OLD = '宁波上航测绘有限公司'
const RDJB3_IDS = [
  'SQ332022062212391',
  'SQ332023041984270',
  'SQ332024052128274',
  'SQ332025060392166',
  'SQ332025062064737',
  'SQ332026052238796',
]

beforeAll(() => {
  const rdjb3 = query({ rdjb: '3', rawResponse: '<html>…zrarData…</html>' })
  RDJB3_IDS.forEach((relationKey, index) =>
    relation(rdjb3, index + 1, {
      relationKey,
      nameRaw: index < 2 ? NAMES_OLD : '宁波上航测绘股份有限公司',
      status: index === 3 ? '省已审' : '待审核',
      batch: index >= 3 ? '2025-1' : '2022-1',
      declareKind: index === 3 ? 'review' : index === 0 ? 'apply' : 'update',
      appliedAt: `202${2 + (index > 2 ? 2 : 0)}-01-0${index + 1} 00:00:00`,
      awardBatchLabel: index === 3 ? '第四批' : null,
    }),
  )
  query({ rdjb: '1', status: 'no_record' })
  query({ rdjb: '2', status: 'no_record' })
  const apply = query({ interface: 'apply_list', rdjb: '', queriedAt: '2026-10-15T17:11:24.000Z' })
  relation(apply, 1, { relationKey: RDJB3_IDS[3]!, batch: '2025-1', year: 2025 })
  relation(apply, 2, { relationKey: RDJB3_IDS[0]!, nameRaw: NAMES_OLD, batch: '2022-1', year: 2022 })
  query({ rdjb: '3', status: 'failed', failureReason: 'business_list rdjb=3 queryKey=…:登录超时', queriedAt: '2026-10-15T18:00:00.000Z' })
  query({ queryKey: OTHER_USCC, status: 'not_queried', queriedAt: '2026-10-15T19:00:00.000Z' })
})

afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('listPlatformQueries:逐条保留 + 四态可分', () => {
  it('一个 USCC 的查询各自成行,rdjb=3 的 6 条关系逐条在、按 sequenceNo 排', () => {
    const result = listPlatformQueries(db, { queryKey: USCC })
    const rdjb3 = result.rows.find((row) => row.query.interface === 'business_list' && row.query.rdjb === '3' && row.query.status === 'success')!
    expect(rdjb3.relations).toHaveLength(6)
    expect(rdjb3.relations.map((r) => r.sequenceNo)).toEqual([1, 2, 3, 4, 5, 6])
    expect(rdjb3.relations.map((r) => r.relationKey)).toEqual(RDJB3_IDS)
    // 同一个 SQ… id 在两个接口各出一次,不按 id 去重。
    expect(rdjb3.relations.filter((r) => r.relationKey === RDJB3_IDS[0])).toHaveLength(1)
  })

  it('四态都取得到,且各自不同(status 过滤生效)', () => {
    const all = listPlatformQueries(db, { queryKey: USCC })
    expect(new Set(all.rows.map((r) => r.query.status))).toEqual(
      new Set(['success', 'no_record', 'failed']),
    )
    expect(listPlatformQueries(db, { queryKey: USCC, status: 'failed' }).rows).toHaveLength(1)
    expect(listPlatformQueries(db, { queryKey: USCC, status: 'no_record' }).rows).toHaveLength(2)
    expect(listPlatformQueries(db, { enterpriseId: undefined, status: 'not_queried' }).rows).toHaveLength(1)
  })

  it('失败查询带 failure_reason,不会被读成「无记录」', () => {
    const failed = listPlatformQueries(db, { queryKey: USCC, status: 'failed' }).rows[0]!
    expect(failed.query.failureReason).toContain('登录超时')
    expect(failed.relations).toEqual([])
  })

  it('旧名关系也在,且带着它匹配到的企业名(现名可以不同)', () => {
    const rdjb3 = listPlatformQueries(db, { queryKey: USCC }).rows.find((r) => r.query.rdjb === '3' && r.query.status === 'success')!
    const oldName = rdjb3.relations.filter((r) => r.nameRaw === NAMES_OLD)
    expect(oldName).toHaveLength(2)
    expect(oldName[0]!.matchedName).toBe('宁波上航测绘股份有限公司')
    expect(oldName[0]!.matchBasis).toBe('uscc')
  })

  it('按企业过滤:只返回有关系归到该企业的查询,关系仍逐条在', () => {
    const result = listPlatformQueries(db, { enterpriseId: shanghang })
    const keys = result.rows.map((r) => `${r.query.interface}:${r.query.rdjb}:${r.query.status}`).sort()
    expect(keys).toEqual(['apply_list::success', 'business_list:3:success'])
  })

  it('默认不带原始响应原文;显式要求时才带', () => {
    const without = listPlatformQueries(db, { queryKey: USCC }).rows.find((r) => r.query.rdjb === '3' && r.query.status === 'success')!
    expect(without.query.rawResponse).toBeUndefined()
    const withRaw = listPlatformQueries(db, { queryKey: USCC, includeRawResponse: true }).rows.find((r) => r.query.rdjb === '3' && r.query.status === 'success')!
    expect(withRaw.query.rawResponse).toContain('zrarData')
  })

  it('分页与计数', () => {
    const page1 = listPlatformQueries(db, { queryKey: USCC, pageSize: 2, page: 1 })
    expect(page1.rows).toHaveLength(2)
    expect(page1.total).toBe(5)
    expect(page1.pageSize).toBe(2)
    expect(page1.counts.success).toBe(2)
    expect(page1.counts.failed).toBe(1)
  })
})

describe('GET /api/platform/queries(§7.6 读接口)', () => {
  let handler: (event: unknown) => ReturnType<typeof listPlatformQueries>
  let query: Record<string, unknown> = {}

  beforeAll(async () => {
    vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
    vi.stubGlobal('getQuery', () => query)
    vi.stubGlobal('createError', (opts: { statusMessage?: string }) =>
      Object.assign(new Error(opts.statusMessage ?? 'Bad request'), opts),
    )
    vi.doMock('@db', () => ({ useDb: () => db }))
    handler = (await import('../server/api/platform/queries.get')).default as unknown as typeof handler
  })

  it('按 queryKey 返回查询与关系', () => {
    query = { queryKey: USCC }
    const result = handler({})
    expect(result.total).toBe(5)
    expect(result.rows.flatMap((r) => r.relations).length).toBe(8)
  })

  it('非法 interface / status ⇒ 400', () => {
    query = { interface: 'nope' }
    expect(() => handler({})).toThrowError(/Unknown interface/)
    query = { status: 'nope' }
    expect(() => handler({})).toThrowError(/Unknown status/)
    query = { enterpriseId: 'abc' }
    expect(() => handler({})).toThrowError(/enterpriseId/)
  })

  it('按企业与状态过滤', () => {
    query = { enterpriseId: String(shanghang), status: 'success' }
    const result = handler({})
    expect(result.rows).toHaveLength(2)
    query = {}
  })
})
