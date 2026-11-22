import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import * as schema from '../../../../../db/schema'
import { type FileCategoryServer, type FileStoreDb as Db } from '../../../../core/server/utils/file-store'
import { SOURCE_ORDER } from '../../../lib/labels'
import { deriveClassification } from '../../../lib/stored-file'
import { classificationColumns, fileClassificationJoin } from '../../utils/roster-file-classification'
import { listFileParts } from '../../utils/file-parts'
import { listRegisteredDeclarations681, registeredSummary681 } from '../../utils/registered-declarations'
import { classificationChanges, rosterFileServerCategory, type FileMetadataPatch, type RosterFileFields } from './files'

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

  const changes = classificationChanges(current, patch)
  if (Object.keys(changes).length) {
    db.update(classification).set(changes).where(eq(classification.fileId, id)).run()
  }
  return true
}

export const rosterFileSqliteCategory = {
  ...rosterFileServerCategory,
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
  registration: {
    ...rosterFileServerCategory.registration,
    async prepare(input) {
      const { prepareRosterRegistration } = await import('./file-upload-sqlite')
      return prepareRosterRegistration(input)
    },
  },
  metadata: { ...rosterFileServerCategory.metadata, write: writeFileClassification },
} satisfies FileCategoryServer
