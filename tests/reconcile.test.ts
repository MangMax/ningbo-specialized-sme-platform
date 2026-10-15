import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ComparisonDirection } from '../lib/comparison'
import { attachReconcile, readReconcile, reconcileKey, type ReconcileEntry } from '../lib/reconcile'
import { formatFetchTime, latestFetchLabel, platformFetchTime } from '../lib/reconcile-time'
import {
  RECONCILE_BASIS,
  RECONCILE_LABELS,
  RECONCILE_REASONS,
  RECONCILE_VARIANTS,
  reconcileHint,
} from '../lib/labels'
import explainFixture from './fixtures/reconcile-explain.json'

/** 夹具是从 pipeline 真实生成的 explain.json 里原样摘录的 3 条(见文件内 source.note)。 */
const FIXTURE_PATH = join(import.meta.dirname, 'fixtures/reconcile-explain.json')

function tempFile(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'reconcile-'))
  const path = join(dir, 'explain.json')
  writeFileSync(path, content)
  return path
}

describe('reconcileKey', () => {
  it('与 pipeline 侧同构:JSON 元组,无统代时退化为 name:<nameNorm>', () => {
    expect(
      reconcileKey({ uscc: '91440300MA5G2DGE3R', nameNorm: '一临云', titleCode: 'specialized_sme', direction: 'extra_in_miit' }),
    ).toBe('["91440300MA5G2DGE3R","specialized_sme","extra_in_miit"]')
    expect(
      reconcileKey({ uscc: null, nameNorm: '某企业', titleCode: 'innovative_sme', direction: 'missing_in_miit' }),
    ).toBe('["name:某企业","innovative_sme","missing_in_miit"]')
  })
})

describe('readReconcile(解释缓存是增强项,读不到不能影响比对)', () => {
  it('路径为空 / 文件不存在 ⇒ 空索引', () => {
    expect(readReconcile(null).entries.size).toBe(0)
    expect(readReconcile(join(tmpdir(), 'definitely-missing-explain.json')).generatedAt).toBeNull()
  })

  it('内容坏了也退化为空索引,不抛错', () => {
    expect(readReconcile(tempFile('{ not json')).entries.size).toBe(0)
    expect(readReconcile(tempFile('{"entries": "nope"}')).entries.size).toBe(0)
  })

  it('读到真实生成的缓存:条目 / 生成时间 / 来源', () => {
    const index = readReconcile(FIXTURE_PATH)
    expect(index.entries.size).toBe(3)
    expect(index.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(index.source).toContain('scripts/reconcile.ts')
  })
})

describe('attachReconcile', () => {
  const index = readReconcile(FIXTURE_PATH)
  const row = (
    over: Partial<{
      uscc: string | null
      nameNorm: string
      titleCode: string
      direction: ComparisonDirection
    }>,
  ) =>
    ({
      uscc: '91440300MA5G2DGE3R',
      nameNorm: '一临云（宁波）科技有限公司',
      titleCode: 'specialized_sme',
      direction: 'extra_in_miit',
      ...over,
    }) satisfies {
      uscc: string | null
      nameNorm: string
      titleCode: string
      direction: ComparisonDirection
    }

  it('按统代 × 称号 × 方向附加解释,不改行上的其他字段', () => {
    const [attached] = attachReconcile([row({})], index)
    expect(attached!.explanation?.explanation.code).toBe('non_local')
    expect(attached!.explanation?.explanation.note).toContain('440300')
    expect(attached!.nameNorm).toBe('一临云（宁波）科技有限公司')
  })

  it('无统代时按 name:<nameNorm> 匹配', () => {
    const [attached] = attachReconcile(
      [row({ uscc: null, nameNorm: '灵峰矿山机械(象山)有限公司', titleCode: 'specialized_sme' })],
      index,
    )
    expect(attached!.explanation).toBeNull() // 夹具里那家只有统代键,无统代查不到
    const [byUscc] = attachReconcile(
      [row({ uscc: '91330225MA2CH9LTXY', nameNorm: '无关名称', titleCode: 'specialized_sme' })],
      index,
    )
    expect(byUscc!.explanation?.explanation.code).toBe('on_platform')
  })

  it('称号或方向不符 / 未抽到 ⇒ explanation 为 null,行照常返回', () => {
    const rows = attachReconcile(
      [
        row({ titleCode: 'innovative_sme' }),
        row({ direction: 'missing_in_miit' }),
        row({ uscc: '91330200000000000X' }),
      ],
      index,
    )
    expect(rows.map((r) => r.explanation)).toEqual([null, null, null])
    expect(rows).toHaveLength(3)
  })

  it('空索引(没有缓存)⇒ 全部 null,不报错', () => {
    const rows = attachReconcile([row({})], readReconcile(null))
    expect(rows[0]!.explanation).toBeNull()
  })
})

describe('解释的展示文案', () => {
  it('每个原因都有标签与徽章变体', () => {
    const codes = Object.keys(RECONCILE_LABELS)
    expect(codes).toHaveLength(7)
    for (const code of codes) {
      expect(RECONCILE_VARIANTS[code as keyof typeof RECONCILE_VARIANTS]).toBeTruthy()
    }
  })

  it('夹具里的每条解释都能取到标签与变体(不会漏文案)', () => {
    const index = readReconcile(FIXTURE_PATH)
    for (const entry of index.entries.values()) {
      expect(RECONCILE_LABELS[entry.explanation.code]).toBeTruthy()
      expect(RECONCILE_VARIANTS[entry.explanation.code]).toBeTruthy()
      expect(entry.explanation.note.length).toBeGreaterThan(0)
    }
  })

  it('夹具结构与 pipeline 生成的一致(键 / 证据字段齐)', () => {
    const first = explainFixture.entries[0]!
    expect(first.key).toBe(
      reconcileKey({
        uscc: first.uscc,
        nameNorm: first.nameNorm,
        titleCode: first.titleCode,
        direction: first.direction as ComparisonDirection,
      }),
    )
    expect(first.evidence).toMatchObject({
      businessCount: expect.any(Number),
      applyCount: expect.any(Number),
      provinces: expect.any(Array),
    })
  })
})

describe('平台取数时间:页脚与行内 tooltip 用同一字段、同一格式', () => {
  const entry = (fetchedAt: string | null) =>
    ({ fetchedAt }) as unknown as ReconcileEntry

  it('取最新的一条;缺失与非法值一律忽略', () => {
    expect(
      platformFetchTime([
        entry('2026-10-14T09:38:27.986Z'),
        entry('2026-10-14T09:38:40.313Z'),
        entry(null),
        entry('不是时间'),
      ]),
    ).toBe('2026-10-14T09:38:40.313Z')
  })

  it('一条都没有(含全是 null / 空数组 / 全是 null 行)⇒ null,页面据此不显示日期', () => {
    expect(platformFetchTime([])).toBeNull()
    expect(platformFetchTime([entry(null), null, undefined])).toBeNull()
    expect(platformFetchTime([null, undefined])).toBeNull()
  })

  it('格式化固定为 YYYY-MM-DD HH:mm;非法值返回 null(不显示半截时间)', () => {
    expect(formatFetchTime('2026-10-14T09:38:40.313Z')).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)
    expect(formatFetchTime(null)).toBeNull()
    expect(formatFetchTime('nope')).toBeNull()
  })

  it('latestFetchLabel 是页面用的那一个入口(与 tooltip 同源)', () => {
    const label = latestFetchLabel([entry('2026-10-14T09:38:27.986Z')])
    expect(label).toBe(formatFetchTime('2026-10-14T09:38:27.986Z'))
  })
})

describe('样本夹具:明确标注「样本 / 离线,不是线上缓存」(B1)', () => {
  it('夹具自带样本标识,不会被当成线上缓存', () => {
    const note = explainFixture.source.note ?? ''
    expect(note).toContain('样本')
    expect(note).toContain('离线')
    expect(note).toContain('不是线上')
  })

  it('样本里的 fetchedAt 都是那次真实取数的时间(可解析),页面据此显示的时间可追溯', () => {
    for (const item of explainFixture.entries) {
      expect(item.fetchedAt).toBeTruthy()
      expect(Number.isNaN(new Date(item.fetchedAt!).getTime())).toBe(false)
    }
    expect(latestFetchLabel(explainFixture.entries as unknown as ReconcileEntry[])).toBe(
      formatFetchTime('2026-10-14T09:38:48.539Z'),
    )
  })
})

describe('口径说明按方向只给相关半句(B5)', () => {
  it('总口径「以公布文件为准」两方向都在,且单独一处', () => {
    expect(RECONCILE_BASIS).toContain('以公布文件为准')
    for (const d of ['missing_in_miit', 'extra_in_miit'] as const) {
      expect(reconcileHint(d).startsWith(RECONCILE_BASIS)).toBe(true)
    }
  })

  it('应纳未纳只讲注销 / 外迁,不出现外地注册', () => {
    expect(RECONCILE_REASONS.missing_in_miit).toContain('注销')
    expect(RECONCILE_REASONS.missing_in_miit).toContain('外迁')
    expect(RECONCILE_REASONS.missing_in_miit).not.toContain('外地注册')
    expect(reconcileHint('missing_in_miit')).not.toContain('外地注册')
  })

  it('应出未出只讲外地注册,不出现注销 / 外迁', () => {
    expect(RECONCILE_REASONS.extra_in_miit).toContain('外地注册')
    expect(RECONCILE_REASONS.extra_in_miit).not.toContain('注销')
    expect(RECONCILE_REASONS.extra_in_miit).not.toContain('外迁')
    expect(reconcileHint('extra_in_miit')).not.toContain('注销')
  })
})
