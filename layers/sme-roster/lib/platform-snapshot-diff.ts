

// ---------------------------------------------------------------------------
// 版本比较(纯函数)
// ---------------------------------------------------------------------------

/** 参与比较的一行(只要这几列;`platform_export_row` 的子集)。 */
export interface SnapshotRow {
  sourceRowNo: number
  usccRaw: string | null
  nameRaw: string | null
  province: string | null
  city: string | null
  district: string | null
  regStatus: string | null
}

/** 字段级变化。 */
export interface SnapshotFieldChange {
  field: 'name' | 'province' | 'city' | 'district' | 'regStatus'
  from: string | null
  to: string | null
}

/** 一条「两边都有、但有字段变了」的行。 */
export interface SnapshotChange {
  /** 行身份键(统代优先,缺失退化为名称)。 */
  key: string
  usccRaw: string | null
  nameRaw: string | null
  /** 旧快照里的源行号。 */
  fromSourceRowNo: number
  /** 新快照里的源行号。 */
  toSourceRowNo: number
  fields: SnapshotFieldChange[]
}

export interface SnapshotDiff {
  /** 新快照有、旧快照没有的行。 */
  added: SnapshotRow[]
  /** 旧快照有、新快照没有的行。 */
  removed: SnapshotRow[]
  /** 两边都有、字段有变化的行。 */
  changed: SnapshotChange[]
  unchanged: number
  fromCount: number
  toCount: number
}

const COMPARED_FIELDS: Array<{ field: SnapshotFieldChange['field']; read: (row: SnapshotRow) => string | null }> = [
  { field: 'name', read: (r) => r.nameRaw },
  { field: 'province', read: (r) => r.province },
  { field: 'city', read: (r) => r.city },
  { field: 'district', read: (r) => r.district },
  { field: 'regStatus', read: (r) => r.regStatus },
]

/**
 * 行身份键:统一社会信用代码(trim + 大写);统代缺失时退化为 `name:<名称>`。
 * 三张导出表实测统代 **0 缺失、0 重复**,所以键在批内唯一;退化分支只是防御。
 */
export function snapshotRowKey(row: SnapshotRow): string {
  const uscc = row.usccRaw?.trim().toUpperCase()
  if (uscc) return uscc
  return `name:${row.nameRaw?.trim() ?? ''}`
}

/**
 * 比较两个快照。
 *
 * 语义以**统代**为准:「新快照有、旧快照没有」= 新增,反之 = 消失,
 * 两边都在但比较字段有差 = 变化。每条结果都带**源行号**,可回溯到原始文件的行。
 */
export function diffPlatformSnapshots(
  from: readonly SnapshotRow[],
  to: readonly SnapshotRow[],
): SnapshotDiff {
  const fromIndex = new Map<string, SnapshotRow>()
  for (const row of from) fromIndex.set(snapshotRowKey(row), row)
  const toIndex = new Map<string, SnapshotRow>()
  for (const row of to) toIndex.set(snapshotRowKey(row), row)

  const added = to.filter((row) => !fromIndex.has(snapshotRowKey(row)))
  const removed = from.filter((row) => !toIndex.has(snapshotRowKey(row)))

  const changed: SnapshotChange[] = []
  let unchanged = 0
  for (const [key, before] of fromIndex) {
    const after = toIndex.get(key)
    if (!after) continue
    const fields: SnapshotFieldChange[] = []
    for (const { field, read } of COMPARED_FIELDS) {
      const beforeValue = read(before)
      const afterValue = read(after)
      if (beforeValue !== afterValue) fields.push({ field, from: beforeValue, to: afterValue })
    }
    if (fields.length === 0) unchanged += 1
    else {
      changed.push({
        key,
        usccRaw: after.usccRaw ?? before.usccRaw,
        nameRaw: after.nameRaw ?? before.nameRaw,
        fromSourceRowNo: before.sourceRowNo,
        toSourceRowNo: after.sourceRowNo,
        fields,
      })
    }
  }

  const byRowNo = (a: { sourceRowNo: number }, b: { sourceRowNo: number }) => a.sourceRowNo - b.sourceRowNo
  return {
    added: [...added].sort(byRowNo),
    removed: [...removed].sort(byRowNo),
    changed: changed.sort((a, b) => a.toSourceRowNo - b.toSourceRowNo),
    unchanged,
    fromCount: from.length,
    toCount: to.length,
  }
}
