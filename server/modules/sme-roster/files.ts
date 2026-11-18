import { landingSegments } from '../../../lib/sme-roster/file-landing'
import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import * as schema from '../../../db/schema'
import { KIND_ORDER, PARSE_STATE_ORDER, SOURCE_ORDER, TITLE_ORDER } from '../../../lib/labels'
import { categoryStateOf, deriveClassification, type CategoryState, type FileKind, type FileSource, type ParseState } from '../../../lib/stored-file'
import type { StoredFilePart } from '../../../lib/file-parts'
import { classificationColumns, fileClassificationJoin } from '../../utils/roster-file-classification'
import { listFileParts } from '../../utils/file-parts'
import { listRegisteredDeclarations681, registeredSummary681 } from '../../utils/registered-declarations'
import { UploadRegistrationError, type FileStoreDb as Db, type FileCategoryServer, type FileRegistrationResult, type FileRow } from '../../utils/file-store'
import manifest from '../../../lib/sme-roster/manifest'
import { rosterFileOpenApi } from './file-openapi'

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

const classification = schema.rosterFileClassification

/** 给已取出的行补上**段**(票 17)。一次查询取回本页所有文件的段,按 `file_id` 分到各行。 */
function readFields(db: Db, ids: readonly number[]): ReadonlyMap<number, Partial<RosterFileFields>> {
  if (!ids.length) return new Map()
  const byFile = listFileParts(
    db,
    [...ids],
  )
  const declarations = listRegisteredDeclarations681(db, [...ids])
  const audits = db.select({ fileId: schema.fileParseAudit105.fileId, inputLineage: sql<string | null>`json_extract(${schema.fileParseAudit105.after}, '$.inputLineage')` }).from(schema.fileParseAudit105)
    .where(and(inArray(schema.fileParseAudit105.fileId, [...ids]), sql`${schema.fileParseAudit105.id} = (select max(a.id) from file_parse_audit_105 a where a.file_id = ${schema.fileParseAudit105.fileId})`)).all()
  const lineage = new Map<number, NonNullable<RosterFileFields['partsBinding']>['inputLineage']>()
  for (const audit of audits) {
    if (!lineage.has(audit.fileId)) {
      const input = (audit.inputLineage ? JSON.parse(audit.inputLineage) : undefined) as NonNullable<RosterFileFields['partsBinding']>['inputLineage'] | undefined
      lineage.set(audit.fileId, input?.status === 'bound' ? input : { status: 'unknown' })
    }
  }
  const classifications = db.select({
    fileId: schema.storedFile.id,
    ...classificationColumns,
    classificationId: classification.fileId,
    referenceCount: sql<number>`(
      select count(*) from ${schema.recordEvidence}
      where ${schema.recordEvidence.sourceFile} = ${schema.storedFile.relPath}
    )`,
  }).from(schema.storedFile).leftJoin(classification, fileClassificationJoin)
    .where(inArray(schema.storedFile.id, [...ids])).all()

  return new Map(classifications.map(({ fileId, classificationId, ...fields }) => [fileId, classificationId === null ? { referenceCount: fields.referenceCount } : {
    ...fields,
    categoryState: fields.categoryState!,
    parseState: fields.parseState!,
    registeredSummary: registeredSummary681(declarations.get(fileId) ?? []),
    parts: byFile.get(fileId) ?? [],
    partsBinding: { historical: 'unknown', inputLineage: lineage.get(fileId) ?? { status: 'unknown' } },
  }]))
}

function rosterFileSnapshot(row: FileRow & Partial<RosterFileFields>): Record<string, unknown> {
  const { source, kind, year, batch, titleCode, categoryState } = row
  return categoryState === undefined ? {} : { source, kind, year, batch, titleCode, categoryState }
}

// Server-only half of the same manifest. The browser reads only its shared file contributions.
export const rosterFileServerCategory = {
  id: manifest.id,
  ...manifest.fileCategories,
  readFields,
  constraint(db, filters) {
    const selected = and(
      filters.source?.length ? inArray(sql`${classification.source}`, filters.source) : undefined,
      filters.categoryState?.length ? inArray(sql`${classification.categoryState}`, filters.categoryState) : undefined,
      filters.parseState?.length ? inArray(sql`${classification.parseState}`, filters.parseState) : undefined,
    )
    if (!selected) return undefined
    return inArray(schema.storedFile.id, db.select({ id: classification.fileId }).from(classification).where(selected))
  },
  orderBy: [
    sql`(select case ${classification.source} ${sql.join(
      SOURCE_ORDER.map((code, i) => sql`when ${code} then ${i}`), sql` `,
    )} else ${SOURCE_ORDER.length} end from ${classification} where ${fileClassificationJoin})`,
    // DESC places NULL after all non-NULL years and batches in SQLite.
    desc(sql`(select ${classification.year} from ${classification} where ${fileClassificationJoin})`),
    desc(sql`(select ${classification.batch} from ${classification} where ${fileClassificationJoin})`),
  ],
  prepareBackfill(relPath) {
    const derived = deriveClassification(relPath)
    if (!derived) return null
    return (db, fileId) => db.insert(classification).values({ fileId, ...derived }).run()
  },
  snapshot: rosterFileSnapshot,
  landing: landingSegments,
  defaultLanding: true,
  registration: {
    async register(db, root, input, context): Promise<FileRegistrationResult> {
      // Defer the writer import because it reads the composed store for the response and audit.
      const { parseUploadDeclaration, registerStoredFile } = await import('./file-upload')
      let declaration
      try {
        declaration = parseUploadDeclaration(input)
      } catch (error) {
        throw new UploadRegistrationError((error as Error).message)
      }
      return registerStoredFile(db, root, declaration, context)
    },
  },
  metadata: {
    properties: rosterFileOpenApi.patchProperties,
    parse: parseMetadataPatch,
    write: writeFileClassification,
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

/**
 * 改一行的**元数据**。返回改后的行;不存在返回 null。
 *
 * **只写元数据列**:`rel_path` / `filename` / `ext` / `bytes` / `sha256` 一律不动
 * (那是磁盘事实),也**不碰磁盘上的任何文件**。这是票 09 的硬要求。
 *
 * 改完 `source` / `kind` / `year` / `batch` 之后,若分类由缺到全,自动把
 * `categoryState` 从 `unset` 提升为 `set` —— 用户刚把分类补齐了,不该还挂着「待分类」。
 */
function writeFileClassification(
  db: Db,
  id: number,
  patch: FileMetadataPatch,
): boolean {
  const current = db.select().from(schema.rosterFileClassification)
    .where(eq(schema.rosterFileClassification.fileId, id)).get()
  if (!current) return false

  const next = {
    source: patch.source !== undefined ? patch.source : current.source,
    kind: patch.kind !== undefined ? patch.kind : current.kind,
    year: patch.year !== undefined ? patch.year : current.year,
    batch: patch.batch !== undefined ? patch.batch : current.batch,
  }

  const set: Record<string, unknown> = {}
  if (patch.source !== undefined) set.source = patch.source
  if (patch.kind !== undefined) set.kind = patch.kind
  if (patch.year !== undefined) set.year = patch.year
  if (patch.batch !== undefined) set.batch = patch.batch
  if (patch.titleCode !== undefined) set.titleCode = patch.titleCode

  // 分类状态由分类是否补齐**自动维持**(人只改分类,不该手工去填一个状态):
  // 分类补齐 → 提升为 `set`;分类被清空 → 退回 `unset`。改分类时才算,只改称号/批次不算。
  if (patch.source !== undefined || patch.kind !== undefined || patch.year !== undefined) {
    if (next.source && next.kind) {
      const derived = categoryStateOf({
        source: next.source,
        kind: next.kind,
        year: next.year,
        batch: next.batch,
      })
      if (derived === 'set' && current.categoryState === 'unset') set.categoryState = 'set'
      if (derived === 'unset') set.categoryState = 'unset'
    } else {
      set.categoryState = 'unset'
    }
  }

  if (Object.keys(set).length) {
    db.update(schema.rosterFileClassification).set(set)
      .where(eq(schema.rosterFileClassification.fileId, id)).run()
  }

  return true
}
