import { businessStatusCell, businessStatusChecks } from './business-status'
import type { FilePart } from './file-part'
import type { FormalValidity } from './record-event-formal-validity'
import type { DispositionFact } from './title-cycle-disposition'
import { sql } from 'drizzle-orm'
import type { AnySQLiteColumn } from 'drizzle-orm/sqlite-core'
import {
  blob,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
  unique,
  customType,
  check,
  foreignKey,
} from 'drizzle-orm/sqlite-core'

const exactText = customType<{ data: unknown; driverData: unknown }>({ dataType: () => 'text' })
const exactInteger = customType<{ data: unknown; driverData: unknown }>({ dataType: () => 'integer' })
const exactCell = customType<{ data: unknown; driverData: unknown }>({ dataType: () => 'blob' })

/** 后台外部服务凭据。仅配置服务读取，不加入台账导出或任务历史。 */
export const serviceCredential = sqliteTable('service_credential', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: text('updated_at').notNull(),
})

/**
 * 称号字典。三种梯度,等级由高到低:小巨人 > 专精特新中小企业 > 创新型中小企业。
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

/** A merged enterprise remains the immutable identity referenced by historical assignments. */
export const enterpriseMerge = sqliteTable('enterprise_merge', {
  fromEnterpriseId: integer('from_enterprise_id').primaryKey().references(() => enterprise.id, { onDelete: 'restrict' }),
  intoEnterpriseId: integer('into_enterprise_id').notNull().references(() => enterprise.id, { onDelete: 'restrict' }),
  basis: text('basis').notNull(),
  recordedAt: text('recorded_at').notNull(),
}, t => [
  index('enterprise_merge_into_idx').on(t.intoEnterpriseId),
  check('enterprise_merge_distinct_ck', sql`${t.fromEnterpriseId} <> ${t.intoEnterpriseId}`),
  ...[t.fromEnterpriseId, t.intoEnterpriseId].map(c => check(`enterprise_merge_${c.name}_safe`, sql`typeof(${c})='integer' AND ${c} BETWEEN 1 AND 9007199254740991`)),
])

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
    /**
     * **复核结论**(RL-01 补的能力缺口)。`passed` 通过 / `failed` 未通过 / `null` 不适用或未知。
     *
     * 只有 `event_type = 'review'` 才有意义;现有模型只能记「有一次复核」,**表达不了
     * 「复核未通过」** —— 而三年复核语义完全依赖它(未通过后不再进入当前有效资格的复核队列)。
     * 可空:认定/维护/培育事件与「复核但结论未知」都是 `null` —— **未知不猜成通过**。
     */
    reviewOutcome: text('review_outcome', { enum: ['passed', 'failed'] }),
    /**
     * **结论年份**(该事件公布/结论的年份)。与 `year` 分工明确:
     *  - `year` 是事件**所涉**年份 —— 认定事件的认定年份;复核事件记的是
     *    **被复核的原认定年份**;
     *  - `decided_year` 是**结论发生**的年份(如 2024 年公布的复核)。
     *
     * 复核锚点(下一次三年到期)按结论年份计算:2021 认定 → 2024 复核通过 ⇒ 下一次到期
     * 2027(= 2024 + 3)。可空;缺失时锚点退回 `year` 并把该企业标为待核 —— **不猜**。
     */
    decidedYear: integer('decided_year'),
    /** Source-bound formal facts; null retains historical unknown precision. */
    formalValidity: text('formal_validity', { mode: 'json' }).$type<FormalValidity>(),
    /** Monotonic formal-source revision; event/evidence corrections advance it atomically. */
    revision: integer('revision').notNull().default(1),
  },
  (t) => [index('record_event_record_idx').on(t.recordId)],
)

/** 事件出处:回溯到文件 / 附件 / 序号 / **页**。 */
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
    /**
     * 该条记录在**源文件**里的页码(1 起)。
     *
     * 票 14 新加:扫描 PDF 没有文字层,出处只能落到页图上 —— 而 OCR 结果**自带页码**
     * (见 `ocr_result.page_no` 与 `lib/ocr-markdown.ts` 的页标记)。`.docx` 那条通路
     * (票 11)产不出页码,一律为 `null` —— **空值优于错误值**:宁可没有,不要猜。
     *
     * `null` 与「第 1 页」是两回事:前者是「这份来源给不出页码」,后者是一个**已知**的页。
     */
    page: integer('page'),
  },
  (t) => [index('record_evidence_event_idx').on(t.recordEventId), index('record_evidence_source_file_105_idx').on(t.sourceFile), index('record_evidence_coordinate_idx').on(t.sourceFile, t.listNo, t.attachment)],
)

/**
 * 文件库(`app/files/`)中每个文件的元数据与处理状态。
 *
 * `rel_path` 是文件库内**相对路径**(`jxj/announcement/2024/1/….pdf`),与
 * `record_evidence.source_file` 同一口径 —— 「被记录引用数」即按此列精确匹配计数。
 */
export const storedFile = sqliteTable(
  'stored_file',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** 文件库内相对路径,`/` 分隔。unique。 */
    relPath: text('rel_path').notNull(),
    /** 用户可见名称覆写;null 表示沿用磁盘文件名。 */
    displayName: text('display_name'),
    /** 磁盘事实:文件名(含扩展名)、小写扩展名(不含点)、字节数、内容 SHA-256。 */
    filename: text('filename').notNull(),
    ext: text('ext').notNull(),
    bytes: integer('bytes').notNull(),
    sha256: text('sha256').notNull(),
    createdAt: text('created_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
    /**
     * 移出文件库的时间。**软删除标志**:DELETE 默认只打这个标、不删磁盘。
     * 有它回填才不会把刚移出的文件又插回来(回填是幂等的,见 `layers/core/server/utils/stored-files.ts`)。
     */
    removedAt: text('removed_at'),
  },
  (t) => [
    uniqueIndex('stored_file_rel_path_uq').on(t.relPath),
  ],
)

/** 文件的名录分类允许未定；分类和解析状态分别记录。 */
export const rosterFileClassification = sqliteTable(
  'roster_file_classification',
  {
    fileId: integer('file_id').primaryKey().references(() => storedFile.id, { onDelete: 'cascade' }),
    /** 分类(可空,见上)。 */
    source: text('source', { enum: ['jxj', 'miit'] }),
    kind: text('kind', { enum: ['announcement', 'export'] }),
    /**
     * **公布**年份 / 批次:目录给出的、**这份文件是哪一批公布的**(单值、可排序)。
     *
     * ⚠️ 与 `storedFilePart.year` **不是一回事** —— 那是文件**内容**里各段的年份/批次,
     * 一份文件可以有多个(票 17)。这里只有一个,因为它由路径 `…/<year>/<batch>/…` 决定。
     *
     */
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
  },
  (t) => [
    index('roster_file_classification_source_idx').on(t.source),
    index('roster_file_classification_category_state_idx').on(t.categoryState),
    index('roster_file_classification_parse_state_idx').on(t.parseState),
  ],
)

/** 用户显示名称的追加式改名历史;磁盘文件名与来源路径保存在 stored_file 本身。 */
export const storedFileAudit = sqliteTable(
  'stored_file_audit',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    storedFileId: integer('stored_file_id')
      .notNull()
      .references(() => storedFile.id),
    oldDisplayName: text('old_display_name').notNull(),
    newDisplayName: text('new_display_name').notNull(),
    createdAt: text('created_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (t) => [index('stored_file_audit_file_idx').on(t.storedFileId)],
)

/**
 * 文件的**段**(票 17):一份文件里含的每一段名单。
 *
 * 一份公布文件常含**多年份、多事件** —— 《〔2024〕192号》一份文件里既有
 * 「2024 年第二批认定(附件1)」又有「2021 年第二批到期复核(附件2)」;《〔2022〕145号》
 * 在同一个附件里并置 2021 与 2022 两段名单。所以文件级的单个 `year`/`batch` 表达不了它,
 * 真实粒度在这里:`(称号, 事件类型, 年份, 批次, 附件)`。
 *
 * 与 `roster_file_classification.year` / `batch`(**公布**年份/批次,单值)分工明确:那里答「这份文件是
 * 哪一批公布的」,这里答「文件里都有什么」。**别把两者混用**。
 *
 * `derived` 是从 `record_evidence` 聚合的派生结果,`agent` 是代理解析声明;升级前已存在的
 * 行标为 `legacy`,因为旧表无法证明它们来自哪条写入路径。回填重建派生行、保留代理行;
 * legacy 行与 evidence 完全一致时可归为 derived,不一致时保留并标记冲突。
 *
 */
// Owned by sme-roster. Physical relocation is tracked by #884.
export const storedFilePart = sqliteTable(
  'stored_file_part',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    fileId: integer('file_id')
      .notNull()
      .references(() => storedFile.id, { onDelete: 'cascade' }),
    /** 该段的称号。与 `roster_file_classification.title_code` 同源表(称号字典)。 */
    titleCode: text('title_code')
      .notNull()
      .references(() => title.code),
    /** 事件类型:认定 / 复核 / 维护 / 入库培育。与 `record_event.event_type` 同一套取值。 */
    eventKind: text('event_kind', {
      enum: ['award', 'review', 'maintain', 'nurture'],
    }).notNull(),
    /**
     * 段的**内容**年份。复核段记的是**被复核的原始认定年份**(如「2021 年度第二批…复核」
     * 在 2024 年公布,这里就是 2021),不是公布年份。可空。
     */
    year: integer('year'),
    batch: integer('batch'),
    /** 归一后的附件名(`附件` / `附件N`),见 `layers/sme-roster/lib/attachment.ts`。可空(导出表无附件)。 */
    attachment: text('attachment'),
    /** 该段的行数(这一段名单有多少条被台账引用)。 */
    rowCount: integer('row_count').notNull().default(0),
    /** 写入路径:`derived` 来自回填,`agent` 来自解析结果,`legacy` 是升级前来源未知的行。 */
    origin: text('origin', { enum: ['derived', 'agent', 'legacy'] })
      .notNull()
      .default('derived'),
    /** 同坐标的 evidence 与 agent/legacy 行数不一致时为 true;回填重算此标记。 */
    hasConflict: integer('has_conflict', { mode: 'boolean' }).notNull().default(false),
  },
  (t) => [
    index('stored_file_part_file_idx').on(t.fileId),
    // SQLite's regular UNIQUE treats NULL values as distinct. Include NULL-presence and
    // normalized values for every nullable coordinate so the requested key remains unique.
    uniqueIndex('stored_file_part_coordinate_uq').on(
      t.fileId,
      t.titleCode,
      t.eventKind,
      sql`(${t.year} IS NULL)`,
      sql`coalesce(${t.year}, 0)`,
      sql`(${t.batch} IS NULL)`,
      sql`coalesce(${t.batch}, 0)`,
      sql`(${t.attachment} IS NULL)`,
      sql`coalesce(${t.attachment}, '')`,
    ),
  ],
)

/**
 * **OCR 结果**(票 14):页图 → 文本。**按页**挂在一个文件上。
 *
 * 三条通路都往这张表落:
 *  - **api** —— `POST /api/jobs {kind:"ocr"}` 调 PaddleOCR API(异步、可批量);
 *  - **upload** —— `POST /api/ocr-results`,人把已在官网跑好的带页码 markdown 传进来;
 *  - **mcp** —— 代理经 MCP 的 `save_ocr_result` 写回。
 * `channel` 记的就是**这一行是哪条通路来的** —— 结果质量对不上时,这是第一个要问的问题。
 *
 * ── 为什么是「按页一行」,不是「一个文件一行 markdown 大文本」────────────
 * 1. **页码是这票的全部意义**:票 14 要按 `page_no` 给 `record_evidence` 补页码,
 *    所以页码必须是**列**(可查、可 join),不能埋在文本里;
 * 2. 单页可重跑:某页识别坏了,重跑那一页,不牵动整份;
 * 3. 幂等判据天然:**(file_id, page_no) 唯一**(见下面的唯一索引)——「同页不重复写」
 *    由库保证,而不用在应用层先查后写(那是竞态)。
 *
 * ── `page_rel_path` 是**第几页**的哪个**页图**,不是外键 ────────────────
 * 票 13 的页图**不入库**(ADR-2026-10-14:页图是派生缓存,`files/**​/.*.pages/` 不进 git、
 * 也不建表),所以这里没有 `stored_page_image` 可引用。页图的身份由**规则**给出:
 * `lib/pdf-page.ts` 的 `pageImageRelPath(pdfRelPath, pageNo)` —— 本列存的就是它算出来的
 * 那个相对路径。它是**派生值**(可由 `stored_file.rel_path` + `page_no` 现算),
 * 存下来是为了让「这条结果对的是哪张图」在库层面直接可读,而不是每次 join 回来推。
 *
 * ── `raw` 与 `markdown` 的分工 ─────────────────────────────────────────
 * `markdown` 是**产物**(人读、pipeline 解析、导出都用它);`raw` 是**原始响应**
 * (API 那一页的 JSON / 上传时给的原文),留它是为了「识别错了」时能回看引擎到底说了什么,
 * 以及日后换解析口径不必重跑付费的 API。两者都不参与查询,所以 `raw` 进 JSON 列。
 *
 * 表**只被本票的读写路径碰**;`record` / `enterprise` / 身份归并一概不碰(见 data-integrity 安全阀)。
 */
export const ocrResult = sqliteTable(
  'ocr_result',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    fileId: integer('file_id')
      .notNull()
      .references(() => storedFile.id, { onDelete: 'cascade' }),
    /** 页码,从 1 起。与票 13 的页图页号、`.pages.json` 的 `page` **同一个号**。 */
    pageNo: integer('page_no').notNull(),
    /** 同一行每次写入递增;与 AUTOINCREMENT id 合成不复用的页版本。 */
    revision: integer('revision').notNull().default(1),
    /** 该页页图在文件库内的相对路径(`lib/pdf-page.ts` 的 `pageImageRelPath`)。可空。 */
    pageRelPath: text('page_rel_path'),
    /** 该页的 markdown(带标题、表格的标准 markdown)。**空页也占一行**(`''`)——
     * 页号必须与源 PDF 的页一一对应,少一行就断号,「按 page_no 回填页码」立刻失准。 */
    markdown: text('markdown').notNull(),
    /** 原始响应(API 那一页的 JSON / 上传的原文)。不参与查询,只供回溯。 */
    raw: text('raw', { mode: 'json' }).$type<unknown>(),
    /** 识别引擎。目前只有 `paddleocr`(上传通路也沿用,除非调用方另说)。 */
    engine: text('engine').notNull().default('paddleocr'),
    /** 模型名(`PaddleOCR-VL-1.6` 之类;上传通路可空)。 */
    model: text('model'),
    /** 三通路之一:`api` / `upload` / `mcp`。 */
    channel: text('channel', { enum: ['api', 'upload', 'mcp'] }).notNull(),
    createdAt: text('created_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (t) => [
    /** **幂等的落点**:同文件的同一页只有一行(重跑/重传覆盖,不堆重复)。 */
    uniqueIndex('ocr_result_file_page_uq').on(t.fileId, t.pageNo),
    index('ocr_result_file_idx').on(t.fileId),
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

/**
 * **异步任务**(票 19):代理提交 → 拿 `jobId` → 轮询。
 *
 * ── 为什么是表,不是 JSON 文件 ────────────────────────────────────────────
 * 三件事 JSON 文件都做不到,而这三件恰好是任务要的:
 *  1. **按 `kind` / `state` 查** —— 列表接口要能筛「还在跑的 render-pages」,
 *     JSON 得整份读进内存再过滤;
 *  2. **跨重启保留** —— 97 页 OCR、700+ 家平台核查是几十分钟级的活,
 *     进程一重启文件里的半截状态就是脏的;
 *  3. **并发写不互相覆盖** —— runner 写进度、HTTP 写取消,JSON 是「改一个字段
 *     重写整份」,两个写者必然丢更新,还得自己实现锁。SQLite 的事务现成。
 *
 * `progress` 与 `result` 存 JSON:前者是 `{done,total}` 一对数字、后者是各 kind
 * **自己**的形状(render-pages 是每份文件的渲染结果),都是**不参与查询**的载荷 ——
 * 它们进 JSON 列不违反上面第 1 条(要查的是 `kind` / `state`,那是独立的列)。
 *
 * `params` / `result` **只放任务自己的载荷**:id、相对路径、分辨率。凭证不进这里
 */
export const job = sqliteTable(
  'job',
  {
    /** ULID(26 位 Crockford base32,时间前缀)—— 见 `lib/job.ts` 的 `newJobId`。 */
    id: text('id').primaryKey(),
    /** 任务种类,如 `render-pages`。指向 `server/utils/job-specs.ts` 的注册表。 */
    kind: text('kind').notNull(),
    /** 提交时给的参数(已过 kind 自己的校验)。 */
    params: text('params', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
    state: text('state', {
      enum: ['queued', 'running', 'done', 'failed', 'cancelled'],
    })
      .notNull()
      .default('queued'),
    /** `{done,total}`;百分比由 `progressPercent` 现算,不落库(见 `lib/job.ts`)。 */
    progress: text('progress', { mode: 'json' })
      .$type<{ done: number; total: number }>()
      .notNull()
      .default({ done: 0, total: 1 }),
    /** 成功时的产出,形状由 kind 决定。 */
    result: text('result', { mode: 'json' }).$type<unknown>(),
    /** 失败原因 / 取消说明。终态为 `done` 时为 null。 */
    error: text('error'),
    createdAt: text('created_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
    startedAt: text('started_at'),
    finishedAt: text('finished_at'),
  },
  (t) => [
    index('job_kind_idx').on(t.kind),
    // sme-roster owns current-roster-export request deduplication.
    uniqueIndex('job_export_request_uq').on(t.kind, sql`json_extract(${t.params}, '$.clientRequestId')`).where(sql`${t.kind} = 'current-roster-export'`),
    index('job_state_idx').on(t.state),
    index('job_created_at_idx').on(t.createdAt),
  ],
)

// ===========================================================================
// 名录生命周期契约(RL-01)—— 冻结的领域对象。
//
// 写入载荷类型见 `layers/sme-roster/lib/roster-import-client.ts`,领域决策见
// `docs/adr/2026-10-16-roster-lifecycle-model.md`。本段是**全仓共享基线**:
// 只由 RL-01 落一次,后续票(RL-02..RL-11)**增量消费,不再改这里的列语义**。
//
// 三条边界,贯穿全部新表:
//  1. **公布 = 权威历史** —— `record` / `record_event` / `record_evidence` 记的是
//     公布文件给出的事实,平台快照**永不改写**它。
//  2. **平台导出 = 采集时点现状** —— `platform_export_batch` / `_row` 是「某一天看到什么」
//     的快照,与公布事件**分开存储、分开查询**。
//  3. **接口记录 = 证据** —— `platform_query` / `platform_relation` 存原始关系与查询时点;
//     软件只提供**证据查看、确认、回填、查询**,不建设模糊推断 / 原因自动猜测引擎。
// ===========================================================================

/**
 * **统一导入批次**(契约 6)。一次写入的**来源身份 + 幂等键 + 预检/提交结果**。
 *
 * 为什么必须有:CLI 直写模式下一批导入失败到一半就再也说不清「哪些进去了」。
 * 批次把一次写入变成一个**可审计、可重放**的单位:
 *  - `idempotencyKey` **库层面唯一** —— 同一来源重放不会重复写企业/事件(幂等);
 *  - `preflightResult` 是**预检**(只读、不落库的业务影响)快照;`status` 区分
 *    `preflight`(仅预检)/`committed`(已提交)/`failed`,提交与否一目了然;
 *  - `itemResults` / `summary` / `error` 让**逐项失败可修复**,而不是笼统一句「导入失败」。
 *
 * 凭证**不进这里**(见 `.env.example` 与 SPEC「凭证不入库」):来源身份是文件相对路径
 * 或 SHA-256,不是 token。
 */
export const importBatch = sqliteTable(
  'import_batch',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** 幂等键。同一来源文件/请求**重复调用必须给同一个值**。unique。 */
    idempotencyKey: text('idempotency_key').notNull(),
    /** 来源类别:公布文件 / 平台导出 / 别名证据。 */
    sourceKind: text('source_kind', {
      enum: ['announcement', 'platform_export', 'platform_archive', 'alias_evidence', 'correspondence_decision', 'comparison_scope_proof', 'event_correction'],
    }).notNull(),
    /** 来源身份:文件库内相对路径或逻辑标识(不含凭证)。 */
    sourceIdentity: text('source_identity').notNull(),
    /** 源文件内容 SHA-256;来源给不出时留空。 */
    sourceSha256: text('source_sha256'),
    /** 批次状态:`preflight` 仅预检 / `committed` 已提交 / `failed` 提交失败。 */
    status: text('status', { enum: ['preflight', 'committed', 'failed'] })
      .notNull()
      .default('preflight'),
    /** 预检结果(新增/更新/移除/待核等计数);不参与查询,进 JSON 列。 */
    preflightResult: text('preflight_result', { mode: 'json' }).$type<unknown>(),
    /** 逐项结果/失败(可逐条修复)。 */
    itemResults: text('item_results', { mode: 'json' }).$type<unknown>(),
    /** 提交摘要。 */
    summary: text('summary', { mode: 'json' }).$type<unknown>(),
    /** 失败原因 / 说明。 */
    error: text('error'),
    createdAt: text('created_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
    /** 提交时间;未提交为 null。 */
    committedAt: text('committed_at'),
  },
  (t) => [
    uniqueIndex('import_batch_idempotency_uq').on(t.idempotencyKey),
    index('import_batch_status_idx').on(t.status),
  ],
)

/** #103: retained import attempts; terminal receipts are never rewritten by reads/retries. */
export const importReceipt = sqliteTable('import_receipt', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  batchId: integer('batch_id').notNull().references(() => importBatch.id),
  operation: text('operation', { enum: ['preflight', 'commit', 'replay'] }).notNull(),
  requestHash: text('request_hash').notNull(),
  /** Canonical validated original-body protocol, with credentials removed before storage. */
  requestBody: text('request_body').notNull(),
  /** Inline owner receipt; shared bodies never form chains. */
  bodyReceiptId: integer('body_receipt_id').references((): AnySQLiteColumn => importReceipt.id),
  status: text('status', { enum: ['processing', 'preflight', 'committed', 'failed'] }).notNull(),
  summary: text('summary', { mode: 'json' }).$type<unknown>(),
  itemResults: text('item_results', { mode: 'json' }).$type<unknown>(),
  createdAt: text('created_at').notNull(),
  completedAt: text('completed_at'),
}, t => [index('import_receipt_batch_id_idx').on(t.batchId, t.id)])

/**
 * **企业曾用名 / 别名**(契约 1)。企业身份的**历史记录**,不是另一家企业。
 *
 * 关键取舍(见 ADR「企业曾用名是证据,不是身份」):
 *  - `name` 保留**原值**、`nameNorm` 保留归一化值 —— 两者都要,前者是证据,后者供搜索;
 *  - `validFrom` / `validTo` 是**来源实际给出的**时间;来源没给就**留空不推测** ——
 *    空值优于错误值(与 `record_evidence.page` 同一口径);
 *  - `verificationStatus` 区分「已确认」与「待核实」:**未确认的别名不参与搜索/归并**,
 *    证据不足宁可待核,不自动合并有歧义的主体;
 *  - `sourceKind` + `sourceRefId` 指向**来源关系证据**(如某条 `platform_relation`)。
 *
 * 唯一键 `(enterprise_id, name_norm, source_kind, source_ref_id 归一)`:
 * 同一企业、同一别名、同一来源只有一条;不同来源/不同关系**各自成条**(逐条留证)。
 */
export const enterpriseAlias = sqliteTable(
  'enterprise_alias',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    enterpriseId: integer('enterprise_id')
      .notNull()
      .references(() => enterprise.id, { onDelete: 'cascade' }),
    version: integer('version').notNull().default(1),
    /** 首次维护前的原名称/来源；迁移回填，旧插入路径保持可空。 */
    originalName: text('original_name'),
    originalSourceKind: text('original_source_kind'),
    originalSourceRefId: integer('original_source_ref_id'),
    /** 当前别名解释；初始原值和来源单独冻结，历次变动追加审计。 */
    name: text('name').notNull(),
    /** 归一化别名(与 `layers/sme-roster/lib/domain.ts` 的 `normalizeName` 同规则),供按曾用名搜索。 */
    nameNorm: text('name_norm').notNull(),
    /** 来源类别:平台业务接口 / 平台申报接口 / 公布文件 / 人工登记。 */
    sourceKind: text('source_kind', {
      enum: ['platform_business', 'platform_apply', 'announcement', 'manual'],
    }).notNull(),
    /** 来源证据行 id(如 `platform_relation.id`);**0 = 无具体来源行引用**(不是 NULL)。 */
    sourceRefId: integer('source_ref_id').notNull().default(0),
    /** 来源给出的生效时间。**未给出留空,不推测**。 */
    validFrom: text('valid_from'),
    /** 来源给出的失效时间。未给出留空。 */
    validTo: text('valid_to'),
    /** 只有confirmed参与有效搜索/匹配；pending待核和withdrawn已撤回均不参与。 */
    verificationStatus: text('verification_status', { enum: ['confirmed', 'pending', 'withdrawn'] })
      .notNull()
      .default('pending'),
    /** 备注(如「平台记录明确写出的经信局侧曾用名」原文摘录)。 */
    note: text('note'),
    createdAt: text('created_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (t) => [
    // 同一企业、同一别名、同一来源只有一条;不同来源行(如两条平台关系)**各自成条**。
    // `source_ref_id` 用 0 表示「无具体来源行引用」而不是 NULL —— 避免 SQLite 把 NULL
    // 视为互不相等而放过重复(也免得索引里出现带逗号的 coalesce 表达式)。
    uniqueIndex('enterprise_alias_identity_uq').on(
      t.enterpriseId,
      t.nameNorm,
      t.sourceKind,
      t.sourceRefId,
    ),
    index('enterprise_alias_name_norm_idx').on(t.nameNorm),
    index('enterprise_alias_enterprise_idx').on(t.enterpriseId),
    index('enterprise_alias_status_page_idx').on(t.enterpriseId, t.verificationStatus, t.id),
  ],
)

/** #96 append-only profile corrections; independent of alias lifecycle (#99). */
export const enterpriseProfileAudit = sqliteTable('enterprise_profile_audit', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  // Immutable historical target; dedicated identity merge may remove its live row.
  enterpriseId: integer('enterprise_id').notNull(),
  idempotencyKey: text('idempotency_key').notNull(),
  requestHash: text('request_hash').notNull(),
  beforeVersion: text('before_version').notNull(),
  afterVersion: text('after_version').notNull(),
  before: text('before', { mode: 'json' }).$type<{ enterpriseId: number; name: string; city: string | null; district: string | null }>().notNull(),
  after: text('after', { mode: 'json' }).$type<{ enterpriseId: number; name: string; city: string | null; district: string | null }>().notNull(),
  actor: text('actor', { mode: 'json' }).$type<{ type: 'user' | 'agent'; id: string }>().notNull(),
  basis: text('basis').notNull(),
  retainedAliasId: integer('retained_alias_id'),
  aliasCreated: integer('alias_created', { mode: 'boolean' }).notNull().default(false),
  createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
}, t => [uniqueIndex('enterprise_profile_audit_key_uq').on(t.idempotencyKey), index('enterprise_profile_audit_enterprise_idx').on(t.enterpriseId, t.id)])

/** Platform collection metadata; raw response bytes belong to the immutable archive. */
export const platformCollection = sqliteTable('platform_collection', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  interface: text('interface', { enum: ['business_list', 'apply_list', 'recognized_list'] }).notNull(),
  queryKey: text('query_key').notNull(),
  rdjb: text('rdjb').notNull(),
  titleCode: text('title_code').references(() => title.code, { onDelete: 'restrict' }),
  queriedAt: text('queried_at').notNull(),
  createdAt: text('created_at').notNull(),
  lastCollectedAt: text('last_collected_at'),
  status: text('status', { enum: ['success', 'failed', 'no_record', 'not_queried', 'partial'] }).notNull(),
  failureReason: text('failure_reason'),
  source: text('source'),
  evidenceStatus: text('evidence_status'),
  completedAt: text('completed_at'),
  completeness: text('completeness', { enum: ['complete', 'partial', 'not_queried', 'unknown'] }).notNull(),
  fullRange: integer('full_range'),
  fetchedCount: integer('fetched_count'),
  declaredTotal: integer('declared_total'),
  scopeMode: text('scope_mode'),
  provenanceState: text('provenance_state', { enum: ['captured', 'legacy_supplement', 'unknown', 'conflict'] }).notNull(),
  parseState: text('parse_state', { enum: ['valid', 'invalid', 'absent'] }).notNull(),
  ruleVersion: text('rule_version').notNull(),
  errorCode: text('error_code'),
  errorMessage: text('error_message'),
  maxRequests: integer('max_requests'),
  maxRows: integer('max_rows'),
  maxDurationMs: integer('max_duration_ms'),
  pageSize: integer('page_size'),
  reconcileSlotState: text('reconcile_slot_state', { enum: ['uncaptured', 'verified', 'miss', 'error'] }).notNull().default('uncaptured'),
  reconcileSlotRule: text('reconcile_slot_rule'),
  reconcileSlotRawArchiveId: integer('reconcile_slot_raw_archive_id').references((): AnySQLiteColumn => platformArchiveValue.id, { onDelete: 'restrict' }),
  reconcileSlotRowCount: integer('reconcile_slot_row_count'),
  reconcileSlotInputSha256: text('reconcile_slot_input_sha256'),
  reconcileSlotReason: text('reconcile_slot_reason'),
  witnessState: text('witness_state').notNull().default('uncaptured'),
  witnessGate: integer('witness_gate'),
  witnessRule: text('witness_rule'),
  witnessArchiveId: integer('witness_archive_id').references((): AnySQLiteColumn => platformArchiveValue.id, { onDelete: 'restrict' }),
  witnessSha256: text('witness_sha256'),
  witnessErrorName: text('witness_error_name'),
  witnessError: text('witness_error'),
}, t => [
  uniqueIndex('platform_collection_identity_uq').on(t.interface, t.queryKey, t.rdjb, t.queriedAt),
  index('platform_collection_key_idx').on(t.queryKey, t.id),
  index('platform_collection_status_time_idx').on(t.status, t.queriedAt, t.id),
  index('platform_collection_title_idx').on(t.titleCode, t.id),
  check('platform_collection_interface_ck', sql`${t.interface} IN ('business_list','apply_list','recognized_list')`),
  check('platform_collection_status_ck', sql`${t.status} IN ('success','failed','no_record','not_queried','partial')`),
  check('platform_collection_completeness_ck', sql`${t.completeness} IN ('complete','partial','not_queried','unknown')`),
  check('platform_collection_provenance_ck', sql`${t.provenanceState} IN ('captured','legacy_supplement','unknown','conflict')`),
  check('platform_collection_parse_ck', sql`${t.parseState} IN ('valid','invalid','absent')`),
  check('platform_collection_full_range_ck', sql`${t.fullRange} IS NULL OR (typeof(${t.fullRange}) = 'integer' AND ${t.fullRange} IN (0,1))`),
  ...[t.fetchedCount, t.declaredTotal].map(c => check(`platform_collection_${c.name}_ck`, sql`${c} IS NULL OR (typeof(${c}) = 'integer' AND ${c} BETWEEN 0 AND 9007199254740991)`)),
  ...[t.maxRequests, t.maxRows, t.maxDurationMs, t.pageSize].map(c => check(`platform_collection_${c.name}_ck`, sql`${c} IS NULL OR (typeof(${c}) = 'integer' AND ${c} BETWEEN 1 AND 9007199254740991)`)),
])

export const platformCollectionPage = sqliteTable('platform_collection_page', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  collectionId: integer('collection_id').notNull().references(() => platformCollection.id, { onDelete: 'restrict' }),
  ordinal: integer('ordinal').notNull(),
  source: text('source'),
  rdjb: text('rdjb'),
  pageNo: integer('page_no'),
  maxPage: integer('max_page'),
  maxPagePresent: integer('max_page_present').notNull().default(0),
  fetchedCount: integer('fetched_count'),
  declaredTotal: integer('declared_total'),
  status: text('status'),
  errorCode: text('error_code'),
  errorMessage: text('error_message'),
  sequenceStart: integer('sequence_start'),
  sequenceEnd: integer('sequence_end'),
  positionState: text('position_state', { enum: ['verified', 'unknown', 'conflict'] }).notNull(),
}, t => [
  uniqueIndex('platform_collection_page_ordinal_uq').on(t.collectionId, t.ordinal),
  index('platform_collection_page_title_idx').on(t.collectionId, t.rdjb, t.pageNo),
  check('platform_collection_page_position_ck', sql`${t.positionState} IN ('verified','unknown','conflict')`),
  check('platform_collection_page_max_page_present_ck', sql`${t.maxPagePresent} IN (0,1)`),
  check('platform_collection_page_ordinal_ck', sql`typeof(${t.ordinal}) = 'integer' AND ${t.ordinal} BETWEEN 0 AND 9007199254740991`),
  ...[t.pageNo, t.maxPage, t.sequenceStart, t.sequenceEnd].map(c => check(`platform_collection_page_${c.name}_ck`, sql`${c} IS NULL OR (typeof(${c}) = 'integer' AND ${c} BETWEEN 1 AND 9007199254740991)`)),
  ...[t.fetchedCount, t.declaredTotal].map(c => check(`platform_collection_page_${c.name}_ck`, sql`${c} IS NULL OR (typeof(${c}) = 'integer' AND ${c} BETWEEN 0 AND 9007199254740991)`)),
  check('platform_collection_page_sequence_ck', sql`(${t.sequenceStart} IS NULL AND ${t.sequenceEnd} IS NULL) OR (${t.sequenceStart} IS NOT NULL AND ${t.sequenceEnd} IS NOT NULL AND ${t.sequenceEnd} >= ${t.sequenceStart})`),
])

export const platformCollectionUnfinished = sqliteTable('platform_collection_unfinished', {
  collectionId: integer('collection_id').notNull().references(() => platformCollection.id, { onDelete: 'restrict' }),
  ordinal: integer('ordinal').notNull(),
  source: text('source'),
  rdjb: text('rdjb'),
  pageNo: integer('page_no'),
}, t => [
  primaryKey({ columns: [t.collectionId, t.ordinal] }),
  check('platform_collection_unfinished_ordinal_ck', sql`typeof(${t.ordinal}) = 'integer' AND ${t.ordinal} BETWEEN 0 AND 9007199254740991`),
  check('platform_collection_unfinished_page_ck', sql`${t.pageNo} IS NULL OR (typeof(${t.pageNo}) = 'integer' AND ${t.pageNo} BETWEEN 1 AND 9007199254740991)`),
])

export const platformCollectionCondition = sqliteTable('platform_collection_condition', {
  collectionId: integer('collection_id').notNull().references(() => platformCollection.id, { onDelete: 'restrict' }),
  name: text('name', { enum: ['name', 'uscc', 'combination', 'sqsj', 'rddqrq', 'whpcyear', 'whpc', 'szq', 'orderField', 'orderDirection'] }).notNull(),
  valueKind: text('value_kind', { enum: ['absent', 'null', 'text', 'integer', 'real', 'boolean', 'array', 'object'] }).notNull(),
  textValue: text('text_value'),
  integerValue: integer('integer_value'),
  witnessKind: text('witness_kind'),
  witnessValue: exactCell('witness_value'),
}, t => [
  primaryKey({ columns: [t.collectionId, t.name] }),
  check('platform_collection_condition_name_ck', sql`${t.name} IN ('name','uscc','combination','sqsj','rddqrq','whpcyear','whpc','szq','orderField','orderDirection')`),
  check('platform_collection_condition_value_ck', sql`
    (${t.valueKind} = 'text' AND ${t.textValue} IS NOT NULL AND typeof(${t.textValue}) = 'text' AND ${t.integerValue} IS NULL) OR
    (${t.valueKind} = 'integer' AND ${t.textValue} IS NULL AND ${t.integerValue} IS NOT NULL AND typeof(${t.integerValue}) = 'integer' AND ${t.integerValue} BETWEEN -9007199254740991 AND 9007199254740991) OR
    (${t.valueKind} = 'boolean' AND ${t.textValue} IS NULL AND ${t.integerValue} IS NOT NULL AND typeof(${t.integerValue}) = 'integer' AND ${t.integerValue} IN (0,1)) OR
    (${t.valueKind} IN ('absent','null','real','array','object') AND ${t.textValue} IS NULL AND ${t.integerValue} IS NULL)
  `),
])

export const platformQueryTitleScope = sqliteTable('platform_query_title_scope', {
  collectionId: integer('collection_id').notNull().references(()=>platformCollection.id,{onDelete:'restrict'}),
  rdjb: text('rdjb').notNull(),
}, t=>[
  primaryKey({columns:[t.collectionId,t.rdjb]}),
  index('platform_query_title_scope_rdjb_collection_idx').on(t.rdjb,t.collectionId),
  check('platform_query_title_scope_safe_id',sql`${t.collectionId} > 0 AND ${t.collectionId} <= 9007199254740991`),
])
/** Rows whose archived title JSON would make the legacy title predicate fail. */
export const platformQueryTitleScopeError = sqliteTable('platform_query_title_scope_error', {
  collectionId: integer('collection_id').primaryKey().notNull().references(()=>platformCollection.id,{onDelete:'restrict'}),
}, t=>[check('platform_query_title_scope_error_safe_id',sql`${t.collectionId} > 0 AND ${t.collectionId} <= 9007199254740991`)])

/** Platform business identity, independently retained across observations. */
export const platformBusinessRecord = sqliteTable('platform_business_record', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  interface: text('interface', { enum: ['business_list', 'apply_list', 'recognized_list'] }).notNull(),
  platformKey: text('platform_key').notNull(),
  identityRuleVersion: text('identity_rule_version').notNull(),
  createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
}, t => [
  uniqueIndex('platform_business_record_identity_uq').on(t.interface, t.platformKey),
  check('platform_business_record_key_ck', sql`length(trim(${t.platformKey})) > 0`),
  check('platform_business_record_interface_ck', sql`${t.interface} IN ('business_list','apply_list','recognized_list')`),
])

export const platformBusinessRecordVersion = sqliteTable('platform_business_record_version', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  recordId: integer('record_id').notNull().references(() => platformBusinessRecord.id, { onDelete: 'restrict' }),
  hashAlgorithm: text('hash_algorithm').notNull(),
  contentHash: text('content_hash').notNull(),
  canonicalRawJson: text('canonical_raw_json').notNull(),
  /** Archive binding for the canonical version input. */
  canonicalArchiveId: integer('canonical_archive_id').references((): AnySQLiteColumn => platformArchiveValue.id, { onDelete: 'restrict' }),
  createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
}, t => [
  uniqueIndex('platform_business_version_hash_uq').on(t.recordId, t.hashAlgorithm, t.contentHash),
  uniqueIndex('platform_business_version_owner_uq').on(t.id, t.recordId),
  index('platform_business_version_canonical_archive_idx').on(t.canonicalArchiveId),
])

/** Native observation fields shared by the source projections. */
export function observationFields() { return {
  pageId: integer('page_id').references(() => platformCollectionPage.id, { onDelete: 'restrict' }),
  pageRowNo: integer('page_row_no'),
  positionState: text('position_state', { enum: ['verified', 'unknown', 'conflict'] }),
  /** Original relation_key, never canonical platformKey/raw.id. NULL before transfer is uncaptured. */
  sourceRelationKey: text('source_relation_key'),
  recordId: integer('record_id').references(() => platformBusinessRecord.id, { onDelete: 'restrict' }),
  versionId: integer('version_id'),
  identityState: text('identity_state', { enum: ['resolved', 'missing_key', 'conflict', 'not_indexed'] }).notNull(),
  contentState: text('content_state', { enum: ['verified', 'unverifiable', 'not_indexed'] }).notNull(),
  keySource: text('key_source', { enum: ['relation_key', 'raw_id', 'both', 'none'] }),
  projectionRuleVersion: text('projection_rule_version'),
  inputFingerprint: text('input_fingerprint'),
  indexedAt: text('indexed_at').$defaultFn(() => new Date().toISOString()),
  batchId: integer('batch_id').references(() => importBatch.id, { onDelete: 'restrict' }),
} }
export function observationConstraints(t: { [K in keyof ReturnType<typeof observationFields>]: AnySQLiteColumn } & { id: AnySQLiteColumn, collectionId: AnySQLiteColumn, sequenceNo: AnySQLiteColumn }, identity: AnySQLiteColumn) { return [
  uniqueIndex('platform_observation_id_uq').on(t.id),
  uniqueIndex('platform_observation_collection_sequence_uq').on(t.collectionId, t.sequenceNo),
  index('platform_observation_position_idx').on(t.collectionId, t.pageId, t.sequenceNo),
  ...[t.id, t.collectionId, t.sequenceNo, t.pageId, t.pageRowNo].map(c => check(`platform_observation_${c.name}_ck`, sql`${c} IS NULL OR (typeof(${c}) = 'integer' AND ${c} BETWEEN 1 AND 9007199254740991)`)),
  check('platform_observation_position_state_ck', sql`${t.positionState} IS NULL OR ${t.positionState} IN ('verified','unknown','conflict')`),
  check('platform_observation_source_key_ck', sql`${t.sourceRelationKey} IS NULL OR typeof(${t.sourceRelationKey}) = 'text'`),
  check('platform_observation_mapping_ck', sql`(${t.id} IS NULL AND ${t.collectionId} IS NULL AND ${t.sequenceNo} IS NULL AND ${t.pageId} IS NULL AND ${t.pageRowNo} IS NULL AND ${t.positionState} IS NULL AND ${t.sourceRelationKey} IS NULL) OR (${t.id} IS NOT NULL AND ${t.collectionId} IS NOT NULL AND ${t.sequenceNo} IS NOT NULL AND ${t.positionState} IS NOT NULL AND (${t.pageRowNo} IS NULL OR ${t.pageId} IS NOT NULL))`),
  foreignKey({ columns: [t.versionId, t.recordId], foreignColumns: [platformBusinessRecordVersion.id, platformBusinessRecordVersion.recordId] }).onDelete('restrict'),
  check('platform_business_observation_state_ck', sql`(${t.identityState} = 'resolved' AND ${t.recordId} IS NOT NULL) OR (${t.identityState} IN ('missing_key','conflict','not_indexed') AND ${t.recordId} IS NULL)`),
  check('platform_business_observation_content_ck', sql`(${t.contentState} = 'verified' AND ${t.versionId} IS NOT NULL AND ${t.recordId} IS NOT NULL) OR (${t.contentState} IN ('unverifiable','not_indexed') AND ${t.versionId} IS NULL)`),
  // Explicit two-branch capture contract: IS/typeof make NULL CHECK outcomes impossible.
  check('platform_observation_capture_ck', sql`(${t.identityState} = 'not_indexed' AND ${t.contentState} = 'not_indexed' AND ${t.recordId} IS NULL AND ${t.versionId} IS NULL AND ${t.keySource} IS NULL AND ${t.projectionRuleVersion} IS NULL AND ${t.inputFingerprint} IS NULL AND ${t.indexedAt} IS NULL) OR (${t.identityState} IN ('resolved','missing_key','conflict') AND ${t.contentState} IN ('verified','unverifiable') AND ${t.keySource} IS NOT NULL AND ${t.keySource} IN ('relation_key','raw_id','both','none') AND typeof(${t.projectionRuleVersion}) = 'text' AND typeof(${t.inputFingerprint}) = 'text' AND typeof(${t.indexedAt}) = 'text')`),
  index('platform_business_observation_record_idx').on(t.recordId, t.versionId, identity),
  index('platform_business_observation_version_idx').on(t.versionId, identity),
] }
export const platformBusinessObservation = sqliteTable('platform_business_observation', {
  id: integer('id').primaryKey(),
  collectionId: integer('collection_id').notNull().references(()=>platformCollection.id,{onDelete:'restrict'}),
  sequenceNo: integer('sequence_no').notNull(),
  ...observationFields(),
  positionState: text('position_state',{enum:['verified','unknown','conflict']}).notNull(),
  processExactOwnerId: integer('process_exact_owner_id'),
  processExactState: text('process_exact_state', { enum: ['captured', 'uncaptured'] }),
  processSqlFactTitleState: text('process_sql_fact_title_state', { enum: ['captured', 'uncaptured'] }),
  applyExactOwnerId: integer('apply_exact_owner_id'),
  applyExactState: text('apply_exact_state', { enum: ['captured', 'uncaptured'] }),
  applySqlFactTitleState: text('apply_sql_fact_title_state', { enum: ['captured', 'uncaptured'] }),
  candidateScopeMask: integer('candidate_scope_mask'),
  candidateScopeRule: text('candidate_scope_rule'),
  candidateScopeArchiveId: integer('candidate_scope_archive_id').references((): AnySQLiteColumn => platformArchiveValue.id, { onDelete: 'restrict' }),
  candidateScopeRdjb: text('candidate_scope_rdjb'),
  candidateScopeTitleCode: text('candidate_scope_title_code'),
  candidateScopeSequenceNo: integer('candidate_scope_sequence_no'),
  candidateScopeError: text('candidate_scope_error').default('not_captured'),
  candidateScopeState: text('candidate_scope_state', { enum: ['uncaptured', 'captured', 'error'] }).notNull().default('uncaptured'),
  witnessRule: text('witness_rule'),
  witnessCollectionId: integer('witness_collection_id'),
  witnessSequenceNo: integer('witness_sequence_no'),
  witnessArchiveId: integer('witness_archive_id').references((): AnySQLiteColumn => platformArchiveValue.id, { onDelete: 'restrict' }),
  witnessSha256: text('witness_sha256'),
  witnessOrdinal: integer('witness_ordinal'),
  witnessRdjbKind: text('witness_rdjb_kind'),
  witnessRdjbValue: exactCell('witness_rdjb_value'),
  witnessRdjbKey: text('witness_rdjb_key'),
  witnessPageKind: text('witness_page_kind'),
  witnessPageValue: exactCell('witness_page_value'),
  witnessErrorName: text('witness_error_name'),
  witnessError: text('witness_error'),
  witnessState: text('witness_state').notNull().default('uncaptured'),
},t=>observationConstraints(t,t.id))
/** Append-only enterprise assignments for an independent observation. */
export function definePlatformObservationAssignment(observationId: () => AnySQLiteColumn) { return sqliteTable('platform_observation_assignment', {
  observationId: integer('observation_id').notNull().references(observationId, { onDelete: 'restrict' }),
  revision: integer('revision').notNull(),
  enterpriseId: integer('enterprise_id').references(() => enterprise.id, { onDelete: 'restrict' }),
  matchBasis: text('match_basis', { enum: ['uscc', 'alias', 'manual', 'none'] }).notNull(),
  verificationStatus: text('verification_status', { enum: ['confirmed', 'pending'] }).notNull(),
  usccRaw: text('uscc_raw'),
  nameRaw: text('name_raw'),
  aliasNameRaw: text('alias_name_raw'),
  actor: text('actor', { mode: 'json' }).$type<{ type: 'user' | 'agent'; id: string } | null>(),
  basis: text('basis'),
  commandReceiptId: integer('command_receipt_id'),
  recordedAt: text('recorded_at'),
  origin: text('origin', { enum: ['migrated_current', 'command'] }).notNull(),
}, t => [
  primaryKey({ columns: [t.observationId, t.revision] }),
  index('platform_assignment_enterprise_idx').on(t.enterpriseId, t.observationId, t.revision),
  index('platform_assignment_uscc_idx').on(t.usccRaw, t.observationId),
  ...[t.observationId, t.revision, t.enterpriseId, t.commandReceiptId].map(c => check(`platform_assignment_${c.name}_ck`, sql`${c} IS NULL OR (typeof(${c}) = 'integer' AND ${c} BETWEEN 1 AND 9007199254740991)`)),
  ...[t.usccRaw, t.nameRaw, t.aliasNameRaw, t.actor, t.basis, t.recordedAt].map(c => check(`platform_assignment_${c.name}_ck`, sql`${c} IS NULL OR typeof(${c}) = 'text'`)),
  check('platform_assignment_match_ck', sql`${t.matchBasis} IN ('uscc','alias','manual','none')`),
  check('platform_assignment_verification_ck', sql`${t.verificationStatus} IN ('confirmed','pending')`),
  check('platform_assignment_origin_ck', sql`(${t.origin} = 'migrated_current' AND ${t.revision} = 1 AND ${t.actor} IS NULL AND ${t.recordedAt} IS NULL AND ${t.commandReceiptId} IS NULL) OR ${t.origin} = 'command'`),
])
}
export const platformObservationAssignment = definePlatformObservationAssignment(() => platformBusinessObservation.id)

/**
 * Source-specific typed projection for apply_list (upstream queryList). One row per
 * immutable content version; the composite owner FK prevents a version/record mismatch.
 * Fields are copied from the archived raw row only (null when absent), never inferred.
 */
export function applyProjectionFields(observationId: () => AnySQLiteColumn) { return {
  id: integer('id').primaryKey({ autoIncrement: true }),
  ...applyStoredFields(),
  observationId: integer('observation_id').references(observationId, { onDelete: 'restrict' }),
  basis: text('basis', { enum: ['verified_raw', 'observation_reconciliation', 'unavailable'] }).notNull().default('verified_raw'),
  versionId: integer('version_id').references(() => platformBusinessRecordVersion.id, { onDelete: 'restrict' }),
  recordId: integer('record_id').references(() => platformBusinessRecord.id, { onDelete: 'restrict' }),
  /** Raw sblx after trimming; unknown dictionary values are retained. */
  declareKind: text('declare_kind'),
  /** Explicit positive decimal-integer source year only. */
  declarationYear: integer('declaration_year'),
  /** Raw sqsj after trimming. */
  appliedAt: text('applied_at'),
  /** Raw cszt after trimming. */
  status: text('status'),
  /** Raw row-level rdjb after trimming; never query title scope. */
  titleRaw: text('title_raw'),
  nameRaw: text('name_raw'),
  usccRaw: text('uscc_raw'),
  sourceTitleKind: text('source_title_kind', { enum: ['absent','null','text','number','boolean','array','object','invalid'] }),
  sourceTitleText: text('source_title_text'),
  sourceTitleNumberText: text('source_title_number_text'),
  sourceTitleBoolean: integer('source_title_boolean'),
  sourceTitleRuleVersion: text('source_title_rule_version'),
  sourceArchiveId: integer('source_archive_id').references(() => platformArchiveValue.id, { onDelete: 'restrict' }),
  parseState: text('parse_state', { enum: ['valid','invalid','absent'] }),
  storedProvinceKind: text('stored_province_kind', { enum: ['absent','null','text','number','boolean','array','object','invalid'] }),
  storedProvince: text('stored_province'),
  parsedProvinceKind: text('parsed_province_kind', { enum: ['absent','null','text','number','boolean','array','object','invalid'] }),
  parsedProvince: text('parsed_province'),
  reconciledProvince: text('reconciled_province'),
  provinceConflict: integer('province_conflict'),
  storedStatusKind: text('stored_status_kind', { enum: ['absent','null','text','number','boolean','array','object','invalid'] }),
  storedStatus: text('stored_status'),
  parsedStatusKind: text('parsed_status_kind', { enum: ['absent','null','text','number','boolean','array','object','invalid'] }),
  parsedStatus: text('parsed_status'),
  reconciledStatus: text('reconciled_status'),
  statusConflict: integer('status_conflict'),
  storedBatchKind: text('stored_batch_kind', { enum: ['absent','null','text','number','boolean','array','object','invalid'] }),
  storedBatch: text('stored_batch'),
  parsedBatchKind: text('parsed_batch_kind', { enum: ['absent','null','text','number','boolean','array','object','invalid'] }),
  parsedBatch: text('parsed_batch'),
  reconciledBatch: text('reconciled_batch'),
  batchConflict: integer('batch_conflict'),
  storedDeclareKindKind: text('stored_declare_kind_kind', { enum: ['absent','null','text','number','boolean','array','object','invalid'] }),
  storedDeclareKind: text('stored_declare_kind'),
  parsedDeclareKindKind: text('parsed_declare_kind_kind', { enum: ['absent','null','text','number','boolean','array','object','invalid'] }),
  parsedDeclareKind: text('parsed_declare_kind'),
  reconciledDeclareKind: text('reconciled_declare_kind'),
  declareKindConflict: integer('declare_kind_conflict'),
  storedAppliedAtKind: text('stored_applied_at_kind', { enum: ['absent','null','text','number','boolean','array','object','invalid'] }),
  storedAppliedAt: text('stored_applied_at'),
  parsedAppliedAtKind: text('parsed_applied_at_kind', { enum: ['absent','null','text','number','boolean','array','object','invalid'] }),
  parsedAppliedAt: text('parsed_applied_at'),
  reconciledAppliedAt: text('reconciled_applied_at'),
  appliedAtConflict: integer('applied_at_conflict'),
  storedAwardBatchLabelKind: text('stored_award_batch_label_kind', { enum: ['absent','null','text','number','boolean','array','object','invalid'] }),
  storedAwardBatchLabel: text('stored_award_batch_label'),
  parsedAwardBatchLabelKind: text('parsed_award_batch_label_kind', { enum: ['absent','null','text','number','boolean','array','object','invalid'] }),
  parsedAwardBatchLabel: text('parsed_award_batch_label'),
  reconciledAwardBatchLabel: text('reconciled_award_batch_label'),
  awardBatchLabelConflict: integer('award_batch_label_conflict'),
  storedYearKind: text('stored_year_kind', { enum: ['absent','null','text','number','boolean','array','object','invalid'] }),
  storedYear: integer('stored_year'),
  parsedYearKind: text('parsed_year_kind', { enum: ['absent','null','text','number','boolean','array','object','invalid'] }),
  parsedYear: integer('parsed_year'),
  reconciledYear: integer('reconciled_year'),
  yearConflict: integer('year_conflict'),
  ruleVersion: text('rule_version').notNull(),
  createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
} }
export function definePlatformApplyProjection(observationId: () => AnySQLiteColumn) { return sqliteTable('platform_apply_projection', {
  ...applyProjectionFields(observationId),
}, t => [
  uniqueIndex('platform_apply_projection_version_uq').on(t.versionId),
  uniqueIndex('platform_apply_projection_observation_uq').on(t.observationId),
  index('platform_apply_projection_source_archive_idx').on(t.sourceArchiveId),
  check('platform_apply_projection_owner_ck', sql`( ${t.versionId} IS NOT NULL AND ${t.recordId} IS NOT NULL AND ${t.observationId} IS NULL AND ${t.basis} = 'verified_raw') OR (${t.versionId} IS NULL AND ${t.recordId} IS NULL AND ${t.observationId} IS NOT NULL AND ${t.basis} IN ('observation_reconciliation','unavailable'))`),
  check('platform_apply_projection_id_ck', sql`${t.id} IS NULL OR (typeof(${t.id}) = 'integer' AND ${t.id} BETWEEN 1 AND 9007199254740991)`),
  check('platform_apply_projection_version_id_ck', sql`${t.versionId} IS NULL OR (typeof(${t.versionId}) = 'integer' AND ${t.versionId} BETWEEN 1 AND 9007199254740991)`),
  check('platform_apply_projection_record_id_ck', sql`${t.recordId} IS NULL OR (typeof(${t.recordId}) = 'integer' AND ${t.recordId} BETWEEN 1 AND 9007199254740991)`),
  check('platform_apply_projection_observation_id_ck', sql`${t.observationId} IS NULL OR (typeof(${t.observationId}) = 'integer' AND ${t.observationId} BETWEEN 1 AND 9007199254740991)`),
  check('platform_apply_projection_source_archive_id_ck', sql`${t.sourceArchiveId} IS NULL OR (typeof(${t.sourceArchiveId}) = 'integer' AND ${t.sourceArchiveId} BETWEEN 1 AND 9007199254740991)`),
  check('platform_apply_projection_capture_ck', sql`(${t.observationId} IS NULL AND ${t.sourceTitleKind} IS NULL AND ${t.sourceTitleText} IS NULL AND ${t.sourceTitleNumberText} IS NULL AND ${t.sourceTitleBoolean} IS NULL AND ${t.sourceTitleRuleVersion} IS NULL AND ${t.sourceArchiveId} IS NULL AND ${t.parseState} IS NULL AND ${t.storedProvinceKind} IS NULL AND ${t.storedProvince} IS NULL AND ${t.parsedProvinceKind} IS NULL AND ${t.parsedProvince} IS NULL AND ${t.reconciledProvince} IS NULL AND ${t.provinceConflict} IS NULL AND ${t.storedStatusKind} IS NULL AND ${t.storedStatus} IS NULL AND ${t.parsedStatusKind} IS NULL AND ${t.parsedStatus} IS NULL AND ${t.reconciledStatus} IS NULL AND ${t.statusConflict} IS NULL AND ${t.storedBatchKind} IS NULL AND ${t.storedBatch} IS NULL AND ${t.parsedBatchKind} IS NULL AND ${t.parsedBatch} IS NULL AND ${t.reconciledBatch} IS NULL AND ${t.batchConflict} IS NULL AND ${t.storedDeclareKindKind} IS NULL AND ${t.storedDeclareKind} IS NULL AND ${t.parsedDeclareKindKind} IS NULL AND ${t.parsedDeclareKind} IS NULL AND ${t.reconciledDeclareKind} IS NULL AND ${t.declareKindConflict} IS NULL AND ${t.storedAppliedAtKind} IS NULL AND ${t.storedAppliedAt} IS NULL AND ${t.parsedAppliedAtKind} IS NULL AND ${t.parsedAppliedAt} IS NULL AND ${t.reconciledAppliedAt} IS NULL AND ${t.appliedAtConflict} IS NULL AND ${t.storedAwardBatchLabelKind} IS NULL AND ${t.storedAwardBatchLabel} IS NULL AND ${t.parsedAwardBatchLabelKind} IS NULL AND ${t.parsedAwardBatchLabel} IS NULL AND ${t.reconciledAwardBatchLabel} IS NULL AND ${t.awardBatchLabelConflict} IS NULL AND ${t.storedYearKind} IS NULL AND ${t.storedYear} IS NULL AND ${t.parsedYearKind} IS NULL AND ${t.parsedYear} IS NULL AND ${t.reconciledYear} IS NULL AND ${t.yearConflict} IS NULL) OR (${t.observationId} IS NOT NULL AND ${t.sourceTitleKind} IS NOT NULL AND ${t.sourceTitleRuleVersion} IS NOT NULL AND ${t.sourceArchiveId} IS NOT NULL AND ${t.parseState} IS NOT NULL AND ${t.storedProvinceKind} IS NOT NULL AND ${t.parsedProvinceKind} IS NOT NULL AND ${t.storedStatusKind} IS NOT NULL AND ${t.parsedStatusKind} IS NOT NULL AND ${t.storedBatchKind} IS NOT NULL AND ${t.parsedBatchKind} IS NOT NULL AND ${t.storedDeclareKindKind} IS NOT NULL AND ${t.parsedDeclareKindKind} IS NOT NULL AND ${t.storedAppliedAtKind} IS NOT NULL AND ${t.parsedAppliedAtKind} IS NOT NULL AND ${t.storedAwardBatchLabelKind} IS NOT NULL AND ${t.parsedAwardBatchLabelKind} IS NOT NULL AND ${t.storedYearKind} IS NOT NULL AND ${t.parsedYearKind} IS NOT NULL AND ${t.provinceConflict} IS NOT NULL AND ${t.statusConflict} IS NOT NULL AND ${t.batchConflict} IS NOT NULL AND ${t.declareKindConflict} IS NOT NULL AND ${t.appliedAtConflict} IS NOT NULL AND ${t.awardBatchLabelConflict} IS NOT NULL AND ${t.yearConflict} IS NOT NULL)`),
  check('platform_apply_projection_title_ck', sql`${t.sourceTitleKind} IS NULL OR (${t.sourceTitleKind} IN ('absent','null','array','object','invalid') AND ${t.sourceTitleText} IS NULL AND ${t.sourceTitleNumberText} IS NULL AND ${t.sourceTitleBoolean} IS NULL) OR (${t.sourceTitleKind} = 'text' AND typeof(${t.sourceTitleText}) = 'text' AND ${t.sourceTitleNumberText} IS NULL AND ${t.sourceTitleBoolean} IS NULL) OR (${t.sourceTitleKind} = 'number' AND typeof(${t.sourceTitleNumberText}) = 'text' AND length(${t.sourceTitleNumberText}) > 0 AND trim(${t.sourceTitleNumberText}) = ${t.sourceTitleNumberText} AND CASE WHEN json_valid(${t.sourceTitleNumberText}) THEN json_type(${t.sourceTitleNumberText}) IN ('integer','real') ELSE 0 END AND ${t.sourceTitleText} IS NULL AND ${t.sourceTitleBoolean} IS NULL) OR (${t.sourceTitleKind} = 'boolean' AND typeof(${t.sourceTitleBoolean}) = 'integer' AND ${t.sourceTitleBoolean} IN (0,1) AND ${t.sourceTitleText} IS NULL AND ${t.sourceTitleNumberText} IS NULL)`),
  check('platform_apply_projection_parse_ck', sql`${t.parseState} IS NULL OR (${t.parseState} IN ('valid','invalid','absent') AND ((${t.basis} = 'unavailable') = (${t.parseState} <> 'valid')))`),
  check('platform_apply_projection_rule_ck', sql`${t.sourceTitleRuleVersion} IS NULL OR (typeof(${t.sourceTitleRuleVersion}) = 'text' AND length(trim(${t.sourceTitleRuleVersion})) > 0)`),
  check('platform_apply_projection_stored_province_kind_ck', sql`${t.storedProvinceKind} IS NULL OR (${t.storedProvinceKind} IN ('absent','null','text','number','boolean','array','object','invalid') AND (${t.storedProvinceKind} NOT IN ('absent','null','array','object','invalid','boolean') OR ${t.storedProvince} IS NULL))`),
  check('platform_apply_projection_parsed_province_kind_ck', sql`${t.parsedProvinceKind} IS NULL OR (${t.parsedProvinceKind} IN ('absent','null','text','number','boolean','array','object','invalid') AND (${t.parsedProvinceKind} NOT IN ('absent','null','array','object','invalid','boolean') OR ${t.parsedProvince} IS NULL))`),
  check('platform_apply_projection_stored_province_ck', sql`${t.storedProvince} IS NULL OR (typeof(${t.storedProvince}) = 'text')`),
  check('platform_apply_projection_parsed_province_ck', sql`${t.parsedProvince} IS NULL OR (typeof(${t.parsedProvince}) = 'text')`),
  check('platform_apply_projection_reconciled_province_ck', sql`${t.reconciledProvince} IS NULL OR (typeof(${t.reconciledProvince}) = 'text')`),
  check('platform_apply_projection_province_reconcile_ck', sql`${t.observationId} IS NULL OR (typeof(${t.provinceConflict}) = 'integer' AND ${t.provinceConflict} = (${t.storedProvince} IS NOT NULL AND ${t.parsedProvince} IS NOT NULL AND ${t.storedProvince} <> ${t.parsedProvince}) AND ${t.reconciledProvince} IS (CASE WHEN ${t.provinceConflict} = 1 THEN NULL ELSE coalesce(${t.storedProvince},${t.parsedProvince}) END))`),
  check('platform_apply_projection_stored_status_kind_ck', sql`${t.storedStatusKind} IS NULL OR (${t.storedStatusKind} IN ('absent','null','text','number','boolean','array','object','invalid') AND (${t.storedStatusKind} NOT IN ('absent','null','array','object','invalid','boolean') OR ${t.storedStatus} IS NULL))`),
  check('platform_apply_projection_parsed_status_kind_ck', sql`${t.parsedStatusKind} IS NULL OR (${t.parsedStatusKind} IN ('absent','null','text','number','boolean','array','object','invalid') AND (${t.parsedStatusKind} NOT IN ('absent','null','array','object','invalid','boolean') OR ${t.parsedStatus} IS NULL))`),
  check('platform_apply_projection_stored_status_ck', sql`${t.storedStatus} IS NULL OR (typeof(${t.storedStatus}) = 'text')`),
  check('platform_apply_projection_parsed_status_ck', sql`${t.parsedStatus} IS NULL OR (typeof(${t.parsedStatus}) = 'text')`),
  check('platform_apply_projection_reconciled_status_ck', sql`${t.reconciledStatus} IS NULL OR (typeof(${t.reconciledStatus}) = 'text')`),
  check('platform_apply_projection_status_reconcile_ck', sql`${t.observationId} IS NULL OR (typeof(${t.statusConflict}) = 'integer' AND ${t.statusConflict} = (${t.storedStatus} IS NOT NULL AND ${t.parsedStatus} IS NOT NULL AND ${t.storedStatus} <> ${t.parsedStatus}) AND ${t.reconciledStatus} IS (CASE WHEN ${t.statusConflict} = 1 THEN NULL ELSE coalesce(${t.storedStatus},${t.parsedStatus}) END))`),
  check('platform_apply_projection_stored_batch_kind_ck', sql`${t.storedBatchKind} IS NULL OR (${t.storedBatchKind} IN ('absent','null','text','number','boolean','array','object','invalid') AND (${t.storedBatchKind} NOT IN ('absent','null','array','object','invalid','boolean') OR ${t.storedBatch} IS NULL))`),
  check('platform_apply_projection_parsed_batch_kind_ck', sql`${t.parsedBatchKind} IS NULL OR (${t.parsedBatchKind} IN ('absent','null','text','number','boolean','array','object','invalid') AND (${t.parsedBatchKind} NOT IN ('absent','null','array','object','invalid','boolean') OR ${t.parsedBatch} IS NULL))`),
  check('platform_apply_projection_stored_batch_ck', sql`${t.storedBatch} IS NULL OR (typeof(${t.storedBatch}) = 'text')`),
  check('platform_apply_projection_parsed_batch_ck', sql`${t.parsedBatch} IS NULL OR (typeof(${t.parsedBatch}) = 'text')`),
  check('platform_apply_projection_reconciled_batch_ck', sql`${t.reconciledBatch} IS NULL OR (typeof(${t.reconciledBatch}) = 'text')`),
  check('platform_apply_projection_batch_reconcile_ck', sql`${t.observationId} IS NULL OR (typeof(${t.batchConflict}) = 'integer' AND ${t.batchConflict} = (${t.storedBatch} IS NOT NULL AND ${t.parsedBatch} IS NOT NULL AND ${t.storedBatch} <> ${t.parsedBatch}) AND ${t.reconciledBatch} IS (CASE WHEN ${t.batchConflict} = 1 THEN NULL ELSE coalesce(${t.storedBatch},${t.parsedBatch}) END))`),
  check('platform_apply_projection_stored_declare_kind_kind_ck', sql`${t.storedDeclareKindKind} IS NULL OR (${t.storedDeclareKindKind} IN ('absent','null','text','number','boolean','array','object','invalid') AND (${t.storedDeclareKindKind} NOT IN ('absent','null','array','object','invalid','boolean') OR ${t.storedDeclareKind} IS NULL))`),
  check('platform_apply_projection_parsed_declare_kind_kind_ck', sql`${t.parsedDeclareKindKind} IS NULL OR (${t.parsedDeclareKindKind} IN ('absent','null','text','number','boolean','array','object','invalid') AND (${t.parsedDeclareKindKind} NOT IN ('absent','null','array','object','invalid','boolean') OR ${t.parsedDeclareKind} IS NULL))`),
  check('platform_apply_projection_stored_declare_kind_ck', sql`${t.storedDeclareKind} IS NULL OR (typeof(${t.storedDeclareKind}) = 'text')`),
  check('platform_apply_projection_parsed_declare_kind_ck', sql`${t.parsedDeclareKind} IS NULL OR (typeof(${t.parsedDeclareKind}) = 'text')`),
  check('platform_apply_projection_reconciled_declare_kind_ck', sql`${t.reconciledDeclareKind} IS NULL OR (typeof(${t.reconciledDeclareKind}) = 'text')`),
  check('platform_apply_projection_declare_kind_reconcile_ck', sql`${t.observationId} IS NULL OR (typeof(${t.declareKindConflict}) = 'integer' AND ${t.declareKindConflict} = (${t.storedDeclareKind} IS NOT NULL AND ${t.parsedDeclareKind} IS NOT NULL AND ${t.storedDeclareKind} <> ${t.parsedDeclareKind}) AND ${t.reconciledDeclareKind} IS (CASE WHEN ${t.declareKindConflict} = 1 THEN NULL ELSE coalesce(${t.storedDeclareKind},${t.parsedDeclareKind}) END))`),
  check('platform_apply_projection_stored_applied_at_kind_ck', sql`${t.storedAppliedAtKind} IS NULL OR (${t.storedAppliedAtKind} IN ('absent','null','text','number','boolean','array','object','invalid') AND (${t.storedAppliedAtKind} NOT IN ('absent','null','array','object','invalid','boolean') OR ${t.storedAppliedAt} IS NULL))`),
  check('platform_apply_projection_parsed_applied_at_kind_ck', sql`${t.parsedAppliedAtKind} IS NULL OR (${t.parsedAppliedAtKind} IN ('absent','null','text','number','boolean','array','object','invalid') AND (${t.parsedAppliedAtKind} NOT IN ('absent','null','array','object','invalid','boolean') OR ${t.parsedAppliedAt} IS NULL))`),
  check('platform_apply_projection_stored_applied_at_ck', sql`${t.storedAppliedAt} IS NULL OR (typeof(${t.storedAppliedAt}) = 'text')`),
  check('platform_apply_projection_parsed_applied_at_ck', sql`${t.parsedAppliedAt} IS NULL OR (typeof(${t.parsedAppliedAt}) = 'text')`),
  check('platform_apply_projection_reconciled_applied_at_ck', sql`${t.reconciledAppliedAt} IS NULL OR (typeof(${t.reconciledAppliedAt}) = 'text')`),
  check('platform_apply_projection_applied_at_reconcile_ck', sql`${t.observationId} IS NULL OR (typeof(${t.appliedAtConflict}) = 'integer' AND ${t.appliedAtConflict} = (${t.storedAppliedAt} IS NOT NULL AND ${t.parsedAppliedAt} IS NOT NULL AND ${t.storedAppliedAt} <> ${t.parsedAppliedAt}) AND ${t.reconciledAppliedAt} IS (CASE WHEN ${t.appliedAtConflict} = 1 THEN NULL ELSE coalesce(${t.storedAppliedAt},${t.parsedAppliedAt}) END))`),
  check('platform_apply_projection_stored_award_batch_label_kind_ck', sql`${t.storedAwardBatchLabelKind} IS NULL OR (${t.storedAwardBatchLabelKind} IN ('absent','null','text','number','boolean','array','object','invalid') AND (${t.storedAwardBatchLabelKind} NOT IN ('absent','null','array','object','invalid','boolean') OR ${t.storedAwardBatchLabel} IS NULL))`),
  check('platform_apply_projection_parsed_award_batch_label_kind_ck', sql`${t.parsedAwardBatchLabelKind} IS NULL OR (${t.parsedAwardBatchLabelKind} IN ('absent','null','text','number','boolean','array','object','invalid') AND (${t.parsedAwardBatchLabelKind} NOT IN ('absent','null','array','object','invalid','boolean') OR ${t.parsedAwardBatchLabel} IS NULL))`),
  check('platform_apply_projection_stored_award_batch_label_ck', sql`${t.storedAwardBatchLabel} IS NULL OR (typeof(${t.storedAwardBatchLabel}) = 'text')`),
  check('platform_apply_projection_parsed_award_batch_label_ck', sql`${t.parsedAwardBatchLabel} IS NULL OR (typeof(${t.parsedAwardBatchLabel}) = 'text')`),
  check('platform_apply_projection_reconciled_award_batch_label_ck', sql`${t.reconciledAwardBatchLabel} IS NULL OR (typeof(${t.reconciledAwardBatchLabel}) = 'text')`),
  check('platform_apply_projection_award_batch_label_reconcile_ck', sql`${t.observationId} IS NULL OR (typeof(${t.awardBatchLabelConflict}) = 'integer' AND ${t.awardBatchLabelConflict} = (${t.storedAwardBatchLabel} IS NOT NULL AND ${t.parsedAwardBatchLabel} IS NOT NULL AND ${t.storedAwardBatchLabel} <> ${t.parsedAwardBatchLabel}) AND ${t.reconciledAwardBatchLabel} IS (CASE WHEN ${t.awardBatchLabelConflict} = 1 THEN NULL ELSE coalesce(${t.storedAwardBatchLabel},${t.parsedAwardBatchLabel}) END))`),
  check('platform_apply_projection_stored_year_kind_ck', sql`${t.storedYearKind} IS NULL OR (${t.storedYearKind} IN ('absent','null','text','number','boolean','array','object','invalid') AND (${t.storedYearKind} NOT IN ('absent','null','array','object','invalid','boolean') OR ${t.storedYear} IS NULL))`),
  check('platform_apply_projection_parsed_year_kind_ck', sql`${t.parsedYearKind} IS NULL OR (${t.parsedYearKind} IN ('absent','null','text','number','boolean','array','object','invalid') AND (${t.parsedYearKind} NOT IN ('absent','null','array','object','invalid','boolean') OR ${t.parsedYear} IS NULL))`),
  check('platform_apply_projection_stored_year_ck', sql`${t.storedYear} IS NULL OR (typeof(${t.storedYear}) = 'integer' AND ${t.storedYear} BETWEEN -9007199254740991 AND 9007199254740991)`),
  check('platform_apply_projection_parsed_year_ck', sql`${t.parsedYear} IS NULL OR (typeof(${t.parsedYear}) = 'integer' AND ${t.parsedYear} BETWEEN -9007199254740991 AND 9007199254740991)`),
  check('platform_apply_projection_reconciled_year_ck', sql`${t.reconciledYear} IS NULL OR (typeof(${t.reconciledYear}) = 'integer' AND ${t.reconciledYear} BETWEEN -9007199254740991 AND 9007199254740991)`),
  check('platform_apply_projection_year_reconcile_ck', sql`${t.observationId} IS NULL OR (typeof(${t.yearConflict}) = 'integer' AND ${t.yearConflict} = (${t.storedYear} IS NOT NULL AND ${t.parsedYear} IS NOT NULL AND ${t.storedYear} <> ${t.parsedYear}) AND ${t.reconciledYear} IS (CASE WHEN ${t.yearConflict} = 1 THEN NULL ELSE coalesce(${t.storedYear},${t.parsedYear}) END))`),

  foreignKey({ columns: [t.versionId, t.recordId], foreignColumns: [platformBusinessRecordVersion.id, platformBusinessRecordVersion.recordId] }).onDelete('restrict'),
  index('platform_apply_projection_record_idx').on(t.recordId),
  index('platform_apply_projection_year_idx').on(t.declarationYear),
  index('platform_apply_projection_kind_idx').on(t.declareKind),
  index('platform_apply_projection_status_idx').on(t.status),
  index('platform_apply_projection_applied_idx').on(t.appliedAt),
  index('platform_apply_projection_uscc_idx').on(t.usccRaw),
  index('platform_apply_projection_title_version_idx').on(t.titleRaw, t.versionId),
])
}
export const platformApplyProjection = definePlatformApplyProjection(() => platformBusinessObservation.id)

/**
 * Source-specific typed projection for business_list (upstream businessList). One row
 * per immutable content version; the composite owner FK prevents a version/record
 * mismatch. Fields are copied from the archived raw row only (null when absent),
 * never inferred. Query title scope is not a row fact and is not stored here.
 */
export function businessProjectionFields(observationId: () => AnySQLiteColumn) { return {
  id: integer('id').primaryKey({ autoIncrement: true }),
  ...processStoredFields(),
  observationId: integer('observation_id').references(observationId, { onDelete: 'restrict' }),
  basis: text('basis', { enum: ['verified_raw', 'observation_reconciliation', 'unavailable'] }).notNull().default('verified_raw'),
  versionId: integer('version_id').references(() => platformBusinessRecordVersion.id, { onDelete: 'restrict' }),
  recordId: integer('record_id').references(() => platformBusinessRecord.id, { onDelete: 'restrict' }),
  /** Raw sblx after trimming; unknown dictionary values are retained. */
  declareKind: text('declare_kind'),
  /** Explicit positive decimal-integer source year only. */
  businessYear: integer('business_year'),
  /** Raw sqsj after trimming. */
  appliedAt: text('applied_at'),
  /** Raw cszt after trimming. */
  status: text('status'),
  /** Raw whpc (维护批次) after trimming. */
  batch: text('batch'),
  /** Raw personuuid (原认定批次标签) after trimming. */
  awardBatchLabel: text('award_batch_label'),
  /** Raw szsfmc (属地) after trimming. */
  province: text('province'),
  /** Raw row-level rdjb after trimming; never query title scope. */
  titleRaw: text('title_raw'),
  nameRaw: text('name_raw'),
  usccRaw: text('uscc_raw'),
  sourceTitleKind: text('source_title_kind', { enum: ['absent','null','text','number','boolean','array','object','invalid'] }),
  sourceTitleText: text('source_title_text'),
  sourceTitleNumberText: text('source_title_number_text'),
  sourceTitleBoolean: integer('source_title_boolean'),
  sourceTitleRuleVersion: text('source_title_rule_version'),
  sourceArchiveId: integer('source_archive_id').references(() => platformArchiveValue.id, { onDelete: 'restrict' }),
  parseState: text('parse_state', { enum: ['valid','invalid','absent'] }),
  storedProvinceKind: text('stored_province_kind', { enum: ['absent','null','text','number','boolean','array','object','invalid'] }),
  storedProvince: text('stored_province'),
  parsedProvinceKind: text('parsed_province_kind', { enum: ['absent','null','text','number','boolean','array','object','invalid'] }),
  parsedProvince: text('parsed_province'),
  reconciledProvince: text('reconciled_province'),
  provinceConflict: integer('province_conflict'),
  storedStatusKind: text('stored_status_kind', { enum: ['absent','null','text','number','boolean','array','object','invalid','blob'] }),
  storedStatus: businessStatusCell('stored_status'),
  parsedStatusKind: text('parsed_status_kind', { enum: ['absent','null','text','number','boolean','array','object','invalid'] }),
  parsedStatus: text('parsed_status'),
  reconciledStatus: businessStatusCell('reconciled_status'),
  statusConflict: integer('status_conflict'),
  storedBatchKind: text('stored_batch_kind', { enum: ['absent','null','text','number','boolean','array','object','invalid'] }),
  storedBatch: text('stored_batch'),
  parsedBatchKind: text('parsed_batch_kind', { enum: ['absent','null','text','number','boolean','array','object','invalid'] }),
  parsedBatch: text('parsed_batch'),
  reconciledBatch: text('reconciled_batch'),
  batchConflict: integer('batch_conflict'),
  storedDeclareKindKind: text('stored_declare_kind_kind', { enum: ['absent','null','text','number','boolean','array','object','invalid'] }),
  storedDeclareKind: text('stored_declare_kind'),
  parsedDeclareKindKind: text('parsed_declare_kind_kind', { enum: ['absent','null','text','number','boolean','array','object','invalid'] }),
  parsedDeclareKind: text('parsed_declare_kind'),
  reconciledDeclareKind: text('reconciled_declare_kind'),
  declareKindConflict: integer('declare_kind_conflict'),
  storedAppliedAtKind: text('stored_applied_at_kind', { enum: ['absent','null','text','number','boolean','array','object','invalid'] }),
  storedAppliedAt: text('stored_applied_at'),
  parsedAppliedAtKind: text('parsed_applied_at_kind', { enum: ['absent','null','text','number','boolean','array','object','invalid'] }),
  parsedAppliedAt: text('parsed_applied_at'),
  reconciledAppliedAt: text('reconciled_applied_at'),
  appliedAtConflict: integer('applied_at_conflict'),
  storedAwardBatchLabelKind: text('stored_award_batch_label_kind', { enum: ['absent','null','text','number','boolean','array','object','invalid'] }),
  storedAwardBatchLabel: text('stored_award_batch_label'),
  parsedAwardBatchLabelKind: text('parsed_award_batch_label_kind', { enum: ['absent','null','text','number','boolean','array','object','invalid'] }),
  parsedAwardBatchLabel: text('parsed_award_batch_label'),
  reconciledAwardBatchLabel: text('reconciled_award_batch_label'),
  awardBatchLabelConflict: integer('award_batch_label_conflict'),
  storedYearKind: text('stored_year_kind', { enum: ['absent','null','text','number','boolean','array','object','invalid'] }),
  storedYear: integer('stored_year'),
  parsedYearKind: text('parsed_year_kind', { enum: ['absent','null','text','number','boolean','array','object','invalid'] }),
  parsedYear: integer('parsed_year'),
  reconciledYear: integer('reconciled_year'),
  yearConflict: integer('year_conflict'),
  ruleVersion: text('rule_version').notNull(),
  createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
} }
export function definePlatformBusinessProjection(observationId: () => AnySQLiteColumn) { return sqliteTable('platform_business_projection', businessProjectionFields(observationId), t => [
  uniqueIndex('platform_business_projection_version_uq').on(t.versionId),
  uniqueIndex('platform_business_projection_observation_uq').on(t.observationId),
  index('platform_business_projection_source_archive_idx').on(t.sourceArchiveId),
  check('platform_business_projection_owner_ck', sql`( ${t.versionId} IS NOT NULL AND ${t.recordId} IS NOT NULL AND ${t.observationId} IS NULL AND ${t.basis} = 'verified_raw') OR (${t.versionId} IS NULL AND ${t.recordId} IS NULL AND ${t.observationId} IS NOT NULL AND ${t.basis} IN ('observation_reconciliation','unavailable'))`),
  check('platform_business_projection_id_ck', sql`${t.id} IS NULL OR (typeof(${t.id}) = 'integer' AND ${t.id} BETWEEN 1 AND 9007199254740991)`),
  check('platform_business_projection_version_id_ck', sql`${t.versionId} IS NULL OR (typeof(${t.versionId}) = 'integer' AND ${t.versionId} BETWEEN 1 AND 9007199254740991)`),
  check('platform_business_projection_record_id_ck', sql`${t.recordId} IS NULL OR (typeof(${t.recordId}) = 'integer' AND ${t.recordId} BETWEEN 1 AND 9007199254740991)`),
  check('platform_business_projection_observation_id_ck', sql`${t.observationId} IS NULL OR (typeof(${t.observationId}) = 'integer' AND ${t.observationId} BETWEEN 1 AND 9007199254740991)`),
  check('platform_business_projection_source_archive_id_ck', sql`${t.sourceArchiveId} IS NULL OR (typeof(${t.sourceArchiveId}) = 'integer' AND ${t.sourceArchiveId} BETWEEN 1 AND 9007199254740991)`),
  check('platform_business_projection_capture_ck', sql`(${t.observationId} IS NULL AND ${t.sourceTitleKind} IS NULL AND ${t.sourceTitleText} IS NULL AND ${t.sourceTitleNumberText} IS NULL AND ${t.sourceTitleBoolean} IS NULL AND ${t.sourceTitleRuleVersion} IS NULL AND ${t.sourceArchiveId} IS NULL AND ${t.parseState} IS NULL AND ${t.storedProvinceKind} IS NULL AND ${t.storedProvince} IS NULL AND ${t.parsedProvinceKind} IS NULL AND ${t.parsedProvince} IS NULL AND ${t.reconciledProvince} IS NULL AND ${t.provinceConflict} IS NULL AND ${t.storedStatusKind} IS NULL AND ${t.storedStatus} IS NULL AND ${t.parsedStatusKind} IS NULL AND ${t.parsedStatus} IS NULL AND ${t.reconciledStatus} IS NULL AND ${t.statusConflict} IS NULL AND ${t.storedBatchKind} IS NULL AND ${t.storedBatch} IS NULL AND ${t.parsedBatchKind} IS NULL AND ${t.parsedBatch} IS NULL AND ${t.reconciledBatch} IS NULL AND ${t.batchConflict} IS NULL AND ${t.storedDeclareKindKind} IS NULL AND ${t.storedDeclareKind} IS NULL AND ${t.parsedDeclareKindKind} IS NULL AND ${t.parsedDeclareKind} IS NULL AND ${t.reconciledDeclareKind} IS NULL AND ${t.declareKindConflict} IS NULL AND ${t.storedAppliedAtKind} IS NULL AND ${t.storedAppliedAt} IS NULL AND ${t.parsedAppliedAtKind} IS NULL AND ${t.parsedAppliedAt} IS NULL AND ${t.reconciledAppliedAt} IS NULL AND ${t.appliedAtConflict} IS NULL AND ${t.storedAwardBatchLabelKind} IS NULL AND ${t.storedAwardBatchLabel} IS NULL AND ${t.parsedAwardBatchLabelKind} IS NULL AND ${t.parsedAwardBatchLabel} IS NULL AND ${t.reconciledAwardBatchLabel} IS NULL AND ${t.awardBatchLabelConflict} IS NULL AND ${t.storedYearKind} IS NULL AND ${t.storedYear} IS NULL AND ${t.parsedYearKind} IS NULL AND ${t.parsedYear} IS NULL AND ${t.reconciledYear} IS NULL AND ${t.yearConflict} IS NULL) OR (${t.observationId} IS NOT NULL AND ${t.sourceTitleKind} IS NOT NULL AND ${t.sourceTitleRuleVersion} IS NOT NULL AND ${t.sourceArchiveId} IS NOT NULL AND ${t.parseState} IS NOT NULL AND ${t.storedProvinceKind} IS NOT NULL AND ${t.parsedProvinceKind} IS NOT NULL AND ${t.storedStatusKind} IS NOT NULL AND ${t.parsedStatusKind} IS NOT NULL AND ${t.storedBatchKind} IS NOT NULL AND ${t.parsedBatchKind} IS NOT NULL AND ${t.storedDeclareKindKind} IS NOT NULL AND ${t.parsedDeclareKindKind} IS NOT NULL AND ${t.storedAppliedAtKind} IS NOT NULL AND ${t.parsedAppliedAtKind} IS NOT NULL AND ${t.storedAwardBatchLabelKind} IS NOT NULL AND ${t.parsedAwardBatchLabelKind} IS NOT NULL AND ${t.storedYearKind} IS NOT NULL AND ${t.parsedYearKind} IS NOT NULL AND ${t.provinceConflict} IS NOT NULL AND ${t.statusConflict} IS NOT NULL AND ${t.batchConflict} IS NOT NULL AND ${t.declareKindConflict} IS NOT NULL AND ${t.appliedAtConflict} IS NOT NULL AND ${t.awardBatchLabelConflict} IS NOT NULL AND ${t.yearConflict} IS NOT NULL)`),
  check('platform_business_projection_title_ck', sql`${t.sourceTitleKind} IS NULL OR (${t.sourceTitleKind} IN ('absent','null','array','object','invalid') AND ${t.sourceTitleText} IS NULL AND ${t.sourceTitleNumberText} IS NULL AND ${t.sourceTitleBoolean} IS NULL) OR (${t.sourceTitleKind} = 'text' AND typeof(${t.sourceTitleText}) = 'text' AND ${t.sourceTitleNumberText} IS NULL AND ${t.sourceTitleBoolean} IS NULL) OR (${t.sourceTitleKind} = 'number' AND typeof(${t.sourceTitleNumberText}) = 'text' AND length(${t.sourceTitleNumberText}) > 0 AND trim(${t.sourceTitleNumberText}) = ${t.sourceTitleNumberText} AND CASE WHEN json_valid(${t.sourceTitleNumberText}) THEN json_type(${t.sourceTitleNumberText}) IN ('integer','real') ELSE 0 END AND ${t.sourceTitleText} IS NULL AND ${t.sourceTitleBoolean} IS NULL) OR (${t.sourceTitleKind} = 'boolean' AND typeof(${t.sourceTitleBoolean}) = 'integer' AND ${t.sourceTitleBoolean} IN (0,1) AND ${t.sourceTitleText} IS NULL AND ${t.sourceTitleNumberText} IS NULL)`),
  check('platform_business_projection_parse_ck', sql`${t.parseState} IS NULL OR (${t.parseState} IN ('valid','invalid','absent') AND ((${t.basis} = 'unavailable') = (${t.parseState} <> 'valid')))`),
  check('platform_business_projection_rule_ck', sql`${t.sourceTitleRuleVersion} IS NULL OR (typeof(${t.sourceTitleRuleVersion}) = 'text' AND length(trim(${t.sourceTitleRuleVersion})) > 0)`),
  check('platform_business_projection_stored_province_kind_ck', sql`${t.storedProvinceKind} IS NULL OR (${t.storedProvinceKind} IN ('absent','null','text','number','boolean','array','object','invalid') AND (${t.storedProvinceKind} NOT IN ('absent','null','array','object','invalid','boolean') OR ${t.storedProvince} IS NULL))`),
  check('platform_business_projection_parsed_province_kind_ck', sql`${t.parsedProvinceKind} IS NULL OR (${t.parsedProvinceKind} IN ('absent','null','text','number','boolean','array','object','invalid') AND (${t.parsedProvinceKind} NOT IN ('absent','null','array','object','invalid','boolean') OR ${t.parsedProvince} IS NULL))`),
  check('platform_business_projection_stored_province_ck', sql`${t.storedProvince} IS NULL OR (typeof(${t.storedProvince}) = 'text')`),
  check('platform_business_projection_parsed_province_ck', sql`${t.parsedProvince} IS NULL OR (typeof(${t.parsedProvince}) = 'text')`),
  check('platform_business_projection_reconciled_province_ck', sql`${t.reconciledProvince} IS NULL OR (typeof(${t.reconciledProvince}) = 'text')`),
  check('platform_business_projection_province_reconcile_ck', sql`${t.observationId} IS NULL OR (typeof(${t.provinceConflict}) = 'integer' AND ${t.provinceConflict} = (${t.storedProvince} IS NOT NULL AND ${t.parsedProvince} IS NOT NULL AND ${t.storedProvince} <> ${t.parsedProvince}) AND ${t.reconciledProvince} IS (CASE WHEN ${t.provinceConflict} = 1 THEN NULL ELSE coalesce(${t.storedProvince},${t.parsedProvince}) END))`),
  check('platform_business_projection_stored_status_kind_ck', sql.raw(businessStatusChecks.stored_status_kind_ck)),
  check('platform_business_projection_parsed_status_kind_ck', sql`${t.parsedStatusKind} IS NULL OR (${t.parsedStatusKind} IN ('absent','null','text','number','boolean','array','object','invalid') AND (${t.parsedStatusKind} NOT IN ('absent','null','array','object','invalid','boolean') OR ${t.parsedStatus} IS NULL))`),
  check('platform_business_projection_stored_status_ck', sql.raw(businessStatusChecks.stored_status_ck)),
  check('platform_business_projection_parsed_status_ck', sql`${t.parsedStatus} IS NULL OR (typeof(${t.parsedStatus}) = 'text')`),
  check('platform_business_projection_reconciled_status_ck', sql.raw(businessStatusChecks.reconciled_status_ck)),
  check('platform_business_projection_status_reconcile_ck', sql.raw(businessStatusChecks.status_reconcile_ck)),
  check('platform_business_projection_stored_batch_kind_ck', sql`${t.storedBatchKind} IS NULL OR (${t.storedBatchKind} IN ('absent','null','text','number','boolean','array','object','invalid') AND (${t.storedBatchKind} NOT IN ('absent','null','array','object','invalid','boolean') OR ${t.storedBatch} IS NULL))`),
  check('platform_business_projection_parsed_batch_kind_ck', sql`${t.parsedBatchKind} IS NULL OR (${t.parsedBatchKind} IN ('absent','null','text','number','boolean','array','object','invalid') AND (${t.parsedBatchKind} NOT IN ('absent','null','array','object','invalid','boolean') OR ${t.parsedBatch} IS NULL))`),
  check('platform_business_projection_stored_batch_ck', sql`${t.storedBatch} IS NULL OR (typeof(${t.storedBatch}) = 'text')`),
  check('platform_business_projection_parsed_batch_ck', sql`${t.parsedBatch} IS NULL OR (typeof(${t.parsedBatch}) = 'text')`),
  check('platform_business_projection_reconciled_batch_ck', sql`${t.reconciledBatch} IS NULL OR (typeof(${t.reconciledBatch}) = 'text')`),
  check('platform_business_projection_batch_reconcile_ck', sql`${t.observationId} IS NULL OR (typeof(${t.batchConflict}) = 'integer' AND ${t.batchConflict} = (${t.storedBatch} IS NOT NULL AND ${t.parsedBatch} IS NOT NULL AND ${t.storedBatch} <> ${t.parsedBatch}) AND ${t.reconciledBatch} IS (CASE WHEN ${t.batchConflict} = 1 THEN NULL ELSE coalesce(${t.storedBatch},${t.parsedBatch}) END))`),
  check('platform_business_projection_stored_declare_kind_kind_ck', sql`${t.storedDeclareKindKind} IS NULL OR (${t.storedDeclareKindKind} IN ('absent','null','text','number','boolean','array','object','invalid') AND (${t.storedDeclareKindKind} NOT IN ('absent','null','array','object','invalid','boolean') OR ${t.storedDeclareKind} IS NULL))`),
  check('platform_business_projection_parsed_declare_kind_kind_ck', sql`${t.parsedDeclareKindKind} IS NULL OR (${t.parsedDeclareKindKind} IN ('absent','null','text','number','boolean','array','object','invalid') AND (${t.parsedDeclareKindKind} NOT IN ('absent','null','array','object','invalid','boolean') OR ${t.parsedDeclareKind} IS NULL))`),
  check('platform_business_projection_stored_declare_kind_ck', sql`${t.storedDeclareKind} IS NULL OR (typeof(${t.storedDeclareKind}) = 'text')`),
  check('platform_business_projection_parsed_declare_kind_ck', sql`${t.parsedDeclareKind} IS NULL OR (typeof(${t.parsedDeclareKind}) = 'text')`),
  check('platform_business_projection_reconciled_declare_kind_ck', sql`${t.reconciledDeclareKind} IS NULL OR (typeof(${t.reconciledDeclareKind}) = 'text')`),
  check('platform_business_projection_declare_kind_reconcile_ck', sql`${t.observationId} IS NULL OR (typeof(${t.declareKindConflict}) = 'integer' AND ${t.declareKindConflict} = (${t.storedDeclareKind} IS NOT NULL AND ${t.parsedDeclareKind} IS NOT NULL AND ${t.storedDeclareKind} <> ${t.parsedDeclareKind}) AND ${t.reconciledDeclareKind} IS (CASE WHEN ${t.declareKindConflict} = 1 THEN NULL ELSE coalesce(${t.storedDeclareKind},${t.parsedDeclareKind}) END))`),
  check('platform_business_projection_stored_applied_at_kind_ck', sql`${t.storedAppliedAtKind} IS NULL OR (${t.storedAppliedAtKind} IN ('absent','null','text','number','boolean','array','object','invalid') AND (${t.storedAppliedAtKind} NOT IN ('absent','null','array','object','invalid','boolean') OR ${t.storedAppliedAt} IS NULL))`),
  check('platform_business_projection_parsed_applied_at_kind_ck', sql`${t.parsedAppliedAtKind} IS NULL OR (${t.parsedAppliedAtKind} IN ('absent','null','text','number','boolean','array','object','invalid') AND (${t.parsedAppliedAtKind} NOT IN ('absent','null','array','object','invalid','boolean') OR ${t.parsedAppliedAt} IS NULL))`),
  check('platform_business_projection_stored_applied_at_ck', sql`${t.storedAppliedAt} IS NULL OR (typeof(${t.storedAppliedAt}) = 'text')`),
  check('platform_business_projection_parsed_applied_at_ck', sql`${t.parsedAppliedAt} IS NULL OR (typeof(${t.parsedAppliedAt}) = 'text')`),
  check('platform_business_projection_reconciled_applied_at_ck', sql`${t.reconciledAppliedAt} IS NULL OR (typeof(${t.reconciledAppliedAt}) = 'text')`),
  check('platform_business_projection_applied_at_reconcile_ck', sql`${t.observationId} IS NULL OR (typeof(${t.appliedAtConflict}) = 'integer' AND ${t.appliedAtConflict} = (${t.storedAppliedAt} IS NOT NULL AND ${t.parsedAppliedAt} IS NOT NULL AND ${t.storedAppliedAt} <> ${t.parsedAppliedAt}) AND ${t.reconciledAppliedAt} IS (CASE WHEN ${t.appliedAtConflict} = 1 THEN NULL ELSE coalesce(${t.storedAppliedAt},${t.parsedAppliedAt}) END))`),
  check('platform_business_projection_stored_award_batch_label_kind_ck', sql`${t.storedAwardBatchLabelKind} IS NULL OR (${t.storedAwardBatchLabelKind} IN ('absent','null','text','number','boolean','array','object','invalid') AND (${t.storedAwardBatchLabelKind} NOT IN ('absent','null','array','object','invalid','boolean') OR ${t.storedAwardBatchLabel} IS NULL))`),
  check('platform_business_projection_parsed_award_batch_label_kind_ck', sql`${t.parsedAwardBatchLabelKind} IS NULL OR (${t.parsedAwardBatchLabelKind} IN ('absent','null','text','number','boolean','array','object','invalid') AND (${t.parsedAwardBatchLabelKind} NOT IN ('absent','null','array','object','invalid','boolean') OR ${t.parsedAwardBatchLabel} IS NULL))`),
  check('platform_business_projection_stored_award_batch_label_ck', sql`${t.storedAwardBatchLabel} IS NULL OR (typeof(${t.storedAwardBatchLabel}) = 'text')`),
  check('platform_business_projection_parsed_award_batch_label_ck', sql`${t.parsedAwardBatchLabel} IS NULL OR (typeof(${t.parsedAwardBatchLabel}) = 'text')`),
  check('platform_business_projection_reconciled_award_batch_label_ck', sql`${t.reconciledAwardBatchLabel} IS NULL OR (typeof(${t.reconciledAwardBatchLabel}) = 'text')`),
  check('platform_business_projection_award_batch_label_reconcile_ck', sql`${t.observationId} IS NULL OR (typeof(${t.awardBatchLabelConflict}) = 'integer' AND ${t.awardBatchLabelConflict} = (${t.storedAwardBatchLabel} IS NOT NULL AND ${t.parsedAwardBatchLabel} IS NOT NULL AND ${t.storedAwardBatchLabel} <> ${t.parsedAwardBatchLabel}) AND ${t.reconciledAwardBatchLabel} IS (CASE WHEN ${t.awardBatchLabelConflict} = 1 THEN NULL ELSE coalesce(${t.storedAwardBatchLabel},${t.parsedAwardBatchLabel}) END))`),
  check('platform_business_projection_stored_year_kind_ck', sql`${t.storedYearKind} IS NULL OR (${t.storedYearKind} IN ('absent','null','text','number','boolean','array','object','invalid') AND (${t.storedYearKind} NOT IN ('absent','null','array','object','invalid','boolean') OR ${t.storedYear} IS NULL))`),
  check('platform_business_projection_parsed_year_kind_ck', sql`${t.parsedYearKind} IS NULL OR (${t.parsedYearKind} IN ('absent','null','text','number','boolean','array','object','invalid') AND (${t.parsedYearKind} NOT IN ('absent','null','array','object','invalid','boolean') OR ${t.parsedYear} IS NULL))`),
  check('platform_business_projection_stored_year_ck', sql`${t.storedYear} IS NULL OR (typeof(${t.storedYear}) = 'integer' AND ${t.storedYear} BETWEEN -9007199254740991 AND 9007199254740991)`),
  check('platform_business_projection_parsed_year_ck', sql`${t.parsedYear} IS NULL OR (typeof(${t.parsedYear}) = 'integer' AND ${t.parsedYear} BETWEEN -9007199254740991 AND 9007199254740991)`),
  check('platform_business_projection_reconciled_year_ck', sql`${t.reconciledYear} IS NULL OR (typeof(${t.reconciledYear}) = 'integer' AND ${t.reconciledYear} BETWEEN -9007199254740991 AND 9007199254740991)`),
  check('platform_business_projection_year_reconcile_ck', sql`${t.observationId} IS NULL OR (typeof(${t.yearConflict}) = 'integer' AND ${t.yearConflict} = (${t.storedYear} IS NOT NULL AND ${t.parsedYear} IS NOT NULL AND ${t.storedYear} <> ${t.parsedYear}) AND ${t.reconciledYear} IS (CASE WHEN ${t.yearConflict} = 1 THEN NULL ELSE coalesce(${t.storedYear},${t.parsedYear}) END))`),

  foreignKey({ columns: [t.versionId, t.recordId], foreignColumns: [platformBusinessRecordVersion.id, platformBusinessRecordVersion.recordId] }).onDelete('restrict'),
  index('platform_business_projection_record_idx').on(t.recordId),
  index('platform_business_projection_year_idx').on(t.businessYear),
  index('platform_business_projection_kind_idx').on(t.declareKind),
  index('platform_business_projection_status_idx').on(t.status),
  index('platform_business_projection_batch_idx').on(t.batch),
  index('platform_business_projection_applied_idx').on(t.appliedAt),
  index('platform_business_projection_uscc_idx').on(t.usccRaw),
  index('platform_business_projection_title_version_idx').on(t.titleRaw, t.versionId),
])
}
export const platformBusinessProjection = definePlatformBusinessProjection(() => platformBusinessObservation.id)

/**
 * Source-specific typed projection for recognized_list (upstream queryBusList, 平台认定目录).
 * One row per immutable content version; the composite owner FK prevents a version/record
 * mismatch. Fields are copied from the archived raw row only (null when absent), never
 * inferred from query conditions, queriedAt, batch or name. Query title scope is not a row
 * fact and is not stored here; a row-level rdjb is retained verbatim as its own raw field.
 */
export function recognizedProjectionFields(observationId: () => AnySQLiteColumn) { return {
  id: integer('id').primaryKey({ autoIncrement: true }),
  exactTitleRaw: exactCell('exact_title_raw'),
  exactTitleState: text('exact_title_state', { enum: ['captured', 'uncaptured'] }),
  exactTitleOrigin: text('exact_title_origin', { enum: ['legacyRowSnapshot', 'commandInput'] }),
  exactTitleArchiveId: integer('exact_title_archive_id').references(() => platformArchiveValue.id, { onDelete: 'restrict' }),
  exactTitleSha256: text('exact_title_sha256'),
  observationId: integer('observation_id').references(observationId, { onDelete: 'restrict' }),
  basis: text('basis', { enum: ['verified_raw', 'observation_reconciliation', 'unavailable'] }).notNull().default('verified_raw'),
  versionId: integer('version_id').references(() => platformBusinessRecordVersion.id, { onDelete: 'restrict' }),
  recordId: integer('record_id').references(() => platformBusinessRecord.id, { onDelete: 'restrict' }),
  /** Raw rddqrq (有效期原值) after trimming; never parsed into a date or year. */
  validityDateRaw: text('validity_date_raw'),
  /** Explicit positive decimal-integer source whpcyear only. */
  maintenanceYear: integer('maintenance_year'),
  /** Raw whpc (维护批次) after trimming. */
  maintenanceBatch: text('maintenance_batch'),
  /** Untrimmed strings for qualification's existing exact grammar; nonstrings are null. */
  sourceRecognizedAt: text('source_recognized_at'),
  sourceValidFlag: exactCell('source_valid_flag'),
  sourceInvalidatedAt: text('source_invalidated_at'),
  sourceInvalidationReason: text('source_invalidation_reason'),
  sourceProvinceName: text('source_province_name'),
  sourceCityName: text('source_city_name'),
  sourceDistrictName: text('source_district_name'),
  qualificationFieldsRule: text('qualification_fields_rule'),
  sourceValidityDate: text('source_validity_date'),
  sourceMaintenanceBatch: text('source_maintenance_batch'),
  /** null = uncaptured; true = original whpcyear missing/null/exact empty string. */
  sourceMaintenanceYearAbsent: integer('source_maintenance_year_absent', { mode: 'boolean' }),
  /** Raw szq (属地) after trimming. */
  district: text('district'),
  /** Raw rdxx (平台认定说明) after trimming. */
  awardNote: text('award_note'),
  /** Raw row-level rdjb (平台称号原值) after trimming; never the query title scope. */
  titleRaw: text('title_raw'),
  nameRaw: text('name_raw'),
  usccRaw: text('uscc_raw'),
  sourceTitleKind: text('source_title_kind', { enum: ['absent','null','text','number','boolean','array','object','invalid'] }),
  sourceTitleText: text('source_title_text'),
  sourceTitleNumberText: text('source_title_number_text'),
  sourceTitleBoolean: integer('source_title_boolean'),
  sourceTitleRuleVersion: text('source_title_rule_version'),
  sourceArchiveId: integer('source_archive_id').references(() => platformArchiveValue.id, { onDelete: 'restrict' }),
  parseState: text('parse_state', { enum: ['valid','invalid','absent'] }),
  storedProvinceKind: text('stored_province_kind', { enum: ['absent','null','text','number','boolean','array','object','invalid'] }),
  storedProvince: text('stored_province'),
  parsedProvinceKind: text('parsed_province_kind', { enum: ['absent','null','text','number','boolean','array','object','invalid'] }),
  parsedProvince: text('parsed_province'),
  reconciledProvince: text('reconciled_province'),
  provinceConflict: integer('province_conflict'),
  storedStatusKind: text('stored_status_kind', { enum: ['absent','null','text','number','boolean','array','object','invalid'] }),
  storedStatus: text('stored_status'),
  parsedStatusKind: text('parsed_status_kind', { enum: ['absent','null','text','number','boolean','array','object','invalid'] }),
  parsedStatus: text('parsed_status'),
  reconciledStatus: text('reconciled_status'),
  statusConflict: integer('status_conflict'),
  storedBatchKind: text('stored_batch_kind', { enum: ['absent','null','text','number','boolean','array','object','invalid'] }),
  storedBatch: text('stored_batch'),
  parsedBatchKind: text('parsed_batch_kind', { enum: ['absent','null','text','number','boolean','array','object','invalid'] }),
  parsedBatch: text('parsed_batch'),
  reconciledBatch: text('reconciled_batch'),
  batchConflict: integer('batch_conflict'),
  storedDeclareKindKind: text('stored_declare_kind_kind', { enum: ['absent','null','text','number','boolean','array','object','invalid'] }),
  storedDeclareKind: text('stored_declare_kind'),
  parsedDeclareKindKind: text('parsed_declare_kind_kind', { enum: ['absent','null','text','number','boolean','array','object','invalid'] }),
  parsedDeclareKind: text('parsed_declare_kind'),
  reconciledDeclareKind: text('reconciled_declare_kind'),
  declareKindConflict: integer('declare_kind_conflict'),
  storedAppliedAtKind: text('stored_applied_at_kind', { enum: ['absent','null','text','number','boolean','array','object','invalid'] }),
  storedAppliedAt: text('stored_applied_at'),
  parsedAppliedAtKind: text('parsed_applied_at_kind', { enum: ['absent','null','text','number','boolean','array','object','invalid'] }),
  parsedAppliedAt: text('parsed_applied_at'),
  reconciledAppliedAt: text('reconciled_applied_at'),
  appliedAtConflict: integer('applied_at_conflict'),
  storedAwardBatchLabelKind: text('stored_award_batch_label_kind', { enum: ['absent','null','text','number','boolean','array','object','invalid'] }),
  storedAwardBatchLabel: text('stored_award_batch_label'),
  parsedAwardBatchLabelKind: text('parsed_award_batch_label_kind', { enum: ['absent','null','text','number','boolean','array','object','invalid'] }),
  parsedAwardBatchLabel: text('parsed_award_batch_label'),
  reconciledAwardBatchLabel: text('reconciled_award_batch_label'),
  awardBatchLabelConflict: integer('award_batch_label_conflict'),
  storedYearKind: text('stored_year_kind', { enum: ['absent','null','text','number','boolean','array','object','invalid'] }),
  storedYear: integer('stored_year'),
  parsedYearKind: text('parsed_year_kind', { enum: ['absent','null','text','number','boolean','array','object','invalid'] }),
  parsedYear: integer('parsed_year'),
  reconciledYear: integer('reconciled_year'),
  yearConflict: integer('year_conflict'),
  ruleVersion: text('rule_version').notNull(),
  createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
} }
export function definePlatformRecognizedProjection(observationId: () => AnySQLiteColumn) { return sqliteTable('platform_recognized_projection', recognizedProjectionFields(observationId), t => [
  uniqueIndex('platform_recognized_projection_version_uq').on(t.versionId),
  uniqueIndex('platform_recognized_projection_observation_uq').on(t.observationId),
  index('platform_recognized_projection_source_archive_idx').on(t.sourceArchiveId),
  check('platform_recognized_projection_owner_ck', sql`( ${t.versionId} IS NOT NULL AND ${t.recordId} IS NOT NULL AND ${t.observationId} IS NULL AND ${t.basis} = 'verified_raw') OR (${t.versionId} IS NULL AND ${t.recordId} IS NULL AND ${t.observationId} IS NOT NULL AND ${t.basis} IN ('observation_reconciliation','unavailable'))`),
  check('platform_recognized_projection_id_ck', sql`${t.id} IS NULL OR (typeof(${t.id}) = 'integer' AND ${t.id} BETWEEN 1 AND 9007199254740991)`),
  check('platform_recognized_projection_version_id_ck', sql`${t.versionId} IS NULL OR (typeof(${t.versionId}) = 'integer' AND ${t.versionId} BETWEEN 1 AND 9007199254740991)`),
  check('platform_recognized_projection_record_id_ck', sql`${t.recordId} IS NULL OR (typeof(${t.recordId}) = 'integer' AND ${t.recordId} BETWEEN 1 AND 9007199254740991)`),
  check('platform_recognized_projection_observation_id_ck', sql`${t.observationId} IS NULL OR (typeof(${t.observationId}) = 'integer' AND ${t.observationId} BETWEEN 1 AND 9007199254740991)`),
  check('platform_recognized_projection_source_archive_id_ck', sql`${t.sourceArchiveId} IS NULL OR (typeof(${t.sourceArchiveId}) = 'integer' AND ${t.sourceArchiveId} BETWEEN 1 AND 9007199254740991)`),
  check('platform_recognized_projection_capture_ck', sql`(${t.observationId} IS NULL AND ${t.sourceTitleKind} IS NULL AND ${t.sourceTitleText} IS NULL AND ${t.sourceTitleNumberText} IS NULL AND ${t.sourceTitleBoolean} IS NULL AND ${t.sourceTitleRuleVersion} IS NULL AND ${t.sourceArchiveId} IS NULL AND ${t.parseState} IS NULL AND ${t.storedProvinceKind} IS NULL AND ${t.storedProvince} IS NULL AND ${t.parsedProvinceKind} IS NULL AND ${t.parsedProvince} IS NULL AND ${t.reconciledProvince} IS NULL AND ${t.provinceConflict} IS NULL AND ${t.storedStatusKind} IS NULL AND ${t.storedStatus} IS NULL AND ${t.parsedStatusKind} IS NULL AND ${t.parsedStatus} IS NULL AND ${t.reconciledStatus} IS NULL AND ${t.statusConflict} IS NULL AND ${t.storedBatchKind} IS NULL AND ${t.storedBatch} IS NULL AND ${t.parsedBatchKind} IS NULL AND ${t.parsedBatch} IS NULL AND ${t.reconciledBatch} IS NULL AND ${t.batchConflict} IS NULL AND ${t.storedDeclareKindKind} IS NULL AND ${t.storedDeclareKind} IS NULL AND ${t.parsedDeclareKindKind} IS NULL AND ${t.parsedDeclareKind} IS NULL AND ${t.reconciledDeclareKind} IS NULL AND ${t.declareKindConflict} IS NULL AND ${t.storedAppliedAtKind} IS NULL AND ${t.storedAppliedAt} IS NULL AND ${t.parsedAppliedAtKind} IS NULL AND ${t.parsedAppliedAt} IS NULL AND ${t.reconciledAppliedAt} IS NULL AND ${t.appliedAtConflict} IS NULL AND ${t.storedAwardBatchLabelKind} IS NULL AND ${t.storedAwardBatchLabel} IS NULL AND ${t.parsedAwardBatchLabelKind} IS NULL AND ${t.parsedAwardBatchLabel} IS NULL AND ${t.reconciledAwardBatchLabel} IS NULL AND ${t.awardBatchLabelConflict} IS NULL AND ${t.storedYearKind} IS NULL AND ${t.storedYear} IS NULL AND ${t.parsedYearKind} IS NULL AND ${t.parsedYear} IS NULL AND ${t.reconciledYear} IS NULL AND ${t.yearConflict} IS NULL) OR (${t.observationId} IS NOT NULL AND ${t.sourceTitleKind} IS NOT NULL AND ${t.sourceTitleRuleVersion} IS NOT NULL AND ${t.sourceArchiveId} IS NOT NULL AND ${t.parseState} IS NOT NULL AND ${t.storedProvinceKind} IS NOT NULL AND ${t.parsedProvinceKind} IS NOT NULL AND ${t.storedStatusKind} IS NOT NULL AND ${t.parsedStatusKind} IS NOT NULL AND ${t.storedBatchKind} IS NOT NULL AND ${t.parsedBatchKind} IS NOT NULL AND ${t.storedDeclareKindKind} IS NOT NULL AND ${t.parsedDeclareKindKind} IS NOT NULL AND ${t.storedAppliedAtKind} IS NOT NULL AND ${t.parsedAppliedAtKind} IS NOT NULL AND ${t.storedAwardBatchLabelKind} IS NOT NULL AND ${t.parsedAwardBatchLabelKind} IS NOT NULL AND ${t.storedYearKind} IS NOT NULL AND ${t.parsedYearKind} IS NOT NULL AND ${t.provinceConflict} IS NOT NULL AND ${t.statusConflict} IS NOT NULL AND ${t.batchConflict} IS NOT NULL AND ${t.declareKindConflict} IS NOT NULL AND ${t.appliedAtConflict} IS NOT NULL AND ${t.awardBatchLabelConflict} IS NOT NULL AND ${t.yearConflict} IS NOT NULL)`),
  check('platform_recognized_projection_title_ck', sql`${t.sourceTitleKind} IS NULL OR (${t.sourceTitleKind} IN ('absent','null','array','object','invalid') AND ${t.sourceTitleText} IS NULL AND ${t.sourceTitleNumberText} IS NULL AND ${t.sourceTitleBoolean} IS NULL) OR (${t.sourceTitleKind} = 'text' AND typeof(${t.sourceTitleText}) = 'text' AND ${t.sourceTitleNumberText} IS NULL AND ${t.sourceTitleBoolean} IS NULL) OR (${t.sourceTitleKind} = 'number' AND typeof(${t.sourceTitleNumberText}) = 'text' AND length(${t.sourceTitleNumberText}) > 0 AND trim(${t.sourceTitleNumberText}) = ${t.sourceTitleNumberText} AND CASE WHEN json_valid(${t.sourceTitleNumberText}) THEN json_type(${t.sourceTitleNumberText}) IN ('integer','real') ELSE 0 END AND ${t.sourceTitleText} IS NULL AND ${t.sourceTitleBoolean} IS NULL) OR (${t.sourceTitleKind} = 'boolean' AND typeof(${t.sourceTitleBoolean}) = 'integer' AND ${t.sourceTitleBoolean} IN (0,1) AND ${t.sourceTitleText} IS NULL AND ${t.sourceTitleNumberText} IS NULL)`),
  check('platform_recognized_projection_parse_ck', sql`${t.parseState} IS NULL OR (${t.parseState} IN ('valid','invalid','absent') AND ((${t.basis} = 'unavailable') = (${t.parseState} <> 'valid')))`),
  check('platform_recognized_projection_rule_ck', sql`${t.sourceTitleRuleVersion} IS NULL OR (typeof(${t.sourceTitleRuleVersion}) = 'text' AND length(trim(${t.sourceTitleRuleVersion})) > 0)`),
  check('platform_recognized_projection_stored_province_kind_ck', sql`${t.storedProvinceKind} IS NULL OR (${t.storedProvinceKind} IN ('absent','null','text','number','boolean','array','object','invalid') AND (${t.storedProvinceKind} NOT IN ('absent','null','array','object','invalid','boolean') OR ${t.storedProvince} IS NULL))`),
  check('platform_recognized_projection_parsed_province_kind_ck', sql`${t.parsedProvinceKind} IS NULL OR (${t.parsedProvinceKind} IN ('absent','null','text','number','boolean','array','object','invalid') AND (${t.parsedProvinceKind} NOT IN ('absent','null','array','object','invalid','boolean') OR ${t.parsedProvince} IS NULL))`),
  check('platform_recognized_projection_stored_province_ck', sql`${t.storedProvince} IS NULL OR (typeof(${t.storedProvince}) = 'text')`),
  check('platform_recognized_projection_parsed_province_ck', sql`${t.parsedProvince} IS NULL OR (typeof(${t.parsedProvince}) = 'text')`),
  check('platform_recognized_projection_reconciled_province_ck', sql`${t.reconciledProvince} IS NULL OR (typeof(${t.reconciledProvince}) = 'text')`),
  check('platform_recognized_projection_province_reconcile_ck', sql`${t.observationId} IS NULL OR (typeof(${t.provinceConflict}) = 'integer' AND ${t.provinceConflict} = (${t.storedProvince} IS NOT NULL AND ${t.parsedProvince} IS NOT NULL AND ${t.storedProvince} <> ${t.parsedProvince}) AND ${t.reconciledProvince} IS (CASE WHEN ${t.provinceConflict} = 1 THEN NULL ELSE coalesce(${t.storedProvince},${t.parsedProvince}) END))`),
  check('platform_recognized_projection_stored_status_kind_ck', sql`${t.storedStatusKind} IS NULL OR (${t.storedStatusKind} IN ('absent','null','text','number','boolean','array','object','invalid') AND (${t.storedStatusKind} NOT IN ('absent','null','array','object','invalid','boolean') OR ${t.storedStatus} IS NULL))`),
  check('platform_recognized_projection_parsed_status_kind_ck', sql`${t.parsedStatusKind} IS NULL OR (${t.parsedStatusKind} IN ('absent','null','text','number','boolean','array','object','invalid') AND (${t.parsedStatusKind} NOT IN ('absent','null','array','object','invalid','boolean') OR ${t.parsedStatus} IS NULL))`),
  check('platform_recognized_projection_stored_status_ck', sql`${t.storedStatus} IS NULL OR (typeof(${t.storedStatus}) = 'text')`),
  check('platform_recognized_projection_parsed_status_ck', sql`${t.parsedStatus} IS NULL OR (typeof(${t.parsedStatus}) = 'text')`),
  check('platform_recognized_projection_reconciled_status_ck', sql`${t.reconciledStatus} IS NULL OR (typeof(${t.reconciledStatus}) = 'text')`),
  check('platform_recognized_projection_status_reconcile_ck', sql`${t.observationId} IS NULL OR (typeof(${t.statusConflict}) = 'integer' AND ${t.statusConflict} = (${t.storedStatus} IS NOT NULL AND ${t.parsedStatus} IS NOT NULL AND ${t.storedStatus} <> ${t.parsedStatus}) AND ${t.reconciledStatus} IS (CASE WHEN ${t.statusConflict} = 1 THEN NULL ELSE coalesce(${t.storedStatus},${t.parsedStatus}) END))`),
  check('platform_recognized_projection_stored_batch_kind_ck', sql`${t.storedBatchKind} IS NULL OR (${t.storedBatchKind} IN ('absent','null','text','number','boolean','array','object','invalid') AND (${t.storedBatchKind} NOT IN ('absent','null','array','object','invalid','boolean') OR ${t.storedBatch} IS NULL))`),
  check('platform_recognized_projection_parsed_batch_kind_ck', sql`${t.parsedBatchKind} IS NULL OR (${t.parsedBatchKind} IN ('absent','null','text','number','boolean','array','object','invalid') AND (${t.parsedBatchKind} NOT IN ('absent','null','array','object','invalid','boolean') OR ${t.parsedBatch} IS NULL))`),
  check('platform_recognized_projection_stored_batch_ck', sql`${t.storedBatch} IS NULL OR (typeof(${t.storedBatch}) = 'text')`),
  check('platform_recognized_projection_parsed_batch_ck', sql`${t.parsedBatch} IS NULL OR (typeof(${t.parsedBatch}) = 'text')`),
  check('platform_recognized_projection_reconciled_batch_ck', sql`${t.reconciledBatch} IS NULL OR (typeof(${t.reconciledBatch}) = 'text')`),
  check('platform_recognized_projection_batch_reconcile_ck', sql`${t.observationId} IS NULL OR (typeof(${t.batchConflict}) = 'integer' AND ${t.batchConflict} = (${t.storedBatch} IS NOT NULL AND ${t.parsedBatch} IS NOT NULL AND ${t.storedBatch} <> ${t.parsedBatch}) AND ${t.reconciledBatch} IS (CASE WHEN ${t.batchConflict} = 1 THEN NULL ELSE coalesce(${t.storedBatch},${t.parsedBatch}) END))`),
  check('platform_recognized_projection_stored_declare_kind_kind_ck', sql`${t.storedDeclareKindKind} IS NULL OR (${t.storedDeclareKindKind} IN ('absent','null','text','number','boolean','array','object','invalid') AND (${t.storedDeclareKindKind} NOT IN ('absent','null','array','object','invalid','boolean') OR ${t.storedDeclareKind} IS NULL))`),
  check('platform_recognized_projection_parsed_declare_kind_kind_ck', sql`${t.parsedDeclareKindKind} IS NULL OR (${t.parsedDeclareKindKind} IN ('absent','null','text','number','boolean','array','object','invalid') AND (${t.parsedDeclareKindKind} NOT IN ('absent','null','array','object','invalid','boolean') OR ${t.parsedDeclareKind} IS NULL))`),
  check('platform_recognized_projection_stored_declare_kind_ck', sql`${t.storedDeclareKind} IS NULL OR (typeof(${t.storedDeclareKind}) = 'text')`),
  check('platform_recognized_projection_parsed_declare_kind_ck', sql`${t.parsedDeclareKind} IS NULL OR (typeof(${t.parsedDeclareKind}) = 'text')`),
  check('platform_recognized_projection_reconciled_declare_kind_ck', sql`${t.reconciledDeclareKind} IS NULL OR (typeof(${t.reconciledDeclareKind}) = 'text')`),
  check('platform_recognized_projection_declare_kind_reconcile_ck', sql`${t.observationId} IS NULL OR (typeof(${t.declareKindConflict}) = 'integer' AND ${t.declareKindConflict} = (${t.storedDeclareKind} IS NOT NULL AND ${t.parsedDeclareKind} IS NOT NULL AND ${t.storedDeclareKind} <> ${t.parsedDeclareKind}) AND ${t.reconciledDeclareKind} IS (CASE WHEN ${t.declareKindConflict} = 1 THEN NULL ELSE coalesce(${t.storedDeclareKind},${t.parsedDeclareKind}) END))`),
  check('platform_recognized_projection_stored_applied_at_kind_ck', sql`${t.storedAppliedAtKind} IS NULL OR (${t.storedAppliedAtKind} IN ('absent','null','text','number','boolean','array','object','invalid') AND (${t.storedAppliedAtKind} NOT IN ('absent','null','array','object','invalid','boolean') OR ${t.storedAppliedAt} IS NULL))`),
  check('platform_recognized_projection_parsed_applied_at_kind_ck', sql`${t.parsedAppliedAtKind} IS NULL OR (${t.parsedAppliedAtKind} IN ('absent','null','text','number','boolean','array','object','invalid') AND (${t.parsedAppliedAtKind} NOT IN ('absent','null','array','object','invalid','boolean') OR ${t.parsedAppliedAt} IS NULL))`),
  check('platform_recognized_projection_stored_applied_at_ck', sql`${t.storedAppliedAt} IS NULL OR (typeof(${t.storedAppliedAt}) = 'text')`),
  check('platform_recognized_projection_parsed_applied_at_ck', sql`${t.parsedAppliedAt} IS NULL OR (typeof(${t.parsedAppliedAt}) = 'text')`),
  check('platform_recognized_projection_reconciled_applied_at_ck', sql`${t.reconciledAppliedAt} IS NULL OR (typeof(${t.reconciledAppliedAt}) = 'text')`),
  check('platform_recognized_projection_applied_at_reconcile_ck', sql`${t.observationId} IS NULL OR (typeof(${t.appliedAtConflict}) = 'integer' AND ${t.appliedAtConflict} = (${t.storedAppliedAt} IS NOT NULL AND ${t.parsedAppliedAt} IS NOT NULL AND ${t.storedAppliedAt} <> ${t.parsedAppliedAt}) AND ${t.reconciledAppliedAt} IS (CASE WHEN ${t.appliedAtConflict} = 1 THEN NULL ELSE coalesce(${t.storedAppliedAt},${t.parsedAppliedAt}) END))`),
  check('platform_recognized_projection_stored_award_batch_label_kind_ck', sql`${t.storedAwardBatchLabelKind} IS NULL OR (${t.storedAwardBatchLabelKind} IN ('absent','null','text','number','boolean','array','object','invalid') AND (${t.storedAwardBatchLabelKind} NOT IN ('absent','null','array','object','invalid','boolean') OR ${t.storedAwardBatchLabel} IS NULL))`),
  check('platform_recognized_projection_parsed_award_batch_label_kind_ck', sql`${t.parsedAwardBatchLabelKind} IS NULL OR (${t.parsedAwardBatchLabelKind} IN ('absent','null','text','number','boolean','array','object','invalid') AND (${t.parsedAwardBatchLabelKind} NOT IN ('absent','null','array','object','invalid','boolean') OR ${t.parsedAwardBatchLabel} IS NULL))`),
  check('platform_recognized_projection_stored_award_batch_label_ck', sql`${t.storedAwardBatchLabel} IS NULL OR (typeof(${t.storedAwardBatchLabel}) = 'text')`),
  check('platform_recognized_projection_parsed_award_batch_label_ck', sql`${t.parsedAwardBatchLabel} IS NULL OR (typeof(${t.parsedAwardBatchLabel}) = 'text')`),
  check('platform_recognized_projection_reconciled_award_batch_label_ck', sql`${t.reconciledAwardBatchLabel} IS NULL OR (typeof(${t.reconciledAwardBatchLabel}) = 'text')`),
  check('platform_recognized_projection_award_batch_label_reconcile_ck', sql`${t.observationId} IS NULL OR (typeof(${t.awardBatchLabelConflict}) = 'integer' AND ${t.awardBatchLabelConflict} = (${t.storedAwardBatchLabel} IS NOT NULL AND ${t.parsedAwardBatchLabel} IS NOT NULL AND ${t.storedAwardBatchLabel} <> ${t.parsedAwardBatchLabel}) AND ${t.reconciledAwardBatchLabel} IS (CASE WHEN ${t.awardBatchLabelConflict} = 1 THEN NULL ELSE coalesce(${t.storedAwardBatchLabel},${t.parsedAwardBatchLabel}) END))`),
  check('platform_recognized_projection_stored_year_kind_ck', sql`${t.storedYearKind} IS NULL OR (${t.storedYearKind} IN ('absent','null','text','number','boolean','array','object','invalid') AND (${t.storedYearKind} NOT IN ('absent','null','array','object','invalid','boolean') OR ${t.storedYear} IS NULL))`),
  check('platform_recognized_projection_parsed_year_kind_ck', sql`${t.parsedYearKind} IS NULL OR (${t.parsedYearKind} IN ('absent','null','text','number','boolean','array','object','invalid') AND (${t.parsedYearKind} NOT IN ('absent','null','array','object','invalid','boolean') OR ${t.parsedYear} IS NULL))`),
  check('platform_recognized_projection_stored_year_ck', sql`${t.storedYear} IS NULL OR (typeof(${t.storedYear}) = 'integer' AND ${t.storedYear} BETWEEN -9007199254740991 AND 9007199254740991)`),
  check('platform_recognized_projection_parsed_year_ck', sql`${t.parsedYear} IS NULL OR (typeof(${t.parsedYear}) = 'integer' AND ${t.parsedYear} BETWEEN -9007199254740991 AND 9007199254740991)`),
  check('platform_recognized_projection_reconciled_year_ck', sql`${t.reconciledYear} IS NULL OR (typeof(${t.reconciledYear}) = 'integer' AND ${t.reconciledYear} BETWEEN -9007199254740991 AND 9007199254740991)`),
  check('platform_recognized_projection_year_reconcile_ck', sql`${t.observationId} IS NULL OR (typeof(${t.yearConflict}) = 'integer' AND ${t.yearConflict} = (${t.storedYear} IS NOT NULL AND ${t.parsedYear} IS NOT NULL AND ${t.storedYear} <> ${t.parsedYear}) AND ${t.reconciledYear} IS (CASE WHEN ${t.yearConflict} = 1 THEN NULL ELSE coalesce(${t.storedYear},${t.parsedYear}) END))`),
  check('platform_recognized_projection_no_process_parse_ck', sql`${t.observationId} IS NULL OR ${t.parsedProvince} IS NULL AND ${t.parsedProvinceKind} = 'absent' AND ${t.parsedStatus} IS NULL AND ${t.parsedStatusKind} = 'absent' AND ${t.parsedBatch} IS NULL AND ${t.parsedBatchKind} = 'absent' AND ${t.parsedDeclareKind} IS NULL AND ${t.parsedDeclareKindKind} = 'absent' AND ${t.parsedAppliedAt} IS NULL AND ${t.parsedAppliedAtKind} = 'absent' AND ${t.parsedAwardBatchLabel} IS NULL AND ${t.parsedAwardBatchLabelKind} = 'absent' AND ${t.parsedYear} IS NULL AND ${t.parsedYearKind} = 'absent'`),

  foreignKey({ columns: [t.versionId, t.recordId], foreignColumns: [platformBusinessRecordVersion.id, platformBusinessRecordVersion.recordId] }).onDelete('restrict'),
  index('platform_recognized_projection_record_idx').on(t.recordId),
  index('platform_recognized_projection_validity_idx').on(t.validityDateRaw),
  index('platform_recognized_projection_year_idx').on(t.maintenanceYear),
  index('platform_recognized_projection_batch_idx').on(t.maintenanceBatch),
  index('platform_recognized_projection_district_idx').on(t.district),
  index('platform_recognized_projection_title_idx').on(t.titleRaw),
  index('platform_recognized_projection_title_version_idx').on(t.titleRaw, t.versionId),
  index('platform_recognized_projection_uscc_idx').on(t.usccRaw),
  check('platform_recognized_projection_fidelity_ck', sql`((${t.sourceMaintenanceYearAbsent} IS NULL OR (typeof(${t.sourceMaintenanceYearAbsent}) = 'integer' AND ${t.sourceMaintenanceYearAbsent} IN (0,1))) AND (${t.observationId} IS NULL OR ((${t.sourceValidityDate} IS NULL OR typeof(${t.sourceValidityDate}) = 'text') AND (${t.sourceMaintenanceBatch} IS NULL OR typeof(${t.sourceMaintenanceBatch}) = 'text'))))`),
])
}
export const platformRecognizedProjection = definePlatformRecognizedProjection(() => platformBusinessObservation.id)

/**
 * **差异原因与后续措施**(契约 4)——**成对**记录的一行。
 *
 * 一行 = 「这家企业 × 这个称号 × 这个方向的差异」在**某个时点**的解释:
 * 原因(`reasonCode`)+ 证据(`evidenceQueryId` / `evidenceRelationId`)+ 核验状态
 * (`verificationStatus`)+ **对应的后续措施**(`measureCode` / `measureNote`)+ 时间
 * (`recordedAt`)。**原因与措施成对出现**,不留「有原因没措施」的半截记录。
 *
 * ── 状态机(`status`)的取值必须彼此可区分 ────────────────────────────────
 *   `not_queried` 未查询 / `query_failed` 查询失败 / `no_record` 无记录 /
 *   `confirmed_no_diff` 已确认无差异 / `confirmed_reason` 已确认原因 /
 *   `needs_review` 待核实。
 * 契约硬要求前五个里 `未查询/失败/无记录/已确认无差异` 四个**互不等价**;
 * `confirmed_reason` 是承载「外迁/注销/更名/平台未更新/迁入」这五类已确认原因的第 6 个取值
 * (见 ADR 的待裁决点)。
 *
 * ── 已知原因 ──────────────────────────────────────────────────────────────
 * `moved_out` 外迁 / `deregistered` 注销 / `renamed` 更名 / `platform_stale` 平台未更新 /
 * `pending_review` 待审核 / `moved_in` 迁入 / `other` 其他(可凭证据扩展 —— `reasonNote` 记新原因的说明)。
 * 迁入另承载 `movedInCity` / `movedInTitleCode` / `movedInYear` / `movedInBatch`
 * (缺项**留空待核,不猜填**)。
 *
 * ── 时态化 ────────────────────────────────────────────────────────────────
 * 唯一键含 `recordedAt`:**旧解释不丢**,新解释形成新行;「当前解释」= `recordedAt` 最新那条。
 */
/** Shared decision fields; explicit target changes only the physical evidence FKs. */
export function differenceReasonFields() { return {
    id: integer('id').primaryKey({ autoIncrement: true }),
    enterpriseId: integer('enterprise_id')
      .notNull()
      .references(() => enterprise.id, { onDelete: 'cascade' }),
    titleCode: text('title_code')
      .notNull()
      .references(() => title.code),
    /** 差异方向,与 `layers/sme-roster/lib/comparison.ts` 的 `COMPARISON_DIRECTIONS` 同值。 */
    direction: text('direction', {
      enum: ['missing_in_miit', 'extra_in_miit'],
    }).notNull(),
    /** 状态机取值,见上。默认 `not_queried`(「还没查」而不是「没有」)。 */
    status: text('status', {
      enum: [
        'not_queried',
        'query_failed',
        'no_record',
        'confirmed_no_diff',
        'confirmed_reason',
        'needs_review',
      ],
    })
      .notNull()
      .default('not_queried'),
    /** 已知原因;`needs_review` / `confirmed_no_diff` 时可为空。 */
    reasonCode: text('reason_code', {
      enum: ['moved_out', 'deregistered', 'renamed', 'platform_stale', 'pending_review', 'moved_in', 'other'],
    }),
    /** 原因的说明(新原因在这里写清,并配 `other`)。 */
    reasonNote: text('reason_note'),
    /** 与原因**成对**的后续措施。 */
    measureCode: text('measure_code', {
      enum: [
        'keep_history',
        'mark_platform_snapshot',
        'follow_review',
        'mark_moved_out',
        'mark_deregistered',
        'update_current_name',
        'record_moved_in',
        'manual_review',
        'none',
      ],
    }),
    measureNote: text('measure_note'),
    /** 迁入承载:原城市 / 原称号 / 年份 / 批次。缺项留空待核。 */
    movedInCity: text('moved_in_city'),
    movedInTitleCode: text('moved_in_title_code').references(() => title.code),
    movedInYear: integer('moved_in_year'),
    movedInBatch: integer('moved_in_batch'),
    factReferences: text('fact_references', { mode: 'json' }).$type<{ enterpriseId: number; factId: number; revision: number; kind: string }[]>(),
    /** Explicit reviewed qualification; migration alone never supplies it. */
    currentQualification: text('current_qualification', { mode: 'json' }).$type<{ titleCode: string; validFrom: string; validUntil: string; basis: string; publicationCheck: { status: 'not_found' | 'not_checked'; scope: string } }>(),
    /** 核验状态:`confirmed` 已确认 / `pending` 待核实。 */
    verificationStatus: text('verification_status', { enum: ['confirmed', 'pending'] })
      .notNull()
      .default('pending'),
    /** 该解释的登记时点(时态化的排序键)。 */
    recordedAt: text('recorded_at').notNull(),
    /** #102: explicit lifecycle metadata; null denotes a historical import, never an inferred decision. */
    lifecycleAction: text('lifecycle_action', { enum: ['replace', 'withdraw'] }),
    /** #108: a browser review genuinely has no recorded actor; null is not a placeholder identity. */
    actor: text('actor', { mode: 'json' }).$type<{ type: 'user' | 'agent'; id: string } | null>(),
    basis: text('basis'),
    ruleVersion: text('rule_version'),
    effectiveAt: text('effective_at'),
    idempotencyKey: text('idempotency_key'),
    requestHash: text('request_hash'),
    createdAt: text('created_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
} }
export const differenceReason = sqliteTable(
  'difference_reason',
  {
    ...differenceReasonFields(),
    /** 证据:平台查询记录 / 平台关系记录。 */
    evidenceCollectionId: integer('evidence_query_id').references(() => platformCollection.id),
    evidenceObservationId: integer('evidence_relation_id').references(() => platformBusinessObservation.id),
    previousId: integer('previous_id').references((): AnySQLiteColumn => differenceReason.id),
  },
  (t) => [
    // 同企业 × 称号 × 方向 × 时点唯一:时点不同 → 并存(旧解释不丢)。
    uniqueIndex('difference_reason_version_uq').on(
      t.enterpriseId,
      t.titleCode,
      t.direction,
      t.recordedAt,
    ),
    uniqueIndex('difference_reason_command_uq').on(t.idempotencyKey),
    index('difference_reason_managed_idx').on(t.enterpriseId, t.titleCode, t.direction).where(sql`${t.lifecycleAction} is not null`),
    index('difference_reason_lookup_idx').on(t.enterpriseId, t.titleCode, t.direction),
    index('difference_reason_impact_head_113_idx').on(t.enterpriseId, t.titleCode, t.direction, t.recordedAt, t.id),
    index('difference_reason_impact_title_113_idx').on(t.titleCode, t.id),
  ],
)

/**
 * **平台导出快照批次**(契约 5·批次身份)。三张工信部导出表**每次采集**的元数据。
 *
 * **不是**公布历史:它记的是「某年某天,某张导出表长这样」。与公布称号事件
 * (`record` / `record_event`)**分开存储、分开查询** —— 平台绝不能改写公布历史。
 *
 *  - **同文件重放幂等**:唯一键 `(title_code, year, sha256)` —— 同一份内容重放不会
 *    多出一批;
 *  - **替换文件形成可区分的新版本**:换了内容 ⇒ `sha256` 变 ⇒ 新的一批;`replacedBatchId`
 *    记下「它替换了哪一批」,两版**并存**(旧快照不因替换而消失,否则失去对照基线);
 *  - `collectedOn` 是**采集日期**、`year` 是**年度**,`rowCount` 是行数,
 *    `importStatus` 记导入状态,`sourceDocumentId` / `importBatchId` 指向来源与批次。
 */
export const platformExportBatch = sqliteTable(
  'platform_export_batch',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    titleCode: text('title_code')
      .notNull()
      .references(() => title.code),
    /** 快照所属年度。 */
    year: integer('year').notNull(),
    /** 采集日期(YYYY-MM-DD)。 */
    collectedOn: text('collected_on').notNull(),
    /** 原文件名。 */
    originalFilename: text('original_filename').notNull(),
    /** 文件内容 SHA-256(版本身份)。 */
    sha256: text('sha256').notNull(),
    /** 快照行数。 */
    rowCount: integer('row_count').notNull().default(0),
    /** 导入状态:`pending` 待导入 / `imported` 已导入 / `failed` 导入失败。 */
    importStatus: text('import_status', { enum: ['pending', 'imported', 'failed'] })
      .notNull()
      .default('pending'),
    /** 来源文件(`source_document`)。可空。 */
    sourceDocumentId: integer('source_document_id').references(() => sourceDocument.id),
    /** 导入它的统一批次(`import_batch`)。可空。 */
    importBatchId: integer('import_batch_id').references(() => importBatch.id),
    /** 本批**替换**了哪一批(自引用);首版为 null。 */
    replacedBatchId: integer('replaced_batch_id').references(
      (): AnySQLiteColumn => platformExportBatch.id,
    ),
    createdAt: text('created_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (t) => [
    uniqueIndex('platform_export_batch_identity_uq').on(t.titleCode, t.year, t.sha256),
    index('platform_export_batch_title_year_idx').on(t.titleCode, t.year),
  ],
)

/**
 * **平台导出快照行**(契约 5·快照行)。一张导出表里的一行。
 *
 * 保留**源行身份**(`sourceRowNo`,来自文件的物理行号)与平台字段;同批内同行号唯一
 * ⇒ 同文件重放不会重复落行。`rawFields` 留整行原始字段(导出表几百列,不必逐列建表)。
 */
export const platformExportRow = sqliteTable(
  'platform_export_row',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    batchId: integer('batch_id')
      .notNull()
      .references(() => platformExportBatch.id, { onDelete: 'cascade' }),
    /** 源行号(该行在源文件里的行序,从 1 起)。 */
    sourceRowNo: integer('source_row_no').notNull(),
    usccRaw: text('uscc_raw'),
    nameRaw: text('name_raw'),
    district: text('district'),
    province: text('province'),
    city: text('city'),
    regStatus: text('reg_status'),
    /** 整行原始字段。 */
    rawFields: text('raw_fields', { mode: 'json' }).$type<Record<string, unknown>>(),
    createdAt: text('created_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (t) => [
    uniqueIndex('platform_export_row_identity_uq').on(t.batchId, t.sourceRowNo),
    index('platform_export_row_batch_idx').on(t.batchId),
    index('platform_export_row_identity_113_idx').on(t.batchId, sql`upper(trim(${t.usccRaw}))`, t.nameRaw),
  ],
)

/** #65: a typed decision between specific immutable source rows. No query-wide or empty-row endpoint. */
export const recordCorrespondence = sqliteTable(
  'record_correspondence',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    edgeKey: text('edge_key').notNull(),
    type: text('type', { enum: ['event_process', 'event_recognized', 'later_process', 'event_export_context', 'process_export_context', 'recognized_export'] }).notNull(),
    role: text('role').notNull(),
    eventId: integer('event_id').references(() => recordEvent.id),
    predecessorEventId: integer('predecessor_event_id').references(() => recordEvent.id),
    observationId: integer('observation_id').references(() => platformBusinessObservation.id),
    exportRowId: integer('export_row_id').references(() => platformExportRow.id),
    enterpriseId: integer('enterprise_id').references(() => enterprise.id),
    titleCode: text('title_code').notNull().references(() => title.code),
    status: text('status', { enum: ['candidate', 'confirmed', 'rejected', 'unlinked'] }).notNull(),
    revision: integer('revision').notNull(),
    targetIdentity: text('target_identity', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
    provenance: text('provenance', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
    sourceFingerprint: text('source_fingerprint').notNull(),
    ruleId: text('rule_id').notNull(),
    ruleVersion: text('rule_version').notNull(),
    createdAt: text('created_at').notNull(),
    decidedAt: text('decided_at'),
    endedAt: text('ended_at'),
  },
  (t) => [
    uniqueIndex('record_correspondence_edge_uq').on(t.edgeKey),
    index('record_correspondence_event_idx').on(t.eventId),
    index('record_correspondence_predecessor_idx').on(t.predecessorEventId),
    index('record_correspondence_relation_idx').on(t.observationId),
    index('record_correspondence_export_idx').on(t.exportRowId),
    index('record_correspondence_enterprise_idx').on(t.enterpriseId, t.titleCode),
  ],
)

/** Append-only decisions; import_batch supplies the shared transaction/idempotency ledger. */
export const recordCorrespondenceAudit = sqliteTable(
  'record_correspondence_audit',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    correspondenceId: integer('correspondence_id').notNull().references(() => recordCorrespondence.id),
    batchId: integer('batch_id').notNull().references(() => importBatch.id),
    idempotencyKey: text('idempotency_key').notNull(),
    fromStatus: text('from_status'),
    toStatus: text('to_status').notNull(),
    expectedRevision: integer('expected_revision').notNull(),
    resultingRevision: integer('resulting_revision').notNull(),
    actorType: text('actor_type', { enum: ['user', 'agent'] }).notNull(),
    actorId: text('actor_id').notNull(),
    basis: text('basis').notNull(),
    ruleId: text('rule_id').notNull(),
    ruleVersion: text('rule_version').notNull(),
    evidence: text('evidence', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
    decidedAt: text('decided_at').notNull(),
  },
  (t) => [index('record_correspondence_audit_edge_idx').on(t.correspondenceId, t.id)],
)

/** #72: immutable source-bound attestation. State is derived from append-only audit. */
export const comparisonScopeProof = sqliteTable('comparison_scope_proof', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  kind: text('kind', { enum: ['official_coverage', 'current_source_equivalence'] }).notNull(),
  evidence: text('evidence', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
  sourceFingerprint: text('source_fingerprint').notNull(),
  createdAt: text('created_at').notNull(),
}, t => [index('comparison_scope_proof_kind_idx').on(t.kind)])

/** Candidate, confirmation and revocation are immutable revisions. */
export const comparisonScopeProofAudit = sqliteTable('comparison_scope_proof_audit', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  proofId: integer('proof_id').notNull().references(() => comparisonScopeProof.id),
  batchId: integer('batch_id').notNull().references(() => importBatch.id),
  idempotencyKey: text('idempotency_key').notNull(),
  fromStatus: text('from_status', { enum: ['candidate', 'confirmed', 'revoked'] }),
  toStatus: text('to_status', { enum: ['candidate', 'confirmed', 'revoked'] }).notNull(),
  expectedRevision: integer('expected_revision').notNull(),
  resultingRevision: integer('resulting_revision').notNull(),
  actorType: text('actor_type', { enum: ['user', 'agent'] }).notNull(),
  actorId: text('actor_id').notNull(),
  basis: text('basis').notNull(),
  ruleId: text('rule_id').notNull(),
  ruleVersion: text('rule_version').notNull(),
  decidedAt: text('decided_at').notNull(),
}, t => [index('comparison_scope_proof_audit_proof_idx').on(t.proofId, t.id)])

/** File metadata/lifecycle receipts; no OCR, parsing or source content in these snapshots. */
export const fileMaintenanceAudit = sqliteTable('file_maintenance_audit', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  fileId: integer('file_id').notNull().references(() => storedFile.id),
  revision: integer('revision').notNull(),
  action: text('action', { enum: ['update', 'remove', 'restore'] }).notNull(),
  idempotencyKey: text('idempotency_key'),
  requestHash: text('request_hash').notNull(),
  mode: text('mode', { enum: ['legacy', 'versioned'] }).notNull(),
  actor: text('actor'),
  basis: text('basis'),
  before: text('before_json', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
  after: text('after_json', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
  createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
}, t => [uniqueIndex('file_maintenance_revision_uq').on(t.fileId, t.revision), uniqueIndex('file_maintenance_key_uq').on(t.idempotencyKey)])

/** #105: parse-only immutable receipts. List projections omit before/after snapshots. */
// Owned by sme-roster. Physical relocation is tracked by #884.
export const fileParseAudit105 = sqliteTable('file_parse_audit_105', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  fileId: integer('file_id').notNull().references(() => storedFile.id),
  idempotencyKey: text('idempotency_key').notNull(),
  requestHash: text('request_hash').notNull(),
  operation: text('operation', { enum: ['replace', 'status'] }).notNull(),
  actor: text('actor', { mode: 'json' }).$type<{ type: 'user' | 'agent'; id: string }>().notNull(),
  reason: text('reason').notNull(),
  before: text('before', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
  after: text('after', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
  createdAt: text('created_at').notNull(),
}, t => [uniqueIndex('file_parse_105_key_uq').on(t.fileId, t.idempotencyKey), index('file_parse_105_history_idx').on(t.fileId, t.id)])
/** #100: append-only in-place event correction history, no source/evidence overwrite. */
export const eventCorrectionAudit = sqliteTable('event_correction_audit', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  eventId: integer('event_id').notNull().references(() => recordEvent.id),
  batchId: integer('batch_id').notNull().references(() => importBatch.id),
  recordId: integer('record_id').notNull(),
  enterpriseId: integer('enterprise_id').notNull(),
  before: text('before', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
  after: text('after', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
  evidence: text('evidence', { mode: 'json' }).$type<unknown[]>().notNull(),
  sourceIdentity: text('source_identity').notNull(),
  actorType: text('actor_type').notNull(),
  actorId: text('actor_id').notNull(),
  basis: text('basis').notNull(),
  correctedAt: text('corrected_at').notNull(),
}, t => [index('event_correction_audit_event_idx').on(t.eventId, t.id)])

/** #99 explicit lifecycle decisions; append only, keyed history and replay. */
export const enterpriseAliasAudit = sqliteTable('enterprise_alias_audit', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  aliasId: integer('alias_id').notNull().references(() => enterpriseAlias.id),
  enterpriseId: integer('enterprise_id').notNull(),
  action: text('action', { enum: ['confirm', 'correct', 'withdraw'] }).notNull(),
  actor: text('actor').notNull(),
  basis: text('basis').notNull(),
  idempotencyKey: text('idempotency_key').notNull(),
  requestHash: text('request_hash').notNull(),
  before: text('before', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
  after: text('after', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
  createdAt: text('created_at').notNull(),
}, t => [
  uniqueIndex('enterprise_alias_audit_request_uq').on(t.aliasId, t.idempotencyKey),
  index('enterprise_alias_audit_page_idx').on(t.aliasId, t.id),
])

/** #101: immutable evidence correction receipts and append-only coordinate history. */
export const evidenceCorrectionBatch = sqliteTable('evidence_correction_batch', {
  idempotencyKey: text('idempotency_key').primaryKey(),
  requestHash: text('request_hash').notNull(),
  planHash: text('plan_hash').notNull(),
  receipt: text('receipt', { mode: 'json' }).$type<unknown>().notNull(),
  createdAt: text('created_at').notNull(),
})

/** #349: append-only published row captures. Captured owners are historical values, not live FKs. */
export const officialEvidenceRowRevision = sqliteTable('official_evidence_row_revision', {
  evidenceId: integer('evidence_id').notNull().references(() => recordEvidence.id),
  revision: integer('revision').notNull(),
  formatVersion: integer('format_version').notNull().default(1),
  eventId: integer('event_id').notNull().references(() => recordEvent.id),
  capturedRecordId: integer('captured_record_id').notNull(),
  capturedEnterpriseId: integer('captured_enterprise_id').notNull(),
  nameRaw: text('name_raw'), usccRaw: text('uscc_raw'), districtRaw: text('district_raw'),
  sourceDocumentId: integer('source_document_id').references(() => sourceDocument.id),
  storedFileId: integer('stored_file_id').references(() => storedFile.id),
  path: text('path'), sha256: text('sha256'), bytes: integer('bytes'),
  attachment: text('attachment'), sectionKey: text('section_key'), listNo: integer('list_no'), page: integer('page'),
  sourceBindingKnown: integer('source_binding_known', { mode: 'boolean' }).notNull(),
  actor: text('actor', { mode: 'json' }).$type<{ type: 'user' | 'agent'; id: string }>().notNull(),
  basis: text('basis').notNull(),
  commandKind: text('command_kind', { enum: ['import', 'evidence_correction'] }).notNull(),
  importBatchId: integer('import_batch_id').references(() => importBatch.id),
  correctionBatchKey: text('correction_batch_key').references(() => evidenceCorrectionBatch.idempotencyKey),
  createdAt: text('created_at').notNull(),
}, t => [
  uniqueIndex('official_evidence_row_revision_uq').on(t.evidenceId, t.revision),
  index('official_evidence_row_source_idx').on(t.sourceDocumentId, t.sha256, t.bytes, t.attachment, t.sectionKey, t.listNo, t.evidenceId, t.revision),
  index('official_evidence_row_event_idx').on(t.eventId, t.evidenceId, t.revision),
  check('official_evidence_row_version_ck', sql`${t.formatVersion} = 1 AND typeof(${t.revision}) = 'integer' AND ${t.revision} BETWEEN 1 AND 9007199254740991`),
  check('official_evidence_row_ids_ck', sql.join([t.evidenceId, t.eventId, t.capturedRecordId, t.capturedEnterpriseId].map(c => sql`(typeof(${c}) = 'integer' AND ${c} BETWEEN 1 AND 9007199254740991)`), sql` AND `)),
  check('official_evidence_row_optional_ids_ck', sql.join([t.sourceDocumentId, t.storedFileId, t.listNo, t.page, t.importBatchId].map(c => sql`(${c} IS NULL OR (typeof(${c}) = 'integer' AND ${c} BETWEEN 1 AND 9007199254740991))`), sql` AND `)),
  check('official_evidence_row_text_ck', sql.join([t.nameRaw, t.usccRaw, t.districtRaw, t.path, t.sha256, t.attachment, t.sectionKey, t.correctionBatchKey].map(c => sql`(${c} IS NULL OR typeof(${c}) = 'text')`), sql` AND `)),
  check('official_evidence_row_bytes_ck', sql`${t.bytes} IS NULL OR (typeof(${t.bytes}) = 'integer' AND ${t.bytes} BETWEEN 0 AND 9007199254740991)`),
  check('official_evidence_row_binding_ck', sql`${t.sourceBindingKnown} IN (0,1) AND (${t.sourceBindingKnown} = 0 OR (${t.sourceDocumentId} IS NOT NULL AND ${t.sha256} IS NOT NULL AND length(${t.sha256}) = 64 AND ${t.sha256} NOT GLOB '*[^0-9a-f]*' AND ${t.bytes} IS NOT NULL AND ${t.sectionKey} IS NOT NULL AND length(CAST(${t.sectionKey} AS BLOB)) > 0 AND ${t.listNo} IS NOT NULL))`),
  check('official_evidence_row_actor_ck', sql`CASE WHEN json_valid(${t.actor}) THEN coalesce(json_type(${t.actor}) = 'object' AND json_extract(${t.actor}, '$.type') IN ('user','agent') AND json_type(${t.actor}, '$.id') = 'text' AND length(CAST(json_extract(${t.actor}, '$.id') AS BLOB)) > 0, 0) ELSE 0 END`),
  check('official_evidence_row_command_ck', sql`(${t.commandKind} = 'import' AND ${t.importBatchId} IS NOT NULL AND ${t.correctionBatchKey} IS NULL) OR (${t.commandKind} = 'evidence_correction' AND ${t.correctionBatchKey} IS NOT NULL AND ${t.importBatchId} IS NULL)`),
])

export const evidenceCorrectionAudit = sqliteTable('evidence_correction_audit', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  evidenceId: integer('evidence_id').notNull().references(() => recordEvidence.id),
  eventId: integer('event_id').notNull().references(() => recordEvent.id),
  batchKey: text('batch_key').references(() => evidenceCorrectionBatch.idempotencyKey),
  entryPoint: text('entry_point', { enum: ['correction', 'legacy_pages'] }).notNull(),
  actor: text('actor', { mode: 'json' }).$type<{ type: 'user' | 'agent' | 'legacy'; id: string }>().notNull(),
  basis: text('basis').notNull(),
  before: text('before', { mode: 'json' }).$type<unknown>().notNull(),
  after: text('after', { mode: 'json' }).$type<unknown>().notNull(),
  createdAt: text('created_at').notNull(),
}, t => [index('evidence_correction_audit_evidence_idx').on(t.evidenceId, t.id)])

/** #113 committed evidence metadata only. No source bodies or business decisions. */
export const evidenceRevision113 = sqliteTable('evidence_revision_113', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  sourceKind: text('source_kind').notNull(), sourceKey: text('source_key').notNull(), sourceVersion: text('source_version').notNull(),
  enterpriseId: integer('enterprise_id'), titleCode: text('title_code'), direction: text('direction'), eventId: integer('event_id'),
  coverageDigest: text('coverage_digest').notNull(), factDigest: text('fact_digest').notNull(),
  coverageChanged: integer('coverage_changed', { mode: 'boolean' }).notNull(), factChanged: integer('fact_changed', { mode: 'boolean' }).notNull(),
  queryExecuted: integer('query_executed', { mode: 'boolean' }).notNull().default(false),
  metadata: text('metadata', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
  maxDecisionId: integer('max_decision_id').notNull(), createdAt: text('created_at').notNull(),
}, t => [uniqueIndex('evidence_revision_source_113_uq').on(t.sourceKind, t.sourceKey, t.sourceVersion), index('evidence_revision_scope_113_idx').on(t.enterpriseId, t.titleCode, t.id)])
export const evidenceSemanticHead113 = sqliteTable('evidence_semantic_head_113', {
  sourceKey: text('source_key').primaryKey(), coverageDigest: text('coverage_digest').notNull(), factDigest: text('fact_digest').notNull(), latestRevisionId: integer('latest_revision_id').notNull(),
})
export const evidenceImpactProgress113 = sqliteTable('evidence_impact_progress_113', {
  revisionId: integer('revision_id').primaryKey().references(() => evidenceRevision113.id), cursor: integer('cursor').notNull().default(0), done: integer('done', { mode: 'boolean' }).notNull().default(false),
}, t => [index('evidence_impact_pending_113_idx').on(t.done, t.revisionId)])
/** Working view keyed by the existing decision version. Retains historical identity across merges. */
export const explanationImpact113 = sqliteTable('explanation_impact_113', {
  id: integer('id').primaryKey({ autoIncrement: true }), enterpriseId: integer('enterprise_id').notNull(), titleCode: text('title_code').notNull(), direction: text('direction').notNull(), decisionId: integer('decision_id').notNull(),
  latestRevisionId: integer('latest_revision_id').notNull(), pendingSinceRevisionId: integer('pending_since_revision_id').notNull(),
  reviewedRevisionId: integer('reviewed_revision_id'), classification: text('classification', { enum: ['premise_invalid', 'evidence_changed'] }).notNull(),
}, t => [uniqueIndex('explanation_impact_coordinate_113_uq').on(t.enterpriseId, t.titleCode, t.direction, t.decisionId), index('explanation_impact_enterprise_113_idx').on(t.enterpriseId, t.id), index('explanation_impact_decision_113_idx').on(t.decisionId)])
export const evidenceImpactLink113 = sqliteTable('evidence_impact_link_113', {
  revisionId: integer('revision_id').notNull().references(() => evidenceRevision113.id), impactId: integer('impact_id').notNull().references(() => explanationImpact113.id), classification: text('classification').notNull(),
}, t => [uniqueIndex('evidence_impact_link_113_uq').on(t.revisionId, t.impactId), index('evidence_impact_link_state_113_idx').on(t.impactId, t.revisionId)])

/** Exact event dependencies captured with the evidence transaction; bounded separate reads. */
export const evidenceRevisionEvent113 = sqliteTable('evidence_revision_event_113', {
  revisionId: integer('revision_id').notNull().references(() => evidenceRevision113.id), eventId: integer('event_id').notNull(), enterpriseId: integer('enterprise_id').notNull(), titleCode: text('title_code').notNull(),
}, t => [uniqueIndex('evidence_revision_event_113_uq').on(t.revisionId, t.eventId), index('evidence_revision_event_scope_113_idx').on(t.revisionId, t.enterpriseId, t.titleCode, t.eventId)])

/** Bounded exact-scope tokens: eight indexed keys per coordinate, no ledger-history scan. */
export const evidenceScopeVersion113 = sqliteTable('evidence_scope_version_113', {
  scopeKey: text('scope_key').primaryKey(), latestRevisionId: integer('latest_revision_id').notNull(), pendingCount: integer('pending_count').notNull(),
})

/** #114 immutable review/explicit-work receipts, never a second decision writer. */
export const evidenceReviewReceipt114 = sqliteTable('evidence_review_receipt_114', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  idempotencyKey: text('idempotency_key').notNull().unique(), requestHash: text('request_hash').notNull(), kind: text('kind').notNull(),
  enterpriseId: integer('enterprise_id'), titleCode: text('title_code'), direction: text('direction'), decisionId: integer('decision_id'), sourceDecisionId: integer('source_decision_id'), reviewedRevisionId: integer('reviewed_revision_id'),
  // JSON null is stored as the non-NULL text 'null'; it means "not recorded", never a synthetic actor.
  actor: text('actor', { mode: 'json' }).$type<{ type: 'user' | 'agent'; id: string } | null>().notNull(), basis: text('basis').notNull(), ruleVersion: text('rule_version'), effectiveAt: text('effective_at'),
  response: text('response', { mode: 'json' }).$type<Record<string, unknown>>().notNull(), recordedAt: text('recorded_at').notNull(),
}, t => [index('evidence_review_scope_114_idx').on(t.enterpriseId, t.titleCode, t.direction, t.decisionId, t.id), index('evidence_review_decision_114_idx').on(t.decisionId,t.id), index('evidence_review_source_decision_114_idx').on(t.sourceDecisionId,t.id)])
/** Pins even unchanged explicit rule evaluations, so versions cannot be silently redefined. */
export const evidenceRuleRelease114 = sqliteTable('evidence_rule_release_114', {
  id: integer('id').primaryKey({ autoIncrement: true }), ruleId: text('rule_id').notNull(), version: text('version').notNull(),
  enterpriseId: integer('enterprise_id').notNull(), titleCode: text('title_code').notNull(), direction: text('direction').notNull(),
  previousDigest: text('previous_digest').notNull(), evaluationDigest: text('evaluation_digest').notNull(), revisionId: integer('revision_id'), receiptKey: text('receipt_key').notNull(),
}, t => [uniqueIndex('evidence_rule_release_scope_114_uq').on(t.ruleId,t.version,t.enterpriseId,t.titleCode,t.direction)])

/** #278 immutable UTF-8 bodies. Sealing/immutability guards live in migration 0029. */






export const enterpriseFactRevision = sqliteTable('enterprise_fact_revision', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  enterpriseId: integer('enterprise_id').notNull().references(() => enterprise.id),
  factId: integer('fact_id').notNull(),
  revision: integer('revision').notNull(),
  status: text('status', { enum: ['pending', 'confirmed', 'replaced', 'withdrawn'] }).notNull(),
  fact: text('fact', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
  replaces: integer('replaces'),
  action: text('action').notNull(),
  actor: text('actor', { mode: 'json' }).$type<{ type: 'user' | 'agent'; id: string }>().notNull(),
  basis: text('basis').notNull(),
  createdAt: text('created_at').notNull(),
}, table => [uniqueIndex('enterprise_fact_revision_key').on(table.enterpriseId, table.factId, table.revision)])
export const enterpriseFactReceipt = sqliteTable('enterprise_fact_receipt', {
  idempotencyKey: text('idempotency_key').primaryKey(),
  requestHash: text('request_hash').notNull(),
  receipt: text('receipt', { mode: 'json' }).$type<{ factId: number; version: string; committedAt: string }>().notNull(),
})

export const filePhysicalIntent = sqliteTable('file_physical_intent', {
  id: text('id').primaryKey(),
  fileId: integer('file_id').notNull().references(() => storedFile.id),
  relPath: text('rel_path').notNull(),
  sha256: text('sha256').notNull(),
  bytes: integer('bytes').notNull(),
  state: text('state', { enum: ['pending', 'quarantined', 'recovering', 'recovered'] }).notNull(),
  deleteKey: text('delete_key').notNull(),
  deleteHash: text('delete_hash').notNull(),
  deleteReceipt: text('delete_receipt', { mode: 'json' }).$type<Record<string, unknown>>(),
  recoverKey: text('recover_key'),
  recoverHash: text('recover_hash'),
  recoverReceipt: text('recover_receipt', { mode: 'json' }).$type<Record<string, unknown>>(),
  createdAt: text('created_at').notNull(),
}, t => [index('file_physical_history_idx').on(t.fileId, t.createdAt, t.id), uniqueIndex('file_physical_active_uq').on(t.fileId).where(sql`${t.state} != 'recovered'`), uniqueIndex('file_physical_delete_key_uq').on(t.deleteKey), uniqueIndex('file_physical_recover_key_uq').on(t.recoverKey)])

/** Current enterprise/title comparison only. Never read by qualification rules. */
export const enterpriseDifferenceComparison = sqliteTable('enterprise_difference_comparison', {
  enterpriseId: integer('enterprise_id').notNull().references(() => enterprise.id, { onDelete: 'cascade' }),
  titleCode: text('title_code').notNull().references(() => title.code),
  comparisonState: text('comparison_state', { enum: ['synchronized', 'unsynchronized', 'not_established'] }).notNull(),
  reasons: text('reasons', { mode: 'json' }).$type<string[]>().notNull(),
  comparisonError: text('comparison_error'),
  decisionCutoffId: integer('decision_cutoff_id').notNull().default(0),
  businessFingerprint: text('business_fingerprint').notNull(),
  changedAt: text('changed_at').notNull(),
  refreshedAt: text('refreshed_at').notNull(),
}, t => [primaryKey({ columns: [t.enterpriseId, t.titleCode] })])

/** #669: stable declarations, independent of rebuilt display parts. History is in parse receipts. */
export const fileDeclaration669 = sqliteTable('file_declaration_669', {
  declarationId: text('declaration_id').primaryKey(),
  displaySequence: integer('display_sequence').notNull().default(0),
  fileId: integer('file_id').notNull().references(() => storedFile.id),
  revision: integer('revision').notNull(),
  active: integer('active', { mode: 'boolean' }).notNull(),
  sha256: text('sha256').notNull(),
  contentVersion: text('content_version'),
  part: text('part', { mode: 'json' }).$type<FilePart>().notNull(),
  pageRanges: text('page_ranges', { mode: 'json' }).$type<{ start: number; end: number }[] | null>(),
}, t => [index('file_declaration_669_file_idx').on(t.fileId)])

/** Original SQLite storage class and bytes; never a business-query payload. */
export const platformArchiveValue = sqliteTable('platform_archive_value', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  storageClass: text('storage_class', { enum: ['null', 'text', 'blob'] }).notNull(),
  bytes: blob('bytes', { mode: 'buffer' }),
  byteLength: integer('byte_length'),
  sha256: text('sha256'),
  createdAt: text('created_at'),
}, t => [
  check('platform_archive_value_ck', sql`(${t.storageClass} = 'null' AND ${t.bytes} IS NULL AND ${t.byteLength} IS NULL AND ${t.sha256} IS NULL) OR (${t.storageClass} IN ('text','blob') AND typeof(${t.bytes}) = 'blob' AND typeof(${t.byteLength}) = 'integer' AND ${t.byteLength} = length(${t.bytes}) AND ${t.sha256} IS NOT NULL AND length(${t.sha256}) = 64 AND ${t.sha256} NOT GLOB '*[^0-9a-f]*')`),
])

export const platformCollectionArchiveRef = sqliteTable('platform_collection_archive_ref', {
  ownerId: integer('owner_id').notNull().references(() => platformCollection.id, { onDelete: 'restrict' }),
  field: text('field', { enum: ['rawResponse', 'collectionEvidence', 'legacyProvenance', 'request'] }).notNull(),
  archiveId: integer('archive_id').notNull().unique().references(() => platformArchiveValue.id, { onDelete: 'restrict' }),
  sealed: integer('sealed').notNull().default(0),
}, t => [primaryKey({ columns: [t.ownerId, t.field] }), check('platform_collection_archive_ref_ck', sql`${t.field} IN ('rawResponse','collectionEvidence','legacyProvenance','request') AND ${t.sealed} IN (0,1)`)])

/** Native observation archive ownership. */
export function definePlatformObservationArchiveRef(observationId: () => AnySQLiteColumn) { return sqliteTable('platform_observation_archive_ref', {
  ownerId: integer('owner_id').notNull().references(observationId, { onDelete: 'restrict' }),
  field: text('field', { enum: ['rawFields', 'sourceText', 'legacyRowSnapshot'] }).notNull(),
  archiveId: integer('archive_id').notNull().unique().references(() => platformArchiveValue.id, { onDelete: 'restrict' }),
  sealed: integer('sealed').notNull().default(0),
}, t => [primaryKey({ columns: [t.ownerId, t.field] }), check('platform_observation_archive_ref_ck', sql`${t.field} IN ('rawFields','sourceText','legacyRowSnapshot') AND ${t.sealed} IN (0,1)`)])
}
export const platformObservationArchiveRef = definePlatformObservationArchiveRef(() => platformBusinessObservation.id)

export const platformVersionArchiveRef = sqliteTable('platform_version_archive_ref', {
  ownerId: integer('owner_id').notNull().references(() => platformBusinessRecordVersion.id, { onDelete: 'restrict' }),
  field: text('field', { enum: ['canonicalRawJson'] }).notNull(),
  archiveId: integer('archive_id').notNull().unique().references(() => platformArchiveValue.id, { onDelete: 'restrict' }),
  sealed: integer('sealed').notNull().default(0),
}, t => [primaryKey({ columns: [t.ownerId, t.field] }), check('platform_version_archive_ref_ck', sql`${t.field} = 'canonicalRawJson' AND ${t.sealed} IN (0,1)`)])

export const platformLegacyQueryAlias = sqliteTable('platform_legacy_query_alias', {
  oldId: integer('old_id').primaryKey(),
  collectionId: integer('collection_id').notNull().unique().references(() => platformCollection.id, { onDelete: 'restrict' }),
}, t => [check('platform_legacy_query_alias_id_ck', sql`${t.oldId} > 0 AND ${t.oldId} <= 9007199254740991`)])
export function definePlatformLegacyRelationAlias(observationId: () => AnySQLiteColumn) { return sqliteTable('platform_legacy_relation_alias', {
  oldId: integer('old_id').primaryKey(),
  observationId: integer('observation_id').notNull().unique().references(observationId, { onDelete: 'restrict' }),
}, t => [check('platform_legacy_relation_alias_id_ck', sql`${t.oldId} > 0 AND ${t.oldId} <= 9007199254740991`)])
}
export const platformLegacyRelationAlias = definePlatformLegacyRelationAlias(() => platformBusinessObservation.id)
/** Explicitly initialized from the frozen source maxima before allocating any new aliases. */
export const platformLegacyAliasSequence = sqliteTable('platform_legacy_alias_sequence', {
  namespace: text('namespace', { enum: ['query', 'relation'] }).primaryKey(),
  highWater: integer('high_water').notNull(),
}, t => [check('platform_legacy_alias_sequence_ck', sql`${t.namespace} IN ('query','relation') AND typeof(${t.highWater}) = 'integer' AND ${t.highWater} BETWEEN 0 AND 9007199254740991`)])

/** Upgrade-only source binding. Runtime never creates or resumes migration runs. */
export const platformMigrationRun = sqliteTable('platform_migration_run', {
  runId: text('run_id').primaryKey(),
  sourceSnapshotSha256: text('source_snapshot_sha256').notNull(),
  sourceSchemaHash: text('source_schema_hash').notNull(),
  sourceManifestSha256: text('source_manifest_sha256').notNull(),
  targetSchemaVersion: text('target_schema_version').notNull(),
  transformVersion: text('transform_version').notNull(),
  state: text('state', { enum: ['running', 'complete'] }).notNull(),
}, t => [check('platform_migration_run_state_ck', sql`${t.state} IN ('running','complete')`)])
export const platformMigrationCheckpoint = sqliteTable('platform_migration_checkpoint', {
  runId: text('run_id').notNull().references(() => platformMigrationRun.runId, { onDelete: 'restrict' }),
  phase: text('phase').notNull(),
  sourceTable: text('source_table').notNull(),
  lastOldId: integer('last_old_id').notNull(),
  copiedCount: integer('copied_count').notNull(),
  batchDigest: text('batch_digest').notNull(),
}, t => [primaryKey({ columns: [t.runId, t.phase, t.sourceTable] }),
  ...[t.lastOldId, t.copiedCount].map(c => check(`platform_migration_checkpoint_${c.name}_ck`, sql`typeof(${c}) = 'integer' AND ${c} BETWEEN 0 AND 9007199254740991`)),
])

export const platformObservationFingerprintBasis = sqliteTable('platform_observation_fingerprint_basis', {
  observationId: integer('observation_id').primaryKey().notNull().references(()=>platformBusinessObservation.id,{onDelete:'restrict'}),
  scheme: text('scheme',{enum:['legacy-indexed-v1','legacy-bootstrap-v1','target-command-v1','uncaptured']}).notNull(),
  inputArchiveId: integer('input_archive_id').unique().references(()=>platformArchiveValue.id,{onDelete:'restrict'}),
},t=>[
  check('platform_fingerprint_basis_safe_id',sql`typeof(${t.observationId})='integer' AND ${t.observationId} BETWEEN 1 AND 9007199254740991`),
  check('platform_fingerprint_basis_scheme',sql`${t.scheme} IN ('legacy-indexed-v1','legacy-bootstrap-v1','target-command-v1','uncaptured')`),
  check('platform_fingerprint_basis_input',sql`(${t.scheme}='uncaptured' AND ${t.inputArchiveId} IS NULL) OR (${t.scheme}<>'uncaptured' AND ${t.inputArchiveId} IS NOT NULL)`),
])


export const platformCollectionLegacyProvenance = sqliteTable('platform_collection_legacy_provenance', {
  collectionId: integer('collection_id').primaryKey().notNull().references(()=>platformCollection.id,{onDelete:'restrict'}),
  origin: text('origin',{enum:['t04_envelope','supplement']}).notNull(),
  sourceIdentity: text('source_identity').notNull(),
  sourceSha256: text('source_sha256').notNull(),
  segmentIndex: integer('segment_index').notNull(),
  inputFingerprint: text('input_fingerprint').notNull(),
  importBatchId: integer('import_batch_id').notNull().references(()=>importBatch.id,{onDelete:'restrict'}),
  createdAt: text('created_at').notNull(),
  archiveId: integer('archive_id').notNull().unique().references(()=>platformArchiveValue.id,{onDelete:'restrict'}),
},t=>[
  unique('platform_collection_legacy_source_uq').on(t.sourceSha256,t.segmentIndex),
  ...[t.collectionId,t.importBatchId,t.archiveId].map(c=>check(`collection_provenance_${c.name}_safe`,sql`typeof(${c})='integer' AND ${c} BETWEEN 1 AND 9007199254740991`)),
  check('collection_provenance_segment_safe',sql`typeof(${t.segmentIndex})='integer' AND ${t.segmentIndex} BETWEEN 0 AND 9007199254740991`),
  check('collection_provenance_origin',sql`typeof(${t.origin})='text' AND ${t.origin} IN ('t04_envelope','supplement')`),
  ...[t.sourceSha256,t.inputFingerprint].map(c=>check(`collection_provenance_${c.name}_hex`,sql`typeof(${c})='text' AND length(${c})=64 AND length(cast(${c} AS blob))=64 AND ${c} NOT GLOB '*[^0-9a-f]*'`)),
  ...[t.sourceIdentity,t.createdAt].map(c=>check(`collection_provenance_${c.name}_text`,sql`typeof(${c})='text'`)),
])


function applyStoredFields(){return {
 exactStatus:exactText('exact_status'),exactDeclareKind:exactText('exact_declare_kind'),
 exactAppliedAt:exactText('exact_applied_at'),exactYear:exactInteger('exact_year'),exactTitleRaw:exactText('exact_title_raw'),
 exactStoredState:text('exact_stored_state',{enum:['captured','uncaptured']}),exactStoredRule:text('exact_stored_rule'),
 exactStoredOrigin:text('exact_stored_origin',{enum:['legacy_source','sealed_snapshot','command_materialized']}),exactStoredReason:text('exact_stored_reason'),
 sqlFactTitle:text('sql_fact_title'),sqlFactTitleState:text('sql_fact_title_state',{enum:['captured','uncaptured']}),
 sqlFactTitleRule:text('sql_fact_title_rule'),sqlFactTitleReason:text('sql_fact_title_reason'),
}}

function processStoredFields(){return {
 exactStatus:exactText('exact_status'),exactDeclareKind:exactText('exact_declare_kind'),exactAppliedAt:exactText('exact_applied_at'),
 exactYear:exactInteger('exact_year'),exactTitleRaw:exactText('exact_title_raw'),exactBatch:exactText('exact_batch'),
 exactAwardBatchLabel:exactText('exact_award_batch_label'),exactProvince:exactText('exact_province'),
 exactStoredState:text('exact_stored_state',{enum:['captured','uncaptured']}),exactStoredRule:text('exact_stored_rule'),
 exactStoredOrigin:text('exact_stored_origin',{enum:['legacy_source','sealed_snapshot','command_materialized']}),exactStoredReason:text('exact_stored_reason'),
 sqlFactTitle:text('sql_fact_title'),sqlFactTitleState:text('sql_fact_title_state',{enum:['captured','uncaptured']}),
 sqlFactTitleRule:text('sql_fact_title_rule'),sqlFactTitleReason:text('sql_fact_title_reason'),
}}

export const titleCycleDispositionRevision = sqliteTable('title_cycle_disposition_revision', {
  revisionId: integer('revision_id').primaryKey(),
  id: text('id').notNull(),
  revision: integer('revision').notNull(),
  enterpriseId: integer('enterprise_id').notNull().references(() => enterprise.id),
  titleCode: text('title_code', { enum: ['little_giant'] }).notNull(),
  cycleEventId: integer('cycle_event_id').references(() => recordEvent.id),
  status: text('status', { enum: ['pending', 'confirmed', 'replaced', 'withdrawn'] }).notNull(),
  kind: text('kind', { enum: ['not_applied', 'not_recommended', 'formal_failure'] }).notNull(),
  sourceFileId: integer('source_file_id').notNull().references(() => storedFile.id),
  sourceSha256: text('source_sha256').notNull(),
  cycleRevision: integer('cycle_revision'),
  effectivePrecision: text('effective_precision', { enum: ['unknown', 'year', 'month', 'day'] }).notNull(),
  effectiveValue: text('effective_value'),
  fact: text('fact', { mode: 'json' }).$type<DispositionFact>().notNull(),
  audit: text('audit', { mode: 'json' }).$type<unknown>().notNull(),
}, t => [
  unique().on(t.id, t.revision),
  index('title_cycle_disposition_scope').on(t.enterpriseId, t.titleCode, t.cycleEventId, t.id, t.revision),
  index('title_cycle_disposition_source').on(t.sourceFileId, t.sourceSha256),
  check('title_cycle_disposition_title', sql`${t.titleCode}='little_giant'`),
  check('title_cycle_disposition_status', sql`${t.status} IN ('pending','confirmed','replaced','withdrawn')`),
  check('title_cycle_disposition_kind', sql`${t.kind} IN ('not_applied','not_recommended','formal_failure')`),
]);
export const titleCycleDispositionReceipt = sqliteTable('title_cycle_disposition_receipt', {
  key: text('key').primaryKey(),
  requestHash: text('request_hash').notNull(),
  receipt: text('receipt', { mode: 'json' }).$type<{ ids: string[]; version: string; committedAt: string }>().notNull(),
});
