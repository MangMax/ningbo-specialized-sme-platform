import { landingSegments, matchesLandingPath } from '../../../lib/sme-roster/file-landing'
import { count, eq, sql } from 'drizzle-orm'
import { storedFile } from '../../../../../db/postgresql/file-tables'
import { recordEvidence } from '../../../../../db/postgresql/ledger-tables'
import { rosterFileClassification } from '../../../../../db/postgresql/roster-file-tables'
import { KIND_ORDER, PARSE_STATE_ORDER, SOURCE_ORDER, TITLE_ORDER } from '../../../lib/labels'
import { categoryStateOf, type CategoryState, type FileKind, type FileSource, type ParseState } from '../../../lib/stored-file'
import type { StoredFilePart } from '../../../lib/file-parts'
import type { registeredSummary681 } from '../../utils/registered-declarations'
import { type FileCategoryServer, type FileRow } from '../../../../core/server/utils/file-store'
import manifest from '../../../manifest'
import { rosterFileOpenApi } from './file-openapi'
import { readPostgresRosterFileFields, rosterFilePostgresConstraint, rosterFilePostgresOrder } from '../../utils/roster-file-postgres'

const KINDS: readonly FileKind[] = KIND_ORDER as FileKind[]
export const PARSE_STATES: readonly ParseState[] = PARSE_STATE_ORDER as ParseState[]

export interface RosterFileFields {
  source: FileSource | null
  kind: FileKind | null
  /** **公布**年份(目录给的、单值)。内容年份见 `parts`。 */
  year: number | null
  /** **公布**批次(目录给的、单值)。内容批次见 `parts`。 */
  batch: number | null
  titleCode: string | null
  categoryState: CategoryState
  parseState: ParseState
  /** 有多少条 `record_evidence` 引用了这个文件(按 `source_file` 精确匹配 `rel_path`)。 */
  referenceCount: number
  /**
   * 文件里的**段**(票 17)。按 `compareParts` 排好序;没有段时是空数组
   * (尚无引用、留待票 11 解析时写入 —— **不是**「文件没有内容」)。
   */
  registeredSummary?: ReturnType<typeof registeredSummary681>
  parts: StoredFilePart[]
  partsBinding?: { historical: 'unknown'; inputLineage: { status: 'unknown' } | { status: 'bound'; inputRef: unknown } }
}

function rosterFileSnapshot(row: FileRow & Partial<RosterFileFields>): Record<string, unknown> {
  const { source, kind, year, batch, titleCode, categoryState } = row
  return categoryState === undefined ? {} : { source, kind, year, batch, titleCode, categoryState }
}

// Server-only half of the same manifest. The browser reads only its shared file contributions.
export const rosterFileServerCategory = {
  id: manifest.id,
  ...manifest.fileCategories,
  postgres: {
    readFields: readPostgresRosterFileFields,
    constraint: rosterFilePostgresConstraint,
    orderBy: rosterFilePostgresOrder,
    async countReferences(db, ids) {
      const rows = await db.select({ id: storedFile.id, count: count() }).from(storedFile)
        .innerJoin(recordEvidence, sql`${recordEvidence.sourceFile} COLLATE "C" = ${storedFile.relPath}`)
        .where(sql`${storedFile.id} = ANY(${sql.param(ids)}::bigint[])`).groupBy(storedFile.id)
      return new Map(rows.map(row => [row.id, row.count]))
    },
  },
  snapshot: rosterFileSnapshot,
  landing: landingSegments,
  defaultLanding: true,
  registration: {
    matchesPath: matchesLandingPath,
    async preparePostgres(input) {
      const { preparePostgresRosterRegistration } = await import('./file-upload')
      return preparePostgresRosterRegistration(input)
    },
  },
  metadata: {
    properties: rosterFileOpenApi.patchProperties,
    parse: parseMetadataPatch,
    async writePostgres(db, file: FileRow & Partial<RosterFileFields>, patch: FileMetadataPatch) {
      if (file.categoryState === undefined) return false
      const current = file as FileRow & RosterFileFields
      const next = { ...current, ...classificationChanges(current, patch) }
      await db.update(rosterFileClassification).set({
        source: next.source, kind: next.kind, year: next.year, batch: next.batch,
        titleCode: next.titleCode, categoryState: next.categoryState,
      }).where(eq(rosterFileClassification.fileId, file.id))
      return true
    },
  },
  openAPI: {
    listDescription: rosterFileOpenApi.listDescription,
    rowProperties: rosterFileOpenApi.rowProperties,
  },
} satisfies FileCategoryServer

/**
 * 可改的元数据字段 —— **票 09 只允许这五项**:`source / kind / year / batch / titleCode`。
 * `rel_path` 明确不在其中(它由磁盘决定,不由人改);`category_state` / `parse_state` 也不在,
 * 因为那是**状态**,由分类是否补齐(本文件自动维持)与解析管线(票 11/14)决定,不该手改。
 */
export interface FileMetadataPatch {
  source?: FileSource | null
  kind?: FileKind | null
  year?: number | null
  batch?: number | null
  titleCode?: string | null
}

/** 一个可空字段的「未提供 / 设为 null / 设为值」三态。 */
interface Tri<T> {
  provided: boolean
  value: T | null
}

function tri<T>(raw: unknown): Tri<T> {
  if (raw === undefined) return { provided: false, value: null }
  if (raw === null || raw === '') return { provided: true, value: null }
  return { provided: true, value: raw as T }
}

/**
 * 解析并校验 PATCH body。**只接受元数据字段** —— 出现 `relPath` / `bytes` / `sha256`
 * 之类磁盘事实的键一律 400,免得「改元数据」悄悄变成改路径或改库外的东西。
 */
export function parseMetadataPatch(body: unknown): FileMetadataPatch {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('请求体必须是对象')
  }
  const b = body as Record<string, unknown>

  const allowed = rosterFileOpenApi.patchProperties
  for (const key of Object.keys(b)) {
    if (!Object.hasOwn(allowed, key)) throw new Error(`不可修改的字段:${key}`)
  }

  const patch: FileMetadataPatch = {}

  const source = tri<FileSource>(b.source)
  if (source.provided) {
    if (source.value !== null && !SOURCE_ORDER.includes(source.value)) {
      throw new Error(`来源不在白名单:${source.value}`)
    }
    patch.source = source.value
  }

  const kind = tri<FileKind>(b.kind)
  if (kind.provided) {
    if (kind.value !== null && !KINDS.includes(kind.value)) {
      throw new Error(`类别不在白名单:${kind.value}`)
    }
    patch.kind = kind.value
  }

  const year = tri<number>(b.year)
  if (year.provided) {
    if (year.value !== null) {
      if (typeof year.value !== 'string' && typeof year.value !== 'number') throw new Error('年份必须是四位数字')
      const n = Number(year.value)
      if (!Number.isInteger(n) || n < 1900 || n > 2100) throw new Error('年份必须是四位数字')
      patch.year = n
    } else patch.year = null
  }

  const batch = tri<number>(b.batch)
  if (batch.provided) {
    if (batch.value !== null) {
      if (typeof batch.value !== 'string' && typeof batch.value !== 'number') throw new Error('批次必须是正整数')
      const n = Number(batch.value)
      if (!Number.isInteger(n) || n <= 0) throw new Error('批次必须是正整数')
      patch.batch = n
    } else patch.batch = null
  }

  const title = tri<string>(b.titleCode)
  if (title.provided) {
    if (title.value !== null && !TITLE_ORDER.includes(title.value)) {
      throw new Error(`称号不在白名单:${title.value}`)
    }
    patch.titleCode = title.value
  }

  return patch
}

export function classificationChanges(
  current: Pick<RosterFileFields, 'source' | 'kind' | 'year' | 'batch' | 'categoryState'>,
  patch: FileMetadataPatch,
): FileMetadataPatch & { categoryState?: CategoryState } {
  if (patch.source === undefined && patch.kind === undefined && patch.year === undefined) return patch
  const next = { ...current, ...patch }
  const derived = next.source && next.kind
    ? categoryStateOf({ source: next.source, kind: next.kind, year: next.year, batch: next.batch })
    : 'unset'
  return derived === 'unset' || current.categoryState === 'unset' ? { ...patch, categoryState: derived } : patch
}
