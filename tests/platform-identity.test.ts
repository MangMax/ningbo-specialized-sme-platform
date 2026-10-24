import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  type PlatformQueryOutcome,
  classifyRawQuery,
  groupRelationsByUscc,
  relationFromRow,
  aliasCandidatesOf,
} from '../lib/platform'

const fixture = (name: string) =>
  readFileSync(join(import.meta.dirname, 'fixtures/platform', name), 'utf8')

const USCC = '91330211255994457P'
const outcomes: PlatformQueryOutcome[] = [
  classifyRawQuery(fixture('business-list-rdjb3.html'), {
    interface: 'business_list',
    rdjb: '3',
    queryKey: USCC,
  }),
  classifyRawQuery(fixture('apply-list.json'), { interface: 'apply_list', queryKey: USCC }),
]
const relations = outcomes.flatMap((o) => o.rows.map((row) => relationFromRow(row, o)))

describe('relationFromRow:平台字段 → 契约 §1.4 列', () => {
  it('逐字段映射(已实测的字段名)', () => {
    const relation = relations[0]!
    expect(relation.relationKey).toBe('SQ332022062212391')
    expect(relation.usccRaw).toBe(USCC)
    expect(relation.nameRaw).toBe('宁波上航测绘有限公司')
    expect(relation.province).toBe('宁波市')
    expect(relation.status).toBe('终审通过')
    expect(relation.batch).toBe('2022-1')
    expect(relation.declareKind).toBe('apply')
    expect(relation.appliedAt).toBe('2022-06-22 17:17:52')
    expect(relation.awardBatchLabel).toBeNull()
    // 原始字段整行原样保留(留证)。
    expect(relation.rawFields.qymc).toBe('宁波上航测绘有限公司')
    expect(relation.rawFields.sblx).toBe('申请')
  })

  it('sblx / personuuid / year 按各自含义落列,不混用编码', () => {
    const review = relations.find((r) => r.relationKey === 'SQ332025060392166')!
    expect(review.declareKind).toBe('review')
    // personuuid 列头是「认定批次」,取值是「第四批」文本,与 whpc(2025-1)不是一套。
    expect(review.awardBatchLabel).toBe('第四批')
    expect(review.batch).toBe('2025-1')
  })

  it('source_kind 由接口决定:business_list → platform_business', () => {
    expect(relationFromRow({ qymc: '甲' }, { interface: 'business_list', rdjb: '3', queryKey: 'x' }).sourceKind).toBe(
      'platform_business',
    )
    expect(relationFromRow({ qymc: '甲' }, { interface: 'apply_list', rdjb: '', queryKey: 'x' }).sourceKind).toBe(
      'platform_apply',
    )
  })

  it('apply 的 year 转整数;源头未给则留空', () => {
    const applyRow = relations.find((r) => r.interface === 'apply_list')!
    expect(applyRow.year).toBe(2025)
    expect(relationFromRow({ qymc: '甲' }, { interface: 'apply_list', rdjb: '', queryKey: 'x' }).year).toBeNull()
  })
})

describe('groupRelationsByUscc:同一 USCC 的多条关系逐条保留', () => {
  it('8 条关系(6 business + 2 apply)全部保留,不按 id 去重', () => {
    expect(relations).toHaveLength(8)
    const groups = groupRelationsByUscc(relations)
    expect(groups).toHaveLength(1)
    expect(groups[0]!.uscc).toBe(USCC)
    expect(groups[0]!.relations).toHaveLength(8)
  })

  it('按 qymc 分出名组:两个名字,各自带全部证据关系', () => {
    const group = groupRelationsByUscc(relations)[0]!
    expect(group.names.map((n) => n.nameNorm).sort()).toEqual(
      ['宁波上航测绘有限公司', '宁波上航测绘股份有限公司'].sort(),
    )
    const oldName = group.names.find((n) => n.nameNorm === '宁波上航测绘有限公司')!
    // business ×2(SQ…212391 / SQ…984270)+ apply ×1(SQ…212391)三条关系
    expect(oldName.relations).toHaveLength(3)
    expect(oldName.relations.map((r) => r.relationKey).sort()).toEqual(
      ['SQ332022062212391', 'SQ332022062212391', 'SQ332023041984270'].sort(),
    )
  })

  it('无统代的关系单独成组(uscc 为空),不并入任何企业', () => {
    const groups = groupRelationsByUscc([
      relationFromRow({ qymc: '无码企业', cszt: '待审核' }, { interface: 'business_list', rdjb: '2', queryKey: 'x' }),
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0]!.uscc).toBeNull()
  })
})

describe('aliasCandidatesOf:只呈现候选,不推测、不确认', () => {
  it('最新关系写的是现名,历史名称成为候选并挂上原始关系证据', () => {
    const group = groupRelationsByUscc(relations)[0]!
    const candidates = aliasCandidatesOf(group)
    expect(candidates).toHaveLength(1)
    expect(candidates[0]!.name).toBe('宁波上航测绘有限公司')
    expect(candidates[0]!.relations).toHaveLength(3)
    // 候选默认待核;确认是代理/人的动作,不是软件的推断。
    expect(candidates[0]!.verificationStatus).toBe('pending')
    // 时间信息取自来源,未给出留空不推测。
    expect(candidates[0]!.validFrom).toBe('2022-06-22 17:17:52')
  })

  it('名字完全一致的一组没有候选', () => {
    const group = groupRelationsByUscc([
      relationFromRow({ qymc: '甲有限公司', tyshxydm: USCC, sqsj: '2020-01-01 00:00:00' }, { interface: 'business_list', rdjb: '3', queryKey: USCC }),
      relationFromRow({ qymc: '甲有限公司', tyshxydm: USCC, sqsj: '2021-01-01 00:00:00' }, { interface: 'business_list', rdjb: '3', queryKey: USCC }),
    ])[0]!
    expect(aliasCandidatesOf(group)).toEqual([])
  })

  it('同名多主体(同一名字挂在不同 USCC 下)被标为冲突,不自动合并', () => {
    const a = relationFromRow({ qymc: '宁波同名科技有限公司', tyshxydm: '91330211000000001A' }, { interface: 'business_list', rdjb: '2', queryKey: 'a' })
    const b = relationFromRow({ qymc: '宁波同名科技有限公司', tyshxydm: '91330211000000002B' }, { interface: 'business_list', rdjb: '2', queryKey: 'b' })
    const groups = groupRelationsByUscc([a, b])
    expect(groups).toHaveLength(2)
    const candidates = groups.flatMap((g) => aliasCandidatesOf(g))
    expect(candidates).toEqual([])
    // 名字重复但主体不同 ⇒ 由调用方保留为待核实(见 payload 测试)。
    expect(groups[0]!.relations[0]!.usccRaw).not.toBe(groups[1]!.relations[0]!.usccRaw)
  })
})

describe('夹具用的是真实响应的裁剪摘录,且不含凭证', () => {
  it('没有 cookie / token 字样', () => {
    for (const name of ['business-list-rdjb3.html', 'apply-list.json', 'business-list-rdjb1-empty.html']) {
      const text = fixture(name)
      expect(text).not.toMatch(/JSESSIONID|token|password/i)
    }
  })
})
