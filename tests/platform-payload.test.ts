import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  aliasDecisionFromCandidate,
  buildPlatformWritePayload,
  type KnownEnterprise,
  type PlatformQueryInput,
} from '../lib/platform/payload'
import {
  aliasCandidatesOf,
  classifyRawQuery,
  groupRelationsByUscc,
  relationFromRow,
  type PlatformQueryOutcome,
  type PlatformRow,
} from '../lib/platform'

const fixture = (name: string) =>
  readFileSync(join(import.meta.dirname, 'fixtures/platform', name), 'utf8')

const USCC = '91330211255994457P'
const QUERIED_AT = '2026-10-15T17:11:21.514Z'

/** 直接用行构造一次成功的查询(用于合成场景,不依赖真实夹具)。 */
function outcomeWithRows(
  rows: PlatformRow[],
  meta: { interface: 'business_list' | 'apply_list'; rdjb?: string; queryKey: string },
): PlatformQueryOutcome {
  return {
    status: rows.length ? 'success' : 'no_record',
    rows,
    maxCount: rows.length,
    source: 'json',
    failureReason: null,
    interface: meta.interface,
    rdjb: meta.rdjb ?? '',
    queryKey: meta.queryKey,
    raw: JSON.stringify(rows),
  }
}

function outcome(name: string, meta: Parameters<typeof classifyRawQuery>[1]): PlatformQueryOutcome {
  return classifyRawQuery(fixture(name), meta)
}

/** 真实回归案例的四个查询:rdjb=1/2 各 0 行(no_record),rdjb=3 六行,申报两行。 */
const queries: PlatformQueryInput[] = [
  {
    interface: 'business_list',
    queryKey: USCC,
    rdjb: '1',
    queriedAt: QUERIED_AT,
    outcome: outcome('business-list-rdjb1-empty.html', { interface: 'business_list', rdjb: '1', queryKey: USCC }),
  },
  {
    interface: 'business_list',
    queryKey: USCC,
    rdjb: '2',
    queriedAt: QUERIED_AT,
    outcome: outcome('business-list-rdjb2-empty.html', { interface: 'business_list', rdjb: '2', queryKey: USCC }),
  },
  {
    interface: 'business_list',
    queryKey: USCC,
    rdjb: '3',
    queriedAt: QUERIED_AT,
    outcome: outcome('business-list-rdjb3.html', { interface: 'business_list', rdjb: '3', queryKey: USCC }),
  },
  {
    interface: 'apply_list',
    queryKey: USCC,
    rdjb: '',
    queriedAt: QUERIED_AT,
    outcome: outcome('apply-list.json', { interface: 'apply_list', queryKey: USCC }),
  },
]

const enterprises: KnownEnterprise[] = [
  { id: 375, name: '宁波上航测绘有限公司', nameNorm: '宁波上航测绘有限公司', uscc: null },
  { id: 7289, name: '宁波上航测绘股份有限公司', nameNorm: '宁波上航测绘股份有限公司', uscc: USCC },
]

describe('buildPlatformWritePayload:平台查询与关系逐条落库(§8.3)', () => {
  const request = buildPlatformWritePayload({
    sourceIdentity: 'platform/91330211255994457P.json',
    queries,
    enterprises,
    aliases: [],
    differences: [],
    merges: [],
  })

  it('四个查询各成一条 platformQuery,rdjb 进键、状态各按实际', () => {
    const rows = request.payload.platformQueries
    expect(rows).toHaveLength(4)
    expect(rows.map((q) => `${q.interface}:${q.rdjb}`)).toEqual([
      'business_list:1',
      'business_list:2',
      'business_list:3',
      'apply_list:',
    ])
    expect(rows[0]!.status).toBe('no_record')
    expect(rows[1]!.status).toBe('no_record')
    expect(rows[2]!.status).toBe('success')
    expect(rows[3]!.status).toBe('success')
    // 原始响应原文留证(回溯用),不参与查询。
    expect(rows[2]!.rawResponse).toContain('SQ332022062212391')
  })

  it('rdjb=3 的 6 条关系逐条保留,sequenceNo 从 1 起', () => {
    const relations = request.payload.platformQueries[2]!.relations!
    expect(relations).toHaveLength(6)
    expect(relations.map((r) => r.sequenceNo)).toEqual([1, 2, 3, 4, 5, 6])
    expect(relations.map((r) => r.relationKey)).toContain('SQ332022062212391')
    // 0 行的两次查询没有关系行。
    expect(request.payload.platformQueries[0]!.relations ?? []).toEqual([])
  })

  it('alias_name_raw 恒为 null —— 平台没有「曾用名」列,不得把 qymc 复制进去充数(C1)', () => {
    for (const query of request.payload.platformQueries) {
      for (const relation of query.relations ?? []) {
        expect(relation.aliasNameRaw).toBeNull()
      }
    }
  })

  it('匹配依据按统代判定:同 USCC 的关系归到该企业,标 confirmed', () => {
    const relations = request.payload.platformQueries[2]!.relations!
    for (const relation of relations) {
      expect(relation.matchBasis).toBe('uscc')
      expect(relation.verificationStatus).toBe('confirmed')
    }
  })

  it('库外企业(统代不在已登记企业里)匹配为 none + pending,不自动归属', () => {
    const request = buildPlatformWritePayload({
      sourceIdentity: 'x',
      queries: [
        {
          interface: 'business_list',
          queryKey: '91330211000000999Z',
          rdjb: '3',
          queriedAt: QUERIED_AT,
          outcome: outcomeWithRows(
            [{ id: 'SQ1', qymc: '宁波库外企业有限公司', tyshxydm: '91330211000000999Z', cszt: '待审核' }],
            { interface: 'business_list', rdjb: '3', queryKey: '91330211000000999Z' },
          ),
        },
      ],
      enterprises,
      aliases: [],
      differences: [],
      merges: [],
    })
    const relations = request.payload.platformQueries[0]!.relations!
    expect(relations[0]!.matchBasis).toBe('none')
    expect(relations[0]!.verificationStatus).toBe('pending')
  })

  it('批次信封有幂等键与来源身份(不含凭证)', () => {
    expect(request.idempotencyKey).toBeTruthy()
    expect(request.idempotencyKey).not.toContain('token')
    expect(request.sourceKind).toBe('alias_evidence')
    expect(request.sourceIdentity).toBe('platform/91330211255994457P.json')
  })

  it('同一输入重复构造 → 同一幂等键(重放不重复写)', () => {
    const again = buildPlatformWritePayload({
      sourceIdentity: 'platform/91330211255994457P.json',
      queries, enterprises, aliases: [], differences: [], merges: [],
    })
    expect(again.idempotencyKey).toBe(request.idempotencyKey)
  })
})

describe('buildPlatformWritePayload:代理确认的曾用名(§5.1)', () => {
  it('确认后的旧名写成 confirmed 别名,挂上来源关系与接口', () => {
    const request = buildPlatformWritePayload({
      sourceIdentity: 'x',
      queries,
      enterprises,
      aliases: [
        {
          enterpriseId: 7289,
          name: '宁波上航测绘有限公司',
          sourceKind: 'platform_business',
          sourceRelation: { queryKey: USCC, interface: 'business_list', rdjb: '3', sequenceNo: 1 },
          sourceRefId: 0,
          validFrom: '2022-06-22 17:17:52',
          note: '平台关系 SQ332022062212391 明确写出',
        },
      ],
      differences: [],
      merges: [],
    })
    const alias = request.payload.aliases![0]!
    expect(alias.name).toBe('宁波上航测绘有限公司')
    expect(alias.uscc).toBe(USCC)
    expect(alias.enterpriseName).toBe('宁波上航测绘股份有限公司')
    expect(alias.sourceKind).toBe('platform_business')
    expect(alias.verificationStatus).toBe('confirmed')
    expect(alias.validFrom).toBe('2022-06-22 17:17:52')
    // 来源关系用自然键指认,写入侧解析成 platform_relation.id(见 C2 协调点)。
    expect(alias.sourceRelationRef).toEqual({
      queryKey: USCC, interface: 'business_list', rdjb: '3', sequenceNo: 1,
    })
  })

  it('同名多主体(同一名字挂在不同 USCC 下)被降级为 pending,不自动回填', () => {
    const name = '宁波同名科技有限公司'
    const request = buildPlatformWritePayload({
      sourceIdentity: 'x',
      queries: [
        {
          interface: 'business_list', queryKey: '91330211000000001A', rdjb: '2', queriedAt: QUERIED_AT,
          outcome: outcomeWithRows(
            [{ id: 'SQ-A', qymc: name, tyshxydm: '91330211000000001A', cszt: '终审通过', sqsj: '2021-01-01 00:00:00' }],
            { interface: 'business_list', rdjb: '2', queryKey: '91330211000000001A' },
          ),
        },
        {
          interface: 'business_list', queryKey: '91330211000000002B', rdjb: '2', queriedAt: QUERIED_AT,
          outcome: outcomeWithRows(
            [{ id: 'SQ-B', qymc: name, tyshxydm: '91330211000000002B', cszt: '终审通过', sqsj: '2021-01-01 00:00:00' }],
            { interface: 'business_list', rdjb: '2', queryKey: '91330211000000002B' },
          ),
        },
      ],
      enterprises: [
        { id: 1, name: '某企业', nameNorm: '某企业', uscc: '91330211000000001A' },
        { id: 2, name: '某企业', nameNorm: '某企业', uscc: '91330211000000002B' },
      ],
      aliases: [
        { enterpriseId: 1, name, sourceKind: 'platform_business', sourceRefId: 0 },
      ],
      differences: [],
      merges: [],
    })
    const alias = request.payload.aliases![0]!
    // 该名字同时挂在两个 USCC 下 ⇒ 冲突,由人解决,绝不自动 confirmed。
    expect(alias.verificationStatus).toBe('pending')
    expect(alias.conflict?.code).toBe('ambiguous_subject')
    expect(alias.conflict?.usccs.sort()).toEqual(['91330211000000001A', '91330211000000002B'])
  })

  it('来源统代与目标企业统代不一致时,同样降级为待核', () => {
    const request = buildPlatformWritePayload({
      sourceIdentity: 'x',
      queries: [
        {
          interface: 'business_list', queryKey: '91330211000000003C', rdjb: '2', queriedAt: QUERIED_AT,
          outcome: outcomeWithRows(
            [{ id: 'SQ-C', qymc: '宁波旧名有限公司', tyshxydm: '91330211000000003C', cszt: '终审通过' }],
            { interface: 'business_list', rdjb: '2', queryKey: '91330211000000003C' },
          ),
        },
      ],
      enterprises: [{ id: 7, name: '宁波现名有限公司', nameNorm: '宁波现名有限公司', uscc: USCC }],
      aliases: [
        { enterpriseId: 7, name: '宁波旧名有限公司', sourceKind: 'platform_business', sourceRefId: 0 },
      ],
      differences: [],
      merges: [],
    })
    expect(request.payload.aliases![0]!.verificationStatus).toBe('pending')
    expect(request.payload.aliases![0]!.conflict?.note).toContain('统代')
  })
})

describe('buildPlatformWritePayload:差异原因与后续措施成对(§2.8 / §1.5)', () => {
  const base = {
    sourceIdentity: 'x', queries, enterprises, aliases: [], merges: [],
  }

  it('五类已知原因各带配对的措施', () => {
    const reasons = [
      ['moved_out', 'mark_moved_out'],
      ['deregistered', 'mark_deregistered'],
      ['renamed', 'update_current_name'],
      ['platform_stale', 'mark_platform_snapshot'],
      ['moved_in', 'record_moved_in'],
    ] as const
    const request = buildPlatformWritePayload({
      ...base,
      differences: reasons.map(([reasonCode, measureCode], i) => ({
        enterpriseId: 7289,
        titleCode: 'specialized_sme' as const,
        direction: 'missing_in_miit' as const,
        status: 'confirmed_reason' as const,
        reasonCode,
        measureCode,
        verificationStatus: 'confirmed' as const,
        recordedAt: `2026-10-1${i}T00:00:00.000Z`,
      })),
    })
    for (const [reasonCode, measureCode] of reasons) {
      const row = request.payload.differences!.find((d) => d.reasonCode === reasonCode)!
      expect(row.measureCode).toBe(measureCode)
    }
  })

  it('迁入承载原城市/称号/年份/批次;证据不足的项留空并标待核', () => {
    const request = buildPlatformWritePayload({
      ...base,
      differences: [
        {
          enterpriseId: 7289, titleCode: 'specialized_sme', direction: 'missing_in_miit',
          status: 'needs_review', reasonCode: 'moved_in', measureCode: 'record_moved_in',
          movedIn: { city: '杭州市', titleCode: 'specialized_sme', year: 2020, batch: null },
          verificationStatus: 'pending', recordedAt: '2026-10-14T00:00:00.000Z',
        },
      ],
    })
    const row = request.payload.differences![0]!
    expect(row.movedIn).toEqual({ city: '杭州市', titleCode: 'specialized_sme', year: 2020, batch: null })
    expect(row.verificationStatus).toBe('pending')
  })

  it('新原因走 other + reason_note,不强塞进五类(§2.8)', () => {
    const request = buildPlatformWritePayload({
      ...base,
      differences: [
        {
          enterpriseId: 7289, titleCode: 'specialized_sme', direction: 'extra_in_miit',
          status: 'confirmed_reason', reasonCode: 'other',
          reasonNote: '平台把集团母公司与子公司合并登记',
          measureCode: 'manual_review', verificationStatus: 'confirmed',
          recordedAt: '2026-10-14T00:00:00.000Z',
        },
      ],
    })
    const row = request.payload.differences![0]!
    expect(row.reasonCode).toBe('other')
    expect(row.reasonNote).toContain('集团母公司')
    expect(row.measureCode).toBe('manual_review')
  })

  it('未查询 / 查询失败 / 无记录 / 已确认无差异四态各自成行,互不等价', () => {
    const statuses = ['not_queried', 'query_failed', 'no_record', 'confirmed_no_diff'] as const
    const request = buildPlatformWritePayload({
      ...base,
      differences: statuses.map((status, i) => ({
        enterpriseId: 7289, titleCode: 'specialized_sme', direction: 'missing_in_miit',
        status, measureCode: status === 'confirmed_no_diff' ? ('none' as const) : null,
        recordedAt: `2026-10-0${i + 1}T00:00:00.000Z`,
      })),
    })
    expect(new Set(request.payload.differences!.map((d) => d.status)).size).toBe(4)
  })
})

describe('回归案例端到端:6 条真实关系 → 候选 → 确认 → 载荷', () => {
  it('从原始关系派生的候选经代理确认后,成为 confirmed 别名并挂回来源关系', () => {
    const relations = queries.flatMap((query) =>
      query.outcome.rows.map((row, index) =>
        relationFromRow(row, {
          interface: query.interface,
          rdjb: query.rdjb,
          queryKey: query.queryKey,
          sequenceNo: index + 1,
        }),
      ),
    )
    const group = groupRelationsByUscc(relations)[0]!
    const [candidate] = aliasCandidatesOf(group)
    expect(candidate!.name).toBe('宁波上航测绘有限公司')

    const request = buildPlatformWritePayload({
      sourceIdentity: 'platform/91330211255994457P.json',
      queries,
      enterprises,
      aliases: [aliasDecisionFromCandidate(7289, candidate!, '候选经代理核对原始关系后确认')],
      differences: [],
      merges: [
        {
          fromEnterpriseId: 375,
          fromEnterpriseName: '宁波上航测绘有限公司',
          intoUscc: USCC,
          aliasName: candidate!.name,
        },
      ],
    })

    const alias = request.payload.aliases![0]!
    expect(alias.verificationStatus).toBe('confirmed')
    expect(alias.sourceRelationRef).toEqual({
      queryKey: USCC, interface: 'business_list', rdjb: '3', sequenceNo: 1,
    })
    // 6 条关系一条不少;旧名的两条仍在,且匹配依据是统代。
    const rdjb3 = request.payload.platformQueries[2]!.relations!
    expect(rdjb3).toHaveLength(6)
    expect(rdjb3.filter((r) => r.nameRaw === '宁波上航测绘有限公司')).toHaveLength(2)
    expect(rdjb3.every((r) => r.matchBasis === 'uscc')).toBe(true)
    // 归并项与别名同批提交(重放幂等)。
    expect(request.payload.merges![0]!.fromEnterpriseId).toBe(375)
  })
})

describe('buildPlatformWritePayload:确认主体后的归并与回填(C2)', () => {
  const request = buildPlatformWritePayload({
    sourceIdentity: 'x', queries, enterprises, aliases: [], differences: [],
    merges: [
      {
        fromEnterpriseId: 375,
        fromEnterpriseName: '宁波上航测绘有限公司',
        intoUscc: USCC,
        aliasName: '宁波上航测绘有限公司',
        sourceRefId: 0,
        evidenceQueryId: 0,
      },
    ],
  })

  it('归并项带来源企业、目标统代、旧名与证据引用', () => {
    const merge = request.payload.merges![0]!
    expect(merge.fromEnterpriseId).toBe(375)
    expect(merge.fromEnterpriseName).toBe('宁波上航测绘有限公司')
    expect(merge.intoUscc).toBe(USCC)
    expect(merge.aliasName).toBe('宁波上航测绘有限公司')
    expect(merge).toHaveProperty('sourceRefId')
    expect(merge).toHaveProperty('evidenceQueryId')
  })

  it('归并项经真实 API 可重放:幂等键随来源身份稳定', () => {
    const again = buildPlatformWritePayload({
      sourceIdentity: 'x', queries, enterprises, aliases: [], differences: [],
      merges: [{ fromEnterpriseId: 375, intoUscc: USCC, aliasName: '宁波上航测绘有限公司' }],
    })
    expect(again.idempotencyKey).toBe(request.idempotencyKey)
  })
})
