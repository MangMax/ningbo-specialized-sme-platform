import { submitNativePlatformQuery } from './helpers/native-platform-fixture'
import { initializeDb } from '../db/client'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { schema, useDb } from '../db'
import { reconcileKey } from '../lib/reconcile'

/**
 * `GET /api/comparison` 的接缝测试(RL-03 交付物 3)。
 *
 * 两件事必须同时成立:
 *  1. **旧的 JSON 解释缓存路径保持兼容** —— 缓存读得到就照旧挂 `explanation`,读不到就全 null
 *     且**不影响**比对结果(`lib/reconcile.ts` 一字未改);
 *  2. **新的库内平台证据** `platform` 段随行返回(曾用名 / 已核验处置 / 关系条数)。
 */
const dir = mkdtempSync(join(tmpdir(), 'spztx-comparison-api-'))
const db = initializeDb({ create: true, dbPath: join(dir, 'api.db') })
const reconcilePath = join(dir, 'platform-reconcile.json')
const curatedPath = join(dir, 'curated.json')

const USCC = '91330211255994457P'
const PLAIN_USCC = '91330211000000001X'

function enterprise(name: string, uscc: string | null) {
  return db
    .insert(schema.enterprise)
    .values({ name, nameNorm: name, usccNorm: uscc })
    .returning({ id: schema.enterprise.id })
    .get().id
}
function record(enterpriseId: number, source: 'jxj' | 'miit') {
  db.insert(schema.record).values({ enterpriseId, source, titleCode: 'specialized_sme', district: '镇海区' }).run()
}

const withEvidence = enterprise('宁波上航测绘股份有限公司', USCC)
record(withEvidence, 'miit')
const plain = enterprise('宁波无证据企业', PLAIN_USCC)
db.insert(schema.record).values({ enterpriseId: plain, source: 'jxj', titleCode: 'specialized_sme', district: '余姚市' }).run()

db.insert(schema.enterpriseAlias)
  .values({
    enterpriseId: withEvidence,
    name: '宁波上航测绘有限公司',
    nameNorm: '宁波上航测绘有限公司',
    sourceKind: 'platform_business',
    sourceRefId: 0,
    verificationStatus: 'confirmed',
  })
  .run()
db.insert(schema.enterpriseAlias)
  .values({
    enterpriseId: plain,
    name: '宁波待核实旧名',
    nameNorm: '宁波待核实旧名',
    sourceKind: 'platform_business',
    sourceRefId: 0,
    verificationStatus: 'pending',
  })
  .run()
const queryId = submitNativePlatformQuery(db, { ...{ interface: 'business_list', queryKey: USCC, rdjb: '3', queriedAt: '2026-10-15T17:11:21.514Z', status: 'success' }, rawResponse: 'Explicit synthetic comparison source', relations: [{ sequenceNo: 1, relationKey: 'SQ1', enterpriseId: withEvidence, usccRaw: USCC, nameRaw: '宁波上航测绘有限公司' }] }).queryId
db.insert(schema.differenceReason)
  .values({
    enterpriseId: withEvidence,
    titleCode: 'specialized_sme',
    direction: 'extra_in_miit',
    status: 'confirmed_reason',
    reasonCode: 'renamed',
    measureCode: 'update_current_name',
    verificationStatus: 'confirmed',
    recordedAt: '2026-10-16T00:00:00.000Z',
  })
  .run()

let handler: (event: unknown) => {
  rows: { enterpriseId: number; explanation: unknown; platform: unknown }[]
  reconcile: { generatedAt: string | null; matched: number }
  platform: { withEvidence: number; withExplanation: number; withoutExplanation: number }
  total: number
  counts: Record<string, Record<string, number>>
  curatedCounts: Record<string, Record<string, number>>
}
let query: Record<string, unknown> = {}

beforeAll(async () => {
  vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
  vi.stubGlobal('getQuery', () => query)
  vi.stubGlobal('createError', (opts: { statusMessage?: string }) =>
    Object.assign(new Error(opts.statusMessage ?? 'Bad request'), opts),
  )
  vi.stubGlobal('useRuntimeConfig', () => ({ reconcilePath, curatedPath }))
  vi.doMock('@db', () => ({ useDb: () => db }))
  handler = (await import('../server/api/comparison.get')).default as unknown as typeof handler
})

afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('GET /api/comparison:库内平台证据 + 旧解释缓存兼容', () => {
  it('没有解释缓存时:explanation 全 null,但库内 platform 段照常返回', () => {
    query = {}
    const result = handler({})
    expect(result.reconcile).toEqual({ generatedAt: null, matched: 0 })
    expect(result.rows.every((row) => row.explanation === null)).toBe(true)
    const row = result.rows.find((r) => r.enterpriseId === withEvidence)!
    expect(row.platform).toMatchObject({
      aliases: [{ name: '宁波上航测绘有限公司', verificationStatus: 'confirmed' }],
      disposition: {
        status: 'confirmed_reason',
        reasonCode: 'renamed',
        measureCode: 'update_current_name',
        explanationId: expect.any(Number),
      },
      relationCount: 1,
    })
    expect(result.platform.withEvidence).toBe(2)
    expect(result.platform.withExplanation).toBe(1)
    expect(result.platform.withoutExplanation).toBe(1)
  })

  it('没有解释记录的行仍带出「未查询」默认态 —— 整页不再有「无数据」的行(RL-15)', () => {
    query = {}
    const result = handler({})
    const row = result.rows.find((r) => r.enterpriseId === plain)!
    expect(row.platform).toMatchObject({
      disposition: { explanationId: null, status: 'not_queried', reasonCode: null, measureCode: null },
      queries: [],
      relationCount: 0,
    })
    expect(result.platform.withoutExplanation).toBe(1)
  })

  it('查询证据带出**可展开的原始关系原文**(时点 / 接口 / 关系)', () => {
    query = {}
    const result = handler({})
    const row = result.rows.find((r) => r.enterpriseId === withEvidence)!
    const platform = row.platform as {
      queries: { interface: string; queriedAt: string; status: string; relations: { nameRaw: string | null }[] }[]
    }
    expect(platform.queries[0]).toMatchObject({
      interface: 'business_list',
      queriedAt: '2026-10-15T17:11:21.514Z',
      status: 'success',
    })
    expect(platform.queries[0]!.relations.map((r) => r.nameRaw)).toEqual(['宁波上航测绘有限公司'])
  })

  it('解释缓存存在时照旧挂上 explanation(旧路径未被破坏)', () => {
    const key = reconcileKey({
      uscc: PLAIN_USCC,
      nameNorm: '宁波无证据企业',
      titleCode: 'specialized_sme',
      direction: 'missing_in_miit',
    })
    writeFileSync(
      reconcilePath,
      JSON.stringify({
        generatedAt: '2026-10-15T11:53:46.532Z',
        source: { command: 'tsx scripts/reconcile.ts', db: '<snapshot>', criterion: 'lib/comparison.ts' },
        counts: { on_platform: 1 },
        entries: [
          {
            key,
            uscc: PLAIN_USCC,
            name: '宁波无证据企业',
            nameNorm: '宁波无证据企业',
            titleCode: 'specialized_sme',
            direction: 'missing_in_miit',
            rdjb: '2',
            explanation: { code: 'on_platform', note: '平台有记录(样本)' },
            evidence: { rdjb: '2', rdjbLabel: '专精特新中小企业', businessCount: 1, applyCount: 0, provinces: ['宁波市'], businessStatuses: [], applyStatuses: [], records: [] },
            fetchedAt: '2026-10-15T11:46:13.380Z',
          },
        ],
      }),
    )
    query = {}
    const result = handler({})
    expect(result.reconcile.generatedAt).toBe('2026-10-15T11:53:46.532Z')
    expect(result.reconcile.matched).toBe(1)
    expect(result.rows.find((r) => r.enterpriseId === plain)!.explanation).toMatchObject({
      explanation: { code: 'on_platform' },
    })
  })

  it('筛选参数照常生效(title / direction)', () => {
    query = { title: 'specialized_sme', direction: 'extra_in_miit' }
    const result = handler({})
    expect(result.rows.every((row) => (row as { direction?: string }).direction === 'extra_in_miit')).toBe(true)
    query = {}
  })

  it('q 按现名、已确认曾用名或大小写无关的统代子串搜索', () => {
    query = { q: '上航 测绘', district: '镇海区' }
    expect(handler({}).rows.map((row) => row.enterpriseId)).toEqual([withEvidence])

    query = { q: '94457p', district: '镇海区' }
    expect(handler({}).rows.map((row) => row.enterpriseId)).toEqual([withEvidence])
  })

  it('区县精确筛选且全局计数不随可见行过滤变化', () => {
    query = {}
    const global = handler({})
    query = { district: '余姚市', title: 'specialized_sme' }
    const result = handler({})
    expect(result.total).toBe(1)
    expect(result.rows.map((row) => row.enterpriseId)).toEqual([plain])
    expect(result.counts).toEqual(global.counts)
    expect(result.curatedCounts).toEqual(global.curatedCounts)
  })

  it('待核实曾用名不参与搜索', () => {
    query = { q: '待核实旧名' }
    expect(handler({}).total).toBe(0)
  })
})
