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
 * 本表**派生自 `record_evidence`**(按 `source_file` 分组聚合),可整体重建 ——
 * 回填按 `file_id` 先删后插,所以幂等。见 `server/utils/file-parts.ts`。
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
  },
  (t) => [index('stored_file_part_file_idx').on(t.fileId)],
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
