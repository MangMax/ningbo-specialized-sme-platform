import { describe, expect, it } from 'vitest'
import { diffPlatformSnapshots, snapshotRowKey, type SnapshotRow } from '../../../layers/sme-roster/lib/platform-snapshots'

const row = (over: Partial<SnapshotRow> & { sourceRowNo: number }): SnapshotRow => ({
  usccRaw: null,
  nameRaw: null,
  province: '浙江省',
  city: '宁波市',
  district: null,
  regStatus: null,
  ...over,
})

// ---------------------------------------------------------------------------

describe('diffPlatformSnapshots:新增 / 消失 / 字段变化,都能追到源行号', () => {
  const before = [
    row({ sourceRowNo: 3, usccRaw: 'CODE1', nameRaw: '甲公司', district: '鄞州区', regStatus: '待审核' }),
    row({ sourceRowNo: 4, usccRaw: 'CODE2', nameRaw: '乙公司', district: '海曙区', regStatus: '省已审' }),
    row({ sourceRowNo: 5, usccRaw: 'CODE3', nameRaw: '丙公司', district: '江北区', regStatus: '待审核' }),
  ]
  const after = [
    // CODE1 不动。
    row({ sourceRowNo: 3, usccRaw: 'CODE1', nameRaw: '甲公司', district: '鄞州区', regStatus: '待审核' }),
    // CODE2 更名 + 换区 + 审核状态推进。
    row({ sourceRowNo: 4, usccRaw: 'CODE2', nameRaw: '乙公司(新)', district: '北仑区', regStatus: '终审通过' }),
    // CODE4 是本轮新增。
    row({ sourceRowNo: 6, usccRaw: 'CODE4', nameRaw: '丁公司', district: '镇海区', regStatus: '待审核' }),
  ]

  it('新增 / 消失按统代判定,带源行号', () => {
    const diff = diffPlatformSnapshots(before, after)
    expect(diff.added.map((r) => [r.usccRaw, r.sourceRowNo])).toEqual([['CODE4', 6]])
    expect(diff.removed.map((r) => [r.usccRaw, r.sourceRowNo])).toEqual([['CODE3', 5]])
  })

  it('字段变化逐字段报出「从什么到什么」,并带两侧源行号', () => {
    const diff = diffPlatformSnapshots(before, after)
    expect(diff.changed).toHaveLength(1)
    const change = diff.changed[0]!
    expect(change).toMatchObject({ key: 'CODE2', usccRaw: 'CODE2', fromSourceRowNo: 4, toSourceRowNo: 4 })
    expect(change.fields).toEqual([
      { field: 'name', from: '乙公司', to: '乙公司(新)' },
      { field: 'district', from: '海曙区', to: '北仑区' },
      { field: 'regStatus', from: '省已审', to: '终审通过' },
    ])
  })

  it('计数如实:未变的不进 changed,两边总量都报出来', () => {
    const diff = diffPlatformSnapshots(before, after)
    expect(diff.unchanged).toBe(1)
    expect(diff.fromCount).toBe(3)
    expect(diff.toCount).toBe(3)
  })

  it('同一文件重放(完全相同的两批)⇒ 全未变,不产生任何差异', () => {
    const diff = diffPlatformSnapshots(before, before)
    expect(diff.added).toEqual([])
    expect(diff.removed).toEqual([])
    expect(diff.changed).toEqual([])
    expect(diff.unchanged).toBe(3)
  })

  it('统代缺失时退化为按名称做身份键(防御分支,不是主路径)', () => {
    const a = [row({ sourceRowNo: 3, usccRaw: null, nameRaw: '无码公司' })]
    const b = [row({ sourceRowNo: 3, usccRaw: null, nameRaw: '无码公司', regStatus: '省已审' })]
    expect(snapshotRowKey(a[0]!)).toBe('name:无码公司')
    const diff = diffPlatformSnapshots(a, b)
    expect(diff.added).toEqual([])
    expect(diff.removed).toEqual([])
    expect(diff.changed).toHaveLength(1)
  })

  it('统代大小写/空白差异不制造假差异', () => {
    const a = [row({ sourceRowNo: 3, usccRaw: '91330201aaaaaaa001' })]
    const b = [row({ sourceRowNo: 9, usccRaw: ' 91330201AAAAAAA001 ' })]
    const diff = diffPlatformSnapshots(a, b)
    expect(diff.added).toEqual([])
    expect(diff.removed).toEqual([])
    expect(diff.unchanged).toBe(1)
  })
})
