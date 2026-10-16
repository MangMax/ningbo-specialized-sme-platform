/**
 * `lib/platform/reconcile.ts` —— 差异原因与后置动作的**判定引擎**(纯函数)。
 *
 * 这一组用例守的是票面的硬约束:**只依据显式证据,绝不推断**,而且四态互不等价。
 * 每一条判定都要能指回一条可读的来源字段(`qymc` / `szsfmc` / `cszt` / `sqsj`),
 * 指不回去的一律 `needs_review` + `manual_review`,并在 `reasonNote` 写清缺什么证据。
 *
 * 真实字节来自父代理在已登录会话里代取的 `91330211255994457P` 四个响应
 * (`tests/fixtures/platform/`,已裁剪、不含凭证)。
 */
import { describe, expect, it } from 'vitest'
import { classifyRawQuery, type PlatformRow } from '../lib/platform'
import type { PlatformInterface } from '../lib/labels'
import { relationFromRow, type PlatformRelationRecord } from '../lib/platform/identity'
import {
  type ReconcileQueryEvidence,
  type ReconcileTarget,
  decideDifference,
} from '../lib/platform/reconcile'

import { platformFixture as fixture } from './helpers/platform-replay'

const USCC = '91330211255994457P'
const OLD_NAME = '宁波上航测绘有限公司'
const NEW_NAME = '宁波上航测绘股份有限公司'
const QUERIED_AT = '2026-10-15T17:11:21.514Z'

/** 用真实夹具构造一次查询证据(走真的解析器,不手写记录)。 */
function evidenceFromFixture(
  name: string,
  meta: { interface: PlatformInterface; rdjb?: string },
): ReconcileQueryEvidence {
  const outcome = classifyRawQuery(fixture(name), { ...meta, queryKey: USCC, queriedAt: QUERIED_AT })
  return {
    interface: outcome.interface,
    rdjb: outcome.rdjb,
    queriedAt: outcome.queriedAt,
    status: outcome.status,
    failureReason: outcome.failureReason,
    relations: outcome.rows.map((row, index) =>
      relationFromRow(row, { interface: outcome.interface, rdjb: outcome.rdjb, queryKey: USCC, sequenceNo: index + 1 }),
    ),
  }
}

/** 合成一次查询(用于构造合成场景,不依赖真实夹具)。 */
function evidence(
  meta: { interface: PlatformInterface; rdjb?: string },
  rows: PlatformRow[],
  status: ReconcileQueryEvidence['status'] = rows.length ? 'success' : 'no_record',
): ReconcileQueryEvidence {
  const rdjb = meta.rdjb ?? ''
  return {
    interface: meta.interface,
    rdjb,
    queriedAt: QUERIED_AT,
    status,
    failureReason: null,
    relations: rows.map((row, index) =>
      relationFromRow(row, { interface: meta.interface, rdjb, queryKey: USCC, sequenceNo: index + 1 }),
    ),
  }
}

function failedEvidence(
  meta: { interface: PlatformInterface; rdjb?: string },
  reason: string,
): ReconcileQueryEvidence {
  return {
    interface: meta.interface,
    rdjb: meta.rdjb ?? '',
    queriedAt: QUERIED_AT,
    status: 'failed',
    failureReason: reason,
    relations: [],
  }
}

function target(overrides: Partial<ReconcileTarget> = {}): ReconcileTarget {
  return {
    enterpriseId: 7289,
    enterpriseName: NEW_NAME,
    enterpriseNameNorm: NEW_NAME,
    uscc: USCC,
    titleCode: 'specialized_sme',
    direction: 'extra_in_miit',
    ...overrides,
  }
}

/** 真实夹具 rdjb=1/2 各 0 行 + rdjb=3 的 6 行 + 申报接口的 2 行。 */
const realQueries = (): ReconcileQueryEvidence[] => [
  evidenceFromFixture('business-list-rdjb1-empty.html', { interface: 'business_list', rdjb: '1' }),
  evidenceFromFixture('business-list-rdjb2-empty.html', { interface: 'business_list', rdjb: '2' }),
  evidenceFromFixture('business-list-rdjb3.html', { interface: 'business_list', rdjb: '3' }),
  evidenceFromFixture('apply-list.json', { interface: 'apply_list' }),
]

const relationOf = (queries: ReconcileQueryEvidence[], rdjb: string, sequenceNo: number): PlatformRelationRecord =>
  queries.find((query) => query.rdjb === rdjb)!.relations.find((relation) => relation.sequenceNo === sequenceNo)!

// ---------------------------------------------------------------------------
// 四态互不等价
// ---------------------------------------------------------------------------

describe('四态互不等价(契约 §3.2)', () => {
  it('无统代 ⇒ not_queried:平台两接口只认 tyshxydm,查不了,也不编造查询键', () => {
    const verdict = decideDifference(target({ uscc: null, enterpriseName: OLD_NAME }), [])
    expect(verdict.status).toBe('not_queried')
    expect(verdict.reasonNote).toContain('tyshxydm')
    expect(verdict.measureCode).toBe('manual_review')
    expect(verdict.evidenceQuery).toBeNull()
    expect(verdict.aliases).toEqual([])
  })

  it('查询没成功执行 ⇒ query_failed,并把失败原文带进说明(不是 no_record)', () => {
    const queries = [
      failedEvidence({ interface: 'business_list', rdjb: '1' }, 'business_list rdjb=1 queryKey=…:登录超时,请重新登录'),
      failedEvidence({ interface: 'business_list', rdjb: '2' }, '登录超时,请重新登录'),
      failedEvidence({ interface: 'business_list', rdjb: '3' }, '登录超时,请重新登录'),
      failedEvidence({ interface: 'apply_list' }, '登录超时,请重新登录'),
    ]
    const verdict = decideDifference(target(), queries)
    expect(verdict.status).toBe('query_failed')
    expect(verdict.reasonNote).toContain('登录超时')
    expect(verdict.measureCode).toBe('manual_review')
    expect(verdict.evidenceQuery).not.toBeNull()
  })

  it('查询成功但平台返回空 ⇒ no_record,并与失败、未查询区分开', () => {
    const queries = [
      evidenceFromFixture('business-list-rdjb1-empty.html', { interface: 'business_list', rdjb: '1' }),
      evidenceFromFixture('business-list-rdjb2-empty.html', { interface: 'business_list', rdjb: '2' }),
      evidence({ interface: 'business_list', rdjb: '3' }, []),
      evidence({ interface: 'apply_list' }, []),
    ]
    const verdict = decideDifference(target({ direction: 'missing_in_miit' }), queries)
    expect(verdict.status).toBe('no_record')
    expect(verdict.reasonNote).toContain('0 条')
    // 两个接口都查不到 ⇒ 无记录 + 转人工(父代理口径:no_record 配 manual_review)。
    expect(verdict.measureCode).toBe('manual_review')
    expect(verdict.verificationStatus).toBe('pending')
    // 与「失败」不是同一件事:这里每一次查询都成功了。
    expect(verdict.status).not.toBe('query_failed')
  })

  it('导出表有、接口却查不到 ⇒ no_record + 转人工(证据互相矛盾,不硬判)', () => {
    const queries = [evidence({ interface: 'business_list', rdjb: '3' }, [])]
    const verdict = decideDifference(target({ direction: 'extra_in_miit' }), queries)
    expect(verdict.status).toBe('no_record')
    expect(verdict.measureCode).toBe('manual_review')
    expect(verdict.reasonNote).toContain('矛盾')
    expect(verdict.verificationStatus).toBe('pending')
  })

  it('一条成功、一条失败 ⇒ 用成功的那条判(不因为有一次失败就整条转人工)', () => {
    const queries = [
      failedEvidence({ interface: 'business_list', rdjb: '1' }, 'HTTP 502'),
      evidenceFromFixture('business-list-rdjb3.html', { interface: 'business_list', rdjb: '3' }),
    ]
    const verdict = decideDifference(target(), queries)
    expect(verdict.status).toBe('confirmed_reason')
    expect(verdict.reasonCode).toBe('renamed')
  })
})

// ---------------------------------------------------------------------------
// 更名 / 曾用名(回归案例 91330211255994457P)
// ---------------------------------------------------------------------------

describe('更名:同一 tyshxydm 下 qymc 不同 ⇒ 曾用名证据(契约 §5.1)', () => {
  it('rdjb=3 的 6 条里前 2 条写旧名 ⇒ renamed + update_current_name,旧名带来源关系', () => {
    const verdict = decideDifference(target(), realQueries())
    expect(verdict.status).toBe('confirmed_reason')
    expect(verdict.reasonCode).toBe('renamed')
    expect(verdict.measureCode).toBe('update_current_name')
    expect(verdict.verificationStatus).toBe('confirmed')
    expect(verdict.aliases).toHaveLength(1)

    const alias = verdict.aliases[0]!
    expect(alias.name).toBe(OLD_NAME)
    expect(alias.sourceKind).toBe('platform_business')
    // 来源关系用**自然键**(§8.7),含真实查询时点与序号 —— 不是猜的 id。
    expect(alias.sourceRelation).toEqual({
      interface: 'business_list',
      queryKey: USCC,
      rdjb: '3',
      queriedAt: QUERIED_AT,
      sequenceNo: 1,
    })
    // 证据明确(同 USCC、qymc 不同、最新申报唯一确定现名)⇒ confirmed。
    expect(alias.verificationStatus).toBe('confirmed')
    expect(alias.note).toContain('SQ332022062212391')
    expect(alias.validFrom).toBe('2022-06-22 17:17:52')
  })

  it('差异证据指向写旧名的那条关系(可回溯),而不是最新那条', () => {
    const verdict = decideDifference(target(), realQueries())
    expect(verdict.evidenceRelation).toEqual({
      interface: 'business_list',
      queryKey: USCC,
      rdjb: '3',
      queriedAt: QUERIED_AT,
      sequenceNo: 1,
    })
    expect(relationOf(realQueries(), '3', 1).nameRaw).toBe(OLD_NAME)
  })

  it('只有一个名字(尽管有 6 条关系)⇒ 不判更名,回到方向判据', () => {
    const rows: PlatformRow[] = [1, 2, 3].map((n) => ({
      id: `SQ-${n}`,
      qymc: NEW_NAME,
      tyshxydm: USCC,
      szsfmc: '宁波市',
      cszt: '终审通过',
      sqsj: `202${n}-06-01 10:00:00`,
      whpc: '2022-1',
    }))
    const verdict = decideDifference(target(), [evidence({ interface: 'business_list', rdjb: '3' }, rows)])
    expect(verdict.reasonCode).toBe('platform_stale')
    expect(verdict.aliases).toEqual([])
  })

  it('没有申报时间 ⇒ 定不出哪个是现名,不产曾用名、不判更名(不猜)', () => {
    const rows: PlatformRow[] = [
      { id: 'SQ-A', qymc: OLD_NAME, tyshxydm: USCC, szsfmc: '宁波市', cszt: '终审通过' },
      { id: 'SQ-B', qymc: NEW_NAME, tyshxydm: USCC, szsfmc: '宁波市', cszt: '待审核' },
    ]
    const verdict = decideDifference(target(), [evidence({ interface: 'business_list', rdjb: '3' }, rows)])
    expect(verdict.aliases).toEqual([])
    expect(verdict.reasonCode).not.toBe('renamed')
  })

  it('平台上只写出**一个**名字、且与公布名不同 ⇒ 也判 renamed(两侧名字不一致本身就是证据)', () => {
    const rows: PlatformRow[] = [
      { id: 'SQ-X', qymc: NEW_NAME, tyshxydm: USCC, szsfmc: '宁波市', cszt: '终审通过', sqsj: '2025-01-01 10:00:00' },
    ]
    // 本企业(公布侧)名是旧名;平台写的是新名 ⇒ 更名确实发生了。
    const verdict = decideDifference(
      target({ enterpriseName: OLD_NAME, enterpriseNameNorm: OLD_NAME }),
      [evidence({ interface: 'business_list', rdjb: '3' }, rows)],
    )
    expect(verdict.status).toBe('confirmed_reason')
    expect(verdict.reasonCode).toBe('renamed')
    expect(verdict.measureCode).toBe('update_current_name')
    // 单个名字定不出先后 ⇒ 整条与曾用名都标待核,不由软件指定谁是现名。
    expect(verdict.verificationStatus).toBe('pending')
    expect(verdict.reasonNote).toContain(OLD_NAME)
    expect(verdict.reasonNote).toContain(NEW_NAME)
    expect(verdict.aliases).toHaveLength(1)
    expect(verdict.aliases[0]!.name).toBe(NEW_NAME)
    expect(verdict.aliases[0]!.verificationStatus).toBe('pending')
    expect(verdict.aliases[0]!.sourceRelation.rdjb).toBe('3')
  })

  it('平台名字与公布名一致 ⇒ 不判更名(回到方向判据)', () => {
    const rows: PlatformRow[] = [
      { id: 'SQ-X', qymc: NEW_NAME, tyshxydm: USCC, szsfmc: '宁波市', cszt: '终审通过', sqsj: '2025-01-01 10:00:00' },
    ]
    const verdict = decideDifference(target(), [evidence({ interface: 'business_list', rdjb: '3' }, rows)])
    expect(verdict.reasonCode).toBe('platform_stale')
    expect(verdict.aliases).toEqual([])
  })
})

describe('证据指针必须指回**那条关系所在的那次查询**(同一接口有多个 rdjb 时尤其要紧)', () => {
  it('rdjb=1 与 rdjb=3 都有 sequenceNo=1 时,指针取 rdjb=3(承载旧名的那一次)', () => {
    const rdjb1 = evidence({ interface: 'business_list', rdjb: '1' }, [
      { id: 'SQ-A', qymc: NEW_NAME, tyshxydm: USCC, szsfmc: '宁波市', cszt: '终审通过', sqsj: '2023-01-01 10:00:00' },
    ])
    const rdjb3 = evidence({ interface: 'business_list', rdjb: '3' }, [
      { id: 'SQ-OLD', qymc: OLD_NAME, tyshxydm: USCC, szsfmc: '宁波市', cszt: '终审通过', sqsj: '2022-06-22 17:17:52' },
      { id: 'SQ-NEW', qymc: NEW_NAME, tyshxydm: USCC, szsfmc: '宁波市', cszt: '待审核', sqsj: '2025-06-21 09:50:48' },
    ])
    const verdict = decideDifference(target(), [rdjb1, rdjb3])
    // 旧名来自 rdjb=3 的第 1 条 —— 指针必须写 rdjb=3,否则 §8.7 的自然键会解析到
    // rdjb=1 的另一个查询(那里根本没有这条关系)。
    expect(verdict.aliases[0]!.sourceRelation).toEqual({
      interface: 'business_list',
      queryKey: USCC,
      rdjb: '3',
      queriedAt: QUERIED_AT,
      sequenceNo: 1,
    })
    expect(verdict.evidenceRelation).toEqual({
      interface: 'business_list',
      queryKey: USCC,
      rdjb: '3',
      queriedAt: QUERIED_AT,
      sequenceNo: 1,
    })
    expect(verdict.evidenceQuery!.rdjb).toBe('3')
  })
})

describe('平台记录全部作废:原因落 `other`(有证据,但不在五个已知原因内)', () => {
  it('状态全部「撤回 / 终审不通过」⇒ other + keep_history,原文写进 reasonNote', () => {
    const rows: PlatformRow[] = [
      { id: 'SQ-1', qymc: NEW_NAME, tyshxydm: USCC, szsfmc: '宁波市', cszt: '撤回', sqsj: '2024-01-01 10:00:00' },
      { id: 'SQ-2', qymc: NEW_NAME, tyshxydm: USCC, szsfmc: '宁波市', cszt: '终审不通过', sqsj: '2024-06-01 10:00:00' },
    ]
    const verdict = decideDifference(target(), [evidence({ interface: 'business_list', rdjb: '3' }, rows)])
    expect(verdict.status).toBe('confirmed_reason')
    expect(verdict.reasonCode).toBe('other')
    expect(verdict.measureCode).toBe('keep_history')
    expect(verdict.reasonNote).toContain('撤回')
    expect(verdict.reasonNote).toContain('终审不通过')
    expect(verdict.verificationStatus).toBe('confirmed')
  })

  it('部分撤回、部分在册 ⇒ 不判 other(不能把在册记录一起说成作废)', () => {
    const rows: PlatformRow[] = [
      { id: 'SQ-1', qymc: NEW_NAME, tyshxydm: USCC, szsfmc: '宁波市', cszt: '撤回', sqsj: '2024-01-01 10:00:00' },
      { id: 'SQ-2', qymc: NEW_NAME, tyshxydm: USCC, szsfmc: '宁波市', cszt: '终审通过', sqsj: '2025-01-01 10:00:00' },
    ]
    const verdict = decideDifference(target(), [evidence({ interface: 'business_list', rdjb: '3' }, rows)])
    expect(verdict.reasonCode).not.toBe('other')
    expect(verdict.reasonCode).toBe('platform_stale')
  })

  it('「待审核」不算作废(在办,不是撤了)', () => {
    const rows: PlatformRow[] = [
      { id: 'SQ-1', qymc: NEW_NAME, tyshxydm: USCC, szsfmc: '宁波市', cszt: '待审核', sqsj: '2025-01-01 10:00:00' },
    ]
    const verdict = decideDifference(target(), [evidence({ interface: 'business_list', rdjb: '3' }, rows)])
    expect(verdict.reasonCode).toBe('platform_stale')
  })
})

// ---------------------------------------------------------------------------
// 省份证据:外迁 / 迁入
// ---------------------------------------------------------------------------

describe('省份证据(szsfmc)判外迁与迁入', () => {
  it('关系省份全不在宁波市 ⇒ moved_out + mark_moved_out', () => {
    const rows: PlatformRow[] = [
      { id: 'SQ-1', qymc: NEW_NAME, tyshxydm: USCC, szsfmc: '深圳市', cszt: '终审通过', sqsj: '2024-06-01 10:00:00' },
      { id: 'SQ-2', qymc: NEW_NAME, tyshxydm: USCC, szsfmc: '深圳市', cszt: '待审核', sqsj: '2025-06-01 10:00:00' },
    ]
    const verdict = decideDifference(target(), [evidence({ interface: 'business_list', rdjb: '3' }, rows)])
    expect(verdict.status).toBe('confirmed_reason')
    expect(verdict.reasonCode).toBe('moved_out')
    expect(verdict.measureCode).toBe('mark_moved_out')
    expect(verdict.reasonNote).toContain('深圳市')
    expect(verdict.movedIn).toBeNull()
  })

  it('最早在外地、最近在宁波市 ⇒ moved_in + record_moved_in,原城市按证据填', () => {
    const rows: PlatformRow[] = [
      { id: 'SQ-1', qymc: NEW_NAME, tyshxydm: USCC, szsfmc: '深圳市', cszt: '终审通过', sqsj: '2023-01-01 10:00:00', rdjb: '2' },
      { id: 'SQ-2', qymc: NEW_NAME, tyshxydm: USCC, szsfmc: '宁波市', cszt: '待审核', sqsj: '2025-06-01 10:00:00', rdjb: '2' },
    ]
    const verdict = decideDifference(target(), [
      evidence({ interface: 'business_list', rdjb: '2' }, rows),
      evidence(
        { interface: 'apply_list' },
        [{ id: 'SQ-1', qymc: NEW_NAME, tyshxydm: USCC, szsfmc: '深圳市', cszt: '终审通过', sqsj: '2023-01-01 10:00:00', year: '2023', rdjb: '2' }],
      ),
    ])
    expect(verdict.status).toBe('confirmed_reason')
    expect(verdict.reasonCode).toBe('moved_in')
    expect(verdict.measureCode).toBe('record_moved_in')
    expect(verdict.movedIn).toEqual({ city: '深圳市', titleCode: 'specialized_sme', year: 2023, batch: null })
    expect(verdict.verificationStatus).toBe('confirmed')
  })

  it('迁入但缺原称号/年份 ⇒ 缺项留空并标待核,不猜填', () => {
    const rows: PlatformRow[] = [
      { id: 'SQ-1', qymc: NEW_NAME, tyshxydm: USCC, szsfmc: '深圳市', cszt: '终审通过', sqsj: '2023-01-01 10:00:00' },
      { id: 'SQ-2', qymc: NEW_NAME, tyshxydm: USCC, szsfmc: '宁波市', cszt: '待审核', sqsj: '2025-06-01 10:00:00' },
    ]
    const verdict = decideDifference(target(), [evidence({ interface: 'apply_list' }, rows)])
    expect(verdict.reasonCode).toBe('moved_in')
    // 申报接口的行不带 `year`,`rdjb` 也没写 ⇒ 称号与年份都缺 ⇒ 留空待核。
    expect(verdict.movedIn!.city).toBe('深圳市')
    expect(verdict.movedIn!.year).toBe(2023) // 申报时间里的年份是**明写的**证据,可以取
    expect(verdict.movedIn!.titleCode).toBeNull()
    expect(verdict.verificationStatus).toBe('pending')
    expect(verdict.reasonNote).toContain('缺项待核')
  })

  it('省份混合但时间排不出先后 ⇒ needs_review,并写清缺什么证据', () => {
    const rows: PlatformRow[] = [
      { id: 'SQ-1', qymc: NEW_NAME, tyshxydm: USCC, szsfmc: '深圳市', cszt: '终审通过' },
      { id: 'SQ-2', qymc: NEW_NAME, tyshxydm: USCC, szsfmc: '宁波市', cszt: '待审核' },
    ]
    const verdict = decideDifference(target(), [evidence({ interface: 'business_list', rdjb: '3' }, rows)])
    expect(verdict.status).toBe('needs_review')
    expect(verdict.measureCode).toBe('manual_review')
    expect(verdict.reasonNote).toContain('申报时间')
    expect(verdict.verificationStatus).toBe('pending')
  })
})

// ---------------------------------------------------------------------------
// 注销:只有证据明说时才判
// ---------------------------------------------------------------------------

describe('注销:只有来源明说时才判,绝不从别的字段推', () => {
  it('关系原文含「注销」⇒ deregistered + mark_deregistered', () => {
    const rows: PlatformRow[] = [
      { id: 'SQ-1', qymc: NEW_NAME, tyshxydm: USCC, szsfmc: '宁波市', cszt: '已注销', sqsj: '2024-06-01 10:00:00' },
    ]
    const verdict = decideDifference(target(), [evidence({ interface: 'business_list', rdjb: '3' }, rows)])
    expect(verdict.reasonCode).toBe('deregistered')
    expect(verdict.measureCode).toBe('mark_deregistered')
    expect(verdict.evidenceRelation!.sequenceNo).toBe(1)
  })

  it('关系只有「待审核/终审通过」这类状态 ⇒ 不判注销', () => {
    const rows: PlatformRow[] = [
      { id: 'SQ-1', qymc: NEW_NAME, tyshxydm: USCC, szsfmc: '宁波市', cszt: '待审核', sqsj: '2024-06-01 10:00:00' },
    ]
    const verdict = decideDifference(target(), [evidence({ interface: 'business_list', rdjb: '3' }, rows)])
    expect(verdict.reasonCode).not.toBe('deregistered')
  })
})

// ---------------------------------------------------------------------------
// 方向判据
// ---------------------------------------------------------------------------

describe('平台有记录、关系无异常:按方向给结论', () => {
  it('missing_in_miit(公布侧有、导出表无)但接口有记录 ⇒ platform_stale(平台未更新),不是「无差异」', () => {
    // 用户 2026-10-16 的口径:官方已公布、平台审核信息滞后 ⇒ 这就是 platform_stale。
    const rows: PlatformRow[] = [
      { id: 'SQ-1', qymc: NEW_NAME, tyshxydm: USCC, szsfmc: '宁波市', cszt: '区县已审', sqsj: '2025-06-21 10:00:00', rdjb: '2' },
      { id: 'SQ-2', qymc: NEW_NAME, tyshxydm: USCC, szsfmc: '宁波市', cszt: '待审核', sqsj: '2024-06-01 10:00:00', rdjb: '2' },
    ]
    const verdict = decideDifference(target({ direction: 'missing_in_miit' }), [
      evidence({ interface: 'business_list', rdjb: '2' }, rows),
    ])
    expect(verdict.status).toBe('confirmed_reason')
    expect(verdict.reasonCode).toBe('platform_stale')
    expect(verdict.measureCode).toBe('mark_platform_snapshot')
    expect(verdict.verificationStatus).toBe('confirmed')
    // reasonNote 要抄下关键 cszt 原文与年份 —— 判定必须能指回可读证据。
    expect(verdict.reasonNote).toContain('区县已审')
    expect(verdict.reasonNote).toContain('待审核')
    expect(verdict.reasonNote).toContain('2024')
    expect(verdict.reasonNote).toContain('2025')
    expect(verdict.evidenceQuery).not.toBeNull()
    expect(verdict.evidenceRelation).not.toBeNull()
    // ⚠️ 绝不能记成 no_record / confirmed_no_diff —— 那会把「平台滞后」误报成「无差异」。
    expect(verdict.status).not.toBe('no_record')
    expect(verdict.status).not.toBe('confirmed_no_diff')
  })

  it('extra_in_miit(导出表有、公布侧无)⇒ platform_stale + mark_platform_snapshot', () => {
    const rows: PlatformRow[] = [
      { id: 'SQ-1', qymc: NEW_NAME, tyshxydm: USCC, szsfmc: '宁波市', cszt: '终审通过', sqsj: '2024-06-01 10:00:00', rdjb: '2' },
    ]
    const verdict = decideDifference(target({ direction: 'extra_in_miit' }), [
      evidence({ interface: 'business_list', rdjb: '2' }, rows),
    ])
    expect(verdict.status).toBe('confirmed_reason')
    expect(verdict.reasonCode).toBe('platform_stale')
    expect(verdict.measureCode).toBe('mark_platform_snapshot')
    expect(verdict.reasonNote).toContain('在册')
    // 「标明平台时点」而不是改写历史 —— 措施文案必须说清这一点。
    expect(verdict.measureNote).toContain('不覆盖')
  })
})

// ---------------------------------------------------------------------------
// 父代理 2026-10-16 用真凭据实测的三个案例(表里的条数 / cszt / 年份 / qymc 逐字照搬)
// ---------------------------------------------------------------------------

describe('实测案例一 `91330206793007818K`:同一次查询里既有现行名又有旧名', () => {
  const YILI = '91330206793007818K'
  const YILI_NOW = '宁波一力实业有限公司'
  const YILI_OLD = '宁波一力减震器有限公司'
  const yiliTarget = (overrides: Partial<ReconcileTarget> = {}) =>
    target({
      enterpriseId: 7286,
      enterpriseName: YILI_NOW,
      enterpriseNameNorm: YILI_NOW,
      uscc: YILI,
      direction: 'extra_in_miit',
      titleCode: 'little_giant',
      ...overrides,
    })

  /** rdjb=3 → 4 条(1 条旧名 + 3 条现行名);rdjb=2 → 1 条;rdjb=1 → 0;申报 → 2 条。 */
  const yiliQueries = (): ReconcileQueryEvidence[] => [
    evidence({ interface: 'business_list', rdjb: '1' }, []),
    evidence({ interface: 'business_list', rdjb: '2' }, [
      { id: 'SQ-Y2', qymc: YILI_NOW, tyshxydm: YILI, szsfmc: '宁波市', cszt: '待审核', sqsj: '2023-04-19 16:46:01', whpc: '2022-1' },
    ]),
    evidence({ interface: 'business_list', rdjb: '3' }, [
      { id: 'SQ332022062212391', qymc: YILI_OLD, tyshxydm: YILI, szsfmc: '宁波市', cszt: '终审通过', sqsj: '2022-06-22 17:17:52', whpc: '2022-1', sblx: '申请' },
      { id: 'SQ-Y-2023', qymc: YILI_NOW, tyshxydm: YILI, szsfmc: '宁波市', cszt: '待审核', sqsj: '2023-04-19 16:46:01', whpc: '2022-1', sblx: '更新' },
      { id: 'SQ-Y-2024', qymc: YILI_NOW, tyshxydm: YILI, szsfmc: '宁波市', cszt: '待审核', sqsj: '2024-05-21 14:10:06', whpc: '2022-1', sblx: '更新' },
      { id: 'SQ-Y-2025', qymc: YILI_NOW, tyshxydm: YILI, szsfmc: '宁波市', cszt: '区县已审', sqsj: '2025-06-21 09:50:48', whpc: '2025-1', sblx: '复核' },
    ]),
    evidence({ interface: 'apply_list' }, [
      { id: 'SQ-Y-2025', qymc: YILI_NOW, tyshxydm: YILI, szsfmc: '宁波市', cszt: '区县已审', sqsj: '2025-06-21 09:50:48', whpc: '2025-1', sblx: '复核', year: '2025', rdjb: '3' },
      { id: 'SQ332022062212391', qymc: YILI_OLD, tyshxydm: YILI, szsfmc: '宁波市', cszt: '终审通过', sqsj: '2022-06-22 17:17:52', whpc: '2022-1', sblx: '申请', year: '2022', rdjb: '3' },
    ]),
  ]

  it('4 条现行名 + 1 条旧名 ⇒ 识别出旧名是曾用名(不是把 4 条现行名当成曾用名)', () => {
    const verdict = decideDifference(yiliTarget(), yiliQueries())
    expect(verdict.aliases).toHaveLength(1)
    expect(verdict.aliases[0]!.name).toBe(YILI_OLD)
    expect(verdict.aliases[0]!.verificationStatus).toBe('confirmed')
    expect(verdict.aliases[0]!.sourceRelation.rdjb).toBe('3')
    expect(verdict.aliases[0]!.sourceRelation.sequenceNo).toBe(1)
    expect(verdict.status).toBe('confirmed_reason')
    expect(verdict.reasonCode).toBe('renamed')
    expect(verdict.measureCode).toBe('update_current_name')
  })

  it('旧名那条的申报时间最早、现名最新 ⇒ 取「最新一次申报写出的名字」当现名', () => {
    const queries = yiliQueries()
    const rdjb3 = queries.find((query) => query.rdjb === '3')!
    expect(rdjb3.relations).toHaveLength(4)
    expect(rdjb3.relations.filter((relation) => relation.nameRaw === YILI_OLD)).toHaveLength(1)
    expect(rdjb3.relations.filter((relation) => relation.nameRaw === YILI_NOW)).toHaveLength(3)
    const verdict = decideDifference(yiliTarget(), queries)
    expect(verdict.aliases.map((alias) => alias.name)).toEqual([YILI_OLD])
  })
})

describe('实测案例三 `913302126102116572`:三条关系、名字只有一个 ⇒ platform_stale 抄下 cszt 原文与年份', () => {
  const JUSHEN = '913302126102116572'
  const NAME = '宁波巨神制泵实业有限公司'

  it('missing_in_miit + 接口有 5 条关系 ⇒ confirmed_reason/platform_stale/mark_platform_snapshot', () => {
    const verdict = decideDifference(
      target({ enterpriseId: 1, enterpriseName: NAME, enterpriseNameNorm: NAME, uscc: JUSHEN, titleCode: 'little_giant', direction: 'missing_in_miit' }),
      [
        evidence({ interface: 'business_list', rdjb: '3' }, [
          { id: 'SQ-J1', qymc: NAME, tyshxydm: JUSHEN, szsfmc: '宁波市', cszt: '终审通过', sqsj: '2021-06-22 17:17:52', whpc: '2021-1' },
          { id: 'SQ-J2', qymc: NAME, tyshxydm: JUSHEN, szsfmc: '宁波市', cszt: '待审核', sqsj: '2022-06-22 17:17:52', whpc: '2021-1' },
          { id: 'SQ-J3', qymc: NAME, tyshxydm: JUSHEN, szsfmc: '宁波市', cszt: '待审核', sqsj: '2023-06-22 17:17:52', whpc: '2021-1' },
        ]),
        evidence({ interface: 'apply_list' }, [
          { id: 'SQ-J2', qymc: NAME, tyshxydm: JUSHEN, szsfmc: '宁波市', cszt: '待审核', sqsj: '2022-06-22 17:17:52', sblx: '复核', year: '2022', rdjb: '3' },
          { id: 'SQ-J1', qymc: NAME, tyshxydm: JUSHEN, szsfmc: '宁波市', cszt: '终审通过', sqsj: '2021-06-22 17:17:52', sblx: '申请', year: '2021', rdjb: '3' },
        ]),
      ],
    )
    expect(verdict.status).toBe('confirmed_reason')
    expect(verdict.reasonCode).toBe('platform_stale')
    expect(verdict.measureCode).toBe('mark_platform_snapshot')
    expect(verdict.verificationStatus).toBe('confirmed')
    expect(verdict.aliases).toEqual([])
    // 两类证据都在说明里:哪几档、哪些状态、哪些年份。
    expect(verdict.reasonNote).toContain('business_list rdjb=3 3 条')
    expect(verdict.reasonNote).toContain('apply_list 2 条')
    expect(verdict.reasonNote).toContain('待审核')
    expect(verdict.reasonNote).toContain('终审通过')
    expect(verdict.reasonNote).toContain('2021')
    expect(verdict.reasonNote).toContain('2022')
    expect(verdict.reasonNote).toContain('滞后')
  })
})

describe('平台未更新与更名是两个正交事实:原因取平台滞后,曾用名照写', () => {
  it('missing_in_miit + 接口有记录 + 关系里带旧名 ⇒ platform_stale,同时仍产出曾用名', () => {
    const USCC2 = '91330211000000021M'
    const NOW = '宁波某实业有限公司'
    const OLD = '宁波某实业厂'
    const verdict = decideDifference(
      target({ enterpriseId: 9, enterpriseName: NOW, enterpriseNameNorm: NOW, uscc: USCC2, direction: 'missing_in_miit' }),
      [
        evidence({ interface: 'business_list', rdjb: '3' }, [
          { id: 'SQ-A', qymc: OLD, tyshxydm: USCC2, szsfmc: '宁波市', cszt: '终审通过', sqsj: '2022-06-22 17:17:52' },
          { id: 'SQ-B', qymc: NOW, tyshxydm: USCC2, szsfmc: '宁波市', cszt: '待审核', sqsj: '2025-06-21 09:50:48' },
        ]),
      ],
    )
    // 父代理口径:missing_in_miit + 任一接口有记录 ⇒ platform_stale(不能记成「无差异」)。
    expect(verdict.reasonCode).toBe('platform_stale')
    expect(verdict.measureCode).toBe('mark_platform_snapshot')
    // 但曾用名是身份事实,照样要写出去 —— 否则这一轮就丢了更名证据。
    expect(verdict.aliases).toHaveLength(1)
    expect(verdict.aliases[0]!.name).toBe(OLD)
    expect(verdict.aliases[0]!.verificationStatus).toBe('confirmed')
    expect(verdict.reasonNote).toContain(OLD)
  })
})

// ---------------------------------------------------------------------------
// 全局不变量
// ---------------------------------------------------------------------------

describe('全局不变量:每条判定都成对、都能指回证据或明确说「缺什么」', () => {
  const scenarios: { name: string; target: ReconcileTarget; queries: ReconcileQueryEvidence[] }[] = [
    { name: '无统代', target: target({ uscc: null }), queries: [] },
    { name: '未查询', target: target(), queries: [] },
    { name: '查询失败', target: target(), queries: [failedEvidence({ interface: 'apply_list' }, 'HTTP 502')] },
    { name: '无记录', target: target({ direction: 'missing_in_miit' }), queries: [evidence({ interface: 'apply_list' }, [])] },
    { name: '更名', target: target(), queries: realQueries() },
    { name: '外迁', target: target(), queries: [evidence({ interface: 'business_list', rdjb: '3' }, [{ id: 'SQ-1', qymc: NEW_NAME, tyshxydm: USCC, szsfmc: '深圳市', cszt: '终审通过', sqsj: '2024-01-01 10:00:00' }])] },
    { name: '待核', target: target(), queries: [evidence({ interface: 'business_list', rdjb: '3' }, [{ id: 'SQ-1', qymc: NEW_NAME, tyshxydm: USCC, szsfmc: '宁波市', cszt: '终审通过' }, { id: 'SQ-2', qymc: NEW_NAME, tyshxydm: USCC, szsfmc: '深圳市', cszt: '终审通过' }])] },
    { name: '更名为待核(平台单个名字≠公布名)', target: target({ enterpriseName: OLD_NAME, enterpriseNameNorm: OLD_NAME }), queries: [evidence({ interface: 'business_list', rdjb: '3' }, [{ id: 'SQ-1', qymc: NEW_NAME, tyshxydm: USCC, szsfmc: '宁波市', cszt: '终审通过', sqsj: '2025-01-01 10:00:00' }])] },
    { name: '其他(记录全部作废)', target: target(), queries: [evidence({ interface: 'business_list', rdjb: '3' }, [{ id: 'SQ-1', qymc: NEW_NAME, tyshxydm: USCC, szsfmc: '宁波市', cszt: '撤回', sqsj: '2024-01-01 10:00:00' }])] },
  ]

  it.each(scenarios)('$name:有 status、有措施、有可读说明', ({ target: subject, queries }) => {
    const verdict = decideDifference(subject, queries)
    expect(verdict.status).toBeTruthy()
    expect(verdict.measureCode).toBeTruthy()
    // 「原因 + 措施」成对:两条说明都不许空着。
    expect(verdict.reasonNote.trim().length).toBeGreaterThan(0)
    expect(verdict.measureNote.trim().length).toBeGreaterThan(0)
    // 待核实必须**只配** manual_review,并落在 `pending`(契约 §3.2 的配对)。
    if (verdict.status === 'needs_review') {
      expect(verdict.verificationStatus).toBe('pending')
      expect(verdict.measureCode).toBe('manual_review')
    }
    // 已确认原因 ⇒ 必须写出原因码与措施,不留半截。
    if (verdict.status === 'confirmed_reason') {
      expect(verdict.reasonCode).not.toBeNull()
      expect(verdict.measureCode).not.toBe('manual_review')
    }
    // 「原因 + 措施」成对:给了原因就必须给措施(反之亦然)。
    expect(verdict.reasonCode == null || verdict.measureCode != null).toBe(true)
    // 没有证据指针时,说明里必须写清「缺什么」,不能一句「无法判断」了事。
    if (!verdict.evidenceQuery && verdict.status !== 'not_queried') {
      expect(verdict.reasonNote.length).toBeGreaterThan(10)
    }
  })

  it('不新增契约里没有的枚举值(原因 6 个 / 措施 8 个,闭集)', () => {
    const reasons = new Set(['moved_out', 'deregistered', 'renamed', 'platform_stale', 'moved_in', 'other', null])
    const measures = new Set([
      'keep_history', 'mark_platform_snapshot', 'mark_moved_out', 'mark_deregistered',
      'update_current_name', 'record_moved_in', 'manual_review', 'none',
    ])
    for (const scenario of scenarios) {
      const verdict = decideDifference(scenario.target, scenario.queries)
      expect(reasons.has(verdict.reasonCode)).toBe(true)
      expect(measures.has(verdict.measureCode)).toBe(true)
    }
  })
})
