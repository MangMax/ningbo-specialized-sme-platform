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
import { afterAll, describe, expect, it } from 'vitest'
import { schema, useDb } from '../db'
import { runPlatformReconcile } from '../server/utils/platform-reconcile'
import { emptyReply, platformFixture, platformReplay, type PlatformCall } from './helpers/platform-replay'

const fixture = platformFixture

const dirs: string[] = []
function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'spztx-reconcile-io-'))
  dirs.push(dir)
  return useDb({ dbPath: join(dir, 'io.db') })
}

afterAll(() => {
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
    const rows = db.select().from(schema.platformQuery).all()
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
    const failed = db.select().from(schema.platformQuery).all().find((row) => row.rdjb === '3')!
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
    const queries = db.select().from(schema.platformQuery).all()
    expect(queries).toHaveLength(4)
    expect(queries.every((row) => row.status === 'failed')).toBe(true)
    expect(queries[0]!.failureReason).toContain('登录超时')
    expect(db.select().from(schema.platformRelation).all()).toHaveLength(0)

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
    expect(db.select().from(schema.platformQuery).all()).toHaveLength(0)
    expect(db.select().from(schema.differenceReason).all()).toHaveLength(0)
  })

  it('全部命中新鲜查询时**不需要**凭据(不打平台就不该要求会话)', async () => {
    const db = freshDb()
    const enterpriseId = seedTarget(db, '宁波新鲜科技有限公司', '91330211000000077W')
    const queries = db.select().from(schema.platformQuery).all()
    expect(queries).toHaveLength(0)
    // 先手写四个「新鲜」查询(模拟上一次运行留下的证据)。
    for (const slot of [
      { interface: 'business_list' as const, rdjb: '1' },
      { interface: 'business_list' as const, rdjb: '2' },
      { interface: 'business_list' as const, rdjb: '3' },
      { interface: 'apply_list' as const, rdjb: '' },
    ]) {
      db.insert(schema.platformQuery)
        .values({
          interface: slot.interface,
          queryKey: '91330211000000077W',
          rdjb: slot.rdjb,
          queriedAt: '2026-10-16T01:00:00.000Z',
          status: 'no_record',
        })
        .run()
    }
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
    expect(report.counts.noRecord).toBe(1)
    expect(enterpriseId).toBeGreaterThan(0)
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
    const relations = db.select().from(schema.platformRelation).all()
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

  it('rdjb=3 已有新鲜成功查询(含两个名字)⇒ 复用原始证据但不自动确认更名,只补另外三个槽位', async () => {
    const db = freshDb()
    const USCC = '91330211000000088V'
    const enterpriseId = seedTarget(db, '宁波上航测绘股份有限公司', USCC)
    const stored = db
      .insert(schema.platformQuery)
      .values({
        interface: 'business_list',
        queryKey: USCC,
        rdjb: '3',
        queriedAt: '2026-10-16T01:00:00.000Z',
        status: 'success',
      })
      .returning({ id: schema.platformQuery.id })
      .get().id
    db.insert(schema.platformRelation)
      .values({
        queryId: stored,
        sequenceNo: 1,
        relationKey: 'SQ-OLD',
        enterpriseId,
        usccRaw: USCC,
        nameRaw: '宁波上航测绘有限公司',
        province: '宁波市',
        status: '终审通过',
        appliedAt: '2022-06-22 17:17:52',
        rawFields: { id: 'SQ-OLD', qymc: '宁波上航测绘有限公司', tyshxydm: USCC, szsfmc: '宁波市', cszt: '终审通过', sqsj: '2022-06-22 17:17:52' },
      })
      .run()
    db.insert(schema.platformRelation)
      .values({
        queryId: stored,
        sequenceNo: 2,
        relationKey: 'SQ-NEW',
        enterpriseId,
        usccRaw: USCC,
        nameRaw: '宁波上航测绘股份有限公司',
        province: '宁波市',
        status: '待审核',
        appliedAt: '2025-06-21 09:50:48',
        rawFields: { id: 'SQ-NEW', qymc: '宁波上航测绘股份有限公司', tyshxydm: USCC, szsfmc: '宁波市', cszt: '待审核', sqsj: '2025-06-21 09:50:48' },
      })
      .run()

    const platform = platformReplay(ok)
    const report = await runPlatformReconcile({
      db,
      fetchImpl: platform.fetchImpl,
      cookie: 'c=1',
      retries: 0,
      now: () => new Date('2026-10-16T02:00:00.000Z'),
    })

    // rdjb=3 复用(0 请求),另外三个槽位实查 —— 共 3 个请求。
    expect(platform.calls).toHaveLength(3)
    expect(platform.calls.some((call) => call.rdjb === '3' && call.interface === 'business_list')).toBe(false)
    expect(report.queries.reused).toBe(1)
    expect(report.queries.network).toBe(3)

    // 复用关系仍可查，但不会自动产出更名结论。
    const difference = db.select().from(schema.differenceReason).all()[0]!
    expect(difference.status).toBe('needs_review')
    expect(difference.reasonCode).toBeNull()
    expect(db.select().from(schema.enterpriseAlias).all()).toHaveLength(0)
    const relation = db.select().from(schema.platformRelation).all().find(row => row.relationKey === 'SQ-OLD')!
    expect(relation.queryId).toBe(stored)

  })

  it('不新鲜的既有查询要重查(过了窗口就该再打一次)', async () => {
    const db = freshDb()
    const USCC = '91330211000000099U'
    seedTarget(db, '宁波陈旧科技有限公司', USCC)
    db.insert(schema.platformQuery)
      .values({
        interface: 'business_list',
        queryKey: USCC,
        rdjb: '3',
        queriedAt: '2026-10-01T01:00:00.000Z', // 远超 24h 窗口
        status: 'no_record',
      })
      .run()
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
    expect(db.select().from(schema.platformQuery).all().filter((row) => row.rdjb === '3')).toHaveLength(2)
  })
})
