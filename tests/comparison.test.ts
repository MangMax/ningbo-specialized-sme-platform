import { initializeDb } from '../db/client'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { useDb, schema } from '../db'
import type { TitleCode } from '../db/titles'
import { getComparison, type ComparisonDirection } from '../lib/comparison'
import type { EventType } from '../lib/query'

const dir = mkdtempSync(join(tmpdir(), 'spztx-comparison-'))
const db = initializeDb({ create: true, dbPath: join(dir, 'test.db') })
const ids: Record<string, number> = {}

function enterprise(key: string, uscc: string | null, name = key, city: string | null = null, regStatus: string | null = null) {
  const id = db.insert(schema.enterprise)
    .values({ name, nameNorm: name, usccNorm: uscc, city, regStatus })
    .returning({ id: schema.enterprise.id }).get().id
  ids[key] = id
  return id
}

function record(enterpriseId: number, source: 'jxj' | 'miit', titleCode: TitleCode = 'specialized_sme', events: EventType[] = ['award']) {
  const recordId = db.insert(schema.record)
    .values({ enterpriseId, source, titleCode, district: '鄞州区' })
    .returning({ id: schema.record.id }).get().id
  events.forEach((eventType) => db.insert(schema.recordEvent)
    .values({ recordId, eventType, year: 2001 }).run())
}

beforeAll(() => {
  const both = enterprise('both', 'BOTH')
  record(both, 'jxj')
  record(both, 'miit')
  record(enterprise('jxj', 'JXJ'), 'jxj', 'specialized_sme', ['award', 'review', 'review'])
  record(enterprise('miit', 'MIIT'), 'miit')
  record(enterprise('nurture', 'NURTURE'), 'jxj', 'specialized_sme', ['nurture'])
  const nurtureMatched = enterprise('nurtureMatched', 'NURTURE-MATCHED')
  record(nurtureMatched, 'jxj', 'specialized_sme', ['nurture'])
  record(nurtureMatched, 'miit')
  record(enterprise('conflictJ', '12330227732092318Q', '宁波市鄞州区规划设计院'), 'jxj')
  record(enterprise('conflictM', '9133021257053651XQ', '宁波市鄞州区规划设计院'), 'miit')
  const noUscc = enterprise('noUscc', null)
  record(noUscc, 'jxj')
  record(noUscc, 'miit')
  record(enterprise('nullJ', null, '同名无统代'), 'jxj')
  record(enterprise('nullM', null, '同名无统代'), 'miit')
  record(enterprise('offCity', 'OFF-CITY', '迁出注销企业', '嘉兴市', '注销'), 'miit')
  record(ids.jxj!, 'miit', 'innovative_sme')
  record(enterprise('reviewOnly', 'REVIEW'), 'jxj', 'innovative_sme', ['review'])
  record(enterprise('giantJ', 'GIANT-J'), 'jxj', 'little_giant')
  record(enterprise('giantM', 'GIANT-M'), 'miit', 'little_giant')
  const giantBoth = enterprise('giantBoth', 'GIANT-BOTH')
  record(giantBoth, 'jxj', 'little_giant')
  record(giantBoth, 'miit', 'little_giant')
})

afterAll(() => rmSync(dir, { recursive: true, force: true }))

const members = (direction: ComparisonDirection, title = 'specialized_sme') =>
  getComparison(db, { title: [title], direction }).rows.map((r) => r.enterpriseId).sort((a, b) => a - b)

describe('getComparison 统代差集(企业 × 称号)', () => {
  it('returns exact member sets for both directions without name fallback', () => {
    expect(members('missing_in_miit')).toEqual(
      ['jxj', 'nurture', 'conflictJ', 'noUscc', 'nullJ'].map((key) => ids[key]!).sort((a, b) => a - b),
    )
    expect(members('extra_in_miit')).toEqual(
      ['miit', 'conflictM', 'noUscc', 'nullM', 'offCity'].map((key) => ids[key]!).sort((a, b) => a - b),
    )
  })

  it('excludes a matching USCC from both directions', () => {
    expect(getComparison(db).rows.filter((r) => r.enterpriseId === ids.both)).toEqual([])
  })

  it('includes nurture-only records in J(T), with and without a matching MIIT record', () => {
    expect(members('missing_in_miit')).toContain(ids.nurture)
    expect(members('extra_in_miit')).not.toContain(ids.nurture)
    expect(getComparison(db).rows.filter((r) => r.enterpriseId === ids.nurtureMatched)).toEqual([])
  })

  it('exposes the same legal person with different source USCCs in both directions', () => {
    const rows = getComparison(db).rows.filter((r) => r.name === '宁波市鄞州区规划设计院')
    expect(rows.map((r) => [r.uscc, r.direction]).sort()).toEqual([
      ['12330227732092318Q', 'missing_in_miit'],
      ['9133021257053651XQ', 'extra_in_miit'],
    ])
  })

  it('never matches null USCCs, even for the same enterprise or identical names', () => {
    expect(members('missing_in_miit')).toEqual(expect.arrayContaining([ids.noUscc, ids.nullJ]))
    expect(members('extra_in_miit')).toEqual(expect.arrayContaining([ids.noUscc, ids.nullM]))
  })

  it('counts each enterprise × title once, regardless of event count or year', () => {
    expect(getComparison(db).rows.filter((r) => r.enterpriseId === ids.jxj)
      .map((r) => [r.titleCode, r.direction])).toEqual([
      ['specialized_sme', 'missing_in_miit'],
      ['innovative_sme', 'extra_in_miit'],
    ])
    expect(members('missing_in_miit', 'innovative_sme')).toEqual([ids.reviewOnly])
  })

  it('keeps migrated and deregistered enterprises and exposes evidence', () => {
    expect(getComparison(db).rows.find((r) => r.enterpriseId === ids.offCity)).toEqual({
      enterpriseId: ids.offCity,
      name: '迁出注销企业', uscc: 'OFF-CITY', district: '鄞州区',
      titleCode: 'specialized_sme', direction: 'extra_in_miit', curated: false,
      evidence: { matchedBy: 'uscc', otherSideUscc: null, currentCity: '嘉兴市', regStatus: '注销' },
    })
  })

  /**
   * 小巨人**双向对比已启用**(用户 2026-10-16 裁决,#4 落地)。
   *
   * 两侧变成:经信局**历年小巨人名单**(RL-02 导入,历史批次权威来源)
   * vs 工信部**导出表**(采集时点现状)。旧期望是「小巨人恒空」——那是基于
   * 「经信局不发布小巨人」这句**已被证伪**的断言,本次是有意变更,不是回归。
   * 硬边界不变:平台导出永不改写公布历史;未匹配平台的公布条目仍然保留。
   */
  it('小巨人两侧都参与比对:公布有而平台无、平台有而公布无都能筛出同一企业', () => {
    expect(members('missing_in_miit', 'little_giant')).toEqual([ids.giantJ])
    expect(members('extra_in_miit', 'little_giant')).toEqual([ids.giantM])
    // 两侧统代一致的那家**两个方向都不出现**(与其它称号同一判据)。
    expect(getComparison(db).rows.filter((r) => r.enterpriseId === ids.giantBoth)).toEqual([])
    // 筛选小巨人时只看得到小巨人,不会串到别的称号。
    expect(
      getComparison(db, { title: ['little_giant'] }).rows.map((r) => r.titleCode),
    ).toEqual(['little_giant', 'little_giant'])
  })

  it('returns global counts consistent with complete rows and independent of filters', () => {
    const all = getComparison(db)
    expect(all.counts).toEqual({
      little_giant: { missing_in_miit: 1, extra_in_miit: 1 },
      specialized_sme: { missing_in_miit: 5, extra_in_miit: 5 },
      innovative_sme: { missing_in_miit: 1, extra_in_miit: 1 },
    })
    for (const [title, directions] of Object.entries(all.counts)) {
      for (const [direction, n] of Object.entries(directions)) {
        expect(all.rows.filter((r) => r.titleCode === title && r.direction === direction)).toHaveLength(n)
      }
    }
    const filtered = getComparison(db, { title: ['specialized_sme'], direction: 'missing_in_miit' })
    expect(filtered.rows).toHaveLength(5)
    expect(filtered.rows.every((r) => r.direction === 'missing_in_miit' && r.titleCode === 'specialized_sme')).toBe(true)
    expect(filtered.counts).toEqual(all.counts)
    expect(all.rows.every((r) => r.curated === false)).toBe(true)
  })
})
