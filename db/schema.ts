import { sql } from 'drizzle-orm'
import type { AnySQLiteColumn } from 'drizzle-orm/sqlite-core'
import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core'

/** 后台外部服务凭据。仅配置服务读取，不加入台账导出或任务历史。 */
export const serviceCredential = sqliteTable('service_credential', {
  key: text('key', { enum: ['ocrToken', 'miitCookie'] }).primaryKey(),
  value: text('value').notNull(),
  updatedAt: text('updated_at').notNull(),
})

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
     *    **被复核的原认定年份**(见 GLOSSARY「复核」);
     *  - `decided_year` 是**结论发生**的年份(如 2024 年公布的复核)。
     *
     * 复核锚点(下一次三年到期)按结论年份计算:2021 认定 → 2024 复核通过 ⇒ 下一次到期
     * 2027(= 2024 + 3)。可空;缺失时锚点退回 `year` 并把该企业标为待核 —— **不猜**。
     */
    decidedYear: integer('decided_year'),
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
  (t) => [index('record_evidence_event_idx').on(t.recordEventId), index('record_evidence_source_file_105_idx').on(t.sourceFile)],
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
    /** 用户可见名称覆写;null 表示沿用磁盘文件名。 */
    displayName: text('display_name'),
    /** 磁盘事实:文件名(含扩展名)、小写扩展名(不含点)、字节数、内容 SHA-256。 */
    filename: text('filename').notNull(),
    ext: text('ext').notNull(),
    bytes: integer('bytes').notNull(),
    sha256: text('sha256').notNull(),
    /** 分类(可空,见上)。 */
    source: text('source', { enum: ['jxj', 'miit'] }),
    kind: text('kind', { enum: ['announcement', 'export'] }),
    /**
     * **公布**年份 / 批次:目录给出的、**这份文件是哪一批公布的**(单值、可排序)。
     *
     * ⚠️ 与 `storedFilePart.year` **不是一回事** —— 那是文件**内容**里各段的年份/批次,
     * 一份文件可以有多个(票 17)。这里只有一个,因为它由路径 `…/<year>/<batch>/…` 决定。
     * 见 `.scratch/ingest-pipeline/issues/17-file-parts.md`。
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
 * 见 `.scratch/ingest-pipeline/issues/17-file-parts.md`。
 *
 * 与 `stored_file.year` / `batch`(**公布**年份/批次,单值)分工明确:那里答「这份文件是
 * 哪一批公布的」,这里答「文件里都有什么」。**别把两者混用**。
 *
 * `derived` 是从 `record_evidence` 聚合的派生结果,`agent` 是代理解析声明;升级前已存在的
 * 行标为 `legacy`,因为旧表无法证明它们来自哪条写入路径。回填重建派生行、保留代理行;
 * legacy 行与 evidence 完全一致时可归为 derived,不一致时保留并标记冲突。
 * 见 `.scratch/ingest-pipeline/issues/20-parts-origin.md`。
 */
export const storedFilePart = sqliteTable(
  'stored_file_part',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    fileId: integer('file_id')
      .notNull()
      .references(() => storedFile.id, { onDelete: 'cascade' }),
    /** 该段的称号。与 `stored_file.title_code` 同源表(称号字典)。 */
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
    /** 归一后的附件名(`附件` / `附件N`),见 `lib/attachment.ts`。可空(导出表无附件)。 */
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
 * 见 `.scratch/ingest-pipeline/issues/14-ocr.md` 与 SPEC 需求 4。三条通路都往这张表落:
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
 * (见 `.scratch/ingest-pipeline/SPEC.md`「凭证不入库」)。
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
    index('job_state_idx').on(t.state),
    index('job_created_at_idx').on(t.createdAt),
  ],
)

// ===========================================================================
// 名录生命周期契约(RL-01)—— 冻结的领域对象。
//
// 契约原文见 `docs/roster-lifecycle-contract.md`,决策见
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
      enum: ['announcement', 'platform_export', 'alias_evidence', 'correspondence_decision', 'comparison_scope_proof', 'event_correction'],
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
    /** 归一化别名(与 `lib/domain.ts` 的 `normalizeName` 同规则),供按曾用名搜索。 */
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

/**
 * **平台查询记录**(契约 3)。一次「查了工信部哪个接口、用什么键、什么时候查、结果如何」。
 *
 * **失败 ≠ 无记录** —— 这是这票的硬要求,所以 `status` 把四态分开:
 *  - `not_queried` **未查询**(还没查过,不是「没有」);
 *  - `failed` **查询失败**(网络/会话/结构异常 —— 查询**没成功执行**);
 *  - `no_record` **无记录**(查询成功执行,平台**返回空**);
 *  - `success` 查询成功且返回至少一条记录(记录逐条落 `platform_relation`)。
 *
 * `rawResponse` 存**原始响应/HTML**:平台接口现在返回 HTML 表格,留原文才能在解析口径
 * 变了以后回看引擎到底收到了什么(不参与查询,只供回溯,所以进 text 而非结构化列)。
 * 重复查询**各占一行**(`queriedAt` 进唯一键)——「不丢历史证据」,缓存/刷新由读侧决定。
 */
export const platformQuery = sqliteTable(
  'platform_query',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** 独立来源：business_list / apply_list / recognized_list(queryBusList)。 */
    interface: text('interface', { enum: ['business_list', 'apply_list', 'recognized_list'] }).notNull(),
    /** 查询键:统一社会信用代码,或 `name:<nameNorm>`(与 `lib/reconcile.ts` 同构)。 */
    queryKey: text('query_key').notNull(),
    /**
     * `businessList` 的 `rdjb` 参数(认定级别):`1` 创新型 / `2` 专精特新中小企业 /
     * `3` 专精特新“小巨人”。空串 = 该接口不用这个参数(如 `applyList`)。
     *
     * 实测:同一 USCC 下 `rdjb=3` 返回 6 条、`rdjb=1`/`rdjb=2` 各返回 0 条 ——
     * 即**同一次查询键、不同 rdjb 是不同查询**,所以它进唯一键。
     */
    rdjb: text('rdjb').notNull().default(''),
    /** 本次查询针对的称号;接口不按称号查时留空。 */
    titleCode: text('title_code').references(() => title.code),
    /** 查询时点(ISO 时间)。 */
    queriedAt: text('queried_at').notNull(),
    /** 四态见上;默认 `not_queried`(「还没查」而不是「没有」)。 */
    status: text('status', {
      enum: ['success', 'failed', 'no_record', 'not_queried', 'partial'],
    })
      .notNull()
      .default('not_queried'),
    /** 失败原因(仅 `failed` 有意义)。 */
    failureReason: text('failure_reason'),
    /** 原始响应 / HTML 原文,供回溯。 */
    rawResponse: text('raw_response'),
    /** 原始逐来源采集结果，旧查询留 null；含原时间、页、条件及原行。 */
    collectionEvidence: text('collection_evidence', { mode: 'json' }).$type<import('../lib/platform/live-query').PlatformLiveQueryResult>(),
    createdAt: text('created_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (t) => [
    // 同接口 + 同查询键 + 同 rdjb + 同一时点 = 同一次查询(重放幂等);不同时点各自留档。
    uniqueIndex('platform_query_identity_uq').on(t.interface, t.queryKey, t.rdjb, t.queriedAt),
    index('platform_query_key_idx').on(t.queryKey),
    // #87: narrow covering scans for counts and stable latest/deep pages.
    index('platform_query_status_time_idx').on(t.status, t.queriedAt, t.id),
    index('platform_query_time_idx').on(t.queriedAt, t.id),
  ],
)

/**
 * **平台接口关系记录**(契约 2)。一次查询返回的**每一条关联关系**各占一行。
 *
 * **同一信用代码返回的多条关联必须逐条保留**(这正是 `91330211255994457P` 案例:
 * 平台记录里明确写了经信局侧曾用名,要能匹配并展示**全部**关联)—— 所以用
 * `(query_id, sequence_no)` 做唯一键,而**不是**按企业或信用代码去重。
 *
 * `matchBasis`(匹配依据)记「这条为什么归到该企业」:`uscc`(统代)/ `alias`(曾用名)/
 * `manual`(人工确认)/ `none`(未匹配 —— `enterprise_id` 留空、`verification_status`
 * 为 `pending`,即「待核实」)。**没有模糊打分**:归属必须能指回一条可读的依据。
 *
 * ── 平台字段的落点(实测 `businessList` `rdjb=3` 的 6 条关联)──────────────────
 * 接口字段名 → 本表列:
 *  `id` → `relationKey`;`qymc` → `nameRaw`;`tyshxydm` → `usccRaw`;`szsfmc` → `province`;
 *  `cszt` → `status`;`whpc`(维护批次)→ `batch`;`sblx` → `declareKind`;
 *  `sqsj` → `appliedAt`;`personuuid`(列头为**认定批次**,值如 `第四批`)→ `awardBatchLabel`;
 *  `queryList` 的 `year` → `year`。
 *
 * ── 曾用名的原始证据就在这里 ──────────────────────────────────────────────
 * 平台**没有**独立「曾用名」列。同一 `tyshxydm` 下 `qymc` 不同的历史关联行**本身**
 * 就是曾用名证据(实测:`SQ332022062212391` 的 `qymc=宁波上航测绘有限公司`,
 * `SQ332024052128274` 的 `qymc=宁波上航测绘股份有限公司`,逐字段比对后**唯一**与名称
 * 有关的差异字段就是 `qymc`)。代理据此判断并确认,回填为 `enterprise_alias`。
 */
export const platformRelation = sqliteTable(
  'platform_relation',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    queryId: integer('query_id')
      .notNull()
      .references(() => platformQuery.id, { onDelete: 'cascade' }),
    /** 关系序号:同一次查询内第几条(从 1 起)。**逐条保留**的载体。 */
    sequenceNo: integer('sequence_no').notNull(),
    /** 平台关联主键(`id`,如 `SQ332022062212391`)。可空(导出/异常响应可能没有)。 */
    relationKey: text('relation_key'),
    /** 匹配到的企业;无法判定时**留空**(不自动归并)。 */
    enterpriseId: integer('enterprise_id').references(() => enterprise.id),
    /** 原始字段(平台那一行/那一块的字段原样)。 */
    rawFields: text('raw_fields', { mode: 'json' }).$type<Record<string, unknown>>(),
    /** 源文本:关系里明确写出的经信局侧曾用名等原文。 */
    sourceText: text('source_text'),
    /** 统一社会信用代码(`tyshxydm`)。 */
    usccRaw: text('uscc_raw'),
    /** 企业名称(`qymc`)。同一 USCC 下 `qymc` 不同 ⇒ **曾用名证据**。 */
    nameRaw: text('name_raw'),
    /** 源文本中明确给出的曾用名(若有)。 */
    aliasNameRaw: text('alias_name_raw'),
    /** 所属省市名称(`szsfmc`)。 */
    province: text('province'),
    /** 存续状态(`cszt`,如「终审通过」「省已审」「待审核」)。 */
    status: text('status'),
    /** 维护批次(`whpc`,如 `2022-1` / `2025-1`)。 */
    batch: text('batch'),
    /**
     * 申报类型(`sblx`):`apply` 申请 / `update` 更新 / `review` 复核。
     * 非枚举字典外的取值原样入库(drizzle 的 enum 只是编译期约束)。
     */
    declareKind: text('declare_kind', { enum: ['apply', 'update', 'review'] }),
    /** 申报时间(`sqsj`)。 */
    appliedAt: text('applied_at'),
    /** 认定批次(`personuuid`,值如 `第四批`);按「2018 + 批次序号」对应年份。 */
    awardBatchLabel: text('award_batch_label'),
    /** 申报记录年份(`queryList` 的 `year`)。 */
    year: integer('year'),
    /** 匹配依据:`uscc` / `alias` / `manual` / `none`。 */
    matchBasis: text('match_basis', { enum: ['uscc', 'alias', 'manual', 'none'] })
      .notNull()
      .default('none'),
    /** 核验状态:`confirmed` 已确认 / `pending` 待核实。 */
    verificationStatus: text('verification_status', { enum: ['confirmed', 'pending'] })
      .notNull()
      .default('pending'),
    createdAt: text('created_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (t) => [
    uniqueIndex('platform_relation_query_seq_uq').on(t.queryId, t.sequenceNo),
    index('platform_relation_enterprise_idx').on(t.enterpriseId),
    index('platform_relation_relation_key_idx').on(t.relationKey),
    // #83 USCC filtering discovers query IDs without scanning original relation bodies.
    index('platform_relation_uscc_query_idx').on(t.usccRaw, t.queryId),
  ],
)

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
export const differenceReason = sqliteTable(
  'difference_reason',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    enterpriseId: integer('enterprise_id')
      .notNull()
      .references(() => enterprise.id, { onDelete: 'cascade' }),
    titleCode: text('title_code')
      .notNull()
      .references(() => title.code),
    /** 差异方向,与 `lib/comparison.ts` 的 `COMPARISON_DIRECTIONS` 同值。 */
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
    /** 证据:平台查询记录 / 平台关系记录。 */
    evidenceQueryId: integer('evidence_query_id').references(() => platformQuery.id),
    evidenceRelationId: integer('evidence_relation_id').references(() => platformRelation.id),
    /** 迁入承载:原城市 / 原称号 / 年份 / 批次。缺项留空待核。 */
    movedInCity: text('moved_in_city'),
    movedInTitleCode: text('moved_in_title_code').references(() => title.code),
    movedInYear: integer('moved_in_year'),
    movedInBatch: integer('moved_in_batch'),
    /** 核验状态:`confirmed` 已确认 / `pending` 待核实。 */
    verificationStatus: text('verification_status', { enum: ['confirmed', 'pending'] })
      .notNull()
      .default('pending'),
    /** 该解释的登记时点(时态化的排序键)。 */
    recordedAt: text('recorded_at').notNull(),
    createdAt: text('created_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (t) => [
    // 同企业 × 称号 × 方向 × 时点唯一:时点不同 → 并存(旧解释不丢)。
    uniqueIndex('difference_reason_version_uq').on(
      t.enterpriseId,
      t.titleCode,
      t.direction,
      t.recordedAt,
    ),
    index('difference_reason_lookup_idx').on(t.enterpriseId, t.titleCode, t.direction),
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
    relationId: integer('relation_id').references(() => platformRelation.id),
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
    index('record_correspondence_relation_idx').on(t.relationId),
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

/** #105: parse-only immutable receipts. List projections omit before/after snapshots. */
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
