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

/**
 * 企业。由记录按身份键归并派生:优先 uscc_norm,缺失时按 name_norm。
 * 见 ADR-2026-10-13-uscc-as-identity。
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
})

/**
 * 记录。最小粒度 = 企业 × 称号 × 来源。见 ADR-2026-10-13-record-as-grain。
 * 唯一性:(enterprise_id, title_code, source)。
 */
export const record = sqliteTable(
  'record',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
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
 * 文件库(`app/files/`)中每个文件的元数据与处理状态。见 `.scratch/ingest-pipeline/issues/09-file-manager.md`。
 *
 * `rel_path` 是文件库内**相对路径**(`jxj/announcement/2024/1/….pdf`),与
 * `record_evidence.source_file` 同一口径 —— 「被记录引用数」即按此列精确匹配计数。
 *
 * `source` / `kind` / `year` / `batch` **可空**:允许「上传时未定、后续回写」(票 12)。
 * 分类状态与解析状态分开记:`category_state` 说的是**分类**是否确定,
 * `parse_state` 说的是**解析**(从文件产出记录)是否完成;两者互不蕴含。
 */
export const storedFile = sqliteTable(
  'stored_file',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** 文件库内相对路径,`/` 分隔。unique。 */
    relPath: text('rel_path').notNull(),
    /** 磁盘事实:文件名(含扩展名)、小写扩展名(不含点)、字节数、内容 SHA-256。 */
    filename: text('filename').notNull(),
    ext: text('ext').notNull(),
    bytes: integer('bytes').notNull(),
    sha256: text('sha256').notNull(),
    /** 分类(可空,见上)。 */
    source: text('source', { enum: ['jxj', 'miit'] }),
    kind: text('kind', { enum: ['announcement', 'export'] }),
    year: integer('year'),
    batch: integer('batch'),
    /** 该文件对应的称号;可空(票 12 回写)。 */
    titleCode: text('title_code').references(() => title.code),
    /** 分类是否已定:`set` 已定 / `inferred` 程序推的 / `unset` 未定。 */
    categoryState: text('category_state', { enum: ['set', 'inferred', 'unset'] })
      .notNull()
      .default('unset'),
    /** 解析是否完成:`unparsed` / `parsed` / `failed`。 */
    parseState: text('parse_state', { enum: ['unparsed', 'parsed', 'failed'] })
      .notNull()
      .default('unparsed'),
    createdAt: text('created_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
    /**
     * 移出文件库的时间。**软删除标志**:DELETE 默认只打这个标、不删磁盘。
     * 有它回填才不会把刚移出的文件又插回来(回填是幂等的,见 `server/utils/stored-files.ts`)。
     */
    removedAt: text('removed_at'),
  },
  (t) => [
    uniqueIndex('stored_file_rel_path_uq').on(t.relPath),
    index('stored_file_source_idx').on(t.source),
    index('stored_file_category_state_idx').on(t.categoryState),
    index('stored_file_parse_state_idx').on(t.parseState),
  ],
)

/**
 * 比对结果。派生、后处理,本期不生成。见 SPEC 票 12。
 */
export const reconciliationResult = sqliteTable(
  'reconciliation_result',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
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
