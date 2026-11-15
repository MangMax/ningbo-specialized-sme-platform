import {readPlatformQueryEvidence} from '../../../lib/platform/evidence-read'
import {submitNativePlatformQuery} from '../fixtures/native-query'
import { nativeQueryRows, nativeRelationRows } from '../fixtures/native-evidence'
import { initializeDb } from '../../../db/client'
/**
 * 平台实查的**取数纪律** —— 并发上限、退避重试、会话过期、凭据缺失、新鲜复用。
 *
 * 这一组用例守的是票面写死的几条:(a) 并发要有上限;(b) 5xx 退避重试,**4xx 与会话过期
 * 一律不重试**;(c) 会话过期(HTTP 200 + `statusCode:301`)归 `failed`,**不是**
 * `no_record`;(d) 拿不到凭据时**不发请求、不写半截结果** —— 绝不产出「一片未查询」的
 * 假证据;(e) 已有**新鲜**查询可复用,不重复打平台。
 *
 * 全部离线:平台响应来自夹具,凭据是注入值(不落库、不进日志)。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { schema, useDb } from '../../../db'
import { runPlatformReconcile } from '../../../server/utils/platform-reconcile'
import { whenIdle } from '../../../server/utils/job-runner'
import { emptyReply, platformFixture, platformReplay, type PlatformCall } from '../fixtures/source-replay'

const fixture = platformFixture

const dirs: string[] = []
const connections: ReturnType<typeof useDb>[] = []
function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'spztx-reconcile-io-'))
  dirs.push(dir)
  const db = initializeDb({ create: true, dbPath: join(dir, 'io.db') })
  connections.push(db)
  return db
}

// Import commits now enqueue derived candidate jobs. Keep the real runner alive
// until they settle, before another case changes the fixture or Vitest tears down.
afterEach(async () => {
  await whenIdle()
  for (const db of connections) {
    expect(db.select({ state: schema.job.state }).from(schema.job).all()
      .filter(row => row.state === 'queued' || row.state === 'running')).toEqual([])
  }
})
afterAll(() => {
  for (const db of connections) db.$client.close()
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

/** 造一家 miit 侧、带统代的企业 ⇒ 比对口径里就是一条 `extra_in_miit`。 */
function seedTarget(db: ReturnType<typeof freshDb>, name: string, uscc: string) {
  const id = db
    .insert(schema.enterprise)
    .values({ name, nameNorm: name, usccNorm: uscc, district: '镇海区' })
    .returning({ id: schema.enterprise.id })
    .get().id
  db.insert(schema.record).values({ enterpriseId: id, source: 'miit', titleCode: 'specialized_sme' }).run()
  return id
}

const ok = (call: PlatformCall) => emptyReply(call)

const TYPED_QUERIED = '2026-10-16T02:00:00.000Z'
/** A complete legacy slot whose accepted page still contains the original typed row. */
function typedSlotResponse(source: 'businessList' | 'queryList', rdjb: string | null, rows: Record<string, unknown>[], uscc: string) {
  const grid = source === 'businessList' ? 'businessListGrid' : 'applyGrid'
  const raw = JSON.stringify({ zrarData: { grid: { [grid]: { pageSet: rows, page: 1, pageSize: 50, maxCount: rows.length, maxPage: 1 } } } })
  return JSON.stringify({
    kind: 'legacy-slot-pages/v1', interface: source === 'businessList' ? 'business_list' : 'apply_list', rdjb: rdjb ?? '', queryKey: uscc,
    queriedAt: TYPED_QUERIED, completedAt: TYPED_QUERIED, completeness: 'complete', declaredTotal: rows.length,
    pages: [{ source, rdjb, page: 1, status: 'success', fetchedCount: rows.length, declaredTotal: rows.length, error: null, queriedAt: TYPED_QUERIED, raw }],
    unfinished: [], requestCount: 1, failureReason: null,
  })
}
function seedTypedSlot(db: ReturnType<typeof freshDb>, uscc: string, rdjb: string, rows: Record<string, unknown>[]) {
  const business = rdjb !== ''
  const titleCode = business ? ({ '1': 'innovative_sme', '2': 'specialized_sme', '3': 'little_giant' } as const)[rdjb as '1' | '2' | '3'] : null
  const seeded=submitNativePlatformQuery(db,{interface:business?'business_list':'apply_list',queryKey:uscc,rdjb,queriedAt:TYPED_QUERIED,status:rows.length?'success':'no_record',titleCode,rawResponse:typedSlotResponse(business?'businessList':'queryList',business?rdjb:null,rows,uscc),relations:rows.map((rawFields,index)=>({sequenceNo:index+1,relationKey:typeof rawFields.id==='string'?rawFields.id:null,nameRaw:typeof rawFields.qymc==='string'?rawFields.qymc:null,usccRaw:typeof rawFields.tyshxydm==='string'?rawFields.tyshxydm:null,rawFields}))})
  const query=nativeQueryRows(db).find(q=>q.id===seeded.queryId)!
  return query
}

it('settles auto-enqueued derived jobs before fixture teardown', async () => {
  const db = freshDb()
  seedTarget(db, '派生任务收尾企业', '91330211000000018T')
  const platform = platformReplay(ok)
  await runPlatformReconcile({ db, fetchImpl: platform.fetchImpl, cookie: 'c=1', retries: 0 })
  await whenIdle()
  const jobs = db.select({ state: schema.job.state }).from(schema.job).all()
  expect(jobs.length).toBeGreaterThan(0)
  expect(jobs.every(row => row.state === 'done')).toBe(true)
})

describe('并发上限', () => {
  it('concurrency=2 时同时在飞的请求不超过 2,且确实并行(不是串行)', async () => {
    const db = freshDb()
    for (const n of ['91330211000000001A', '91330211000000002B', '91330211000000003C']) {
      seedTarget(db, `企业${n.slice(-3)}`, n)
    }
    const platform = platformReplay(ok, { delayMs: 15 })
    const report = await runPlatformReconcile({
      db,
      fetchImpl: platform.fetchImpl,
      cookie: 'c=1',
      concurrency: 2,
      retries: 0,
      now: () => new Date('2026-10-16T02:00:00.000Z'),
    })
    expect(platform.calls).toHaveLength(12) // 3 个 USCC × 4 个槽位
    expect(report.queries.network).toBe(12)
    expect(platform.peak()).toBe(2)
  })
})

describe('退避重试:5xx 重试,4xx 与会话过期不重试', () => {
  it('5xx 重试后成功,退避等待按 1000 * 3^(n-1)', async () => {
    const db = freshDb()
    seedTarget(db, '宁波重试科技有限公司', '91330211000000011R')
    const sleeps: number[] = []
    const platform = platformReplay((call, attempt) => {
      if (call.interface === 'business_list' && call.rdjb === '3' && attempt === 1) {
        return { status: 502, text: 'bad gateway' }
      }
      return ok(call)
    })
    const report = await runPlatformReconcile({
      db,
      fetchImpl: platform.fetchImpl,
      cookie: 'c=1',
      retries: 2,
      sleep: async (ms) => {
        sleeps.push(ms)
      },
      now: () => new Date('2026-10-16T02:00:00.000Z'),
    })
    expect(sleeps).toEqual([1000])
    const third = platform.calls.filter((call) => call.rdjb === '3' && call.interface === 'business_list')
    expect(third).toHaveLength(2)
    const rows = nativeQueryRows(db)
    expect(rows.find((row) => row.rdjb === '3')!.status).toBe('no_record')
    expect(report.counts.queryFailed).toBe(0)
  })

  it('4xx 不重试:一次就定性失败,理由里带 HTTP 状态码;其余档位照常判定', async () => {
    const db = freshDb()
    const target = seedTarget(db, '宁波四零四科技有限公司', '91330211000000044X')
    const sleeps: number[] = []
    const platform = platformReplay((call) =>
      call.interface === 'business_list' && call.rdjb === '3' ? { status: 400, text: 'bad request' } : ok(call),
    )
    const report = await runPlatformReconcile({
      db,
      fetchImpl: platform.fetchImpl,
      cookie: 'c=1',
      retries: 2,
      sleep: async (ms) => {
        sleeps.push(ms)
      },
      now: () => new Date('2026-10-16T02:00:00.000Z'),
    })
    expect(sleeps).toEqual([])
    expect(platform.calls.filter((call) => call.rdjb === '3' && call.interface === 'business_list')).toHaveLength(1)
    const failed = nativeQueryRows(db).find((row) => row.rdjb === '3')!
    expect(failed.status).toBe('failed')
    expect(failed.failureReason).toContain('HTTP 400')

    // 三档成功零条不覆盖失败的第四档，整体不能记完整无记录。
    // 一档失败即不能把其它成功零条称作完整无记录。
    const difference = db.select().from(schema.differenceReason).all()[0]!
    expect(difference.status).toBe('query_failed')
    expect(difference.verificationStatus).toBe('pending')
    expect(difference.measureCode).toBe('manual_review')
    expect(difference.reasonNote).toContain('rdjb=3')
    expect(difference.reasonNote).toContain('范围不完整')
    expect(report.counts.noRecord).toBe(0)
    expect(report.counts.queryFailed).toBe(1)
    expect(target).toBeGreaterThan(0)
  })
})

describe('会话过期:HTTP 200 也要归 failed(不是 no_record)', () => {
  it('四个请求全回过期页 ⇒ 查询 failed、差异 query_failed,绝不冒充「无记录」', async () => {
    const db = freshDb()
    seedTarget(db, '宁波过期科技有限公司', '91330211000000055Y')
    const platform = platformReplay(() => ({ text: fixture('session-expired.json') }))
    const report = await runPlatformReconcile({
      db,
      fetchImpl: platform.fetchImpl,
      cookie: 'c=1',
      retries: 2,
      sleep: async () => undefined,
      now: () => new Date('2026-10-16T02:00:00.000Z'),
    })
    // 过期是 HTTP 200 ⇒ **不重试**(重试也不会变好),每个槽位只打一次。
    expect(platform.calls).toHaveLength(4)
    const queries = nativeQueryRows(db)
    expect(queries).toHaveLength(4)
    expect(queries.every((row) => row.status === 'failed')).toBe(true)
    expect(queries[0]!.failureReason).toContain('登录超时')
    expect(nativeRelationRows(db)).toHaveLength(0)

    const difference = db.select().from(schema.differenceReason).all()[0]!
    expect(difference.status).toBe('query_failed')
    expect(difference.reasonNote).toContain('登录超时')
    expect(report.counts.queryFailed).toBe(1)
    expect(report.counts.noRecord).toBe(0)
  })
})

describe('凭据:拿不到就不发请求、不写半截结果', () => {
  it('无凭据 ⇒ 明确报错,库里一行不写(不产出「一片未查询」)', async () => {
    const db = freshDb()
    seedTarget(db, '宁波无凭据科技有限公司', '91330211000000066Z')
    const platform = platformReplay(ok)
    await expect(
      runPlatformReconcile({
        db,
        fetchImpl: platform.fetchImpl,
        cookie: () => '',
        now: () => new Date('2026-10-16T02:00:00.000Z'),
      }),
    ).rejects.toThrow(/MIIT_COOKIE/)
    expect(platform.calls).toHaveLength(0)
    expect(nativeQueryRows(db)).toHaveLength(0)
    expect(db.select().from(schema.differenceReason).all()).toHaveLength(0)
  })

  it('全部命中新鲜查询时**不需要**凭据(不打平台就不该要求会话)', async () => {
    const db = freshDb()
    const enterpriseId = seedTarget(db, '宁波新鲜科技有限公司', '91330211000000077W')
    const queries = nativeQueryRows(db)
    expect(queries).toHaveLength(0)
    // Reusable coverage must come from a real complete traversal, not a bare status.
    await runPlatformReconcile({ db, fetchImpl: platformReplay(ok).fetchImpl,
      cookie: 'synthetic', now: () => new Date('2026-10-16T01:00:00.000Z') })
    const platform = platformReplay(ok)
    const report = await runPlatformReconcile({
      db,
      fetchImpl: platform.fetchImpl,
      cookie: null,
      now: () => new Date('2026-10-16T02:00:00.000Z'),
    })
    expect(platform.calls).toHaveLength(0)
    expect(report.queries.network).toBe(0)
    expect(report.queries.reused).toBe(4)
    expect(report.counts.noRecord).toBe(0)
    expect(report.counts.reusedFresh).toBe(1)
    expect(report.write).toBeNull()
    expect(enterpriseId).toBeGreaterThan(0)
  })

  it('复用 typed 归档写出差异时不把原行字符串化，原行类型与关系保持不变', async () => {
    const db = freshDb()
    const uscc = '91330211000000088X'
    seedTarget(db, '宁波类型保真科技有限公司', uscc)
    const typed = JSON.parse(`{"id":"SQ-TYPED","qymc":"宁波类型保真科技有限公司","tyshxydm":"${uscc}","n":1,"b":true,"x":null,"o":{"a":1},"arr":[1,false],"__proto__":{"own":true},"constructor":"own"}`)
    for (const rdjb of ['1', '2']) seedTypedSlot(db, uscc, rdjb, [])
    seedTypedSlot(db, uscc, '3', [typed])
    seedTypedSlot(db, uscc, '', [])
    const before = nativeRelationRows(db)
    const report = await runPlatformReconcile({
      db,
      fetchImpl: async () => { throw new Error('fresh typed slots must not reach the network') },
      write: true,
      now: () => new Date('2026-10-16T02:01:00.000Z'),
      retries: 0,
    })
    expect(report.queries.network).toBe(0)
    expect(report.write?.status).toBe('committed')
    expect(nativeRelationRows(db)).toEqual(before)
    const source=before.find(row=>row.rawFields?.b===true)!
    const bytes=readPlatformQueryEvidence(db,{queryId:source.queryId,relationId:source.id,field:'relation'})
    if(!('data' in bytes))throw Error('Expected immutable row bytes')
    expect(JSON.parse(Buffer.from(bytes.data,'base64').toString()).rawFields).toEqual(typed)
  })
})

describe('实测案例 `91330206793007818K`:旧名要真的落进 enterprise_alias', () => {
  const USCC = '91330206793007818K'
  const NOW = '宁波一力实业有限公司'
  const OLD = '宁波一力减震器有限公司'

  const emptyBusiness = fixture('business-list-rdjb1-empty.html')
  const reply = (call: PlatformCall) => {
    if (call.interface === 'apply_list') {
      return {
        text: JSON.stringify({
          zrarData: {
            grid: {
              applyGrid: {
                maxCount: 2,
                page: 1,
                pageSize: 50,
                pageSet: [
                  { id: 'SQ-Y-2025', qymc: NOW, tyshxydm: USCC, szsfmc: '宁波市', cszt: '区县已审', sqsj: '2025-06-21 09:50:48', whpc: '2025-1', sblx: '复核', year: '2025', rdjb: '3' },
                  { id: 'SQ-Y-2022', qymc: OLD, tyshxydm: USCC, szsfmc: '宁波市', cszt: '终审通过', sqsj: '2022-06-22 17:17:52', whpc: '2022-1', sblx: '申请', year: '2022', rdjb: '3' },
                ],
              },
            },
          },
        }),
      }
    }
    if (call.rdjb !== '3' && call.rdjb !== '2') return { text: emptyBusiness }
    const rows =
      call.rdjb === '3'
        ? [
            { id: 'SQ-Y-2022', qymc: OLD, tyshxydm: USCC, szsfmc: '宁波市', cszt: '终审通过', sqsj: '2022-06-22 17:17:52', whpc: '2022-1', sblx: '申请' },
            { id: 'SQ-Y-2023', qymc: NOW, tyshxydm: USCC, szsfmc: '宁波市', cszt: '待审核', sqsj: '2023-04-19 16:46:01', whpc: '2022-1', sblx: '更新' },
            { id: 'SQ-Y-2024', qymc: NOW, tyshxydm: USCC, szsfmc: '宁波市', cszt: '待审核', sqsj: '2024-05-21 14:10:06', whpc: '2022-1', sblx: '更新' },
            { id: 'SQ-Y-2025', qymc: NOW, tyshxydm: USCC, szsfmc: '宁波市', cszt: '区县已审', sqsj: '2025-06-21 09:50:48', whpc: '2025-1', sblx: '复核' },
          ]
        : [{ id: 'SQ-Y-2023', qymc: NOW, tyshxydm: USCC, szsfmc: '宁波市', cszt: '待审核', sqsj: '2023-04-19 16:46:01', whpc: '2022-1', sblx: '更新' }]
    return {
      text: `<table name="businessListGrid"><tbody></tbody></table>\n<script>\n(function(data){ })( ${JSON.stringify({
        zrarData: { grid: { businessListGrid: { maxCount: rows.length, page: 1, pageSize: 50, pageSet: rows } } },
      })} );\n</script>`,
    }
  }

  it('4 条关系(3 现名 + 1 旧名)⇒ 原始关系完整保留，原因与曾用名交代理确认', async () => {
    const db = freshDb()
    const enterpriseId = seedTarget(db, NOW, USCC)
    db.delete(schema.record).run()
    db.insert(schema.record).values({ enterpriseId, source: 'miit', titleCode: 'little_giant' }).run()

    const platform = platformReplay(reply)
    const report = await runPlatformReconcile({
      db,
      fetchImpl: platform.fetchImpl,
      cookie: 'c=1',
      retries: 0,
      now: () => new Date('2026-10-16T02:00:00.000Z'),
    })

    // 四档都问了;rdjb=3 的 4 条关系逐条落库。
    expect(new Set(platform.calls.map((call) => `${call.interface}|${call.rdjb}`))).toEqual(
      new Set(['business_list|1', 'business_list|2', 'business_list|3', 'apply_list|']),
    )
    const relations = nativeRelationRows(db)
    expect(relations).toHaveLength(4 + 1 + 2)

    const difference = db.select().from(schema.differenceReason).all().find((row) => row.enterpriseId === enterpriseId)!
    expect(difference.titleCode).toBe('little_giant')
    expect(difference.direction).toBe('extra_in_miit')
    expect(difference.status).toBe('needs_review')
    expect(difference.reasonCode).toBeNull()
    expect(difference.measureCode).toBe('manual_review')

    const alias = db.select().from(schema.enterpriseAlias).all()
    expect(alias).toHaveLength(0)
    expect(relations.find(row => row.relationKey === 'SQ-Y-2022')).toBeDefined()
    expect(report.counts.byReason).toEqual({})
  })
})

describe('新鲜复用:库里的旧证据直接参与判定,不再打平台', () => {

  it('rdjb=3 历史成功缺完整性证明⇒ 保留原始证据并重新采集四个槽位', async () => {
    const db = freshDb()
    const USCC = '91330211000000088V'
    const enterpriseId = seedTarget(db, '宁波上航测绘股份有限公司', USCC)
    const stored=submitNativePlatformQuery(db,{interface:'business_list',queryKey:USCC,rdjb:'3',queriedAt:'2026-10-16T01:00:00.000Z',status:'success',rawResponse:'Explicit incomplete source',relations:[
      {sequenceNo:1,relationKey:'SQ-OLD',enterpriseId,usccRaw:USCC,nameRaw:'宁波上航测绘有限公司',rawFields:{id:'SQ-OLD',qymc:'宁波上航测绘有限公司',tyshxydm:USCC,szsfmc:'宁波市',cszt:'终审通过',sqsj:'2022-06-22 17:17:52'}},
      {sequenceNo:2,relationKey:'SQ-NEW',enterpriseId,usccRaw:USCC,nameRaw:'宁波上航测绘股份有限公司',rawFields:{id:'SQ-NEW',qymc:'宁波上航测绘股份有限公司',tyshxydm:USCC,szsfmc:'宁波市',cszt:'待审核',sqsj:'2025-06-21 09:50:48'}}
    ]}).queryId

    const platform = platformReplay(ok)
    const report = await runPlatformReconcile({
      db,
      fetchImpl: platform.fetchImpl,
      cookie: 'c=1',
      retries: 0,
      now: () => new Date('2026-10-16T02:00:00.000Z'),
    })

    // Historical success cannot prove all pages were collected.
    expect(platform.calls).toHaveLength(4)
    expect(platform.calls.some((call) => call.rdjb === '3' && call.interface === 'business_list')).toBe(true)
    expect(report.queries.reused).toBe(0)
    expect(report.queries.network).toBe(4)

    // Historical rows stay readable; the new complete empty observation does not confirm renaming.
    const difference = db.select().from(schema.differenceReason).all()[0]!
    expect(difference.status).toBe('no_record')
    expect(difference.reasonCode).toBeNull()
    expect(db.select().from(schema.enterpriseAlias).all()).toHaveLength(0)
    const relation = nativeRelationRows(db).find(row => row.relationKey === 'SQ-OLD')!
    expect(relation.queryId).toBe(stored)

  })

  it('不新鲜的既有查询要重查(过了窗口就该再打一次)', async () => {
    const db = freshDb()
    const USCC = '91330211000000099U'
    seedTarget(db, '宁波陈旧科技有限公司', USCC)
    submitNativePlatformQuery(db,{interface:'business_list',queryKey:USCC,rdjb:'3',queriedAt:'2026-10-01T01:00:00.000Z',status:'no_record',rawResponse:'Explicit original empty source'})
    const platform = platformReplay(ok)
    const report = await runPlatformReconcile({
      db,
      fetchImpl: platform.fetchImpl,
      cookie: 'c=1',
      retries: 0,
      freshnessMs: 24 * 3600_000,
      now: () => new Date('2026-10-16T02:00:00.000Z'),
    })
    expect(platform.calls).toHaveLength(4)
    expect(report.queries.reused).toBe(0)
    expect(report.queries.network).toBe(4)
    // 两个时点各自留档(旧解释不丢)。
    expect(nativeQueryRows(db).filter((row) => row.rdjb === '3')).toHaveLength(2)
  })
})
