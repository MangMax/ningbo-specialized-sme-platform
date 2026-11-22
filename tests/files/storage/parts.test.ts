import { describe, expect, it } from 'vitest'
import { normalizeAttachment } from '../../../layers/sme-roster/lib/attachment'
import type { FilePart } from '../../../db/file-part'
import {
  aggregateParts,
  compareParts,
  joinSeries,
  partBatches,
  partKey,
  partYears,
  seriesLabel,
} from '../../../layers/sme-roster/lib/file-parts'

/**
 * 票 17 —— **文件含多段**:年份/批次/事件按「段」建模。
 *
 * 分三块:
 *  1. 附件名归一(`layers/sme-roster/lib/attachment.ts`)——「附件」「附 件 1」「附件1」「附件2」同形状;
 *  2. 段聚合与排序(`layers/sme-roster/lib/file-parts.ts`)—— 纯函数,口径可单测;
 *     145号 = 2 段,以及幂等。
 *
 * 种子用的是 `files/` 里那两份文件的**真实路径、真实段与真实行数**(389/67 与 301/413),
 * 断言里的数字就是台账里的数字,不是编出来的。
 */

// ---------------------------------------------------------------------------
// 1. 附件名归一
// ---------------------------------------------------------------------------

describe('normalizeAttachment 附件名归一', () => {
  it('实测的四种写法归成同一形状', () => {
    expect(normalizeAttachment('附件')).toBe('附件')
    expect(normalizeAttachment('附 件 1')).toBe('附件1') // ← 空格位置不一是本次要治的毛病
    expect(normalizeAttachment('附件1')).toBe('附件1')
    expect(normalizeAttachment('附件2')).toBe('附件2')
  })

  it('全角空格与不同空白位置一并收掉', () => {
    expect(normalizeAttachment('附　件　1')).toBe('附件1')
    expect(normalizeAttachment(' 附 件  2 ')).toBe('附件2')
    expect(normalizeAttachment('\t附件\n')).toBe('附件')
  })

  it('编号一律读成阿拉伯数字(中文数字、全角、前置零)', () => {
    expect(normalizeAttachment('附件一')).toBe('附件1')
    expect(normalizeAttachment('附件十二')).toBe('附件12')
    expect(normalizeAttachment('附件二十三')).toBe('附件23')
    expect(normalizeAttachment('附件０１')).toBe('附件1')
  })

  it('「附件」不补编号 —— 源里没有编号就不造一个(空值优于错值)', () => {
    // 145号 只有一个附件、源里就写「附件」,里面并置了 2021 与 2022 两段名单。
    expect(normalizeAttachment('附件')).toBe('附件')
    expect(normalizeAttachment('附件')).not.toBe('附件1')
  })

  it('空值 / 全空白 → null(「没有附件」用 null 表示,不用空串)', () => {
    expect(normalizeAttachment(null)).toBeNull()
    expect(normalizeAttachment(undefined)).toBeNull()
    expect(normalizeAttachment('')).toBeNull()
    expect(normalizeAttachment('   ')).toBeNull()
  })

  it('认不出的写法原样保留(去掉空白),不猜也不丢', () => {
    expect(normalizeAttachment('附表 1')).toBe('附表1')
    expect(normalizeAttachment('附件甲')).toBe('附件甲')
  })

  it('幂等:归一再归一,结果不变', () => {
    for (const raw of ['附件', '附 件 1', '附件2', '附件一', '附件０１', '附件甲']) {
      const once = normalizeAttachment(raw)
      expect(normalizeAttachment(once)).toBe(once)
    }
  })
})

// ---------------------------------------------------------------------------
// 2. 段聚合与排序(纯函数)
// ---------------------------------------------------------------------------

function makePart(over: Partial<FilePart> = {}): FilePart {
  return {
    titleCode: 'specialized_sme',
    eventKind: 'award',
    year: null,
    batch: null,
    attachment: null,
    rowCount: 1,
    ...over,
  }
}

describe('aggregateParts 段聚合', () => {
  it('同坐标合并、行数相加;不同附件不合并', () => {
    const parts = aggregateParts([
      { titleCode: 'specialized_sme', eventKind: 'award', year: 2024, batch: 2, attachment: '附件1' },
      { titleCode: 'specialized_sme', eventKind: 'award', year: 2024, batch: 2, attachment: '附件1' },
      { titleCode: 'specialized_sme', eventKind: 'award', year: 2024, batch: 2, attachment: '附件2' },
    ])
    expect(parts).toHaveLength(2)
    expect(parts[0]).toMatchObject({ attachment: '附件1', rowCount: 2 })
    expect(parts[1]).toMatchObject({ attachment: '附件2', rowCount: 1 })
  })

  it('null 年份与「年份是某值」不会撞键', () => {
    expect(
      partKey({ titleCode: 'a', eventKind: 'award', year: null, batch: null, attachment: null }),
    ).not.toBe(partKey({ titleCode: 'a', eventKind: 'award', year: 1, batch: null, attachment: null }))
  })

  it('排序:事件次序优先(认定在前、复核在后)→ 年份 → 批次', () => {
    const parts = aggregateParts([
      { titleCode: 'specialized_sme', eventKind: 'review', year: 2021, batch: 2, attachment: '附件2' },
      { titleCode: 'specialized_sme', eventKind: 'award', year: 2024, batch: 2, attachment: '附件1' },
      { titleCode: 'specialized_sme', eventKind: 'award', year: 2021, batch: null, attachment: '附件' },
    ])
    expect(parts.map((p) => `${p.eventKind}/${p.year}`)).toEqual([
      'award/2021',
      'award/2024',
      'review/2021',
    ])
  })

  it('称号等级优先于事件次序(小巨人段排在专精特新段之前)', () => {
    const parts = aggregateParts([
      { titleCode: 'innovative_sme', eventKind: 'award', year: 2024, batch: 1, attachment: null },
      { titleCode: 'little_giant', eventKind: 'maintain', year: 2024, batch: 1, attachment: null },
    ])
    expect(parts.map((p) => p.titleCode)).toEqual(['little_giant', 'innovative_sme'])
  })

  it('空输入 → 空数组', () => {
    expect(aggregateParts([])).toEqual([])
  })
})

describe('段的派生展示值', () => {
  it('年份 / 批次去重升序', () => {
    const parts = [
      makePart({ year: 2024, batch: 2 }),
      makePart({ year: 2021, batch: 2 }),
      makePart({ year: 2021, batch: null }),
    ]
    expect(partYears(parts)).toEqual([2021, 2024])
    expect(partBatches(parts)).toEqual([2])
  })

  it('全是 null 时给空数组,由页面走「—」', () => {
    expect(partYears([makePart({ year: null })])).toEqual([])
    expect(partBatches([makePart({ batch: null })])).toEqual([])
  })

  it('joinSeries 用顿号连接;空数组给 null', () => {
    expect(joinSeries([2021, 2022])).toBe('2021、2022')
    expect(joinSeries([2])).toBe('2')
    expect(joinSeries([])).toBeNull()
  })

  it('seriesLabel 超过上限只列前几个并缀 +剩 N(工信部导出跨六七年,全列会撑破窄列)', () => {
    expect(seriesLabel([2021, 2022])).toBe('2021、2022')
    expect(seriesLabel([2021, 2022, 2023])).toBe('2021、2022 +1')
    expect(seriesLabel([2021, 2022, 2023, 2024, 2025, 2026])).toBe('2021、2022 +4')
    expect(seriesLabel([])).toBeNull()
    // 上限可调。
    expect(seriesLabel([1, 2, 3, 4], 1)).toBe('1 +3')
    expect(seriesLabel([1, 2, 3], 3)).toBe('1、2、3')
  })

  it('compareParts 把无年份/无批次的段排在同类的最后', () => {
    const withYear = makePart({ year: 2024 })
    const without = makePart({ year: null })
    expect([without, withYear].sort(compareParts)).toEqual([withYear, without])
  })
})
