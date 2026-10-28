/**
 * 名录统一导入 API 的**契约类型 + 客户端**（RL-11）。
 *
 * 契约原文：[`docs/roster-lifecycle-contract.md`](../docs/roster-lifecycle-contract.md) §8（写接口）
 * 与 §9（MCP tool）。本文件是**跨进程可复用**的那一半：类型与 HTTP 客户端。
 * 服务端实现见 `server/utils/roster-import.ts`（纯逻辑）与
 * `server/utils/roster-import-http.ts`（把逻辑翻成 HTTP 状态码/JSON）。
 *
 * ── 为什么客户端在 `lib/` 而不是 `server/` ─────────────────────────────
 * 项目外的 `pipeline/`（解析/清洗/导入）要**退化为本 API 的客户端**，而它按
 * `lib/domain.ts` 的先例直接 import 本仓的 `lib/*` 来共用契约 —— 这条通路要求
 * 客户端不依赖 Nuxt/Nitro 的运行时（只用标准 `fetch`，可注入）。
 *
 * ── 用凭证的方式（硬约束）──────────────────────────────────────────────
 * token 只由**运行时**传进来（服务端 `NUXT_API_TOKEN`；客户端调用方从自己的密钥存储取）。
 * 契约、日志、仓库里都**不出现** token 的值 —— 本文件只有 header 名与占位说明。
 *
 * ── 一个批次 = 一次原子写入 ────────────────────────────────────────────
 * `preflight` 只算影响、不写业务数据；`commit` 是**单批事务**：要么整批落库，
 * 要么一条不落并把逐项错误交回。幂等键是 body 的 `idempotencyKey`，
 * 同一来源重复调用不会重复写企业/事件。
 */
import type { PlatformInterface } from './labels'
import type { CurrentQualificationSnapshot, OfficialEventFieldDiagnostics } from './roster/current-qualification'

export type OfficialDeclaration =
  | { kind: 'existing'; sourceDocumentId: number; basis: string }
  | { kind: 'independent'; sourceDocument: { source: 'jxj'; title: string; docNumber: string | null; issueDate: string | null; path: string }; basis: string }
export interface OfficialPublishedRow {
  nameRaw: string | null; usccRaw: string | null; districtRaw: string | null
  declaration: OfficialDeclaration
  storedFileId: number | null; path: string | null; sha256: string | null; bytes: number | null
  attachment: string | null; sectionKey: string | null; listNo: number | null; page: number | null
  sourceBindingKnown: boolean
  actor: { type: 'user' | 'agent'; id: string }; basis: string
}
export interface OfficialEvidenceCorrectionOperation {
  evidenceId: number; eventId: number; recordId: number; enterpriseId: number
  expectedVersion: string
  coordinate: { sourceFile: string; attachment: string | null; listNo: number | null; page: number | null }
  publishedRow?: OfficialPublishedRow; expectedRowRevision?: number
}
export interface OfficialEvidenceCorrections {
  actor: { type: 'user' | 'agent'; id: string }; basis: string
  operations: OfficialEvidenceCorrectionOperation[]
}
export interface OfficialEvidenceAppend {
  eventId: number; recordId: number; enterpriseId: number
  /** Existing public event.revision. */
  expectedVersion: number
  evidence: { sourceFile: string; attachment: string | null; listNo: number | null; page: number | null; publishedRow: OfficialPublishedRow }
}

// ---------------------------------------------------------------------------
// payload 形状（契约 §8.3）
// ---------------------------------------------------------------------------

/** 事件出处（回溯到文件 / 附件 / 序号 / 页）。 */
export interface RosterImportEvidence {
  /** 文件库内相对路径（与 `record_evidence.source_file` 同一口径）。 */
  sourceFile: string
  attachment?: string | null
  listNo?: number | null
  /** 源文件/PDF 实际页序；给不出**留空**，不猜。 */
  page?: number | null
  publishedRow?: OfficialPublishedRow
}

/** 一条称号事件（认定 / 复核 / 维护 / 入库培育）。 */
export interface RosterImportEvent {
  eventType: 'award' | 'review' | 'maintain' | 'nurture'
  /** 事件**所涉**年份：认定年份；复核事件记**被复核的原认定年份**。 */
  year?: number | null
  batchSeq?: number | null
  /** **结论发生**年份；给不出留空（锚点退回 `year` 并标待核）。 */
  decidedYear?: number | null
  /** 仅复核有意义；未知**不猜成通过**。 */
  reviewOutcome?: 'passed' | 'failed' | null
  evidence?: RosterImportEvidence[]
}

/** 一条称号记录（企业 × 称号 × 来源）+ 它的事件。 */
export interface RosterImportRecord {
  enterprise: {
    name: string
    /** 统一社会信用代码；可空（无统代企业）。 */
    uscc?: string | null
    district?: string | null
  }
  titleCode: string
  /** 记录级来源；不给则取 `announcement.sourceDocument.source`。 */
  source?: 'jxj' | 'miit'
  events?: RosterImportEvent[]
}

/** 公布文件及其记录（权威历史）。 */
export interface RosterImportAnnouncement {
  sourceDocument: {
    source: 'jxj' | 'miit'
    title: string
    docNumber?: string | null
    issueDate?: string | null
  }
  records: RosterImportRecord[]
}

/**
 * 平台查询 / 关系的**自然键**（批内引用）。
 *
 * ── 为什么必须有它 ──────────────────────────────────────────────────────
 * `enterprise_alias.source_ref_id` / `difference_reason.evidence_query_id` /
 * `evidence_relation_id` 存的是**整数行 id**，而 `platform_query` / `platform_relation`
 * 的 id 由写入侧在**本批事务内**生成 —— 客户端构造载荷时**不可能预知**。
 * 若只认裸 id，写入方就被迫拆成两批（先写查询、读回 id、再写别名与差异），
 * 而契约的验收要求是「**一个批次**可提交企业、**带来源证据的**已确认曾用名、
 * 差异原因和后续措施」。自然键让证据指针在**同一批内**指到本批新建的关系行。
 *
 * ── 键的构成（为什么不是 `relationKey`）──────────────────────────────────
 * `platform_query` 的唯一键是 `(interface, query_key, rdjb, queried_at)`；
 * `platform_relation` 的唯一键是 `(query_id, sequence_no)` —— 这就是自然键的来源。
 * **不能只用 `relationKey`（如 `SQ332022062212391`）**：实测同一 `relationKey` 在
 * `business_list` 与 `apply_list` 下**各出现一次**，单靠它有歧义。
 *
 * `queriedAt` 可省：省了就用 `(interface, queryKey, rdjb)` 匹配，并要求**恰好命中一次**
 * （命中多次 ⇒ 逐项报错，绝不猜）；给了就精确匹配那一次查询。
 */
export interface RosterPlatformRef {
  interface: PlatformInterface
  /** 查询键：统一社会信用代码、`name:<nameNorm>`，或已认定无主体归档的稳定键。 */
  queryKey: string
  /** `business_list` 的认定级别（`1`/`2`/`3`）；默认 `''`。 */
  rdjb?: string
  /** 查询时点（ISO）。给了就精确匹配；不给则要求 `(interface, queryKey, rdjb)` 唯一。 */
  queriedAt?: string
  /** 关系序号（同一次查询内第几条，从 1 起）。**关系引用必填**；查询引用不用。 */
  sequenceNo?: number
  /**
   * 关系的**权威锚点**（RL-06 增量）。
   *
   * 为什么需要它：实测「平台的排序可能与其解析顺序不同，`sequenceNo` 只作参考」——
   * 序号对不上时按序号去锚，会把别名/归并的证据指针指到**另一条关系**上。
   * 给了 `relationKey` 时：解析出的那条关系**必须**就是它；同时给了 `sequenceNo` 却指到别的行
   * ⇒ 逐项报错 `relation_ref_mismatch`，**绝不按其中一个猜**。
   * 两个都给是最稳的用法：`relationKey` 定身份、`sequenceNo` 交叉校验。
   */
  relationKey?: string | null
}

/** 企业曾用名 / 别名（身份历史，是**证据**不是身份）。 */
export interface RosterImportAlias {
  /** 归属企业：给 `uscc` 优先，否则按 `enterpriseName` 归一化名找。 */
  enterpriseName?: string
  uscc?: string | null
  name: string
  sourceKind: 'platform_business' | 'platform_apply' | 'announcement' | 'manual'
  /** 来源证据行 id（如 `platform_relation.id`，**已存在**的行）；0 = 无具体来源行引用。 */
  sourceRefId?: number
  /**
   * 来源关系行的**自然键**（可指向**本批新建**的关系）。与 `sourceRefId` **恰给其一**；
   * 两个都给 ⇒ 逐项报错（不静默取一个）。
   */
  sourceRelationRef?: RosterPlatformRef
  verificationStatus?: 'confirmed' | 'pending'
  validFrom?: string | null
  validTo?: string | null
  note?: string | null
}

/** 一条平台关联关系（同一查询返回的**每一条**都要落，不按企业去重）。 */
export interface RosterImportRelation {
  sequenceNo: number
  relationKey?: string | null
  /** 归属企业：显式给则用；不给则按 `usccRaw` 精确匹配企业，匹配不到留空待核。 */
  enterpriseId?: number | null
  usccRaw?: string | null
  nameRaw?: string | null
  aliasNameRaw?: string | null
  province?: string | null
  status?: string | null
  batch?: string | null
  /** `sblx`；非字典取值**原样入库**且标待核（不因未知取值崩溃）。 */
  declareKind?: string | null
  appliedAt?: string | null
  awardBatchLabel?: string | null
  year?: number | null
  matchBasis?: 'uscc' | 'alias' | 'manual' | 'none'
  verificationStatus?: 'confirmed' | 'pending'
  sourceText?: string | null
  rawFields?: Record<string, unknown> | null
}

/** 一次平台查询及其返回的全部关系。 */
export interface RosterImportPlatformQuery {
  /** 仅引用已存在采集坐标；省略正文不代表清空，显式给出的不可变值仍须相同。不得补行。 */
  reuseExisting?: true
  interface: PlatformInterface
  /** 统一社会信用代码、`name:<nameNorm>`，或已认定无主体归档的稳定键。 */
  queryKey: string
  /** `businessList` 的认定级别；进唯一键（同键不同 rdjb 是不同查询）。 */
  rdjb?: string
  titleCode?: string | null
  queriedAt: string
  status?: 'success' | 'failed' | 'no_record' | 'not_queried' | 'partial'
  /** recognized_list 必填；三来源 typed 归档带原封套。rawData.version=1 选择真实原行，缺省保持 legacy，不补造类型/时间。 */
  collectionEvidence?: import('./platform/live-query').PlatformLiveQueryResult | null
  failureReason?: string | null
  rawResponse?: string | null
  relations?: RosterImportRelation[]
}

/** 平台导出快照（采集时点现状，只作对照）。 */
export interface RosterImportExportSnapshot {
  titleCode: string
  year: number
  collectedOn: string
  originalFilename: string
  /** 文件内容 SHA-256（版本身份）；换内容 ⇒ 新版本并记替换关系。 */
  sha256: string
  rows: RosterImportExportRow[]
}

export interface RosterImportExportRow {
  /** 源文件里的**行序**（从 1 起，同批内唯一 ⇒ 重放不重复落行）。 */
  sourceRowNo: number
  usccRaw?: string | null
  nameRaw?: string | null
  district?: string | null
  province?: string | null
  city?: string | null
  regStatus?: string | null
  rawFields?: Record<string, unknown> | null
}

/** 差异原因 + **成对**的后续措施。 */
export interface RosterImportDifference {
  enterpriseName?: string
  uscc?: string | null
  titleCode: string
  direction: 'missing_in_miit' | 'extra_in_miit'
  status?:
    | 'not_queried'
    | 'query_failed'
    | 'no_record'
    | 'confirmed_no_diff'
    | 'confirmed_reason'
    | 'needs_review'
  reasonCode?: string | null
  reasonNote?: string | null
  measureCode?: string | null
  measureNote?: string | null
  evidenceQueryId?: number | null
  evidenceRelationId?: number | null
  /** 平台**查询**的自然键（指向本批新建的查询）。与 `evidenceQueryId` 恰给其一。 */
  evidenceQueryRef?: RosterPlatformRef
  /** 平台**关系**的自然键（指向本批新建的关系）。与 `evidenceRelationId` 恰给其一。 */
  evidenceRelationRef?: RosterPlatformRef
  /** 迁入承载；缺项留空待核，不猜。 */
  movedIn?: {
    city?: string | null
    titleCode?: string | null
    year?: number | null
    batch?: number | null
  } | null
  verificationStatus?: 'confirmed' | 'pending'
  /** 该解释的登记时点（时态化排序键）；**必填**。 */
  recordedAt: string
}

/**
 * 归并与回填（契约 §5.2 的写入形状 —— §8.3 原来缺这一项，由 RL-11 增量补齐）。
 *
 * 语义：确认主体后**不是 UPDATE `uscc_norm`**（会撞 `enterprise_uscc_norm_uq`），
 * 而是一次 MERGE：写曾用名 → 迁子行 → 解决 `record_identity_uq` 冲突（事件与出处
 * **一条都不合并、不折叠、不删除**）→ 删除被并企业行。血缘落 `import_batch.item_results`。
 */
export interface RosterImportMerge {
  /** 被并企业 id。与 `fromEnterpriseName` 恰给其一。 */
  fromEnterpriseId?: number
  /** 被并企业名称（按归一化名找）。 */
  fromEnterpriseName?: string
  /** 规范行（保留的那家）的统一社会信用代码。 */
  intoUscc: string
  /**
   * **规范行的主名称**（§5.3 ①：以工信部导出表/最新平台态为准）。
   *
   * 给了就把规范行的 `name` 改成它，**被顶掉的原名**落成 `enterprise_alias`
   * （`verification_status='confirmed'`，来源 = 本次归并的来源行）。不给（或与原名相同）
   * ⇒ **不改名**（缺省行为，向后兼容）。
   *
   * **导出表侧没有该企业的名字时留空，不猜**；调用方只在真的拿到导出表侧的名字时才填。
   */
  canonicalName?: string | null
  /** 写进曾用名的名称；不给则用被并企业的现名。 */
  aliasName?: string
  /** 曾用名的来源类别；默认 `manual`。 */
  sourceKind?: 'platform_business' | 'platform_apply' | 'announcement' | 'manual'
  /** 曾用名的来源证据行 id（如 `platform_relation.id`，**已存在**的行）。 */
  sourceRefId?: number
  /** 曾用名来源关系行的**自然键**（可指向本批新建的关系）。与 `sourceRefId` 恰给其一。 */
  sourceRelationRef?: RosterPlatformRef
  /** 支撑这次归并的查询证据（记入血缘）。与 `evidenceQueryRef` 恰给其一。 */
  evidenceQueryId?: number | null
  /** 支撑这次归并的查询证据的**自然键**（可指向本批新建的查询）。 */
  evidenceQueryRef?: RosterPlatformRef
  note?: string | null
}

/**
 * **公开来源证据**（RL-06）：补录统一社会信用代码必须**可复核**。
 *
 * 票面第 3 条：「每个补入代码均保存可复核的公开内容来源、查证日期和主体对应依据」——
 * 所以这三样在契约里是**必填**，缺一即 `source_evidence_incomplete`，整批 `failed`。
 * 搜索引擎摘要**不算**主体证据（票面明写）：`url` 要指向内容页，`basis` 要说清
 * 「为什么这个主体就是本企业」。
 */
export interface RosterImportUsccSource {
  /** 可复核的公开内容来源 URL。 */
  url: string
  /** 查证日期（`YYYY-MM-DD`）。 */
  checkedOn: string
  /** 名称 / 地区对应依据。 */
  basis: string
  /** 来源里写出的主体名称（原值，留档）。 */
  name: string
  /** 来源给出的地区（如 `宁波市/鄞州区`）；给不出留空，不猜。 */
  region?: string | null
}

/**
 * **补录统一社会信用代码**（RL-06 增量，`payload.usccBackfills`）。
 *
 * ── 它补的是 `payload` 缺的那一格 ────────────────────────────────────────
 * §5.2 / §8.4 的 `merges` 只覆盖「规范行**已经存在**（该统代已挂在某家企业行上）」的情形 ——
 * 那是**归并**。而 RL-06 走「库内核心词 → 候选 → 平台按统代验证」这条路时，候选统代有时
 * **库里还没有任何一行持有**（该企业只出现在公布名单里，导出表从未见过它）：
 * 这时没有任何「规范行」可以并过去，`merges` 表达不了，而 `announcement.records[].enterprise.uscc`
 * 又会按统代**另起一行**（`upsertEnterprise` 有统代只按统代匹配）—— 那正是要避免的重复。
 *
 * 所以这里加一个**显式的、最小的**写入形状：给一家**本来没有统代**的企业**补上**这个值。
 *
 * ── 硬边界（票面第 4/5 条）──────────────────────────────────────────────
 *  - **只补缺失值**：企业已有统代 ⇒ `uscc_already_present`，**不覆盖**；
 *  - **不做身份合并**：这个统代已被**别的**企业占用 ⇒ `uscc_taken`（冲突），
 *    要合并请走 `merges`（那条路要求平台关系证据，且是另一件事）；
 *  - **不猜**：代码格式/校验位不合法 ⇒ `uscc_format_invalid`；来源三要素不齐 ⇒
 *    `source_evidence_incomplete`。任一项不过 ⇒ 整批 `failed`，业务数据一行不落。
 *  - 不写别名、不改名、不动 `record` —— 名称沿革是 `aliases` / `merges` 的事。
 */
export interface RosterImportUsccBackfill {
  /** 归属企业 id。与 `enterpriseName` 恰给其一。 */
  enterpriseId?: number
  /** 归属企业名称（按归一化名找）。 */
  enterpriseName?: string
  /** 补入的统一社会信用代码；格式与校验位必须合法（GB 32100-2015）。 */
  uscc: string
  /** 公开来源证据（三要素必填）。 */
  source: RosterImportUsccSource
  note?: string | null
}

/** 预检与提交共用的写入载荷。 */
export interface RosterImportPayload {
  officialEvidenceAppends?: OfficialEvidenceAppend[]
  officialEvidenceCorrections?: OfficialEvidenceCorrections
  /** Returned by opt-in preflight, checked again under the writer lock. */
  officialEvidencePlanHash?: string
  announcement?: RosterImportAnnouncement
  aliases?: RosterImportAlias[]
  platformQueries?: RosterImportPlatformQuery[]
  /** Server reads original observations; 1..100 per request, no client hashes/raw. */
  platformRecordObservations?: { relationId: number }[]
  exportSnapshot?: RosterImportExportSnapshot
  differences?: RosterImportDifference[]
  /** 归并与回填（RL-11 增量扩展，见 `RosterImportMerge`）。 */
  merges?: RosterImportMerge[]
  /**
   * 给**本来没有统代**的企业补录代码（RL-06 增量，见 `RosterImportUsccBackfill`）。
   * 与 `merges` 的分工：`merges` 并身份，`usccBackfills` 只补一个缺失的值。
   */
  usccBackfills?: RosterImportUsccBackfill[]
}

/** 一次写入请求（预检与提交共用；幂等键在 body）。 */
export interface RosterImportRequest {
  /** 幂等键；库层面唯一。同一来源重复调用必须给同一个值。 */
  idempotencyKey: string
  sourceKind: 'announcement' | 'platform_export' | 'platform_archive' | 'alias_evidence'
  /** 来源身份：文件相对路径 / 逻辑标识（**不含凭证**）。 */
  sourceIdentity: string
  sourceSha256?: string | null
  payload: RosterImportPayload
}

// ---------------------------------------------------------------------------
// 响应形状（契约 §8.1 / §8.2）
// ---------------------------------------------------------------------------

/** 逐项结果 / 失败（可逐条修复）。失败形状固定为 `{ ok:false, kind, ref, error }`。 */
export interface RosterImportItemResult {
  ok: boolean
  kind: string
  ref: string
  error?: { code: string; field?: string; message: string }
  /** 成功项可带补充信息（如归并血缘、写入的行 id）。 */
  detail?: Record<string, unknown>
}

/**
 * **重名候选**（RL-14）—— 导入**新建企业**时，库里已存在 `name_norm` 相同的企业行。
 *
 * ── 为什么要有它（真实事故）──────────────────────────────────────────────
 * `upsertEnterprise` 的身份规则是「**有统代只按统代、无统代才按名**」（这个行为本身正确：
 * 按名自动合并会踩「同名多主体」，规格明令禁止）。后果是：同一家公司带着统代再进来一次，
 * 就会与既有那条「同名但无统代」的行**另起一行**，而**导入报告里一个字都没有** ——
 * 实测导入经信局历年小巨人工作簿后静默多出 4 家重复企业身份。
 *
 * 本结构把这件事**显式化**：不改匹配规则、不自动合并，只如实报出「新建这一行时，
 * 库里已经有同名的另一行」。是否归并由**证据**决定（见 `docs/roster-lifecycle-contract.md`
 * §8.8 与 §5.3），候选本身不是结论。
 */
export interface DuplicateNameCandidate {
  /** 判定依据。目前只有一种：归一化名相同（`same_name_norm`）。 */
  basis: 'same_name_norm'
  /** 归一化名（两侧相同，就是判据本身）。 */
  nameNorm: string
  /** 展示用的企业名（本批新建侧的原值）。 */
  name: string
  /** 被比对的**既有**一侧：库里已有、或**本批更早**写入的同名行。 */
  existingEnterpriseId: number | null
  existingEnterpriseName: string
  /** 既有行的统代；无统代的既有行是 `null`（事故里正是这种）。 */
  existingUscc: string | null
  /** 本批**新建**的那一行。 */
  newEnterpriseId: number | null
  /** 新建行的统代（新建必然带统代，否则会按名命中既有行）。 */
  newUscc: string | null
  /** 触发新建的**载荷项引用**（如 `record:3`），供逐项追溯。 */
  sourceRef: string
}

/** Candidate input diagnostics are not a projected post-commit qualification. */
export interface RosterImportQualificationDiagnostic extends OfficialEventFieldDiagnostics {
  ref: string
  eventType: RosterImportEvent['eventType']
}
/** Original candidate diagnostics retained for one exact successful historical item. */
export type RosterImportHistoricalQualificationDiagnostics =
  | { status: 'captured'; items: RosterImportQualificationDiagnostic[] }
  | { status: 'not_retained'; reason: 'legacy_receipt' }
  | { status: 'unavailable'; reason: 'read_unavailable' }
export type RosterImportBeforeQualificationReadback =
  | { stage: 'before'; status: 'captured'; target: { enterpriseId: number }; assessment: CurrentQualificationSnapshot }
  | { stage: 'before'; status: 'not_retained'; target: null; reason: 'new_target' | 'multiple_targets' | 'scope_not_established'; enterpriseIds?: number[] }
  | { stage: 'before'; status: 'unavailable'; target: { enterpriseId: number }; reason: 'response_limit'; requiredBytes: number }
  | { stage: 'before'; status: 'unavailable'; target: { enterpriseId: number }; reason: 'read_unavailable' }

/** Immutable observation of a successful announcement commit, never a qualification authority. */
export type RosterImportAfterQualificationReadback =
  | { stage: 'after'; status: 'captured'; target: { enterpriseId: number }; assessment: CurrentQualificationSnapshot }
  | { stage: 'after'; status: 'not_retained'; target: null; reason: 'multiple_targets' | 'no_targets' | 'scope_not_established' | 'legacy_receipt'; enterpriseIds?: number[] }
  | { stage: 'after'; status: 'unavailable'; target: { enterpriseId: number }; reason: 'response_limit'; requiredBytes: number }
  | { stage: 'after'; status: 'unavailable'; target: { enterpriseId: number }; reason: 'read_unavailable' }

/** 预检的影响计数；`conflicts` 是**逐项冲突**（不静默丢行）。 */
export interface RosterImportPreflight {
  qualificationDiagnostics?: RosterImportQualificationDiagnostic[]
  /** Current stored facts only. No after/historical capture is implied by this field. */
  qualificationReadback?: RosterImportBeforeQualificationReadback
  officialEvidencePlanHash?: string
  canonicalProjection?: { relationId: number | null; identityState: string; contentState: string; keySource: string }[]
  /** Frozen server-side source inputs for bounded historical projection. */
  platformObservationSources?: { relationId: number; inputFingerprint: string }[]
  /** 将新增的行数（任一新行，含企业/记录/事件/出处/别名/关系/快照行/差异/归并）。 */
  add: number
  /** 将复用/更新的既有行数。 */
  update: number
  /** 归并会删除的企业行数。 */
  remove: number
  /** 落在待核状态的行数（`pending` / `needs_review` / 未知枚举原样入库）。 */
  review: number
  conflicts: RosterImportItemResult[]
  /**
   * **行口径**：本次提交会真的改掉几行 `record_evidence.source_file`（出处指针收敛，RL-16/RL-19）。
   *
   * 为什么它和 `update` 不是同一个数：`update` 的单位是**计划项**（一个 `payload.records[]` 条目算一，
   * 见契约 §8.5），而一条记录可以带多条事件、每条事件各有出处 —— 实测小巨人工作簿
   * `update: 510`（510 条记录）而 `evidenceRepoints: 511`（511 行出处，有一条记录跨两批）。
   * 两处都报出来，「预检答应的」与「提交真改的」才逐行可比对。
   */
  evidenceRepoints: number
  /** 本次导入会**新建**的重名候选（RL-14；明细可与提交后的 `item_results` 对照）。 */
  duplicateCandidates?: DuplicateNameCandidate[]
  /**
   * 预检时该幂等键在库里的批次状态（RL-19）。
   *
   * `'committed'` 是一个**必须看见**的信号：同键的 `commit` 不会再写任何东西（§8.2 的幂等），
   * 此时上面的计数一律为 0 —— 若还有出处指针要收敛，走 `POST /api/roster/import/replay`（§8.9.3）。
   */
  batchStatus?: 'preflight' | 'committed' | 'failed'
}

export interface RosterImportPreflightResponse {
  batchId: number
  status: 'preflight'
  preflight: RosterImportPreflight
}

export interface RosterImportSummary {
  /** Separate from the legacy query/relation rowsWritten count. */
  canonicalProjection?: import('./platform/business-record').PlatformProjectionSummary
  written: number
  skipped: number
  failed: number
  /**
   * **行口径**：本次提交真的改掉了几行 `record_evidence.source_file`（出处指针收敛，RL-16/RL-19）。
   *
   * 与 `preflight.evidenceRepoints` 同口径、可直接相等比对；它**不计入** `written`
   * （那是**新增**的行数）。逐项明细在 `items[].detail.evidenceRepointed`。
   */
  evidenceRepointed: number
}

export interface RosterImportCommitResponse {
  /** Saved in existing batch/receipt JSON and returned here once, including on replay. */
  qualificationReadback?: RosterImportAfterQualificationReadback
  /** #214: durable candidate-task IDs for archived query scopes; does not imply candidate completion. */
  candidateTaskIds?: string[]
  batchId: number
  status: 'committed' | 'failed'
  summary: RosterImportSummary
  items: RosterImportItemResult[]
  error?: string | null
}

/**
 * **出处指针收敛重放**的响应（RL-19，契约 §8.9.3）。
 *
 * 用途：幂等键已被消费（批次已 `committed`）、而库里仍有出处行指着库外/旧路径时，
 * 用**同一份请求体**调 `POST /api/roster/import/replay` 把指针收敛掉。
 */
export interface RosterImportReplayResponse {
  /** 本次收敛的记账批次 id（键 = `<原幂等键>#repoint`，见 §8.9.3）。 */
  batchId: number
  status: 'replayed' | 'failed'
  /** 计划口径（与 §8.5 的 `update` 同口径）：本次将收敛的**计划项**数。 */
  update: number
  /** 行口径：本次**真的**改掉的出处行数（= 预检 `evidenceRepoints` 的同口径值）。 */
  evidenceRepointed: number
  items: RosterImportItemResult[]
  error: string | null
}

// ---------------------------------------------------------------------------
// HTTP 客户端
// ---------------------------------------------------------------------------

/** 预检路径。 */
export const ROSTER_IMPORT_PREFLIGHT_PATH = '/api/roster/import/preflight'
/** 提交路径。 */
export const ROSTER_IMPORT_COMMIT_PATH = '/api/roster/import/commit'
/** 出处指针**收敛重放**路径（RL-19，契约 §8.9.3）。请求体同提交。 */
export const ROSTER_IMPORT_REPLAY_PATH = '/api/roster/import/replay'

/** 服务端返回非 2xx（或响应体不是预期形状）时抛出。 */
export class RosterImportApiError extends Error {
  readonly status: number
  readonly body: unknown

  constructor(status: number, message: string, body: unknown) {
    super(message)
    this.name = 'RosterImportApiError'
    this.status = status
    this.body = body
  }
}

export interface RosterImportClientOptions {
  /** app 基址，如 `http://127.0.0.1:3470`（不带尾斜杠）。 */
  baseUrl: string
  /** `NUXT_API_TOKEN` 的值。**只从运行时密钥存储取**，不写进仓库/日志。 */
  token: string
  /** 注入 fetch（测试/自建代理用）；默认全局 `fetch`。 */
  fetch?: typeof fetch
}

/** 名录统一导入 API 的最小客户端。 */
export class RosterImportClient {
  private readonly baseUrl: string
  private readonly token: string
  private readonly doFetch: typeof fetch

  constructor(options: RosterImportClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '')
    this.token = options.token
    this.doFetch = options.fetch ?? globalThis.fetch
  }

  /** 只读预检：算影响、落一条 `status='preflight'` 的批次，**不写业务数据**。 */
  async preflight(request: RosterImportRequest): Promise<RosterImportPreflightResponse> {
    return (await this.post(ROSTER_IMPORT_PREFLIGHT_PATH, request)) as RosterImportPreflightResponse
  }

  /** 事务提交。同一幂等键重复调用返回既有批次的摘要，不重复写企业/事件。 */
  async commit(request: RosterImportRequest): Promise<RosterImportCommitResponse> {
    return (await this.post(ROSTER_IMPORT_COMMIT_PATH, request)) as RosterImportCommitResponse
  }

  /**
   * **出处指针收敛重放**（RL-19，契约 §8.9.3）：只把既有出处行的 `source_file` 收敛到
   * 载荷给的新路径，一行不加、一行不删。对已 `committed` 的幂等键也能跑。
   */
  async replay(request: RosterImportRequest): Promise<RosterImportReplayResponse> {
    return (await this.post(ROSTER_IMPORT_REPLAY_PATH, request)) as RosterImportReplayResponse
  }

  private async post(path: string, body: unknown): Promise<unknown> {
    const response = await this.doFetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // 只从运行时取；header 名固定，值不进仓库。
        authorization: `Bearer ${this.token}`,
      },
      body: JSON.stringify(body),
    })
    const text = await response.text()
    let parsed: unknown = null
    try {
      parsed = text ? JSON.parse(text) : null
    } catch {
      parsed = text
    }
    if (!response.ok) {
      const message =
        parsed && typeof parsed === 'object' && 'message' in parsed
          ? String((parsed as { message: unknown }).message)
          : typeof parsed === 'string' && parsed
            ? parsed
            : `名录导入接口返回 ${response.status}`
      throw new RosterImportApiError(response.status, message, parsed)
    }
    return parsed
  }
}

/** 构造客户端（等价 `new RosterImportClient(options)`，给不习惯 `new` 的调用点）。 */
export function createRosterImportClient(options: RosterImportClientOptions): RosterImportClient {
  return new RosterImportClient(options)
}
