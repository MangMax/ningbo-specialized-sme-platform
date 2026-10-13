import { sql } from 'drizzle-orm'
import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core'

/**
 * 称号字典。三种梯度,等级由高到低:小巨人 > 专精特新中小企业 > 创新型中小企业。
 * 见 GLOSSARY.md / docs/data-model.md。
 */
export const title = sqliteTable('title', {
  code: text('code').primaryKey(),
  nameZh: text('name_zh').notNull(),
  level: text('level', { enum: ['national', 'municipal'] }).notNull(),
  rank: integer('rank').notNull(),
})

/** 导入快照。每次把一份数据目录导入即产生一个不可变快照。 */
export const importBatch = sqliteTable('import_batch', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  label: text('label').notNull(),
  sourceRoot: text('source_root').notNull(),
  importedAt: text('imported_at')
    .notNull()
    .default(sql`(datetime('now'))`),
  note: text('note'),
})

/**
 * 企业。由记录按身份键归并派生:优先 uscc_norm,缺失时按 name_norm。
 * 见 ADR-0002。
 */
export const enterprise = sqliteTable(
  'enterprise',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    usccNorm: text('uscc_norm'),
    name: text('name').notNull(),
    nameNorm: text('name_norm').notNull(),
    district: text('district'),
    city: text('city'),
    regStatus: text('reg_status'),
    qualityFlags: text('quality_flags', { mode: 'json' }).$type<string[]>().default([]),
  },
  (t) => [
    uniqueIndex('enterprise_uscc_norm_uq').on(t.usccNorm),
    index('enterprise_name_norm_idx').on(t.nameNorm),
  ],
)

/** 来源文件。公布文件或工信部导出。 */
export const sourceDocument = sqliteTable('source_document', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  source: text('source', { enum: ['jxj', 'miit'] }).notNull(),
  title: text('title').notNull(),
  docNumber: text('doc_number'),
  issueDate: text('issue_date'),
  path: text('path').notNull(),
  importBatchId: integer('import_batch_id').references(() => importBatch.id),
})

/**
 * 记录。最小粒度 = 企业 × 称号 × 来源。见 ADR-0003。
 * 唯一性:(enterprise_id, title_code, source)。
 */
export const record = sqliteTable(
  'record',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    importBatchId: integer('import_batch_id')
      .notNull()
      .references(() => importBatch.id),
    enterpriseId: integer('enterprise_id')
      .notNull()
      .references(() => enterprise.id),
    titleCode: text('title_code')
      .notNull()
      .references(() => title.code),
    source: text('source', { enum: ['jxj', 'miit'] }).notNull(),
    district: text('district'),
    usccRaw: text('uscc_raw'),
    nameRaw: text('name_raw'),
    qualityFlags: text('quality_flags', { mode: 'json' }).$type<string[]>().default([]),
  },
  (t) => [
    uniqueIndex('record_identity_uq').on(t.enterpriseId, t.titleCode, t.source),
    index('record_title_idx').on(t.titleCode),
    index('record_source_idx').on(t.source),
    index('record_district_idx').on(t.district),
  ],
)

/** 记录事件。认定 / 复核 / 维护 / 入库培育。同类型可多条。 */
export const recordEvent = sqliteTable(
  'record_event',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    recordId: integer('record_id')
      .notNull()
      .references(() => record.id, { onDelete: 'cascade' }),
    eventType: text('event_type', {
      enum: ['award', 'review', 'maintain', 'nurture'],
    }).notNull(),
    year: integer('year'),
    batchSeq: integer('batch_seq'),
    sortKey: integer('sort_key').notNull().default(0),
  },
  (t) => [index('record_event_record_idx').on(t.recordId)],
)

/** 事件出处:回溯到文件 / 附件 / 序号。 */
export const recordEvidence = sqliteTable(
  'record_evidence',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    recordEventId: integer('record_event_id')
      .notNull()
      .references(() => recordEvent.id, { onDelete: 'cascade' }),
    sourceFile: text('source_file').notNull(),
    attachment: text('attachment'),
    listNo: integer('list_no'),
  },
  (t) => [index('record_evidence_event_idx').on(t.recordEventId)],
)

/**
 * 比对结果。派生、后处理,本期不生成。见 SPEC 票 12。
 */
export const reconciliationResult = sqliteTable(
  'reconciliation_result',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    importBatchId: integer('import_batch_id')
      .notNull()
      .references(() => importBatch.id),
    titleCode: text('title_code')
      .notNull()
      .references(() => title.code),
    enterpriseId: integer('enterprise_id')
      .notNull()
      .references(() => enterprise.id),
    direction: text('direction', {
      enum: ['missing_in_miit', 'extra_in_miit'],
    }).notNull(),
    curated: integer('curated', { mode: 'boolean' }).notNull().default(false),
    evidence: text('evidence', { mode: 'json' }).$type<Record<string, unknown>>(),
  },
  (t) => [index('reconciliation_dir_idx').on(t.direction)],
)
