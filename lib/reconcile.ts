import { existsSync, readFileSync } from 'node:fs'
import type { ComparisonDirection } from './comparison'
import type { ReconcileReason } from './labels'

/**
 * 比对差异的**平台解释**(入库管线重整 票 16)。
 *
 * 口径与判据**都不在这里** —— 差异集合由 `lib/comparison.ts` 的 `getComparison` 算出(唯一来源),
 * 「为什么是差异」由 pipeline 的 `pnpm reconcile` 查工信部平台两个接口后推出来,写进本仓库
 * `data/platform-reconcile.json`(与 `roster.db` 同一流向,app 不反向依赖 pipeline)。
 * 本模块只做两件事:
 *
 * 1. 读那份缓存(读不到就当作没有解释 —— 绝不报错、绝不影响比对本身);
 * 2. 按 `(统一社会信用代码 | name:<nameNorm>, 称号, 方向)` 把解释**附加到比对行**。
 *
 * **计算在读取时、不写库**:零 schema 变更(票 16 的硬约束)。
 * 键的构造必须与 pipeline 侧 `scripts/reconcile.ts` 的 `reconcileKey` 一致。
 */

export interface ReconcileExplanation {
  code: ReconcileReason
  note: string
}

export interface ReconcileRecord {
  source: 'business' | 'apply'
  name: string
  uscc: string
  province: string
  status: string
  batch: string
  appliedAt: string
}

export interface ReconcileEvidence {
  rdjb: string | null
  rdjbLabel: string | null
  businessCount: number
  applyCount: number
  provinces: string[]
  businessStatuses: string[]
  applyStatuses: string[]
  records: ReconcileRecord[]
}

export interface ReconcileEntry {
  key: string
  uscc: string | null
  name: string
  nameNorm: string
  titleCode: string
  direction: ComparisonDirection
  rdjb: string | null
  explanation: ReconcileExplanation
  evidence: ReconcileEvidence
  fetchedAt: string | null
}

export interface ReconcileFile {
  generatedAt: string
  source: { command: string; db: string; criterion: string }
  counts: Record<string, number>
  entries: ReconcileEntry[]
}

export interface ReconcileIndex {
  /** 有解释的键 → 解释。 */
  entries: Map<string, ReconcileEntry>
  /** 缓存生成时间;没有缓存时为 null。 */
  generatedAt: string | null
  /** 缓存的来源说明(命令 / 库),展示用。 */
  source: string | null
}

/** 与 pipeline `scripts/reconcile.ts` 的 `reconcileKey` 同构。 */
export function reconcileKey(input: {
  uscc?: string | null
  nameNorm: string
  titleCode: string
  direction: ComparisonDirection
}): string {
  return JSON.stringify([input.uscc || `name:${input.nameNorm}`, input.titleCode, input.direction])
}

const EMPTY: ReconcileIndex = { entries: new Map(), generatedAt: null, source: null }

/**
 * 读解释缓存。**读不到 → 空索引**(解释是增强项,不该让比对页挂掉);
 * 但文件存在却解析不了时同样退化为空 —— 与既有 `curation.ts` 同风格。
 */
export function readReconcile(path: string | undefined | null): ReconcileIndex {
  if (!path || !existsSync(path)) return EMPTY
  try {
    const file = JSON.parse(readFileSync(path, 'utf8')) as ReconcileFile
    if (!Array.isArray(file?.entries)) return EMPTY
    const entries = new Map<string, ReconcileEntry>()
    for (const entry of file.entries) {
      if (!entry?.explanation?.code || !entry.titleCode || !entry.direction) continue
      entries.set(
        entry.key ??
          reconcileKey({
            uscc: entry.uscc,
            nameNorm: entry.nameNorm,
            titleCode: entry.titleCode,
            direction: entry.direction,
          }),
        entry,
      )
    }
    return { entries, generatedAt: file.generatedAt ?? null, source: file.source?.command ?? null }
  } catch {
    return EMPTY
  }
}

/** 给比对行附加解释。没有对应解释的行 `explanation` 为 `null`。 */
export function attachReconcile<
  T extends {
    uscc: string | null
    nameNorm: string
    titleCode: string
    direction: ComparisonDirection
  },
>(rows: T[], index: ReconcileIndex): (T & { explanation: ReconcileEntry | null })[] {
  return rows.map((row) => ({
    ...row,
    explanation:
      index.entries.get(
        reconcileKey({
          uscc: row.uscc,
          nameNorm: row.nameNorm,
          titleCode: row.titleCode,
          direction: row.direction,
        }),
      ) ?? null,
  }))
}
