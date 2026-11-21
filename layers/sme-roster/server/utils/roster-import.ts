import { insertEnterprise, insertEnterpriseAlias, moveEnterpriseAlias, updateEnterprise } from '../../../core/server/public'
import { collectionImportSource,collectionImportPreview,writeImportedCollection,verifyImportedCollectionFields,historicalObservationPlan,ensureHistoricalObservation } from './collection-import-target'
import { withFingerprintVerificationSnapshot } from '../../lib/platform/fingerprint-verifier'
import { sqliteConnection } from '../../lib/platform/target-connection'
import { targetCandidateTables } from './candidate-target-sources'
import { targetDifferenceReason } from '../../lib/platform/difference-reference-target'
import { readDifferenceCollection,readDifferenceCollectionScope,readDifferenceObservation } from '../../lib/platform/difference-sources'
import { queryEvidenceError } from '../../lib/platform/query-evidence'
import { platformQuerySourceConflict,stagedPlatformQuerySource,type PlatformQueryReplaySource } from '../../lib/platform/query-replay'
import { enqueueArchivedCandidates } from './jobs/candidate-discovery'
import { managedDecision102 } from './decision-lifecycle-102'
import { applyProjectionPreview,businessProjectionPreview,planPlatformObservation,PlatformProjectionError,projectionPreview,recognizedProjectionPreview } from './platform-business-record'
import type { PlatformProjectionResult,PlatformProjectionSummary } from '../../lib/platform/business-record'
import { isDeepStrictEqual } from 'node:util'
import { RDJB_TITLE_CODES } from '../../lib/platform/recognized-evidence'
import { normalizePlatformRelation } from '../../lib/platform/normalization'
import { platformRelationInputSchema } from './roster-import-platform-schema'
/**
 * 名录统一导入的**核心实现**（RL-11）—— 预检与单批事务提交（契约 §8）。
 *
 * 本文件是纯逻辑（只吃 `db` 与请求对象），不碰 h3/runtimeConfig：
 *  - HTTP 那一层（鉴权判据、状态码、JSON 形状）在 `layers/sme-roster/server/utils/roster-import-http.ts`；
 *  - 两个路由文件只是把 event 翻成本模块的入参。
 *
 * ── 两条硬约束 ──────────────────────────────────────────────────────────
 * 1. **单批事务**：要么整批 `committed`，要么 `failed` 且 `error` 说明原因 ——
 *    绝不部分提交。业务写入全在一个 SQLite 事务里；批次行本身是**记账**（不在事务内读回），
 *    这样事务回滚后仍能记下「失败原因 + 逐项错误」。
 * 2. **逐项错误不静默丢行**：每个载荷项都产出 `{ ok, kind, ref }`；任何一项不合法 ⇒
 *    整批 `failed`、业务数据一行不落，`items` 里带着每项的错误码与字段名。
 *
 * ── 为什么先「计划」再「执行」───────────────────────────────────────────
 * 预检若自己算一套、提交再算一套，两边迟早会漂。这里**同一份 `planRosterImport`**
 * 既用于预检（只报数），也用于提交（照计划执行）—— 预检报的影响就是提交真会发生的事。
 */

import { createHash } from 'node:crypto'
import { and,desc,eq,inArray,isNull,ne,sql,type SQL } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '../../../../db/schema'
import { isPageCapable } from '../../lib/roster/evidence-page'
import { normalizeName,normalizeUscc } from '../../lib/domain'
import { duplicateCandidatesFromBatch, duplicateTwinKey } from '../../lib/roster/duplicate-merge'
import { missingUsccSourceFields,usccFormatVerdict } from '../../lib/roster/uscc-research'
import { diagnoseOfficialEventFields,readCurrentQualificationAssessment } from '../../lib/roster/current-qualification'
import { PLATFORM_INTERFACE_VALUES,TITLE_ORDER,type PlatformInterface } from '../../lib/labels'
import type {
DuplicateNameCandidate,
RosterImportAlias,
RosterImportAnnouncement,
RosterImportDifference,
RosterImportEvidence,
RosterImportEvent,
RosterImportExportSnapshot,
RosterImportItemResult,
RosterImportMerge,
RosterImportPayload,
RosterImportPlatformQuery,RosterImportPreflight,
RosterImportQualificationDiagnostic,
RosterImportHistoricalQualificationDiagnostics,
RosterImportAfterQualificationReadback,
RosterImportReplayResponse,
RosterImportRequest,
RosterImportSummary,
RosterImportUsccBackfill
} from '../../lib/roster-import-client'
import { officialAppendSchema,officialPublishedRowSchema,planOfficialEvidenceChanges,resolveOfficialDeclaration,verifyOfficialDeclaration,writeOfficialPublishedRow,readOfficialFile,officialPlanDigest,OfficialFactError,type OfficialClaimChange,type OfficialCoordinate } from './official-evidence-plan'
import { OfficialEvidenceError } from './official-evidence'
import { evidenceCorrectionRequestSchema,planEvidenceCorrectionTargets,writeImportedEvidenceCorrection } from './roster-evidence-correction'
import { advanceOfficialEventRevision } from './roster-event-version'
import { ensureBatchRow,findBatchByKey } from './roster-batch-ledger'
import { captureIdentityRevision113,identityMaterial113,selectedSnapshot113,captureSnapshotRevision113,captureOfficialEventRevision113 } from './evidence-impact-113'
import { recordImportReceipt } from './import-receipt-ledger'
import { refreshDerivedFileParts } from './file-parts'
import { legacyPlatformProvenanceItemsSchema } from '../../lib/platform/legacy-provenance'
import { inspectLegacyPlatformProvenance,writeLegacyPlatformProvenance,LegacyProvenanceError } from './platform-legacy-provenance'
import { canonicalEnterpriseId,currentEnterpriseIdentity } from '../../lib/roster/enterprise-identity'
import { mergeTargetEnterpriseIdentity } from './enterprise-merge-target'

type Db = BetterSQLite3Database<typeof schema>
/** Internal persistence only; the public summary keeps its existing counts/projection shape. */
type StoredImportDiagnosticBinding = {
  itemIndex: number; ref: string; enterpriseId: number; recordId: number; candidateRef: string
  diagnostics: RosterImportHistoricalQualificationDiagnostics
  digest: string
}
type StoredImportSummary = RosterImportSummary & {
  qualificationReadback?: RosterImportAfterQualificationReadback
  qualificationDiagnosticsByItem?: Record<string, StoredImportDiagnosticBinding>
}
/** 事务内外都能用的执行器（`tx` 与本连接在 select/insert/update/delete 上同形）。 */
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]
export type Executor = Db | Tx

// ---------------------------------------------------------------------------
// 校验用的取值集
// ---------------------------------------------------------------------------
//
// 这些集合**不重述取值** —— 一律从既有的冻结出处派生：
//  - 表列的枚举取自 `db/schema.ts` 的 `*.enumValues`（drizzle 把 `text('c',{enum:[…]})`
//    的取值挂在列对象上），于是「表的枚举」与「写入侧的校验」不可能各自漂移；
//  - 没有表列的（称号、平台接口）取自 `layers/sme-roster/lib/labels.ts` / `db/titles.ts` 的既有常量。
// 旧写法是把 `not_queried` / `failed` / … 逐个再抄一遍，抄漏一个就成了静默放行。

/** 把一列已冻结的枚举取值变成校验集合。 */
function enumSet(values: readonly string[]): Set<string> {
  return new Set(values)
}

/** 称号字典（`db/titles.ts` 的种子；不引 runtime）。 */
const TITLE_CODES = new Set<string>(TITLE_ORDER)
const EVENT_TYPES = enumSet(schema.recordEvent.eventType.enumValues)
const REVIEW_OUTCOMES = enumSet(schema.recordEvent.reviewOutcome.enumValues)
const SOURCES = enumSet(schema.record.source.enumValues)
const ALIAS_SOURCE_KINDS = enumSet(schema.enterpriseAlias.sourceKind.enumValues)
const VERIFICATION_STATUSES = enumSet(schema.enterpriseAlias.verificationStatus.enumValues)
/** 平台接口取值集 = `layers/sme-roster/lib/labels.ts` 的唯一出处（契约 §2.4）。 */
const PLATFORM_INTERFACE_SET = new Set<string>(PLATFORM_INTERFACE_VALUES)
const QUERY_STATUSES = enumSet(schema.platformCollection.status.enumValues)
const MATCH_BASES = enumSet(schema.platformObservationAssignment.matchBasis.enumValues)
const DIRECTIONS = enumSet(schema.differenceReason.direction.enumValues)
const DIFFERENCE_STATUSES = enumSet(schema.differenceReason.status.enumValues)
const DIFFERENCE_REASONS = enumSet(schema.differenceReason.reasonCode.enumValues)
const DIFFERENCE_MEASURES = enumSet(schema.differenceReason.measureCode.enumValues)
// Correspondence decisions share the batch ledger, but are never a roster-import payload.
const IMPORT_SOURCE_KINDS = new Set<string>(['announcement', 'platform_export', 'platform_archive', 'alias_evidence'])
/** `sblx` 的字典取值；之外的**原样入库 + 标待核**（不因未知取值崩溃）。 */

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

/**
 * 归一化统一社会信用代码;**空值 → `null`**(写入侧按「未给统代」处理)。
 * 归一化规则本身只有一处实现:{@link normalizeUscc}(`layers/sme-roster/lib/domain.ts`,紧邻 `normalizeName`)。
 */
function usccOrNull(raw: unknown): string | null {
  return normalizeUscc(raw) || null
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function optionalString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed || null
}

function optionalInt(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return Math.trunc(value)
}

/** Typed coordinates are verbatim; the old legacy grouping/write rules stay local. */
export function announcementEvidenceCoordinate(evidence: { sourceFile: string; attachment?: unknown; listNo?: unknown; page?: unknown; publishedRow?: unknown }, grouped = false): OfficialCoordinate {
  if (evidence.publishedRow !== undefined) return {
    sourceFile: evidence.sourceFile,
    attachment: typeof evidence.attachment === 'string' ? evidence.attachment : null,
    listNo: typeof evidence.listNo === 'number' ? evidence.listNo : null,
    page: typeof evidence.page === 'number' ? evidence.page : null,
  }
  const sourceFile = grouped ? optionalString(evidence.sourceFile) ?? evidence.sourceFile : evidence.sourceFile
  return { sourceFile, attachment: optionalString(evidence.attachment), listNo: optionalInt(evidence.listNo), page: isPageCapable(sourceFile) ? optionalInt(evidence.page) : null }
}

/** 一条 item 级错误。 */
function failure(kind: string, ref: string, code: string, message: string, field?: string): RosterImportItemResult {
  return { ok: false, kind, ref, error: { code, ...(field ? { field } : {}), message } }
}

function success(kind: string, ref: string, detail?: Record<string, unknown>): RosterImportItemResult {
  return { ok: true, kind, ref, ...(detail ? { detail } : {}) }
}

// ---------------------------------------------------------------------------
// 请求校验
// ---------------------------------------------------------------------------

export type ValidateResult =
  | { ok: true; value: RosterImportRequest }
  | { ok: false; status: number; message: string }

export function validateImportRequest(raw: unknown): ValidateResult {
  if (!isObject(raw)) return { ok: false, status: 400, message: '请求体必须是 JSON 对象' }

  const idempotencyKey = optionalString(raw.idempotencyKey)
  if (!idempotencyKey) {
    return { ok: false, status: 400, message: '缺少 idempotencyKey（幂等键）' }
  }
  const sourceKind = optionalString(raw.sourceKind)
  if (!sourceKind || !IMPORT_SOURCE_KINDS.has(sourceKind)) {
    return {
      ok: false,
      status: 400,
      message: `sourceKind 必须是 announcement / platform_export / platform_archive / alias_evidence 之一，收到：${sourceKind ?? '(空)'}`,
    }
  }
  const sourceIdentity = optionalString(raw.sourceIdentity)
  if (!sourceIdentity) {
    return { ok: false, status: 400, message: '缺少 sourceIdentity（来源身份：文件相对路径或逻辑标识）' }
  }
  if (!isObject(raw.payload)) {
    return { ok: false, status: 400, message: '缺少 payload（写入载荷）或它不是对象' }
  }
  const projectionError = validatePlatformProjectionPayload(raw.payload, sourceKind)
  if (projectionError) return { ok: false, status: 400, message: projectionError }

  return {
    ok: true,
    value: {
      idempotencyKey,
      sourceKind: sourceKind as RosterImportRequest['sourceKind'],
      sourceIdentity,
      sourceSha256: optionalString(raw.sourceSha256),
      payload: raw.payload as RosterImportPayload,
    },
  }
}

/** Strict additive field validation: malformed/empty projection commands cannot silently succeed. */
export function validatePlatformProjectionPayload(payload: Record<string, unknown>, sourceKind: string): string | null {
  if (Object.hasOwn(payload, 'platformLegacyProvenance')) {
    if (sourceKind !== 'platform_archive') return 'platformLegacyProvenance requires sourceKind=platform_archive'
    const parsed = legacyPlatformProvenanceItemsSchema.safeParse(payload.platformLegacyProvenance)
    if (!parsed.success) return `platformLegacyProvenance: ${parsed.error.issues.map(issue => issue.message).join('; ')}`
  }
  if (Object.hasOwn(payload, 'platformRecordObservations')) {
    const rows = payload.platformRecordObservations
    if (sourceKind !== 'platform_archive') return 'platformRecordObservations requires sourceKind=platform_archive'
    if (!Array.isArray(rows) || rows.length < 1 || rows.length > 100) return 'platformRecordObservations must contain 1..100 observations'
    const seen = new Set<number>()
    for (const row of rows) {
      if (!isObject(row) || Object.keys(row).length !== 1 || !Number.isSafeInteger(row.relationId) || (row.relationId as number) < 1) return 'platformRecordObservations items require only a positive safe integer relationId'
      if (seen.has(row.relationId as number)) return 'platformRecordObservations relationId must be unique per request'
      seen.add(row.relationId as number)
    }
  }
  if (sourceKind === 'platform_archive' && !Object.hasOwn(payload, 'platformLegacyProvenance') && !Object.hasOwn(payload, 'platformRecordObservations') && (!Array.isArray(payload.platformQueries) || !payload.platformQueries.length)) return 'platform_archive requires platformQueries, platformRecordObservations or platformLegacyProvenance'
  return null
}

// ---------------------------------------------------------------------------
// 企业身份解析（读）
// ---------------------------------------------------------------------------

interface ResolvedEnterprise {
  id: number
  name: string
  nameNorm: string
  usccNorm: string | null
}

/** 按身份规则定位企业的入参（`name` / `uscc` 至少给一个；`uscc` 空串等同没给）。 */
type EnterpriseSpec = { name?: string | null; uscc?: string | null }

/**
 * 定位企业时要取的列 —— **只有**这四列（{@link ResolvedEnterprise} 的形状）。
 *
 * 只取这四列是有意的（RL-18）：`enterprise` 表还有 `district` / `quality_flags` 等列，
 * 而按身份键定位一行用不到它们。
 */
const enterpriseColumns = {
  id: schema.enterprise.id,
  name: schema.enterprise.name,
  nameNorm: schema.enterprise.nameNorm,
  usccNorm: schema.enterprise.usccNorm,
}

/**
 * 按统代定位企业（**唯一**的身份键之一；重名候选与归并读侧共用这一份）。
 *
 * RL-18：**按键定位** —— 谓词进 `WHERE`、命中 `enterprise_uscc_norm_uq`（唯一索引）。
 * 以前是 `select().all().find(...)`，即每次调用都整表读进内存再线性找；而这条路径是
 * **写入阶段每条平台关系**都要走一次的（`enterpriseByExactUscc`），企业表达万行时
 * 单批就是分钟级 —— 实测对比见契约 §3.1c。
 */
export function findEnterpriseByUscc(db: Executor, usccNorm: string): ResolvedEnterprise | null {
  const row = db
    .select(enterpriseColumns)
    .from(schema.enterprise)
    .where(eq(schema.enterprise.usccNorm, usccNorm))
    .get()
  return row ? findEnterpriseById(db, row.id) : null
}

/** 按行 id 定位企业（归并/候选在写入阶段解析真 id 时用）—— RL-18：命中主键。 */
export function findEnterpriseById(db: Executor, id: number): ResolvedEnterprise | null {
  const canonicalId = canonicalEnterpriseId(db, id)
  if (canonicalId === null) return null
  return db
    .select(enterpriseColumns)
    .from(schema.enterprise)
    .where(eq(schema.enterprise.id, canonicalId))
    .get() ?? null
}

/**
 * 按归一化名定位企业 —— RL-18：命中 `enterprise_name_norm_idx`。
 *
 * 这条索引**不唯一**（同名多主体正是本模型要如实保留的），所以命中可能不止一行。
 * 取「第一行」的口径与改前一致：`.get()` 与原来的 `.all().find()` 都是**按 rowid 升序的第一行**
 * —— 全表扫描本就是 rowid 序；走索引时索引项是 `(name_norm, rowid)` 序，同一 `name_norm` 内
 * 仍是 rowid 序。（实测把查询计划逼成 `SCAN enterprise` 也仍取到同一行，见
 * `tests/roster-import-semantics.test.ts` 的同名多主体场景。）
 *
 * 一处**已知且不可达**的差别：SQL 绑定经 better-sqlite3 的 UTF-8 编码，**落单的代理对**
 * （lone surrogate）会被换成 U+FFFD，于是它**可能**匹配到 JS `===` 匹配不到的行。
 * `nameNorm` 一律来自 {@link normalizeName}，输入是真实企业名／平台 JSON，取不到落单代理对，
 * 所以这条差别够不着；写在这里是为了不把「完全一致」说成无条件成立。
 */
function findEnterpriseByNorm(db: Executor, nameNorm: string): ResolvedEnterprise | null {
  return db
    .select(enterpriseColumns)
    .from(schema.enterprise)
    .where(and(eq(schema.enterprise.nameNorm, nameNorm), currentEnterpriseIdentity(db)))
    .get() ?? null
}

/**
 * **全部**同名行（`name_norm` 相同）—— 不论它有没有统代。重名候选的判据基础。
 *
 * RL-18：谓词进 `WHERE`（命中 `enterprise_name_norm_idx`）。返回的是**同一个集合**，
 * 且仍是 rowid 升序（重名候选的先后顺序因此不变）——「为什么第一行不变」的完整理由与
 * 那处已知不可达的差别见 {@link findEnterpriseByNorm}。
 */
function findEnterprisesByNorm(db: Executor, nameNorm: string): ResolvedEnterprise[] {
  return db
    .select(enterpriseColumns)
    .from(schema.enterprise)
    .where(and(eq(schema.enterprise.nameNorm, nameNorm), currentEnterpriseIdentity(db)))
    .all()
}

/**
 * 按 {@link upsertEnterprise} 的**身份规则**定位企业：有统代只按统代、无统代才按名。
 *
 * 与 {@link locateEnterprise} 的差别正是本票的事故根因：后者在「统代查不到」时会**退回按名找**，
 * 所以预检会说「企业已存在」，而写入侧（只按统代）却会**新建一行** —— 重复于是静默产生。
 * 这里把写入侧的规则单独摘出来，让「这次到底会不会新建」在预检阶段就能问对。
 */
function findEnterpriseByIdentity(db: Executor, spec: EnterpriseSpec): ResolvedEnterprise | null {
  const uscc = usccOrNull(spec.uscc)
  if (uscc) return findEnterpriseByUscc(db, uscc)
  const name = optionalString(spec.name)
  return name ? findEnterpriseByNorm(db, normalizeName(name)) : null
}

/**
 * 按身份键定位企业：**统代优先，缺失时按归一化名**（既有决策，不改）。
 * 定位不到时返回 `null`（由调用方决定是新建还是报错）。
 */
function locateEnterprise(db: Executor, spec: EnterpriseSpec): ResolvedEnterprise | null {
  const uscc = usccOrNull(spec.uscc)
  if (uscc) {
    const byUscc = findEnterpriseByUscc(db, uscc)
    if (byUscc) return byUscc
  }
  const name = optionalString(spec.name)
  if (name) return findEnterpriseByNorm(db, normalizeName(name))
  return null
}

/** 与某查询键完全相等的企业（只按**统代**，是 `match_basis='uscc'` 的判据，不是模糊匹配）。 */
function enterpriseByExactUscc(db: Executor, usccRaw: unknown): number | null {
  const uscc = usccOrNull(usccRaw)
  if (!uscc) return null
  return findEnterpriseByUscc(db, uscc)?.id ?? null
}

// ---------------------------------------------------------------------------
// 重名候选（RL-14）：把「静默多出一行」变成**显式的一条报告项**
// ---------------------------------------------------------------------------
//
// 事故机制：`upsertEnterprise` 有统代时**只按统代匹配**（正确，按名合并会踩同名多主体），
// 于是「同一家公司带统代再进来一次」会与既有那条「同名但无统代」的行另起一行，
// 而导入报告里一个字都没有。本段**只做显式化**：
//   - 不改 `upsertEnterprise` 的匹配规则；
//   - 不按名自动合并；候选不是结论，归并另由证据驱动（§5.3 / §8.8）。
//
// 判据用的是**写入侧的同一份身份规则**（{@link findEnterpriseByIdentity}），所以预检说
// 「会新建」与提交时**真的新建**是同一件事 —— 这正是以前对不上的地方。

/** 本批将**新建**的企业身份（`records[i]` 一项；不会新建的是 `null`）。 */
interface PendingEnterpriseCreate {
  /** 触发新建的载荷项引用（`record:<i>`）。 */
  ref: string
  name: string
  nameNorm: string
  uscc: string | null
}

/** 一条待写的重名候选：`candidate.newEnterpriseId` 在预检阶段为 `null`（那一行还没建）。 */
interface PlannedDuplicateCandidate {
  candidate: DuplicateNameCandidate
  /** 既有侧的解析口径（执行阶段据此取真 id）。 */
  existing: { kind: 'enterprise'; id: number } | { kind: 'batch'; name: string; uscc: string | null }
}

/** 身份键（与 {@link pendingKeys} 同一套写法）：有统代按统代、无统代按归一化名。 */
function identityKeyOf(spec: { name: string; uscc: string | null }): string {
  return spec.uscc ? usccKey(spec.uscc) : nameKey(normalizeName(spec.name))
}

interface AnnouncementBatchIdentityPlan {
  reviewedOwners?: ReadonlyMap<number, number>
  reviewedCreates?: ReadonlySet<number>
  /** 身份解析使用的 USCC；名称项只会映射到唯一的既有 / 本批身份候选。 */
  identityUsccByRecord: Map<number, string | null>
  ambiguousNameOnlyRecords: Set<number>
}

/**
 * 从整份公告为 name-only 项解析稳定的身份。候选集合同时包含既有同名企业和本批显式 USCC；
 * 只有合并后恰好一个身份时才归组，多个候选失败关闭。
 */
function planAnnouncementBatchIdentity(
  db: Executor,
  records: RosterImportAnnouncement['records'],
): AnnouncementBatchIdentityPlan {
  const usccCandidatesByName = new Map<string, Set<string>>()
  for (const record of records) {
    const name = optionalString(record?.enterprise?.name)
    const uscc = usccOrNull(record?.enterprise?.uscc)
    if (!name || !uscc) continue
    const nameNorm = normalizeName(name)
    const candidates = usccCandidatesByName.get(nameNorm) ?? new Set<string>()
    candidates.add(uscc)
    usccCandidatesByName.set(nameNorm, candidates)
  }

  const existingByName = new Map<string, ResolvedEnterprise[]>()
  const identityUsccByRecord = new Map<number, string | null>()
  const ambiguousNameOnlyRecords = new Set<number>()
  records.forEach((record, index) => {
    const name = optionalString(record?.enterprise?.name)
    const requestedUscc = usccOrNull(record?.enterprise?.uscc)
    let identityUscc = requestedUscc

    if (!requestedUscc && name) {
      const nameNorm = normalizeName(name)
      let existing = existingByName.get(nameNorm)
      if (!existing) {
        existing = findEnterprisesByNorm(db, nameNorm)
        existingByName.set(nameNorm, existing)
      }
      const identities = new Map<string, string | null>()
      for (const enterprise of existing) {
        const existingUscc = enterprise.usccNorm && usccFormatVerdict(enterprise.usccNorm) === 'ok'
          ? usccOrNull(enterprise.usccNorm)
          : null
        const identity = existingUscc
          ? usccKey(existingUscc)
          : `enterprise:${enterprise.id}`
        identities.set(identity, existingUscc)
      }
      for (const uscc of usccCandidatesByName.get(nameNorm) ?? []) {
        identities.set(usccKey(uscc), uscc)
      }
      if (identities.size > 1) {
        ambiguousNameOnlyRecords.add(index)
      } else if (identities.size === 1) {
        identityUscc = [...identities.values()][0] ?? null
      }
    }

    identityUsccByRecord.set(index, identityUscc)
  })

  return { identityUsccByRecord, ambiguousNameOnlyRecords }
}

/**
 * 本批**会新建**的企业（按 `records` 下标对齐；不会新建的是 `null`）。
 *
 * 两层排除，缺一不可：
 *  1. 库里已按身份规则命中 ⇒ 这次是复用，不是新建；
 *  2. 本批**更早**的记录已经新建过同一身份 ⇒ 这条会复用它，也不是新建。
 */
function announcementOwner(db: Executor, plan: AnnouncementBatchIdentityPlan, index: number, name: string, uscc: string | null) {
  const owner = plan.reviewedOwners?.get(index)
  return owner === undefined ? findEnterpriseByIdentity(db, { name, uscc }) : findEnterpriseById(db, owner)
}

function planEnterpriseCreates(
  db: Executor,
  records: RosterImportAnnouncement['records'],
  identityPlan: AnnouncementBatchIdentityPlan,
): Array<PendingEnterpriseCreate | null> {
  const out: Array<PendingEnterpriseCreate | null> = []
  const seen = new Set<string>()
  records.forEach((record, index) => {
    const name = optionalString(record?.enterprise?.name)
    if (!name) {
      out.push(null)
      return
    }
    if (!identityPlan.reviewedOwners?.has(index) && identityPlan.ambiguousNameOnlyRecords.has(index)) {
      out.push(null)
      return
    }
    const uscc = identityPlan.identityUsccByRecord.get(index) ?? usccOrNull(record?.enterprise?.uscc)
    const reviewedOwner = identityPlan.reviewedOwners?.get(index)
    const existing = announcementOwner(db, identityPlan, index, name, uscc)
    if (reviewedOwner !== undefined && existing && identityPlan.reviewedCreates?.has(reviewedOwner)) {
      const key = `enterprise:${reviewedOwner}`
      if (!seen.has(key)) {
        seen.add(key)
        out.push({ ref: `record:${index}`, name: existing.name, nameNorm: existing.nameNorm, uscc: existing.usccNorm })
        return
      }
    }
    if (existing) {
      out.push(null)
      return
    }
    const key = identityKeyOf({ name, uscc })
    if (seen.has(key)) {
      out.push(null)
      return
    }
    seen.add(key)
    out.push({ ref: `record:${index}`, name, nameNorm: normalizeName(name), uscc })
  })
  return out
}

/**
 * 一条新建企业的重名候选：库里（或本批更早）**同名**的行各成一条候选。
 *
 * 同名 = `name_norm` 相同（与全库的身份口径一致），**不看有没有统代** ——
 * 事故里正是「既有那行无统代、新建那行有统代」。
 */
function duplicateNameCandidates(
  db: Executor,
  create: PendingEnterpriseCreate,
  earlierSameName: PendingEnterpriseCreate[],
  reviewedCreates?: ReadonlySet<number>,
  reviewedOwner?: number,
): PlannedDuplicateCandidate[] {
  const base = {
    basis: 'same_name_norm' as const,
    nameNorm: create.nameNorm,
    name: create.name,
    newEnterpriseId: null,
    newUscc: create.uscc,
    sourceRef: create.ref,
  }
  return [
    ...findEnterprisesByNorm(db, create.nameNorm).filter(row => !reviewedCreates?.has(row.id) || (reviewedOwner !== undefined && row.id < reviewedOwner)).map(
      (row): PlannedDuplicateCandidate => ({
        candidate: {
          ...base,
          existingEnterpriseId: row.id,
          existingEnterpriseName: row.name,
          existingUscc: row.usccNorm,
        },
        existing: { kind: 'enterprise', id: row.id },
      }),
    ),
    ...(reviewedOwner === undefined ? earlierSameName : []).map(
      (twin): PlannedDuplicateCandidate => ({
        candidate: {
          ...base,
          existingEnterpriseId: null,
          existingEnterpriseName: twin.name,
          existingUscc: twin.uscc,
        },
        existing: { kind: 'batch', name: twin.name, uscc: twin.uscc },
      }),
    ),
  ]
}

/** 候选的稳定引用（同一批次里唯一，供逐项追溯与去重）。 */
function duplicateCandidateRef(candidate: DuplicateNameCandidate): string {
  return `duplicate_candidate:${candidate.newUscc ?? candidate.nameNorm}~${duplicateTwinKey(candidate)}`
}

/**
 * 执行阶段**补齐 id**：新建行这时才存在。既有侧若本就在库里，其 id 计划时就有
 * （条目描述的正是当时看到的那个状态，故保持原值）；本批更早的同名行这时也已插入，按身份解析。
 */
function resolveDuplicateCandidate(tx: Executor, planned: PlannedDuplicateCandidate, reviewedOwner?: number): RosterImportItemResult {
  const { candidate, existing } = planned
  const existingEnterpriseId =
    existing.kind === 'enterprise'
      ? existing.id
      : (findEnterpriseByIdentity(tx, existing)?.id ?? null)
  const newEnterpriseId = reviewedOwner ?? findEnterpriseByIdentity(tx, { name: candidate.name, uscc: candidate.newUscc })?.id ?? null
  const resolved: DuplicateNameCandidate = { ...candidate, existingEnterpriseId, newEnterpriseId }
  return success('duplicate_candidate', duplicateCandidateRef(candidate), { candidate: resolved })
}

/**
 * **本批将新建**的企业键（`uscc:<norm>` / `name:<norm>`）。
 *
 * 为什么要它:一个批次的载荷常常「先写企业，再写它的别名/差异/归并」（契约 §8.3 的
 * 形状就是按这个顺序给的）。这些后续项按名字/统代找企业时,库里**还没有**那一行 ——
 * 若不认「本批将建」的身份,合法的批次会被自己的预检判成 `enterprise_not_found`。
 *
 * 真正的 id 在**执行时**解析（那时前面的项已经插入了）;预检只用它判「能不能解析到」。
 */
type PendingEnterprises = Set<string>

/** 身份键的两种写法。**只在这里拼**：{@link pendingKeys} 全给、{@link identityKeyOf} 按偏好给一个。 */
const usccKey = (uscc: string) => `uscc:${uscc}`
const nameKey = (nameNorm: string) => `name:${nameNorm}`

function pendingKeys(spec: EnterpriseSpec): string[] {
  const keys: string[] = []
  const uscc = usccOrNull(spec.uscc)
  if (uscc) keys.push(usccKey(uscc))
  const name = optionalString(spec.name)
  if (name) keys.push(nameKey(normalizeName(name)))
  return keys
}

/** 该企业是否**已存在或本批将新建**（预检判据）。 */
function enterpriseKnown(db: Executor, pending: PendingEnterprises, spec: EnterpriseSpec): boolean {
  if (locateEnterprise(db, spec)) return true
  return pendingKeys(spec).some((key) => pending.has(key))
}

// ---------------------------------------------------------------------------
// 平台查询 / 关系的**批内自然键**引用（与上面的「本批新建企业」同一套机制）
//
// `enterprise_alias.source_ref_id` / `difference_reason.evidence_*_id` 是整数行 id，
// 由本批事务内生成 —— 客户端事前不可能知道。自然键 `(interface, query_key, rdjb[, queried_at])`
// `(+ sequence_no)` 让证据指针在**同一批内**指到本批新建的查询/关系行：
//   - 预检阶段：查库 + 查「本批将写入」的索引，判「能不能解析」；解析不到 ⇒ 逐项报错；
//   - 执行阶段：关系已插入，**真实**解析出行 id 落列。
// **绝不静默落 0 哨兵、绝不猜**（`source_ref_id = 0` 只表示「本就没给来源行」）。
// ---------------------------------------------------------------------------

/** 本批将写入的平台查询（自然键 + 它声明的关系序号）。 */
interface PendingPlatformRef {
  collectionEvidence: RosterImportPlatformQuery['collectionEvidence']
  interface: string
  queryKey: string
  rdjb: string
  queriedAt: string
  sequenceNos: number[]
  /** 本批将写入的那些关系的 `relationKey`（权威锚点，见 `NormalizedRef.relationKey`）。 */
  relationKeys: string[]
  /** 预检用的平台原始身份事实；只用于校验平台别名已有证据是否支持目标 qymc。 */
  relations: Array<{
    sequenceNo: number
    relationKey: string | null
    enterpriseId: number | null
    usccRaw: string | null
    nameRaw: string | null
  }>
}

type PendingPlatformRefs = PendingPlatformRef[]

/** 从载荷里收集「本批将写入」的平台查询自然键。 */
function collectPendingPlatformRefs(payload: RosterImportPayload): PendingPlatformRefs {
  const out: PendingPlatformRefs = []
  for (const query of Array.isArray(payload.platformQueries) ? payload.platformQueries : []) {
    if (!isObject(query)) continue
    const iface = optionalString((query as { interface?: unknown }).interface)
    const queryKey = optionalString((query as { queryKey?: unknown }).queryKey)
    const queriedAt = optionalString((query as { queriedAt?: unknown }).queriedAt)
    if (!iface || !queryKey || !queriedAt) continue
    const relations = (query as { relations?: unknown }).relations
    if (out.some(q => q.interface === iface && q.queryKey === queryKey && q.rdjb === (optionalString(query.rdjb) ?? '') && q.queriedAt === queriedAt)) continue
    out.push({
      collectionEvidence: query.collectionEvidence,
      interface: iface,
      queryKey,
      rdjb: optionalString((query as { rdjb?: unknown }).rdjb) ?? '',
      queriedAt,
      sequenceNos: (Array.isArray(relations) ? relations : [])
        .map((relation) => optionalInt((relation as { sequenceNo?: unknown })?.sequenceNo))
        .filter((n): n is number => n != null),
      // RL-06：`relationKey` 是**权威锚点**（平台的排序可能与解析顺序不同），所以本批将写入的
      // 关系也要把 key 收进来，好在预检阶段就能校验「序号那条是不是 key 那条」。
      relationKeys: (Array.isArray(relations) ? relations : [])
        .map((relation) => optionalString((relation as { relationKey?: unknown })?.relationKey))
        .filter((k): k is string => !!k),
      relations: (Array.isArray(relations) ? relations : [])
        .map((relation) => ({
          sequenceNo: optionalInt((relation as { sequenceNo?: unknown })?.sequenceNo),
          relationKey: optionalString((relation as { relationKey?: unknown })?.relationKey),
          enterpriseId: optionalInt((relation as { enterpriseId?: unknown })?.enterpriseId),
          usccRaw: optionalString((relation as { usccRaw?: unknown })?.usccRaw),
          nameRaw: optionalString((relation as { nameRaw?: unknown })?.nameRaw),
        }))
        .filter((relation): relation is PendingPlatformRef['relations'][number] => relation.sequenceNo != null),
    })
  }
  return out
}

/** 归一后的自然键（`queriedAt` 可空 = 要求 `(interface, queryKey, rdjb)` 唯一）。 */
export interface NormalizedRef {
  interface: string
  queryKey: string
  rdjb: string
  queriedAt: string | null
  sequenceNo: number | null
  /**
   * 关系的**权威锚点**（`RL-06` 增量：父代理 2026-10-16，两个复查代理都实测「平台的排序可能
   * 与其解析顺序不同，`sequenceNo` 只作参考」）。
   *
   * 给 `relationKey` 时：解析出的那条关系**必须**就是它；`sequenceNo` 同时给了却指到别的行
   * ⇒ **报错**（`relation_ref_mismatch`），**不按其中一个猜**。不给则保持原行为（按 `sequenceNo`）。
   */
  relationKey: string | null
}

type RefError = { code: string; field: string; message: string }

/** 校验自然键的形状（不查库）。 */
export function normalizeRef(ref: unknown, field: string): { ok: true; value: NormalizedRef } | { ok: false; error: RefError } {
  if (!isObject(ref)) {
    return { ok: false, error: { code: 'ref_shape_invalid', field, message: `引用必须是对象 { interface, queryKey, rdjb?, queriedAt?, sequenceNo? }` } }
  }
  const iface = optionalString(ref.interface)
  if (!iface || !PLATFORM_INTERFACE_SET.has(iface)) {
    return { ok: false, error: { code: 'ref_interface_unknown', field: `${field}.interface`, message: `引用缺少 interface 或取值不在字典内：${String(ref.interface)}` } }
  }
  const queryKey = optionalString(ref.queryKey)
  if (!queryKey) {
    return { ok: false, error: { code: 'ref_query_key_required', field: `${field}.queryKey`, message: '引用缺少 queryKey' } }
  }
  return {
    ok: true,
    value: {
      interface: iface,
      queryKey,
      rdjb: optionalString(ref.rdjb) ?? '',
      queriedAt: optionalString(ref.queriedAt),
      sequenceNo: optionalInt(ref.sequenceNo),
      relationKey: optionalString(ref.relationKey),
    },
  }
}

/**
 * 自然键（除 `sequenceNo`）→ SQL 谓词。**只在这里拼**：{@link refCandidates}、
 * {@link resolveQueryIdAt} 都靠它，于是「按自然键找查询」的口径只有一处。
 *
 * 谓词下推进 `WHERE` 是为了**按键定位**（RL-18）。注意这条路径与下面那四个
 * `find*Row` 的**强度不同**，别混为一谈：
 *  - 给了 `queriedAt` ⇒ 四列齐 ⇒ 命中 `platform_query_identity_uq`，至多一行；
 *  - 没给 `queriedAt` ⇒ 三列 ⇒ 命中同一索引的**前三列前缀**，是一次索引区间扫描，
 *    **可能命中多行**（`resolveQueryRefPlan` 的「引用不唯一」正是靠这个数条数）。
 * 两种情况都只取 `id`，所以都不会碰 `raw_response` —— 那是本条路径真正省下的字节。
 */
function importPlatformTables(db: Executor) {
  return targetCandidateTables(db)
}

function platformQueryWhere(ref: NormalizedRef, q: ReturnType<typeof importPlatformTables>['q']) {
  const conditions = [
    eq(q.interface, ref.interface as PlatformInterface),
    eq(q.queryKey, ref.queryKey),
    eq(q.rdjb, ref.rdjb),
  ]
  if (ref.queriedAt) conditions.push(eq(q.queriedAt, ref.queriedAt))
  return and(...conditions)
}

/** 按自然键在「库内 + 本批将写入」两处找候选查询。 */
function refCandidates(source: Executor, pending: PendingPlatformRefs, ref: NormalizedRef) {
  const { q } = importPlatformTables(source)
  const matches = (candidate: { interface: string; queryKey: string; rdjb: string; queriedAt: string }) =>
    candidate.interface === ref.interface &&
    candidate.queryKey === ref.queryKey &&
    candidate.rdjb === ref.rdjb &&
    (ref.queriedAt ? candidate.queriedAt === ref.queriedAt : true)
  return {
    // 库内一侧**按键定位**且只取 `id`；本批一侧是内存数组，谓词留在 JS 里。
    dbHits: source
      .select({ id: q.id })
      .from(q)
      .where(platformQueryWhere(ref, q))
      .all(),
    pendingHits: pending.filter(matches).filter(candidate => !findQueryRow(source, { interface: candidate.interface as PlatformInterface, queryKey: candidate.queryKey, rdjb: candidate.rdjb, queriedAt: candidate.queriedAt })),
  }
}

/** 预检阶段的「查询能不能解析」。 */
function resolveQueryRefPlan(source: Executor, pending: PendingPlatformRefs, ref: NormalizedRef, field: string): { ok: true } | { ok: false; error: RefError } {
  const { dbHits, pendingHits } = refCandidates(source, pending, ref)
  const total = dbHits.length + pendingHits.length
  if (total === 0) {
    return { ok: false, error: { code: 'query_ref_not_found', field, message: `引用不到平台查询：${describeRef(ref)}` } }
  }
  // 没给 queriedAt ⇒ 必须唯一命中（给了一次查询的时点就不必）。
  if (!ref.queriedAt && total > 1) {
    return { ok: false, error: { code: 'query_ref_ambiguous', field, message: `引用不唯一：${describeRef(ref)} 命中 ${total} 次查询；请补 queriedAt` } }
  }
  return { ok: true }
}

/** 预检阶段的「关系能不能解析」。 */
function resolveRelationRefPlan(source: Executor, pending: PendingPlatformRefs, ref: NormalizedRef, field: string): { ok: true } | { ok: false; error: RefError } {
  const { r } = importPlatformTables(source)
  if (ref.sequenceNo == null || ref.sequenceNo < 1) {
    return { ok: false, error: { code: 'ref_sequence_no_required', field: `${field}.sequenceNo`, message: '关系引用缺少 sequenceNo（同一次查询内第几条，从 1 起）' } }
  }
  const { dbHits, pendingHits } = refCandidates(source, pending, ref)
  if (dbHits.length + pendingHits.length === 0) {
    return { ok: false, error: { code: 'query_ref_not_found', field, message: `引用不到平台查询：${describeRef(ref)}` } }
  }
  // RL-06 的 `relationKey` 校验要**按查询取关系行**；RL-18 的纪律是按键定位而不是整表扫 ——
  // `queryId` 正是 `platform_relation_query_seq_uq` 的前缀，所以这里是索引前缀查询。
  const relationsOf = (query: { id: number }) =>
    source
      .select()
      .from(r)
      .where(eq(sql<number>`${r.queryId}`, query.id))
      .all()
  // 「这条查询里有没有序号 N 的关系」= 关系表**唯一键**的按键定位（RL-18）。
  // 以前这里对每个候选查询各扫一遍整张 `platform_relation`。
  const dbWithSeq = dbHits.filter(
    (query) => findRelationRow(source, { queryId: query.id, sequenceNo: ref.sequenceNo! }) != null,
  )

  const pendingWithSeq = pendingHits.filter((query) => query.sequenceNos.includes(ref.sequenceNo!))
  if (dbWithSeq.length + pendingWithSeq.length === 0) {
    return { ok: false, error: { code: 'relation_ref_not_found', field, message: `引用不到平台关系：${describeRef(ref)}（该查询里没有序号 ${ref.sequenceNo} 的关系）` } }
  }
  if (!ref.queriedAt && dbWithSeq.length + pendingWithSeq.length > 1) {
    return { ok: false, error: { code: 'relation_ref_ambiguous', field, message: `引用不唯一：${describeRef(ref)} 命中 ${dbWithSeq.length + pendingWithSeq.length} 条同序号关系；请补 queriedAt` } }
  }
  // **`relationKey` 是权威锚点**：给了就必须对得上；给了 key 又给了序号、两者指的不是同一行 ⇒
  // 报错（不按其中一个猜）。判据是「库内/本批该查询下，序号那条的 key 是不是这个 key」。
  if (ref.relationKey) {
    const keyed = [
      ...dbWithSeq.flatMap((query) =>
        relationsOf(query)
          .filter((relation) => relation.sequenceNo === ref.sequenceNo)
          .map((relation) => relation.relationKey),
      ),
      ...pendingHits
        .filter((query) => query.sequenceNos.includes(ref.sequenceNo!))
        .map((query) => (query.relations.find(r => r.sequenceNo === ref.sequenceNo)?.relationKey ?? null)),
    ].filter((key): key is string => key != null)
    const anyKey = [
      ...dbHits.flatMap((query) => relationsOf(query).map((relation) => relation.relationKey)),
      ...pendingHits.flatMap((query) => query.relationKeys),
    ]
    if (!anyKey.includes(ref.relationKey)) {
      return { ok: false, error: { code: 'relation_ref_not_found', field: `${field}.relationKey`, message: `引用不到平台关系：该查询下没有 relationKey=${ref.relationKey} 的关系` } }
    }
    if (!keyed.includes(ref.relationKey)) {
      return {
        ok: false,
        error: {
          code: 'relation_ref_mismatch',
          field: `${field}.relationKey`,
          message:
            `序号与关系键不符：${describeRef(ref)} —— 序号 ${ref.sequenceNo} 那条的 relationKey ` +
            `不是 ${ref.relationKey}。**按关系键为准、不猜**，请改用正确的序号，或只给 relationKey。`,
        },
      }
    }
  }
  return { ok: true }
}

export function describeRef(ref: NormalizedRef): string {
  const parts = [`interface=${ref.interface}`, `queryKey=${ref.queryKey}`, `rdjb=${ref.rdjb || "''"}`]
  if (ref.queriedAt) parts.push(`queriedAt=${ref.queriedAt}`)
  if (ref.sequenceNo != null) parts.push(`sequenceNo=${ref.sequenceNo}`)
  if (ref.relationKey) parts.push(`relationKey=${ref.relationKey}`)
  return parts.join(' ')
}

/** 执行阶段：解析出**真实**的 `platform_query.id`。 */
function resolveQueryIdAt(source: Executor, ref: NormalizedRef): number | null {
  const { q } = importPlatformTables(source)
  const hits = source
    .select({ id: q.id })
    .from(q)
    .where(platformQueryWhere(ref, q))
    .all()
  if (hits.length === 0) return null
  if (ref.queriedAt) return hits[0]!.id
  return hits.length === 1 ? hits[0]!.id : null
}

/** 执行阶段：解析出**真实**的 `platform_relation.id`。 */
function resolveRelationIdAt(source: Executor, ref: NormalizedRef): number | null {
  if (ref.sequenceNo == null) return null
  const queryId = resolveQueryIdAt(source, ref)
  if (queryId == null) return null
  return findRelationRow(source, { queryId, sequenceNo: ref.sequenceNo })?.id ?? null}

interface PlatformAliasRelationEvidence {
  interface: string
  enterpriseId: number | null
  usccRaw: string | null
  nameRaw: string | null
}

/** Load the actual platform row facts used to validate a platform-sourced alias. */
export function findPlatformAliasRelationEvidence(source: Executor, relationId: number): PlatformAliasRelationEvidence | null {
  const { q, r } = importPlatformTables(source)
  return source
    .select({
      interface: q.interface,
      enterpriseId: r.enterpriseId,
      usccRaw: r.usccRaw,
      nameRaw: r.nameRaw,
    })
    .from(r)
    .innerJoin(q, eq(q.id, r.queryId))
    .where(eq(sql<number>`${r.id}`, relationId))
    .get() ?? null
}

/** Get the asserted row facts for a relation that will be inserted by this request. */
function findPendingPlatformAliasRelationEvidence(
  pending: PendingPlatformRefs,
  ref: NormalizedRef,
): PlatformAliasRelationEvidence | null {
  const matches = pending
    .filter((query) =>
      query.interface === ref.interface &&
      query.queryKey === ref.queryKey &&
      query.rdjb === ref.rdjb &&
      (ref.queriedAt ? query.queriedAt === ref.queriedAt : true),
    )
    .flatMap((query) =>
      query.relations
        .filter((relation) =>
          relation.sequenceNo === ref.sequenceNo &&
          (!ref.relationKey || relation.relationKey === ref.relationKey),
        )
        .map((relation) => ({
          interface: query.interface,
          enterpriseId: relation.enterpriseId,
          usccRaw: relation.usccRaw,
          nameRaw: relation.nameRaw,
        })),
    )
  return matches.length === 1 ? matches[0]! : null
}

/** Validate the existing row facts; never infer a missing USCC or qymc from a name. */
export function platformAliasEvidenceMismatch(
  source: Executor,
  sourceKind: string,
  aliasName: string,
  targetUscc: string | null,
  targetEnterpriseId: number | null,
  evidence: PlatformAliasRelationEvidence,
): string | null {
  const expectedInterface = sourceKind === 'platform_business' ? 'business_list' : 'apply_list'
  if (
    evidence.interface !== expectedInterface ||
    !targetUscc ||
    usccOrNull(evidence.usccRaw) !== targetUscc ||
    evidence.nameRaw !== aliasName
  ) {
    return '平台关系的接口、统一社会信用代码或 qymc 与该别名不一致'
  }
  if (evidence.enterpriseId != null) {
    const owner = findEnterpriseById(source, evidence.enterpriseId)
    if (!owner || (targetEnterpriseId != null ? owner.id !== targetEnterpriseId : owner.usccNorm !== targetUscc)) {
      return '平台关系已归属的企业与该别名归属企业不一致'
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// 计划（预检与提交共用）
// ---------------------------------------------------------------------------

/** 计划中的一项动作。 */
interface PlannedItem {
  item: RosterImportItemResult
  /** Reference participation, including commands that return no observation mapping. */
  platformFieldReference?: boolean
  /** Frozen by the same identity resolution as the write closure; never re-guessed on readback. */
  qualificationCandidate?: { ref: string; targetKey: string; enterpriseId: number | null; diagnostics: RosterImportQualificationDiagnostic[] }
  /** 预检的影响归类。`note` = **只记录、不计入任何影响计数**（如重名候选）。 */
  action: 'add' | 'update' | 'skip' | 'note'
  /** 是否落在待核状态（`pending` / `needs_review` / 未知枚举）。 */
  review: boolean
  /**
   * 本项会让几行 `record_evidence.source_file` 收敛（行口径，RL-16/RL-19）。
   * `summarizePlan` 把它求和成 `preflight.evidenceRepoints` —— 「预检答应的」与
   * 「提交真改的」逐行可比对，就靠这一项**在计划期**就算准。
   */
  repoints?: number
  /** The exact targets also held by this item's execution closure. */
  evidenceRepointTargets?: readonly EvidenceRepointTarget[]
  mergePlan?: MergePlan
  /** 确实要执行时才有的写入闭包（提交阶段调用）。 */
  run?: (tx: Executor) => RosterImportItemResult
}

/** 一条已冻结的出处指针更新，供 commit 与显式 replay 执行同一计划。 */
interface EvidenceRepointTarget {
  id: number
  recordId: number
  recordEventId: number
  fromSourceFile: string
  sourceFile: string
}

type EvidenceContentHashIndex = Map<string, Set<string>>
type EvidenceContentHashConflict = 'unknown' | 'mismatch'

interface EvidenceRepointPlan {
  targets: EvidenceRepointTarget[]
  hashConflicts: Set<EvidenceContentHashConflict>
}

/** 公布文件记录的计划口径：正常写入 / 只收敛出处指针。 */
type AnnouncementPlanMode = 'write' | 'converge'

interface Plan {
  platformLegacyProvenanceSources?: RosterImportPreflight['platformLegacyProvenanceSources']
  items: PlannedItem[]
  conflicts: RosterImportItemResult[]
  platformObservationSources?: RosterImportPreflight['platformObservationSources']
  officialEvidencePlanHash?: string
}

/** 汇总计划的影响计数。 */
function summarizePlan(plan: Plan): RosterImportPreflight {
  let add = 0
  let update = 0
  let remove = 0
  let review = 0
  let evidenceRepoints = 0
  const duplicateCandidates: DuplicateNameCandidate[] = []
  for (const planned of plan.items) {
    if (planned.action === 'add') add += 1
    else if (planned.action === 'update') update += 1
    if (planned.review) review += 1
    evidenceRepoints += planned.repoints ?? 0
    if (planned.item.kind === 'merge' && planned.item.ok) remove += 1
    const candidate = planned.item.detail?.candidate as DuplicateNameCandidate | undefined
    if (planned.item.kind === 'duplicate_candidate' && planned.item.ok && candidate) {
      duplicateCandidates.push(candidate)
    }
  }
  const canonicalProjection = plan.items.flatMap(p => (p.item.detail?.canonicalProjection as NonNullable<RosterImportPreflight['canonicalProjection']> | undefined) ?? [])
  return { ...(plan.platformLegacyProvenanceSources ? { platformLegacyProvenanceSources: plan.platformLegacyProvenanceSources } : {}), ...(plan.officialEvidencePlanHash ? { officialEvidencePlanHash: plan.officialEvidencePlanHash } : {}), add, update, remove, review, conflicts: plan.conflicts, evidenceRepoints, duplicateCandidates, ...(canonicalProjection.length ? { canonicalProjection } : {}), ...(plan.platformObservationSources ? { platformObservationSources: plan.platformObservationSources } : {}) }
}

/**
 * 同一批次里尚不存在的相同事件坐标先按安全的企业身份汇总出处，再只由首次出现项插入。
 * 不同来源文件是不同证据关系，全部保留；完全相同的关系只插入一次。无统代名称本身不唯一时
 * 单独保留，不把证据猜并到某个同名主体；具体逐项冲突由 {@link planAnnouncementRecord} 在
 * 预检和提交共用的记录规划中报告。
 */
function planNewEventEvidence(
  db: Executor,
  announcement: RosterImportAnnouncement,
  records: readonly RosterImportAnnouncement['records'][number][],
  identityPlan: AnnouncementBatchIdentityPlan,
): { eventsByRecord: Map<number, RosterImportEvent[]>; groupedOccurrences: Set<string> } {
  return groupNewAnnouncementEvidence(announcement, records, (recordIndex, name) => {
    const record = records[recordIndex]!
    const requestedUscc = usccOrNull(record.enterprise?.uscc)
    const uscc = identityPlan.identityUsccByRecord.get(recordIndex) ?? requestedUscc
    const nameMatches = findEnterprisesByNorm(db, normalizeName(name))
    const resolvedByWriteIdentity = announcementOwner(db, identityPlan, recordIndex, name, uscc)
    const ambiguousNameOnly = !identityPlan.reviewedOwners?.has(recordIndex) && !requestedUscc && (
      identityPlan.ambiguousNameOnlyRecords.has(recordIndex) || nameMatches.length > 1
    )
    const groupIdentity = identityPlan.reviewedOwners?.has(recordIndex) ? `enterprise:${resolvedByWriteIdentity!.id}` : uscc
      ? resolvedByWriteIdentity
        ? `enterprise:${resolvedByWriteIdentity.id}`
        : identityKeyOf({ name, uscc })
      : nameMatches.length === 1
        ? `enterprise:${nameMatches[0]!.id}`
        : identityKeyOf({ name, uscc: null })
    return { ambiguous: ambiguousNameOnly, key: groupIdentity }
  }, (recordIndex, titleCode, source, event) => {
    const representative = records[recordIndex]!
    const name = optionalString(representative.enterprise.name)!
    const requestedUscc = usccOrNull(representative.enterprise?.uscc)
    const uscc = identityPlan.identityUsccByRecord.get(recordIndex) ?? requestedUscc
    const enterprise = announcementOwner(db, identityPlan, recordIndex, name, uscc)
    const storedRecord = enterprise
      ? db
          .select()
          .from(schema.record)
          .where(
            and(
              eq(schema.record.enterpriseId, enterprise.id),
              eq(schema.record.titleCode, titleCode),
              eq(schema.record.source, source),
            ),
          )
          .get()
      : undefined
    const existingEvent = storedRecord
      ? db
          .select()
          .from(schema.recordEvent)
          .where(eq(schema.recordEvent.recordId, storedRecord.id))
          .all()
          .find((row) => matchesEventCoordinates(row, eventCoordinates(storedRecord.id, event)))
      : undefined
    return !!existingEvent
  })
}

export function groupNewAnnouncementEvidence(
  announcement: RosterImportAnnouncement,
  records: readonly RosterImportAnnouncement['records'][number][],
  identity: (index: number, name: string) => { key: string; ambiguous?: boolean },
  alreadyStored: (recordIndex: number, titleCode: string, source: 'jxj' | 'miit', event: RosterImportEvent) => boolean,
): { eventsByRecord: Map<number, RosterImportEvent[]>; groupedOccurrences: Set<string> } {
  interface Occurrence {
    recordIndex: number
    eventIndex: number
    event: RosterImportEvent
  }

  const planned = new Map<number, RosterImportEvent[]>()
  const groupedOccurrences = new Set<string>()
  const groups = new Map<string, Occurrence[]>()
  for (const [recordIndex, record] of records.entries()) {
    const events = Array.isArray(record?.events) ? record.events : []
    planned.set(
      recordIndex,
      events.map((event) => {
        const candidate: unknown = event
        // Keep malformed array entries for planAnnouncementRecord's structured validation.
        // In particular, JSON null must not throw here before it can become an item error.
        if (!isObject(candidate)) return event
        const evidence = candidate.evidence
        return {
          ...candidate,
          evidence: Array.isArray(evidence) ? [...evidence] : (evidence ?? []),
        } as unknown as RosterImportEvent
      }),
    )

    const name = optionalString(record?.enterprise?.name)
    const titleCode = optionalString(record?.titleCode)
    const source = record?.source ?? announcement.sourceDocument?.source
    if (!name || !titleCode || !TITLE_CODES.has(titleCode) || !SOURCES.has(String(source))) continue
    const group = identity(recordIndex, name)
    events.forEach((event, eventIndex) => {
      if (!EVENT_TYPES.has(String(event?.eventType))) return
      const coordinates = eventCoordinates(0, event)
      const occurrence: Occurrence = {
        recordIndex,
        eventIndex,
        event,
      }

      // 一条不唯一的名称无法确认企业身份，不能按名称查询碰巧返回的第一家参与归组。
      // planAnnouncementRecord 会在任何写入解析前拒绝这条 name-only 记录。
      const identityKey = group.ambiguous ? `ambiguous:${recordIndex}:${eventIndex}` : group.key
      const key = JSON.stringify([identityKey, titleCode, source, coordinates])
      const occurrences = groups.get(key) ?? []
      occurrences.push(occurrence)
      groups.set(key, occurrences)
    })
  }

  for (const occurrences of groups.values()) {
    if (occurrences.length < 2) continue
    const first = occurrences[0]
    if (!first) continue
    const representative = records[first.recordIndex]
    if (!representative) continue
    const name = optionalString(representative?.enterprise?.name)
    const titleCode = optionalString(representative?.titleCode)
    const source = representative?.source ?? announcement.sourceDocument?.source
    if (!name || !titleCode || !SOURCES.has(String(source))) continue
    if (alreadyStored(first.recordIndex, titleCode, source, first.event)) continue

    const uniqueEvidence = new Map<string, RosterImportEvidence>()
    const invalidEvidence: unknown[] = []
    for (const occurrence of occurrences) {
      const evidenceValues: unknown[] = Array.isArray(occurrence.event.evidence) ? occurrence.event.evidence : []
      for (const rawEvidence of evidenceValues) {
        // Keep malformed entries in the planned event. The original payload is validated below,
        // and these entries must become structured record_evidence errors rather than disappear.
        if (!isObject(rawEvidence)) {
          invalidEvidence.push(rawEvidence)
          continue
        }
        if (typeof rawEvidence.sourceFile !== 'string' || !optionalString(rawEvidence.sourceFile)) {
          invalidEvidence.push(rawEvidence)
          continue
        }
        const normalized: RosterImportEvidence = {
          ...(rawEvidence.publishedRow !== undefined ? { publishedRow: rawEvidence.publishedRow as import('../../lib/roster-import-client').OfficialPublishedRow } : {}),
          ...announcementEvidenceCoordinate({ ...rawEvidence, sourceFile: rawEvidence.sourceFile }, true),
        }
        const key = JSON.stringify([
          normalized.sourceFile,
          normalized.attachment ?? null,
          normalized.listNo ?? null,
          normalized.page ?? null,
        ])
        uniqueEvidence.set(key, normalized)
      }
    }
    const mergedEvidence = [...uniqueEvidence.entries()]
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([, evidence]) => evidence)
    mergedEvidence.push(...(invalidEvidence as RosterImportEvidence[]))
    const [firstOccurrence, ...duplicates] = occurrences
    for (const occurrence of occurrences) groupedOccurrences.add(`${occurrence.recordIndex}:${occurrence.eventIndex}`)
    if (firstOccurrence) {
      const event = planned.get(firstOccurrence.recordIndex)?.[firstOccurrence.eventIndex]
      if (event) planned.get(firstOccurrence.recordIndex)![firstOccurrence.eventIndex] = { ...event, evidence: mergedEvidence }
    }
    for (const duplicate of duplicates) {
      const event = planned.get(duplicate.recordIndex)?.[duplicate.eventIndex]
      if (event) planned.get(duplicate.recordIndex)![duplicate.eventIndex] = { ...event, evidence: [] }
    }
  }

  return { eventsByRecord: planned, groupedOccurrences }
}

/** 对象键及集合数组顺序不影响公告载荷的快照指纹;重复项仍按重数保留。 */
function canonicalEvidencePlanJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalEvidencePlanJson).sort().join(',')}]`
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${canonicalEvidencePlanJson(child)}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

/** 同一幂等键若被复用于不同公告载荷或默认来源,不应复用旧的收敛目标快照。 */
export function evidenceRepointPlanFingerprint(request: RosterImportRequest): string {
  return createHash('sha256')
    .update(canonicalEvidencePlanJson(request.payload?.announcement ?? null))
    .digest('hex')
}

/**
 * 把载荷翻成一份**只读**计划。所有身份解析（企业、记录、查询）都在这里发生，
 * 因此预检报的 add/update/remove/review 就是提交真会发生的事。
 *
 * `context.convergeOnly`（RL-19，§8.9.3）只规划**公布文件记录的出处指针收敛**：
 * 其余各类（平台查询 / 别名 / 差异 / 快照 / 归并）**一项都不进计划** —— 收敛重放
 * 一行不加、一行不删，那几类都可能写新行，故它们根本没有执行闭包可跑。
 */
interface OfficialImportState { declarations: Map<string, number>; batchId?: number; changedEvents?: Map<number, number> }
export function hasOfficialFactInput(request: RosterImportRequest): boolean {
  const payload = request.payload
  return ['officialEvidenceAppends', 'officialEvidenceCorrections', 'officialEvidencePlanHash'].some(key => Object.hasOwn(payload, key)) || (Array.isArray(payload.announcement?.records) && payload.announcement.records.some(record => Array.isArray(record?.events) && record.events.some(event => Array.isArray(event?.evidence) && event.evidence.some(evidence => evidence && Object.hasOwn(evidence, 'publishedRow')))))
}
function prepareOfficialImport(db: Executor, request: RosterImportRequest, items: PlannedItem[], identities: AnnouncementBatchIdentityPlan, filesDir: string | undefined, state: OfficialImportState, plannedEvents: ReadonlyMap<number, RosterImportEvent[]>, groupedOccurrences: ReadonlySet<string>) {
  function fail(code: string, message: string): never { throw new OfficialFactError(code, message, 409) }
  if (request.payload.announcement && !Array.isArray(request.payload.announcement.records)) fail('invalid_input', 'announcement.records must be an array')
  const captureCount = request.payload.announcement?.records?.reduce((n, record) => n + (record.events ?? []).reduce((m, event) => m + (event.evidence ?? []).filter(evidence => evidence.publishedRow !== undefined).length, 0), 0) ?? 0
  if (captureCount + (request.payload.officialEvidenceAppends?.length ?? 0) + (request.payload.officialEvidenceCorrections?.operations?.length ?? 0) > 100) throw new OfficialFactError('input_limit', 'At most 100 new official fact operations', 400)
  const appends = request.payload.officialEvidenceAppends === undefined ? [] : officialAppendSchema.array().min(1).max(100).parse(request.payload.officialEvidenceAppends)
  const correctionInput = request.payload.officialEvidenceCorrections
  const correction = correctionInput === undefined ? undefined : evidenceCorrectionRequestSchema.omit({ idempotencyKey: true }).parse(correctionInput)
  const changes: OfficialClaimChange[] = []
  const newUnknownClaims: { ref: string; coordinate: OfficialCoordinate }[] = []
  // A new reviewed subject has no durable ID during preflight. Use its first
  // reviewed row to bind claims without depending on the SQLite ID allocator.
  const createdSubjects = new Map<number, number>()
  for (const [index, owner] of identities.reviewedOwners ?? []) {
    if (identities.reviewedCreates?.has(owner) && !createdSubjects.has(owner)) createdSubjects.set(owner, index)
  }
  const existingOwner = (id: number) => {
    const created = createdSubjects.get(id)
    return created === undefined ? `enterprise:${id}` : `pending:reviewed:${created}`
  }
  const captures = request.payload.announcement?.records ?? []
  for (const events of plannedEvents.values()) for (const event of events) if (event.evidence?.some(evidence => evidence.publishedRow !== undefined) && event.evidence.length > 300) throw new OfficialFactError('source_limit', 'Final new event evidence exceeds 300', 413)
  const originalVersions: unknown[] = []
  const batchCoordinates = new Map<string, boolean>()
  captures.forEach((record, ri) => {
    const name = optionalString(record.enterprise.name)!, uscc = identities.identityUsccByRecord.get(ri) ?? usccOrNull(record.enterprise.uscc)
    const enterprise = announcementOwner(db, identities, ri, name, uscc)
    const storedRecord = enterprise ? db.select({ id: schema.record.id }).from(schema.record).where(and(eq(schema.record.enterpriseId, enterprise.id), eq(schema.record.titleCode, record.titleCode), eq(schema.record.source, record.source ?? request.payload.announcement!.sourceDocument.source))).get() : undefined
    record.events?.forEach((event, ei) => {
      const identity = enterprise ? existingOwner(enterprise.id) : `pending:${identityKeyOf({ name, uscc })}`
      const eventKey = `${identity}:${record.titleCode}:${officialPlanDigest(eventCoordinates(0, event))}`
      for (const evidence of event.evidence ?? []) {
        const key = officialPlanDigest({ eventKey, ...announcementEvidenceCoordinate(evidence, groupedOccurrences.has(`${ri}:${ei}`)) })
        const typed = evidence.publishedRow !== undefined
        if (batchCoordinates.has(key) && (typed || batchCoordinates.get(key))) fail('ambiguous_target', 'Typed new capture coordinate must be stated once across the batch')
        batchCoordinates.set(key, typed)
      }
      const published = event.evidence?.filter(evidence => evidence.publishedRow !== undefined) ?? []
      if (!published.length) return
      if ((record.source ?? request.payload.announcement!.sourceDocument.source) !== 'jxj') fail('target_mismatch', 'Published facts belong to official jxj events')
      if ((event.evidence?.length ?? 0) > 300) throw new OfficialFactError('source_limit', 'Event evidence exceeds 300', 413)
      if (storedRecord && findExistingEvent(db, eventCoordinates(storedRecord.id, event))) fail('explicit_append_required', 'Existing event requires exact officialEvidenceAppends; ordinary duplicate import adds no facts')
      const coordinates = new Set<string>()
      event.evidence?.forEach((evidence, index) => {
        if (evidence.publishedRow === undefined) return
        const parsed = officialPublishedRowSchema.safeParse(evidence.publishedRow)
        if (!parsed.success) fail('invalid_input', 'Full explicit publishedRow required')
        verifyOfficialDeclaration(db, evidence.publishedRow, request.payload.announcement!.sourceDocument)
        const coordinate = announcementEvidenceCoordinate(evidence)
        const coordinateKey = officialPlanDigest(coordinate)
        if (coordinates.has(coordinateKey)) fail('ambiguous_target', 'Repeated new capture coordinate must be stated once')
        coordinates.add(coordinateKey)
        changes.push({ ref: `capture:${ri}:${ei}:${index}`, evidenceId: `capture:${ri}:${ei}:${index}`, eventId: `event:${identity}:${record.titleCode}:${officialPlanDigest(eventCoordinates(0, event))}`, owner: identity, titleCode: record.titleCode, coordinate, publishedRow: evidence.publishedRow, expectedRowRevision: 0 })
      })
    })
    // Consume the actual grouped write plan. Existing events skip insertion;
    // duplicate occurrences have already moved all evidence to their first item.
    for (const [ei, event] of (plannedEvents.get(ri) ?? []).entries()) {
      if (storedRecord && findExistingEvent(db, eventCoordinates(storedRecord.id, event))) continue
      for (const [index, evidence] of (event.evidence ?? []).entries()) if (evidence.publishedRow === undefined) {
        newUnknownClaims.push({ ref: `legacy:${ri}:${ei}:${index}`, coordinate: announcementEvidenceCoordinate(evidence) })
      }
    }
  })
  const appendTargets = appends.map((op, index) => {
    const target = db.select({ event: schema.recordEvent, record: schema.record, enterpriseId: schema.enterprise.id }).from(schema.recordEvent).innerJoin(schema.record, eq(schema.record.id, schema.recordEvent.recordId)).innerJoin(schema.enterprise, eq(schema.enterprise.id, schema.record.enterpriseId)).where(eq(schema.recordEvent.id, op.eventId)).get()
    if (!target || target.record.source !== 'jxj' || target.record.id !== op.recordId || target.enterpriseId !== op.enterpriseId) fail('target_mismatch', 'Exact event and current real owner must match')
    if (target.event.revision !== op.expectedVersion) fail('stale_version', 'Official event revision changed')
    const scope = db.select({ id: schema.recordEvidence.id }).from(schema.recordEvidence).where(eq(schema.recordEvidence.recordEventId, op.eventId)).limit(301).all()
    if (scope.length > 300) throw new OfficialFactError('source_limit', 'Event evidence exceeds 300', 413)
    originalVersions.push({ event: target.event, record: target.record, scope: scope.map(row => row.id) })
    const change: OfficialClaimChange = { ref: `append:${index}`, evidenceId: `append:${index}`, eventId: op.eventId, owner: `enterprise:${target.enterpriseId}`, titleCode: target.record.titleCode, coordinate: { sourceFile: op.evidence.sourceFile, attachment: op.evidence.attachment, listNo: op.evidence.listNo, page: op.evidence.page }, publishedRow: op.evidence.publishedRow, expectedRowRevision: 0 }
    changes.push(change)
    return { op, target, change, scope: scope.length }
  })
  const inspections = new Map<string, ReturnType<typeof readOfficialFile> & { pageCount: number | null }>()
  for (const op of correction?.operations ?? []) inspections.set(op.coordinate.sourceFile, { ...readOfficialFile(filesDir, op.coordinate.sourceFile), pageCount: null })
  const correctionTargets = correction ? planEvidenceCorrectionTargets(db, { ...correction, idempotencyKey: request.idempotencyKey }, inspections, true) : []
  for (const target of correctionTargets) {
    if (!target.rowChange) fail('ambiguity', 'Import correction requires explicit publishedRow')
    changes.push(target.rowChange)
    originalVersions.push({ evidenceId: target.evidenceId, expectedVersion: target.expectedVersion, event: target.event, file: target.file })
  }
  if (!changes.length) fail('invalid_input', 'Opt-in official request has no fact operations')
  const ownerMap = new Map<string, string>()
  for (const item of items) {
    const plan = item.mergePlan
    if (!plan || !item.item.ok) continue
    const targetUscc = usccOrNull(plan.merge.intoUscc)!
    const target = findEnterpriseByUscc(db, targetUscc)
    const into = target ? existingOwner(target.id) : `pending:uscc:${targetUscc}`
    const pendingSourceIndex = captures.findIndex((record, index) => normalizeName(record.enterprise.name) === normalizeName(plan.merge.fromEnterpriseName ?? '') && !findEnterpriseByIdentity(db, { name: record.enterprise.name, uscc: identities.identityUsccByRecord.get(index) ?? usccOrNull(record.enterprise.uscc) }))
    const pendingSource = captures[pendingSourceIndex]
    const from = plan.sourceEnterpriseId !== null ? existingOwner(plan.sourceEnterpriseId)
      : pendingSource ? `pending:${identityKeyOf({ name: pendingSource.enterprise.name, uscc: identities.identityUsccByRecord.get(pendingSourceIndex) ?? usccOrNull(pendingSource.enterprise.uscc) })}` : null
    if (!from || ownerMap.has(from)) fail('ambiguity', 'Legal merge owner mapping must be uniquely provable')
    ownerMap.set(from, into)
  }
  const finalOwner = (owner: string | null) => {
    const seen = new Set<string>()
    while (owner !== null && ownerMap.has(owner)) { if (seen.has(owner)) return fail('ambiguity', 'Cyclic merge ownership'); seen.add(owner); owner = ownerMap.get(owner)! }
    return owner
  }
  const locatorMoves = items.flatMap(item => item.evidenceRepointTargets ?? [])
  const facts = planOfficialEvidenceChanges(db, changes, filesDir, finalOwner, newUnknownClaims, locatorMoves)
  for (const target of appendTargets) {
    const additions = appendTargets.filter(other => other.op.eventId === target.op.eventId && other.change.noOpEvidenceId === undefined).length
    if (target.scope + additions > 300) throw new OfficialFactError('source_limit', 'Final event evidence exceeds 300', 413)
  }
  const { officialEvidencePlanHash: _provided, ...payload } = request.payload
  const planHash = officialPlanDigest({ request: { ...request, sourceSha256: request.sourceSha256 ?? null, payload }, facts: facts.planHash, originalVersions, ownerMap: [...ownerMap] })
  const item: PlannedItem = {
    item: success('official_evidence', 'official_evidence', { operations: changes.length }), action: 'update', review: false,
    run: tx => {
      const declarationsBefore = state.declarations.size
      const changedEvents = new Map<number, number>(state.changedEvents), changedFiles = new Set<string>(), evidence: unknown[] = []
      for (const { op, target, change } of appendTargets) {
        if (change.noOpEvidenceId !== undefined) { evidence.push({ evidenceId: change.noOpEvidenceId, eventId: op.eventId, unchanged: true }); continue }
        const evidenceId = tx.insert(schema.recordEvidence).values({ recordEventId: op.eventId, ...change.coordinate }).returning({ id: schema.recordEvidence.id }).get().id
        const row = writeOfficialPublishedRow(tx, change.publishedRow, evidenceId, 0, { kind: 'import', batchId: state.batchId! }, state.declarations)
        evidence.push(row); changedEvents.set(op.eventId, target.event.revision); changedFiles.add(change.coordinate.sourceFile)
      }
      for (const target of correctionTargets) {
        if (writeImportedEvidenceCorrection(tx, target, correction!, state.batchId!, state.declarations)) { changedEvents.set(target.eventId, target.event.revision); changedFiles.add(target.before.sourceFile); changedFiles.add(target.after.sourceFile) }
        evidence.push({ evidenceId: target.evidenceId, eventId: target.eventId, revision: target.rowChange!.expectedRowRevision + Number(target.rowChange!.changed) })
      }
      for (const [eventId, revision] of changedEvents) advanceOfficialEventRevision(tx, eventId, revision)
      // Refresh only derived file parts; all raw/proof/decision provenance remains owned by its original writer.
      refreshDerivedFileParts(tx, changedFiles)
      return success('official_evidence', 'official_evidence', { evidence, rowsWritten: appendTargets.filter(target => target.change.noOpEvidenceId === undefined).length + state.declarations.size - declarationsBefore })
    },
  }
  return { planHash, item }
}

interface ReviewedAnnouncementPlan {
  owners: ReadonlyMap<number, number>
  created: ReadonlySet<number>
  decision: string
  planHash?: string
}

export function planRosterImport(
  db: Executor,
  request: RosterImportRequest,
  context: {
    batchId?: number
    filesDir?: string
    reviewedAnnouncement?: ReviewedAnnouncementPlan
    convergeOnly?: boolean
    /** Source-PDF page-count failures collected by the REST/MCP boundary before planning. */
    pageCountErrors?: readonly RosterImportItemResult[]
    /** 原提交批次保存的目标快照；空数组也表示该批次已记录过计划。 */
    evidenceRepointTargets?: readonly EvidenceRepointTarget[]
  } = {},
): Plan {
  const items: PlannedItem[] = []
  const conflicts: RosterImportItemResult[] = []
  const payload = request.payload ?? {}
  const officialInput = hasOfficialFactInput(request)
  const officialState: OfficialImportState = { declarations: new Map<string, number>(), batchId: context.batchId, changedEvents: officialInput ? new Map() : undefined }
  if (context.convergeOnly && officialInput) {
    const item = failure('official_evidence', 'payload', 'replay_facts_forbidden', 'Replay cannot capture, append or correct official facts')
    return { items: [{ item, action: 'skip', review: false }], conflicts: [item] }
  }
  const projectionPayloadError = validatePlatformProjectionPayload(payload as Record<string, unknown>, request.sourceKind)
  if (projectionPayloadError) {
    const item = failure('platform_observation', 'payload', 'projection_payload_invalid', projectionPayloadError, 'platformRecordObservations')
    return { items: [{ item, action: 'skip', review: false }], conflicts: [item] }
  }
  const mode: AnnouncementPlanMode = context.convergeOnly ? 'converge' : 'write'

  // Announcement identity and event-evidence values must be rejected before the batch-wide
  // identity plan sees them. Otherwise a malformed USCC can become candidate identity evidence,
  // and an invalid page may be truncated later by the generic optionalInt used for years/sequence.
  const announcementInputErrors = [
    ...validateAnnouncementIdentityAndEvidence(payload.announcement),
    ...(context.pageCountErrors ?? []),
  ]
  if (announcementInputErrors.length > 0) {
    return {
      items: announcementInputErrors.map((item) => ({ item, action: 'skip', review: false })),
      conflicts: announcementInputErrors,
    }
  }

  const evidencePlanFingerprint = evidenceRepointPlanFingerprint(request)
  const evidenceContentHashes = payload.announcement
    ? evidenceContentHashIndex(db, request)
    : new Map<string, Set<string>>()
  /** 本批将新建的企业键（供别名 / 差异 / 归并在预检时解析到同批企业）。 */
  const pending: PendingEnterprises = new Set()
  /** 本批新建主体的名称与统代（用于确认平台别名/按名归并是否只有一个真实候选）。 */
  const pendingEnterpriseCreates: PendingEnterpriseCreate[] = []
  /** 本批将写入的平台查询自然键（供别名 / 差异 / 归并在预检时解析到同批关系行）。 */
  const pendingRefs: PendingPlatformRefs = collectPendingPlatformRefs(payload)
  /** 先看整份载荷，标出同一出处行被指向多个不同目标路径的冲突。 */
  const announcementRecords = Array.isArray(payload.announcement?.records) ? payload.announcement.records : []
  const announcementIdentityPlan = payload.announcement && mode === 'write'
    ? planAnnouncementBatchIdentity(db, announcementRecords)
    : {
        identityUsccByRecord: new Map<number, string | null>(),
        ambiguousNameOnlyRecords: new Set<number>(),
      }
  announcementIdentityPlan.reviewedOwners = context.reviewedAnnouncement?.owners
  announcementIdentityPlan.reviewedCreates = context.reviewedAnnouncement?.created
  const ambiguousEvidence = payload.announcement
    ? ambiguousEvidenceRepointIds(db, payload.announcement, announcementRecords, evidenceContentHashes, announcementIdentityPlan)
    : new Set<number>()
  /** 新事件在首次写入前合并同坐标出处，避免重复项按遍历顺序覆盖来源。 */
  const newEventEvidencePlan = payload.announcement && mode === 'write'
    ? planNewEventEvidence(db, payload.announcement, announcementRecords, announcementIdentityPlan)
    : { eventsByRecord: new Map<number, RosterImportEvent[]>(), groupedOccurrences: new Set<string>() }
  const plannedWriteEvents = newEventEvidencePlan.eventsByRecord
  /**
   * **整份计划**已认领的出处行 id。
   *
   * 为什么必须跨记录共享：两条载荷记录若落到**同一条**既有记录上（同身份同坐标的重复行），
   * 各自算一遍 repoints 会把同一行数两次 —— 而执行阶段第二条会发现指针已经改好了（0 行）。
   * 同路径 no-op 不会认领；多目标冲突已由 `ambiguousEvidence` 在整份载荷上统一屏蔽。
   * 共享集合后每行只进入一个计划项，执行时使用该项冻结的目标，不会因前项写入而反向匹配。
   */
  const claimedEvidence = new Set<number>()

  const push = (planned: PlannedItem) => {
    items.push(planned)
    if (!planned.item.ok) conflicts.push(planned.item)
  }

  // ---- 公布文件：企业 / 记录 / 事件 / 出处 ---------------------------------
  if (payload.announcement) {
    const announcement = payload.announcement as RosterImportAnnouncement
    const source = announcement?.sourceDocument?.source
    const records = Array.isArray(announcement?.records) ? announcement.records : []
    if (!isObject(announcement?.sourceDocument) || !SOURCES.has(String(source))) {
      push({
        item: failure('announcement', 'announcement', 'source_document_invalid', 'announcement.sourceDocument.source 必须是 jxj / miit', 'sourceDocument.source'),
        action: 'skip',
        review: false,
      })
    } else if (mode === 'converge') {
      // 收敛重放不需要「本批会新建谁」这套推断 —— 它明确不新建任何行，
      // 故也不做 `planEnterpriseCreates`（那正是为了判 add/skip 而存在的）。
      records.forEach((record, index) => {
        planAnnouncementRecord(db, request, announcement, record, index, push, {
          create: null,
          earlierSameName: [],
          reusedInBatch: false,
        }, mode, claimedEvidence, ambiguousEvidence, undefined, context.evidenceRepointTargets, evidencePlanFingerprint, evidenceContentHashes, officialState)
      })
    } else {
      // 会**新建**的企业 —— 判据就是写入侧的身份规则（有统代只按统代、无统代才按名），
      // 不再用带「按名回退」的 {@link locateEnterprise}：那会让预检说「复用既有行」而
      // 写入侧**另起一行**（事故根因），本批的引用解析也跟着算错。**同一套规则只此一份**。
      const creates = planEnterpriseCreates(db, records, announcementIdentityPlan)
      for (const create of creates) {
        if (create) {
          if (!context.reviewedAnnouncement?.owners) pendingEnterpriseCreates.push(create)
          for (const key of pendingKeys(create)) pending.add(key)
        }
      }
      // 本批**已计划**的两张索引（都只装「本批会新建」的那些记录）：
      //  - 「身份键 → 已计划过的 (称号, 来源) 坐标」：同一批里两条记录同身份又同坐标时，
      //    写入侧会**复用**前一条新建的企业与记录 ⇒ 后一条要计 `skip`，不能计 `add`；
      //  - 「name_norm → 已计划新建的同名企业」：重名候选用。
      const plannedCoordinates = new Map<string, Set<string>>()
      const earlierByName = new Map<string, PendingEnterpriseCreate[]>()
      records.forEach((record, index) => {
        const create = creates[index] ?? null
        const name = optionalString(record?.enterprise?.name)
        const requestedUscc = usccOrNull(record?.enterprise?.uscc)
        const uscc = announcementIdentityPlan.identityUsccByRecord.get(index) ?? requestedUscc
        const coordinate = `${optionalString(record?.titleCode) ?? ''}/${optionalString(record?.source) ?? optionalString(announcement.sourceDocument?.source) ?? ''}`
        const reviewedOwner = context.reviewedAnnouncement?.owners?.get(index)
        const identityKey = reviewedOwner !== undefined ? `enterprise:${reviewedOwner}` : name ? identityKeyOf({ name, uscc }) : null
        const reusedInBatch = identityKey != null && (plannedCoordinates.get(identityKey)?.has(coordinate) ?? false)
        planAnnouncementRecord(db, request, announcement, record, index, push, {
          create,
          earlierSameName: create ? (earlierByName.get(create.nameNorm) ?? []) : [],
          reusedInBatch,
          identityUscc: uscc,
          ambiguousNameOnly: reviewedOwner === undefined && announcementIdentityPlan.ambiguousNameOnlyRecords.has(index),
          reviewedOwner,
          reviewedCreates: context.reviewedAnnouncement?.created,
        }, mode, claimedEvidence, ambiguousEvidence, plannedWriteEvents.get(index), context.evidenceRepointTargets, evidencePlanFingerprint, evidenceContentHashes, officialState)
        if ((create || reviewedOwner !== undefined) && identityKey != null) {
          const coordinates = plannedCoordinates.get(identityKey) ?? new Set<string>()
          coordinates.add(coordinate)
          plannedCoordinates.set(identityKey, coordinates)
          if (create) earlierByName.set(create.nameNorm, [...(earlierByName.get(create.nameNorm) ?? []), create])
        }
      })
    }
  }

  // ---- 收敛重放到此为止（§8.9.3）：下面每一类都可能**写新行** ---------------
  if (mode === 'converge') return { items, conflicts }

  // ---- 平台查询与关系 ------------------------------------------------------
  // **必须排在 aliases / differences / merges 之前**:那三项的自然键引用可能指向本批
  // 新建的查询/关系行,执行阶段要按「关系已插入」的顺序落真实 id（见本节顶部说明）。
  const queries = Array.isArray(payload.platformQueries) ? payload.platformQueries : []
  const recognizedKeys = new Set<string>()
  const pendingQueries = new Map<string, PlatformQueryReplaySource>()
  queries.forEach((query, index) => {
    const queryIdentity = JSON.stringify([query?.interface, optionalString(query?.queryKey), optionalString(query?.rdjb) ?? '', optionalString(query?.queriedAt)])
    if (query?.interface === 'recognized_list') {
      if (recognizedKeys.has(queryIdentity)) {
        push({ item: failure('platform_query', `query:${index}`, 'query_identity_duplicate', 'One original query identity may appear only once per batch', 'platformQueries'), action: 'skip', review: false })
        return
      }
      recognizedKeys.add(queryIdentity)
    }
    const source = planPlatformQuery(db, query, index, push, context.batchId, pendingQueries.get(queryIdentity))
    if (source) pendingQueries.set(queryIdentity, source)
  })

  // Freeze only server-read source inputs. Never accept a caller-provided content hash.
  const previousSources = context.batchId ? (db.select({ value: schema.importBatch.preflightResult }).from(schema.importBatch).where(eq(schema.importBatch.id, context.batchId)).get()?.value as RosterImportPreflight | null)?.platformObservationSources : undefined
  const platformObservationSources: NonNullable<RosterImportPreflight['platformObservationSources']> = []
  for (const { relationId } of payload.platformRecordObservations ?? []) {
    const expected = previousSources?.find(row => row.relationId === relationId)?.inputFingerprint
    try {
      const projection = historicalObservationPlan(db, relationId)
      platformObservationSources.push({ relationId, inputFingerprint: expected ?? projection.inputFingerprint })
      if (expected && projection.inputFingerprint !== expected) throw new PlatformProjectionError('projection_source_drift', `Original relation ${relationId} changed since preflight`)
      const apply = applyProjectionPreview(projection)
      const business = businessProjectionPreview(projection)
      const recognized = recognizedProjectionPreview(projection)
      push({ item: success('platform_observation', `relation:${relationId}`, { canonicalProjection: [{ ...projectionPreview(projection), ...(apply ? { applyProjection: apply } : {}), ...(business ? { businessProjection: business } : {}), ...(recognized ? { recognizedProjection: recognized } : {}) }] }), action: 'note', review: projection.identityState !== 'resolved' || projection.contentState !== 'verified', run: tx => projectionItem(tx, relationId, context.batchId, expected ?? projection.inputFingerprint) })
    } catch (error) {
      if (!(error instanceof PlatformProjectionError)) throw error
      if (expected && !platformObservationSources.some(row => row.relationId === relationId)) platformObservationSources.push({ relationId, inputFingerprint: expected })
      push({ item: failure('platform_observation', `relation:${relationId}`, error.code, error.message), action: 'skip', review: false })
    }
  }

  const previousLegacySources = context.batchId ? (db.select({ value: schema.importBatch.preflightResult }).from(schema.importBatch).where(eq(schema.importBatch.id, context.batchId)).get()?.value as RosterImportPreflight | null)?.platformLegacyProvenanceSources : undefined
  const platformLegacyProvenanceSources: NonNullable<RosterImportPreflight['platformLegacyProvenanceSources']> = []
  for (const input of payload.platformLegacyProvenance ?? []) {
    const ref = `query:${input.queryId}`
    const expected = previousLegacySources?.find(row => row.queryId === input.queryId)?.inputFingerprint
    try {
      const state = inspectLegacyPlatformProvenance(db, input, expected)
      platformLegacyProvenanceSources.push({ queryId: input.queryId, inputFingerprint: expected ?? state.inputFingerprint })
      push({ item: success('platform_legacy_provenance', ref, { queryId: input.queryId, provenanceKind: 'legacy_pagination', typedState: 'unknown', relationCount: state.relationCount }),
        action: state.exists ? 'skip' : 'add', review: false, run: tx => {
          try { return success('platform_legacy_provenance', ref, writeLegacyPlatformProvenance(tx, input, context.batchId!, expected ?? state.inputFingerprint)) }
          catch (error) {
            if (!(error instanceof LegacyProvenanceError)) throw error
            return failure('platform_legacy_provenance', ref, error.code, error.message)
          }
        } })
    } catch (error) {
      if (!(error instanceof LegacyProvenanceError)) throw error
      if (expected && !platformLegacyProvenanceSources.some(row => row.queryId === input.queryId)) platformLegacyProvenanceSources.push({ queryId: input.queryId, inputFingerprint: expected })
      push({ item: failure('platform_legacy_provenance', ref, error.code, error.message), action: 'skip', review: false })
    }
  }

  // ---- 曾用名 / 别名 -------------------------------------------------------
  const aliases = Array.isArray(payload.aliases) ? payload.aliases : []
  aliases.forEach((alias, index) => planAlias(db, pending, pendingEnterpriseCreates, pendingRefs, alias, index, push))

  // ---- 差异原因与措施 ------------------------------------------------------
  const differences = Array.isArray(payload.differences) ? payload.differences : []
  differences.forEach((difference, index) => planDifference(db, pending, pendingRefs, difference, index, push))

  // ---- 导出快照 ------------------------------------------------------------
  if (payload.exportSnapshot) planExportSnapshot(db, payload.exportSnapshot, context, push)

  // ---- 补录统一社会信用代码（RL-06）：只补**本来没有**的值，不并身份 -------------
  // 排在 `merges` **之前**：本项只把一家无统代企业的 `uscc_norm` 填上，而 `merges` 会
  // **删掉**被并企业行 —— 两项若指向同一行，先归并会让补录在写入阶段找不到企业
  // （进而整批回滚）。读侧计划从不为同一个目标同时给出两者（见
  // `layers/sme-roster/server/utils/uscc-research.ts`：一个目标要么有规范行可并、要么只能补录）。
  const backfills = Array.isArray(payload.usccBackfills) ? payload.usccBackfills : []
  backfills.forEach((backfill, index) => planUsccBackfill(db, backfill, index, push))

  // ---- 归并与回填（最后做，才能把本批新建的记录一并折进规范行）--------------
  const merges = Array.isArray(payload.merges) ? payload.merges : []
  merges.forEach((merge, index) => planMerge(db, pending, pendingEnterpriseCreates, pendingRefs, merge, index, push))

  let officialEvidencePlanHash: string | undefined
  if (officialInput && !conflicts.length) {
    try {
      const official = prepareOfficialImport(db, request, items, announcementIdentityPlan, context.filesDir, officialState, plannedWriteEvents, newEventEvidencePlan.groupedOccurrences)
      officialEvidencePlanHash = context.reviewedAnnouncement
        ? officialPlanDigest({ review: context.reviewedAnnouncement.decision, plan: official.planHash })
        : official.planHash
      const beforeMerges = items.findIndex(item => item.item.kind === 'merge')
      items.splice(beforeMerges < 0 ? items.length : beforeMerges, 0, official.item)
    } catch (error) {
      if (error instanceof Error && 'issues' in error) error = new OfficialFactError('invalid_input', 'Malformed typed official fact input', 400)
      if (!(error instanceof OfficialFactError || error instanceof OfficialEvidenceError || error instanceof Error && 'code' in error)) throw error
      const item = failure('official_evidence', 'payload', String(error.code), error.message)
      push({ item, action: 'skip', review: false })
    }
  }
  return { items, conflicts, officialEvidencePlanHash, ...(platformLegacyProvenanceSources.length ? { platformLegacyProvenanceSources } : {}), ...(platformObservationSources.length ? { platformObservationSources } : {}) }
}

function projectionItem(tx: Executor, relationId: number, batchId?: number, expected?: string): RosterImportItemResult {
  try {
    return success('platform_observation', `relation:${relationId}`, { canonicalProjection: [ensureHistoricalObservation(tx, relationId, batchId, expected)], rowsWritten: 0 })
  } catch (error) {
    if (!(error instanceof PlatformProjectionError)) throw error
    return failure('platform_observation', `relation:${relationId}`, error.code, error.message)
  }
}

/**
 * Validate the two announcement-only values whose malformed forms can change identity or evidence
 * meaning. Generic `optionalInt` remains shared by years and batch fields and is not changed here.
 */
export function validateAnnouncementIdentityAndEvidence(
  announcement: RosterImportAnnouncement | null | undefined,
): RosterImportItemResult[] {
  if (!announcement || !Array.isArray(announcement.records)) return []

  const errors: RosterImportItemResult[] = []
  announcement.records.forEach((record, recordIndex) => {
    const enterprise = isObject(record?.enterprise) ? record.enterprise : null
    const rawUscc = enterprise?.uscc
    const hasNonblankUscc =
      rawUscc !== null &&
      rawUscc !== undefined &&
      (typeof rawUscc !== 'string' || normalizeUscc(rawUscc) !== '')
    if (hasNonblankUscc) {
      const verdict = usccFormatVerdict(rawUscc)
      if (verdict !== 'ok') {
        const why =
          verdict === 'length' ? '长度不是 18 位' : verdict === 'charset' ? '含字符集外的字符' : '校验位不符'
        errors.push(
          failure(
            'record',
            `record:${recordIndex}`,
            'uscc_format_invalid',
            `统一社会信用代码不合法（${why}）：${String(rawUscc)}`,
            'enterprise.uscc',
          ),
        )
      }
    }

    const events = Array.isArray(record?.events) ? record.events : []
    events.forEach((event, eventIndex) => {
      const evidence = Array.isArray(event?.evidence) ? event.evidence : []
      evidence.forEach((item, evidenceIndex) => {
        if (!isObject(item)) return
        const sourceFile = optionalString(item.sourceFile)
        if (!sourceFile || item.page === null || item.page === undefined) return
        const ref = `record:${recordIndex}#${eventIndex}/e${evidenceIndex}`
        if (!isPageCapable(sourceFile)) {
          errors.push(
            failure(
              'record_evidence',
              ref,
              'not_page_capable',
              `${sourceFile} 不是 PDF，不能提供可复核的实际页码；请移除 page 或设为 null`,
              'evidence.page',
            ),
          )
          return
        }
        const page = item.page
        if (typeof page !== 'number' || !Number.isFinite(page) || !Number.isInteger(page) || page < 1) {
          errors.push(
            failure(
              'record_evidence',
              ref,
              'page_invalid',
              `PDF 出处 page 必须是正整数，收到：${String(page)}`,
              'evidence.page',
            ),
          )
        }
      })
    })
  })

  return errors
}

// --- 公布文件 --------------------------------------------------------------

export function validateAnnouncementRecord(
  announcement: RosterImportAnnouncement, record: RosterImportAnnouncement['records'][number], index: number,
) {
  const ref = `record:${index}`
  const name = optionalString(record?.enterprise?.name)
  if (!name) {
    return { error: failure('record', ref, 'enterprise_name_required', '记录缺少企业名称', 'records[].enterprise.name') } as const
  }
  const titleCode = optionalString(record.titleCode)
  if (!titleCode || !TITLE_CODES.has(titleCode)) {
    return { error: failure('record', ref, 'title_unknown', `称号不在字典内：${titleCode ?? '(空)'}`, 'titleCode') } as const
  }
  const source = record.source ?? announcement.sourceDocument.source
  if (!SOURCES.has(String(source))) {
    return { error: failure('record', ref, 'source_unknown', `来源必须是 jxj / miit，收到：${String(source)}`, 'source') } as const
  }
  const events = Array.isArray(record.events) ? record.events : []
  for (let i = 0; i < events.length; i += 1) {
    const event = events[i]!
    const eventRef = `record:${index}#${i}`
    if (!EVENT_TYPES.has(String(event?.eventType))) {
      return { error: failure('record_event', eventRef, 'event_type_unknown', `事件类型不在字典内：${String(event?.eventType)}`, 'eventType') } as const
    }
    if (event.reviewOutcome != null && !REVIEW_OUTCOMES.has(String(event.reviewOutcome))) {
      return { error: failure('record_event', eventRef, 'review_outcome_unknown', `复核结论必须是 passed / failed，收到：${String(event.reviewOutcome)}`, 'reviewOutcome') } as const
    }
    const evidence = Array.isArray(event.evidence) ? event.evidence : []
    for (let k = 0; k < evidence.length; k += 1) {
      if (!optionalString(evidence[k]?.sourceFile)) {
        return { error: failure('record_evidence', `${eventRef}/e${k}`, 'source_file_required', '出处缺少 sourceFile', 'evidence.sourceFile') } as const
      }
    }
  }

  return { name, titleCode, source, events }
}

function planAnnouncementRecord(
  db: Executor,
  request: RosterImportRequest,
  announcement: RosterImportAnnouncement,
  record: RosterImportAnnouncement['records'][number],
  index: number,
  push: (item: PlannedItem) => void,
  candidates: {
    create: PendingEnterpriseCreate | null
    earlierSameName: PendingEnterpriseCreate[]
    reusedInBatch: boolean
    identityUscc?: string | null
    ambiguousNameOnly?: boolean
    reviewedOwner?: number
    reviewedCreates?: ReadonlySet<number>
  } = { create: null, earlierSameName: [], reusedInBatch: false },
  mode: AnnouncementPlanMode = 'write',
  claimedEvidence: Set<number> = new Set(),
  ambiguousEvidence: ReadonlySet<number> = new Set(),
  plannedWriteEvents?: readonly RosterImportEvent[],
  savedEvidenceRepointTargets?: readonly EvidenceRepointTarget[],
  evidencePlanFingerprint = '',
  evidenceContentHashes: EvidenceContentHashIndex = new Map(),
  officialState?: OfficialImportState,
): void {
  const ref = `record:${index}`
  const validated = validateAnnouncementRecord(announcement, record, index)
  if (validated.error) {
    push({ item: validated.error, action: 'skip', review: false })
    return
  }
  const { name, titleCode, source, events } = validated

  const requestedUscc = usccOrNull(record.enterprise.uscc)
  const identityUscc = candidates.identityUscc !== undefined ? candidates.identityUscc : requestedUscc
  if (candidates.reviewedOwner === undefined && !requestedUscc && (
    candidates.ambiguousNameOnly || findEnterprisesByNorm(db, normalizeName(name)).length > 1
  )) {
    push({
      item: failure(
        'record',
        ref,
        'enterprise_ambiguous',
        '归一化名称命中多家既有企业，缺少统一社会信用代码无法唯一定位；请补充统代后重试',
        'enterprise.uscc',
      ),
      action: 'skip',
      review: false,
    })
    return
  }
  // 定位用**写入侧的身份规则**（预检与提交必须同一套）：
  // `locateEnterprise` 在「统代查不到」时会退回按名找，于是预检会说「企业已存在、这条是 skip」，
  // 而 `upsertEnterprise`（只按统代）却会新建一行 —— 那是本票事故的根因，不能用它来决定 add/skip。
  const existing = candidates.reviewedOwner === undefined ? findEnterpriseByIdentity(db, { name, uscc: identityUscc }) : findEnterpriseById(db, candidates.reviewedOwner)
  const district = optionalString(record.enterprise.district)
  let existingRecord: { id: number } | undefined
  if (existing) {
    existingRecord = db
      .select({ id: schema.record.id })
      .from(schema.record)
      .where(and(
        eq(schema.record.enterpriseId, existing.id),
        eq(schema.record.titleCode, titleCode),
        eq(schema.record.source, source),
      ))
      .orderBy(schema.record.id)
      .limit(1)
      .get()
  }

  // 重放时**出处指针**可能需要收敛(RL-16):
  // 来源文件入库后同一份内容的标识从库外路径变成库内路径。事件坐标不变 ⇒ 历史一行不改,
  // 只有出处的 `source_file` 被指向新路径。这件事**要报进预检**,故按提交会改的行数定 action。
  //
  // `claimedEvidence` 由整份计划共享（同一行不会被两条载荷记录各认领一次 —— 认领的粒度是
  // **出处行 id**）。目标操作在计划期冻结；提交和 replay 执行同一组 id/path，不会因前一项写入
  // 改变匹配结果。已提交批次的 replay 复用原提交快照，避免把已更新的目标误判成旧来源。
  const repointPlan = existingRecord
    ? mode === 'converge' && savedEvidenceRepointTargets !== undefined
      ? evidenceRepointsFromSavedPlan(db, existingRecord.id, savedEvidenceRepointTargets, claimedEvidence, evidenceContentHashes)
      : countEvidenceRepoints(db, existingRecord.id, events, claimedEvidence, ambiguousEvidence, evidenceContentHashes)
    : { targets: [], hashConflicts: new Set<EvidenceContentHashConflict>() }
  if (repointPlan.hashConflicts.size > 0) {
    const mismatch = repointPlan.hashConflicts.has('mismatch')
    push({
      item: failure(
        'record_evidence',
        ref,
        mismatch ? 'evidence_content_hash_mismatch' : 'evidence_content_hash_unknown',
        mismatch
          ? '旧出处与目标文件 SHA-256 不同，保留旧出处；请人工核对是否需要追加独立出处'
          : '旧出处或目标文件缺少唯一可验证的 SHA-256，保留旧出处；请人工核对来源身份',
        'evidence.sourceFile',
      ),
      action: 'skip',
      review: false,
    })
    return
  }
  const repointTargets = repointPlan.targets
  const repoints = repointTargets.length

  // 收敛重放（§8.9.3）：只改既有出处行的指针，**不新建任何行**、也不记重名候选。
  // 库状态在这一模式下没得商量 —— 载荷里有、库里没有的东西一律不写（故没有 `add`）。
  if (mode === 'converge') {
    const recordId = existingRecord?.id
    push({
      item: success('record', recordId != null ? `record:${recordId}` : ref, {
        enterpriseId: existing?.id ?? null,
        titleCode,
        source,
      }),
      action: repoints > 0 ? 'update' : 'skip',
      review: false,
      repoints,
      evidenceRepointTargets: repointTargets,
      run:
        repoints > 0 && recordId != null
          ? (tx) => {
              const evidenceRepointed = applyEvidenceRepointTargets(tx, repointTargets, officialState?.changedEvents)
              return success('record', `record:${recordId}`, {
                enterpriseId: existing?.id ?? null,
                recordId,
                evidenceRepointed,
                evidenceRepointTargets: repointTargets,
                evidenceRepointPlanFingerprint: evidencePlanFingerprint,
                // 收敛**只改指针**：一行没插，也没有事件被跳过。
                skipped: 0,
                rowsWritten: 0,
              })
            }
          : undefined,
    })
    return
  }

  // 这一条记录会**复用**既有行（`existingRecord`）吗？
  // 两条判据都必须在，否则预检又会与提交不一致：
  //  - 库里已有同坐标记录（库状态）；
  //  - 或**本批更早**的记录已经为**同一身份的同一坐标**建过（写入侧会复用那条，
  //    `rowsWritten` 为 0）—— 库里此刻看不到它，只看库会把这种情况误报成 `add`。
  const reused = !!existingRecord || candidates.reusedInBatch
  const writeEvents = plannedWriteEvents ?? events

  push({
    item: success(
      'record',
      existing ? `record:${existingRecord?.id ?? ref}` : ref,
      { enterpriseId: existing?.id ?? null, titleCode, source },
    ),
    qualificationCandidate: {
      ref,
      targetKey: existing ? `enterprise:${existing.id}` : `new:${identityKeyOf({ name, uscc: identityUscc })}`,
      enterpriseId: existing?.id ?? null,
      diagnostics: source === 'jxj' ? events.map((event, eventIndex) => ({ ref: `${ref}#${eventIndex}`, eventType: event.eventType, ...diagnoseOfficialEventFields(event) })) : [],
    },
    // 两条判据**都要**：不复用 ⇒ add；复用且有出处指针收敛 ⇒ update（预检如实计入 §8.5）；
    // 复用且无收敛 ⇒ skip。
    action: !reused ? 'add' : repoints > 0 ? 'update' : 'skip',
    review: !requestedUscc,
    repoints,
    evidenceRepointTargets: repointTargets,
    run: (tx) => {
      const result = writeAnnouncementRecord(
        tx,
        request,
        announcement,
        { ...record, events: [...writeEvents] },
        { name, uscc: identityUscc, district, titleCode, source, reviewedOwner: candidates.reviewedOwner, reviewedCreate: candidates.create !== null, reason: { existingRecord } },
        repointTargets,
        officialState,
      )
      return {
        ...result,
        detail: { ...(result.detail ?? {}), evidenceRepointPlanFingerprint: evidencePlanFingerprint },
      }
    },
  })

  // 重名候选（RL-14）：这次**新建企业**，而库里（或本批更早）已经有同名的另一行。
  // 只报出不合并、不计入影响计数（`action: 'note'`）—— 是否归并由证据决定（§5.3）。
  if (candidates.create) {
    for (const planned of duplicateNameCandidates(db, candidates.create, candidates.earlierSameName, candidates.reviewedCreates, candidates.reviewedOwner)) {
      push({
        item: success('duplicate_candidate', duplicateCandidateRef(planned.candidate), {
          candidate: planned.candidate,
        }),
        action: 'note',
        review: false,
        run: (tx) => resolveDuplicateCandidate(tx, planned, candidates.reviewedOwner),
      })
    }
  }
}

interface AnnouncementWriteReason {
  existingRecord?: { id: number }
}

function writeAnnouncementRecord(
  tx: Executor,
  request: RosterImportRequest,
  announcement: RosterImportAnnouncement,
  record: RosterImportAnnouncement['records'][number],
  resolved: {
    name: string
    uscc: string | null
    district: string | null
    titleCode: string
    source: 'jxj' | 'miit'
    reviewedOwner?: number
    reviewedCreate?: boolean
    reason: AnnouncementWriteReason
  },
  repointTargets: readonly EvidenceRepointTarget[] = [],
  officialState?: OfficialImportState,
): RosterImportItemResult {
  const { name, uscc, district, titleCode, source } = resolved

  // 来源文件（公布文件）。按 (来源, 标题, 文号) 复用，避免重放堆行。
  const published = record.events?.flatMap(event => event.evidence ?? []).find(evidence => evidence.publishedRow)?.publishedRow
  const declarationsBefore = officialState?.declarations.size ?? 0
  const sourceDocument = published && officialState
    ? { id: resolveOfficialDeclaration(tx, published.declaration, officialState.declarations), created: officialState.declarations.size > declarationsBefore }
    : upsertSourceDocument(tx, {
    source,
    title: optionalString(announcement.sourceDocument.title) ?? request.sourceIdentity,
    docNumber: optionalString(announcement.sourceDocument.docNumber),
    issueDate: optionalString(announcement.sourceDocument.issueDate),
    path: request.sourceIdentity,
  })

  // 企业：统代优先、缺失按归一化名。
  const enterprise = resolved.reviewedOwner === undefined
    ? upsertEnterprise(tx, { name, uscc, district })
    : { id: resolved.reviewedOwner, created: resolved.reviewedCreate === true }
  if (resolved.reviewedOwner === undefined) {
    tx.insert(schema.rosterLegacyMember).values({ enterpriseId: enterprise.id }).onConflictDoNothing().run()
  }

  // 记录：(企业, 称号, 来源) 唯一。
  const recordRow = upsertRecord(tx, {
    enterpriseId: enterprise.id,
    titleCode,
    source,
    usccRaw: uscc,
    nameRaw: name,
    district,
  })
  const recordId = recordRow.id
  const evidenceRepointed = applyEvidenceRepointTargets(tx, repointTargets, officialState?.changedEvents)

  // 事件 + 出处：同坐标的完全相同事件**跳过**（重放安全），否则新增。
  const writtenEvents: number[] = []
  const writtenEvidence: number[] = []
  let skipped = 0
  for (const event of record.events ?? []) {
    const coords = eventCoordinates(recordId, event)
    const duplicate = findExistingEvent(tx, coords)
    if (duplicate) {
      skipped += 1
      // 既有事件的出处指针已由计划期冻结的 `repointTargets` 更新；不在执行期重新匹配。
      // 新事件的重复坐标已在计划期合并到首次出现项，其余项在此只计跳过。
      continue
    }
    const values = {
      recordId,
      eventType: event.eventType,
      year: optionalInt(event.year),
      batchSeq: optionalInt(event.batchSeq),
      sortKey: optionalInt(event.year) ?? 0,
      reviewOutcome: (event.reviewOutcome ?? null) as 'passed' | 'failed' | null,
      decidedYear: optionalInt(event.decidedYear),
    }
    const eventId = tx.insert(schema.recordEvent).values(values).returning({ id: schema.recordEvent.id }).get().id
    writtenEvents.push(eventId)
    for (const evidence of event.evidence ?? []) {
      const evidenceId = tx
        .insert(schema.recordEvidence)
        .values({
          recordEventId: eventId,
          ...announcementEvidenceCoordinate(evidence),
        })
        .returning({ id: schema.recordEvidence.id })
        .get().id
      writtenEvidence.push(evidenceId)
      if (evidence.publishedRow && officialState?.batchId) writeOfficialPublishedRow(tx, evidence.publishedRow, evidenceId, 0, { kind: 'import', batchId: officialState.batchId }, officialState.declarations)
    }
    if (source === 'jxj') captureOfficialEventRevision113(tx, eventId, 0, 1)
  }

  return success('record_event', `record:${recordId}`, {
    enterpriseId: enterprise.id,
    recordId,
    sourceDocumentId: sourceDocument.id,
    events: writtenEvents,
    evidence: writtenEvidence,
    skipped,
    /**
     * **被收敛了指针**的既有出处行数(RL-16)。它不是新增行(`rowsWritten` 不含它),
     * 但也不是「什么都没发生」—— 单独报出来,免得重放看起来像纯空操作。
     * 0 表示本次没有任何出处需要改(绝大多数的重放都是 0)。
     */
    evidenceRepointed,
    evidenceRepointTargets: repointTargets,
    /**
     * 本项**真正插入的行数**：新企业 / 新来源文件 / 新记录 / 新事件 / 新出处。
     * 重放同一内容时全是 0（企业与记录按自然键复用、同坐标事件跳过）——
     * `summary.written` 由它求和，所以「零新增」不会再被报成「写了 N 条记录」。
     */
    rowsWritten:
      (published && officialState ? officialState.declarations.size - declarationsBefore : sourceDocument.created ? 1 : 0) +
      (enterprise.created ? 1 : 0) +
      (recordRow.created ? 1 : 0) +
      writtenEvents.length +
      writtenEvidence.length,
  })
}

/**
 * 定位或新建来源文件。返回 `created` —— 本项**真的插了一行**才为真。
 * 「重放时一行没写」这个事实必须能报出来(`summary.written`,见 `summarizeCommit`)。
 */
function upsertSourceDocument(
  tx: Executor,
  input: { source: string; title: string; docNumber: string | null; issueDate: string | null; path: string },
): { id: number; created: boolean } {
  const existing = tx
    .select()
    .from(schema.sourceDocument)
    .all()
    .find(
      (d) =>
        d.source === input.source &&
        d.title === input.title &&
        (d.docNumber ?? null) === input.docNumber,
    )
  if (existing) return { id: existing.id, created: false }
  const id = tx
    .insert(schema.sourceDocument)
    .values({
      source: input.source as 'jxj' | 'miit',
      title: input.title,
      docNumber: input.docNumber,
      issueDate: input.issueDate,
      path: input.path,
    })
    .returning({ id: schema.sourceDocument.id })
    .get().id
  return { id, created: true }
}

/** 定位或新建企业。返回 `created`(同 {@link upsertSourceDocument})。 */
function upsertEnterprise(
  tx: Executor,
  input: { name: string; uscc: string | null; district: string | null },
): { id: number; created: boolean } {
  const nameNorm = normalizeName(input.name)
  const existing = input.uscc
    ? findEnterpriseByUscc(tx, input.uscc)
    : findEnterpriseByNorm(tx, nameNorm)
  if (existing) return { id: existing.id, created: false }
  const { id } = insertEnterprise(tx, {
      usccNorm: input.uscc,
      name: input.name,
      nameNorm,
      district: input.district,
      qualityFlags: input.uscc ? [] : ['uscc_missing'],
    })
  return { id, created: true }
}

/** 定位或新建记录(企业 × 称号 × 来源)。返回 `created`(同 {@link upsertSourceDocument})。 */
function upsertRecord(
  tx: Executor,
  input: {
    enterpriseId: number
    titleCode: string
    source: 'jxj' | 'miit'
    usccRaw: string | null
    nameRaw: string
    district: string | null
  },
): { id: number; created: boolean } {
  const existing = tx
    .select({ id: schema.record.id })
    .from(schema.record)
    .where(and(
      eq(schema.record.enterpriseId, input.enterpriseId),
      eq(schema.record.titleCode, input.titleCode),
      eq(schema.record.source, input.source),
    ))
    .orderBy(schema.record.id)
    .limit(1)
    .get()
  if (existing) return { id: existing.id, created: false }
  const id = tx
    .insert(schema.record)
    .values({
      enterpriseId: input.enterpriseId,
      titleCode: input.titleCode,
      source: input.source,
      district: input.district,
      usccRaw: input.usccRaw,
      nameRaw: input.nameRaw,
    })
    .returning({ id: schema.record.id })
    .get().id
  return { id, created: true }
}

/**
 * 事件的**坐标**(重放判重与收敛比对共用同一份取值)。
 *
 * 为什么抽出来:预检(算「将要更新几行」)与执行(真的改哪几行)必须**同一条判据** ——
 * 两处各算一次迟早会漂,而漂了以后预检报的就不再是提交真会发生的事(本文件开头的承诺)。
 */
interface EventCoordinates {
  recordId: number
  eventType: string
  year: number | null
  batchSeq: number | null
  reviewOutcome: string | null
  decidedYear: number | null
}

/** 由载荷里的一条事件 + 它所属记录算出坐标。 */
export function eventCoordinates(recordId: number, event: RosterImportEvent): EventCoordinates {
  return {
    recordId,
    eventType: String(event.eventType),
    year: optionalInt(event.year),
    batchSeq: optionalInt(event.batchSeq),
    reviewOutcome: event.reviewOutcome == null ? null : String(event.reviewOutcome),
    decidedYear: optionalInt(event.decidedYear),
  }
}

/** 一行 `record_event` 是不是这个坐标。 */
export function matchesEventCoordinates(row: EventCoordinates, values: EventCoordinates): boolean {
  return (
    row.recordId === values.recordId &&
    row.eventType === values.eventType &&
    (row.year ?? null) === values.year &&
    (row.batchSeq ?? null) === values.batchSeq &&
    (row.reviewOutcome ?? null) === values.reviewOutcome &&
    (row.decidedYear ?? null) === values.decidedYear
  )
}

/** 同坐标的**完全相同**事件(含复核结论与结论年份)—— 命中即跳过,保证重放不堆行。 */
function findExistingEvent(tx: Executor, values: EventCoordinates): { id: number } | undefined {
  return tx
    .select({ id: schema.recordEvent.id })
    .from(schema.recordEvent)
    .where(and(
      eq(schema.recordEvent.recordId, values.recordId),
      eq(schema.recordEvent.eventType, sql`${values.eventType}`),
      values.year === null ? isNull(schema.recordEvent.year) : eq(schema.recordEvent.year, values.year),
      values.batchSeq === null ? isNull(schema.recordEvent.batchSeq) : eq(schema.recordEvent.batchSeq, values.batchSeq),
      values.reviewOutcome === null ? isNull(schema.recordEvent.reviewOutcome) : eq(schema.recordEvent.reviewOutcome, sql`${values.reviewOutcome}`),
      values.decidedYear === null ? isNull(schema.recordEvent.decidedYear) : eq(schema.recordEvent.decidedYear, values.decidedYear),
    ))
    // The former table scan + find selected the first ROWID among duplicate coordinates.
    .orderBy(schema.recordEvent.id)
    .limit(1)
    .get()
}

// ---------------------------------------------------------------------------
// 重放时的**出处指针收敛**(RL-16)
// ---------------------------------------------------------------------------
//
// 背景:来源文件入库后,同一份内容的标识从**库外路径**变成**库内路径**。若重放既有事件时
// 只「跳过」,`record_evidence.source_file` 就永远指着库外路径,名录行点开预览解析不到文件。
//
// 三条边界(为什么这样做是安全的):
//  1. **事件事实不变**。事件坐标(类型/年份/批次/结论/结论年份)逐字相同才进入这条路径,
//     事件与出处行一行不加、一行不删；只收敛来源指针,并按目标文件类型清理不可靠页码。
//  2. 附件、序号逐字匹配；页码只对目标 PDF 参与匹配。目标格式没有稳定分页时,两侧 page 都归一为
//     null,且只有事件内唯一的 (附件, 序号) 行才允许收敛；多个候选视为歧义并跳过,不把一行错配给另一行。
//     非 PDF 目标还会清理历史伪页码；PDF 的既有实际页码原样保留。路径只是「同一份文档在库里的位置」,不是身份。
//     旧路径与目标路径还必须各自有唯一可验证的 SHA-256 且完全相同;缺失 / 冲突 / 不同都报告冲突并保留旧出处。
//  3. **收敛的触发权在幂等键上**。键含来源标识(见 `layers/sme-roster/lib/roster/little-giant-import.ts`):
//     只有携带**同一份来源内容**、且来源标识变了的批次才会走到这里。

/** 出处行的坐标字段(路径不参与 —— 它正是要被收敛的那一项)。 */
interface EvidenceCoordinateRow {
  id: number
  sourceFile: string
  attachment: string | null
  listNo: number | null
  page: number | null
}

/** 收集只与其精确路径身份绑定的 SHA-256；逻辑身份不能替另一条出处路径背书。 */
export function indexedEvidenceHashes(request: RosterImportRequest, sources: readonly { path: string; sha256: string | null }[]) {
  const index: EvidenceContentHashIndex = new Map()
  const add = (path: string | null | undefined, rawHash: unknown) => {
    const sha256 = optionalString(rawHash)
    if (!path || !sha256 || !/^[a-f0-9]{64}$/i.test(sha256)) return
    const hashes = index.get(path) ?? new Set<string>()
    hashes.add(sha256.toLowerCase())
    index.set(path, hashes)
  }

  for (const { path, sha256 } of sources) add(path, sha256)
  add(request.sourceIdentity, request.sourceSha256)
  return index
}

function evidenceContentHashIndex(db: Executor, request: RosterImportRequest): EvidenceContentHashIndex {
  const files = db.select({ path: schema.storedFile.relPath, sha256: schema.storedFile.sha256 }).from(schema.storedFile).all()
  const batches = db.select({ path: schema.importBatch.sourceIdentity, sha256: schema.importBatch.sourceSha256 })
    .from(schema.importBatch).where(and(eq(schema.importBatch.status, 'committed'), eq(schema.importBatch.sourceKind, 'announcement'))).all()
  return indexedEvidenceHashes(request, [...files, ...batches])
}

function verifiedEvidenceContentHash(index: EvidenceContentHashIndex, path: string): string | null {
  const hashes = index.get(path)
  return hashes?.size === 1 ? [...hashes][0] ?? null : null
}

function evidenceContentHashMatch(
  index: EvidenceContentHashIndex,
  oldPath: string,
  targetPath: string,
): EvidenceContentHashConflict | 'same' {
  const oldHash = verifiedEvidenceContentHash(index, oldPath)
  const targetHash = verifiedEvidenceContentHash(index, targetPath)
  if (!oldHash || !targetHash) return 'unknown'
  return oldHash === targetHash ? 'same' : 'mismatch'
}

interface CandidateEvidencePaths {
  pathsByRow: Map<number, Set<string>>
  hashConflicts: Set<EvidenceContentHashConflict>
}

/** 页码只在目标来源是 PDF 时作为坐标；其它格式把请求值和存储值都归一成 null。 */
function evidencePageCoordinate(sourceFile: string, page: unknown): number | null {
  return isPageCapable(sourceFile) ? (optionalInt(page) ?? null) : null
}

/** 已存在出处行的格式化坐标是否与载荷里的那条出处相同。 */
function matchesEvidenceCoordinates(row: EvidenceCoordinateRow, wanted: RosterImportEvidence): boolean {
  return (
    (row.attachment ?? null) === (optionalString(wanted.attachment) ?? null) &&
    (row.listNo ?? null) === (optionalInt(wanted.listNo) ?? null) &&
    evidencePageCoordinate(wanted.sourceFile, row.page) === evidencePageCoordinate(wanted.sourceFile, wanted.page)
  )
}

/**
 * 算出**这次要改哪几条出处行**。一进一出各一条、按行一一对应(同一条已存在的行不会被
 * 两条载荷出处重复认领),且只在 `source_file` 真的不同时才改。
 */
function repointTargets(
  recordId: number,
  recordEventId: number,
  existing: readonly EvidenceCoordinateRow[],
  wanted: readonly RosterImportEvidence[],
  taken: Set<number> = new Set(),
  ambiguous: ReadonlySet<number> = new Set(),
  evidenceContentHashes: EvidenceContentHashIndex,
): EvidenceRepointPlan {
  const { pathsByRow: targetPathsByRow, hashConflicts } = candidateTargetPathsByRow(existing, wanted, evidenceContentHashes)
  const existingById = new Map(existing.map((row) => [row.id, row]))
  const out: EvidenceRepointTarget[] = []
  for (const [id, paths] of targetPathsByRow) {
    // 一条既有行若有多个不同目标路径或已被整份载荷判为冲突，不按载荷顺序猜一个。
    if (taken.has(id) || ambiguous.has(id) || paths.size !== 1) continue
    const [sourceFile] = paths
    if (!sourceFile) continue
    const current = existingById.get(id)
    if (!current) continue
    taken.add(id)
    out.push({ id, recordId, recordEventId, fromSourceFile: current.sourceFile, sourceFile })
  }
  return { targets: out, hashConflicts }
}

/** 每个唯一坐标行收集本组载荷里实际需要改到的路径；同路径 no-op 不参与认领。 */
function candidateTargetPathsByRow(
  existing: readonly EvidenceCoordinateRow[],
  wanted: readonly RosterImportEvidence[],
  evidenceContentHashes: EvidenceContentHashIndex,
): CandidateEvidencePaths {
  const targetPathsByRow = new Map<number, Set<string>>()
  const hashConflicts = new Set<EvidenceContentHashConflict>()
  for (const rawCandidate of wanted as readonly unknown[]) {
    if (!isObject(rawCandidate)) continue
    const candidate = rawCandidate as unknown as RosterImportEvidence
    const sourceFile = optionalString(candidate.sourceFile)
    if (!sourceFile) continue
    // 按目标格式归一坐标后必须只命中一行。非 PDF 的 page 不参与坐标；PDF 页号仍精确参与。
    // 同路径候选是 no-op，不认领该行；这样后续有效路径仍可更新它。
    const matches = existing.filter((row) => matchesEvidenceCoordinates(row, candidate))
    if (matches.length !== 1) continue
    const [hit] = matches
    if (!hit || hit.sourceFile === sourceFile) continue
    const hashMatch = evidenceContentHashMatch(evidenceContentHashes, hit.sourceFile, sourceFile)
    if (hashMatch !== 'same') {
      hashConflicts.add(hashMatch)
      continue
    }
    const paths = targetPathsByRow.get(hit.id) ?? new Set<string>()
    paths.add(sourceFile)
    targetPathsByRow.set(hit.id, paths)
  }
  return { pathsByRow: targetPathsByRow, hashConflicts }
}

/**
 * 扫描整份公告载荷，把同一既有出处行被不同记录指向多个路径的情况标为歧义。
 * 这样预检、普通提交与显式重放对跨记录重复键也采用同一决定。
 */
function ambiguousEvidenceRepointIds(
  db: Executor,
  announcement: RosterImportAnnouncement,
  records: readonly RosterImportAnnouncement['records'][number][],
  evidenceContentHashes: EvidenceContentHashIndex,
  identities: AnnouncementBatchIdentityPlan,
): Set<number> {
  const recordIdByIndex = new Map<number, number>()
  const storedRecords = db.select().from(schema.record).all()
  for (const [index, record] of records.entries()) {
    const name = optionalString(record?.enterprise?.name)
    const titleCode = optionalString(record?.titleCode)
    const source = record?.source ?? announcement.sourceDocument?.source
    if (!name || !titleCode || !TITLE_CODES.has(titleCode) || !SOURCES.has(String(source))) continue
    const enterprise = announcementOwner(db, identities, index, name, identities.identityUsccByRecord.get(index) ?? usccOrNull(record.enterprise.uscc))
    if (!enterprise) continue
    const existingRecord = storedRecords.find(
      (row) => row.enterpriseId === enterprise.id && row.titleCode === titleCode && row.source === source,
    )
    if (existingRecord) recordIdByIndex.set(index, existingRecord.id)
  }
  if (recordIdByIndex.size === 0) return new Set()

  const recordIds = [...new Set(recordIdByIndex.values())]
  const eventRows = db
    .select()
    .from(schema.recordEvent)
    .where(inArray(schema.recordEvent.recordId, recordIds))
    .all()
  if (eventRows.length === 0) return new Set()
  const eventIds = eventRows.map((event) => event.id)
  const evidenceRows = db
    .select({
      id: schema.recordEvidence.id,
      recordEventId: schema.recordEvidence.recordEventId,
      sourceFile: schema.recordEvidence.sourceFile,
      attachment: schema.recordEvidence.attachment,
      listNo: schema.recordEvidence.listNo,
      page: schema.recordEvidence.page,
    })
    .from(schema.recordEvidence)
    .where(inArray(schema.recordEvidence.recordEventId, eventIds))
    .all()

  return ambiguousAnnouncementRepoints(records, recordIdByIndex, eventRows, evidenceRows, evidenceContentHashes)
}

export function ambiguousAnnouncementRepoints(records: readonly RosterImportAnnouncement['records'][number][],
  recordIdByIndex: ReadonlyMap<number, number>, eventRows: typeof schema.recordEvent.$inferSelect[],
  evidenceRows: readonly (EvidenceCoordinateRow & { recordEventId: number })[], evidenceContentHashes: EvidenceContentHashIndex) {
  const eventsByRecord = new Map<number, typeof eventRows>()
  for (const row of eventRows) {
    const rows = eventsByRecord.get(row.recordId) ?? []
    rows.push(row)
    eventsByRecord.set(row.recordId, rows)
  }
  const evidenceByEvent = new Map<number, EvidenceCoordinateRow[]>()
  for (const row of evidenceRows) {
    const rows = evidenceByEvent.get(row.recordEventId) ?? []
    rows.push(row)
    evidenceByEvent.set(row.recordEventId, rows)
  }

  const targetPathsByEvidence = new Map<number, Set<string>>()
  for (const [index, recordId] of recordIdByIndex) {
    const storedEvents = eventsByRecord.get(recordId) ?? []
    const requestEvents = Array.isArray(records[index]?.events) ? records[index]!.events! : []
    for (const rawEvent of requestEvents) {
      // Invalid event elements must reach planAnnouncementRecord's structured validation.
      if (!isObject(rawEvent)) continue
      const event = rawEvent as unknown as RosterImportEvent
      const coords = eventCoordinates(recordId, event)
      const existingEvent = storedEvents.find((row) => matchesEventCoordinates(row, coords))
      if (!existingEvent) continue
      const candidates = candidateTargetPathsByRow(
        evidenceByEvent.get(existingEvent.id) ?? [],
        Array.isArray(event.evidence) ? event.evidence : [],
        evidenceContentHashes,
      )
      for (const [evidenceId, paths] of candidates.pathsByRow) {
        const allPaths = targetPathsByEvidence.get(evidenceId) ?? new Set<string>()
        for (const path of paths) allPaths.add(path)
        targetPathsByEvidence.set(evidenceId, allPaths)
      }
    }
  }

  return new Set([...targetPathsByEvidence].filter(([, paths]) => paths.size > 1).map(([id]) => id))
}

/** 将重复出现的同一事件坐标合并，之后一次性按出处行解析目标与歧义。 */
function groupEventEvidenceById(
  events: readonly RosterImportEvent[],
  eventIdFor: (event: RosterImportEvent) => number | undefined,
): Map<number, RosterImportEvidence[]> {
  const byEvent = new Map<number, RosterImportEvidence[]>()
  for (const event of events) {
    const eventId = eventIdFor(event)
    if (eventId == null) continue
    const evidence = byEvent.get(eventId) ?? []
    evidence.push(...(event.evidence ?? []))
    byEvent.set(eventId, evidence)
  }
  return byEvent
}

/** 执行计划期冻结的收敛目标；路径或事件已被别的操作改变时安全跳过。 */
function applyEvidenceRepointTargets(tx: Executor, targets: readonly EvidenceRepointTarget[], deferredRevisions?: Map<number, number>): number {
  let repointed = 0
  const changedEvents = new Map<number, number>()
  for (const target of targets) {
    const before = !isPageCapable(target.sourceFile) ? tx.select({ page: schema.recordEvidence.page, revision: schema.recordEvent.revision }).from(schema.recordEvidence)
      .innerJoin(schema.recordEvent, eq(schema.recordEvent.id, schema.recordEvidence.recordEventId)).where(eq(schema.recordEvidence.id, target.id)).get() : null
    const result = tx
      .update(schema.recordEvidence)
      .set(
        isPageCapable(target.sourceFile)
          ? { sourceFile: target.sourceFile }
          : { sourceFile: target.sourceFile, page: null },
      )
      .where(
        and(
          eq(schema.recordEvidence.id, target.id),
          eq(schema.recordEvidence.recordEventId, target.recordEventId),
          eq(schema.recordEvidence.sourceFile, target.fromSourceFile),
        ),
      )
      .run()
    if (result.changes > 0) {
      repointed += 1
      // Path convergence is prevalidated equal SHA content. Only a lost page coordinate
      // changes usable evidence; pure same-content path moves are semantic no-ops.
      if (before?.page != null) changedEvents.set(target.recordEventId, before.revision)
    }
  }
  for (const [eventId, revision] of changedEvents) {
    if (deferredRevisions) deferredRevisions.set(eventId, revision)
    else advanceOfficialEventRevision(tx, eventId, revision)
  }
  return repointed
}

/** 已提交批次的目标快照只在原路径仍然存在时重放，已到达目标则自然成为 no-op。 */
function evidenceRepointsFromSavedPlan(
  db: Executor,
  recordId: number,
  saved: readonly EvidenceRepointTarget[],
  taken: Set<number>,
  evidenceContentHashes: EvidenceContentHashIndex,
): EvidenceRepointPlan {
  const candidates = saved.filter((target) => target.recordId === recordId && !taken.has(target.id))
  if (candidates.length === 0) return { targets: [], hashConflicts: new Set() }
  const evidenceRows = db
    .select({ id: schema.recordEvidence.id, sourceFile: schema.recordEvidence.sourceFile, recordEventId: schema.recordEvidence.recordEventId })
    .from(schema.recordEvidence)
    .where(inArray(schema.recordEvidence.id, candidates.map((target) => target.id)))
    .all()
  const eventIds = [...new Set(candidates.map((target) => target.recordEventId))]
  const eventRows = db
    .select({ id: schema.recordEvent.id, recordId: schema.recordEvent.recordId })
    .from(schema.recordEvent)
    .where(inArray(schema.recordEvent.id, eventIds))
    .all()
  const evidenceById = new Map(evidenceRows.map((row) => [row.id, row]))
  const recordIdByEvent = new Map(eventRows.map((row) => [row.id, row.recordId]))
  const targets: EvidenceRepointTarget[] = []
  const hashConflicts = new Set<EvidenceContentHashConflict>()
  for (const target of candidates) {
    const row = evidenceById.get(target.id)
    if (
      !row ||
      row.recordEventId !== target.recordEventId ||
      recordIdByEvent.get(target.recordEventId) !== recordId ||
      row.sourceFile !== target.fromSourceFile
    ) continue
    const hashMatch = evidenceContentHashMatch(evidenceContentHashes, target.fromSourceFile, target.sourceFile)
    if (hashMatch !== 'same') {
      hashConflicts.add(hashMatch)
      continue
    }
    taken.add(target.id)
    targets.push(target)
  }
  return { targets, hashConflicts }
}

/**
 * 本次载荷会把**已存在出处行**的 `source_file` 收敛掉几条 —— 预检用。
 * 与执行阶段同一份 `repointTargets`,故预检报的 `evidenceRepoints` 就是提交真会改的行数。
 *
 * `taken` 由调用方给（整份计划共享一个），否则两条载荷记录落到同一条既有记录时会各自
 * 数一遍同一批出处行 —— 预检就会报出提交改不到的条数。
 */
function countEvidenceRepoints(
  db: Executor,
  recordId: number,
  events: readonly RosterImportEvent[],
  taken: Set<number> = new Set(),
  ambiguous: ReadonlySet<number> = new Set(),
  evidenceContentHashes: EvidenceContentHashIndex,
): EvidenceRepointPlan {
  if (events.length === 0) return { targets: [], hashConflicts: new Set() }
  const eventRows = db
    .select()
    .from(schema.recordEvent)
    .where(eq(schema.recordEvent.recordId, recordId))
    .all()
  if (eventRows.length === 0) return { targets: [], hashConflicts: new Set() }
  const evidenceRows = db
    .select({
      id: schema.recordEvidence.id,
      recordEventId: schema.recordEvidence.recordEventId,
      sourceFile: schema.recordEvidence.sourceFile,
      attachment: schema.recordEvidence.attachment,
      listNo: schema.recordEvidence.listNo,
      page: schema.recordEvidence.page,
    })
    .from(schema.recordEvidence)
    .where(
      inArray(
        schema.recordEvidence.recordEventId,
        eventRows.map((row) => row.id),
      ),
    )
    .all()

  return projectAnnouncementRepoints(recordId, events, eventRows, evidenceRows, taken, ambiguous, evidenceContentHashes)
}

export function projectAnnouncementRepoints(recordId: number, events: readonly RosterImportEvent[],
  eventRows: readonly typeof schema.recordEvent.$inferSelect[], evidenceRows: readonly (EvidenceCoordinateRow & { recordEventId: number })[],
  taken: Set<number>, ambiguous: ReadonlySet<number>, evidenceContentHashes: EvidenceContentHashIndex) {
  const byEvent = new Map<number, EvidenceCoordinateRow[]>()
  for (const row of evidenceRows) {
    const list = byEvent.get(row.recordEventId)
    if (list) list.push(row)
    else byEvent.set(row.recordEventId, [row])
  }

  const targets: EvidenceRepointTarget[] = []
  const hashConflicts = new Set<EvidenceContentHashConflict>()
  const wantedByEvent = groupEventEvidenceById(events, (event) => {
    const coords = eventCoordinates(recordId, event)
    return eventRows.find((row) => matchesEventCoordinates(row, coords))?.id
  })
  for (const [eventId, wanted] of wantedByEvent) {
    const plan = repointTargets(recordId, eventId, byEvent.get(eventId) ?? [], wanted, taken, ambiguous, evidenceContentHashes)
    for (const conflict of plan.hashConflicts) hashConflicts.add(conflict)
    targets.push(...plan.targets)
  }
  return { targets, hashConflicts }
}
// ---------------------------------------------------------------------------
// 既有行查找（预检与执行阶段**共用同一份**谓词）
// ---------------------------------------------------------------------------
//
// 每种实体的身份就是它在前面的唯一键（契约 §1.2 / §1.3 / §1.4 / §1.5）：
// 预检阶段按「载荷给的值」查一次、执行阶段按「解析出的真 id」再查一次 ——
// 以前这两次各自把 `.select().from(t).all().find(...)` 与列比较抄了一遍，
// 抄漏一列就成了「重放时多插一行」。现在两次都走下面这同一个函数。
//
// ── RL-18：这些函数一律是**按键定位**，不是整表线性找 ─────────────────────
// 每条实体各有**两条**要走同一个身份的函数：别名、差异（预检 + 执行各一次），查询、关系
// （预检取既有行、执行按真 id 再取一次）。以前它们各自把 `.select().from(t).all().find(...)`
// 与列比较抄了一遍；现在一律走下面这四个 —— 于是「身份是哪几列」只有一处定义。
//
// 三条要求同时成立，缺一条都会让批量写入退化成卡死（实测见契约 §3.1c）：
//  1. 谓词下推到 SQL 的 `WHERE`，并且**正好是 schema 里那条唯一索引的全部列**
//     （`enterprise_alias_identity_uq` / `platform_query_identity_uq` /
//     `platform_relation_query_seq_uq` / `difference_reason_version_uq`）⇒ 一次索引查找，
//     而不是把整表读进内存再 `.find(...)`；
//  2. 只 `select` 判定真正用得到的列 —— 调用方只要 `id`，所以**只取 `id`**。
//     这条对 `platform_query` 是硬要求：整行里带着 `raw_response`（平台原始 HTML，
//     几十 KB/条），比一个用不到它的键等于白读几十 KB；
//  3. 唯一键 ⇒ 至多一行，所以 `.get()` 与原来的 `.find()` 取到的是同一行（`get()` 本就取首行）。
//
// 为什么是这三条：批内 N 条查询/关系/别名/差异，每条都要查一次 ⇒ 整表线性找就是
// O(N × 表行数)（表随本批增长时即 N²），而每次还要把几十 KB 的 `raw_response` 读出来。

/** 别名身份：`(enterprise_id, name_norm, source_kind, source_ref_id)`（契约 §1.2）。 */
function findAliasRow(
  db: Executor,
  spec: { enterpriseId: number; nameNorm: string; sourceKind: string; sourceRefId: number },
): { id: number } | undefined {
  return db
    .select({ id: schema.enterpriseAlias.id })
    .from(schema.enterpriseAlias)
    .where(
      and(
        eq(schema.enterpriseAlias.enterpriseId, spec.enterpriseId),
        eq(schema.enterpriseAlias.nameNorm, spec.nameNorm),
        eq(
          schema.enterpriseAlias.sourceKind,
          spec.sourceKind as typeof schema.enterpriseAlias.$inferSelect.sourceKind,
        ),
        eq(schema.enterpriseAlias.sourceRefId, spec.sourceRefId),
      ),
    )
    .get()
}

/** 查询身份：`(interface, query_key, rdjb, queried_at)`（契约 §1.3）。 */
function findQueryRow(
  db: Executor,
  spec: { interface: PlatformInterface; queryKey: string; rdjb: string; queriedAt: string },
): { id: number } | undefined {
  const { q } = importPlatformTables(db)
  return db
    .select({ id: q.id })
    .from(q)
    .where(
      and(
        eq(q.interface, spec.interface),
        eq(q.queryKey, spec.queryKey),
        eq(q.rdjb, spec.rdjb),
        eq(q.queriedAt, spec.queriedAt),
      ),
    )
    .get()
}

/** 关系身份：`(query_id, sequence_no)`（契约 §1.4）。 */
function findRelationRow(
  db: Executor,
  spec: { queryId: number; sequenceNo: number },
): { id: number } | undefined {
  const { r } = importPlatformTables(db)
  return db
    .select({ id: r.id })
    .from(r)
    .where(
      and(
        eq(sql<number>`${r.queryId}`, spec.queryId),
        eq(r.sequenceNo, spec.sequenceNo),
      ),
    )
    .get()
}

/** 差异身份：`(enterprise_id, title_code, direction, recorded_at)`（契约 §1.5）。 */
function findDifferenceRow(
  db: Executor,
  spec: { enterpriseId: number; titleCode: string; direction: string; recordedAt: string },
): { id: number } | undefined {
  return db
    .select({ id: schema.differenceReason.id })
    .from(schema.differenceReason)
    .where(
      and(
        eq(schema.differenceReason.enterpriseId, spec.enterpriseId),
        eq(schema.differenceReason.titleCode, spec.titleCode),
        eq(
          schema.differenceReason.direction,
          spec.direction as typeof schema.differenceReason.$inferSelect.direction,
        ),
        eq(schema.differenceReason.recordedAt, spec.recordedAt),
      ),
    )
    .get()
}

type DifferenceRow = typeof schema.differenceReason.$inferSelect

function findDifferenceContentRow(
  db: Executor,
  spec: { enterpriseId: number; titleCode: string; direction: string; recordedAt: string },
): DifferenceRow | undefined {
  return db
    .select()
    .from(schema.differenceReason)
    .where(
      and(
        eq(schema.differenceReason.enterpriseId, spec.enterpriseId),
        eq(schema.differenceReason.titleCode, spec.titleCode),
        eq(schema.differenceReason.direction, spec.direction as typeof schema.differenceReason.$inferSelect.direction),
        eq(schema.differenceReason.recordedAt, spec.recordedAt),
      ),
    )
    .get()
}

/** Legacy-only deduplication; lifecycle-managed histories are rejected before reaching this path. */
function sameDifferenceContent(left: DifferenceRow, right: DifferenceRow): boolean {
  return left.status === right.status &&
    left.reasonCode === right.reasonCode &&
    left.reasonNote === right.reasonNote &&
    left.measureCode === right.measureCode &&
    left.measureNote === right.measureNote &&
    left.evidenceCollectionId === right.evidenceCollectionId &&
    left.evidenceObservationId === right.evidenceObservationId &&
    left.movedInCity === right.movedInCity &&
    left.movedInTitleCode === right.movedInTitleCode &&
    left.movedInYear === right.movedInYear &&
    left.movedInBatch === right.movedInBatch &&
    left.verificationStatus === right.verificationStatus
}

/** Identity reassignment cannot preserve a managed command's original scope/hash/replay. */
function findMergeDifferenceLifecycleConflict(db: Executor, fromEnterpriseId: number, intoEnterpriseId: number | null) {
  if (fromEnterpriseId === intoEnterpriseId) return null
  const source = db.select({ id: schema.differenceReason.id, enterpriseId: schema.differenceReason.enterpriseId,
    titleCode: schema.differenceReason.titleCode, direction: schema.differenceReason.direction })
    .from(schema.differenceReason).where(and(eq(schema.differenceReason.enterpriseId, fromEnterpriseId),
      managedDecision102())).limit(1).get()
  // Even a non-colliding legacy row must not enter an explicitly adopted target coordinate.
  const affected = source ?? (intoEnterpriseId == null ? undefined : db.get<{
    id: number; enterpriseId: number; titleCode: string; direction: string
  }>(sql`select managed.id, managed.enterprise_id as enterpriseId, managed.title_code as titleCode, managed.direction
    from difference_reason managed
    where managed.enterprise_id=${intoEnterpriseId} and ${managedDecision102(sql`managed.id`, sql`managed.lifecycle_action`)}
      and exists(select 1 from difference_reason source where source.enterprise_id=${fromEnterpriseId}
        and source.title_code=managed.title_code and source.direction=managed.direction)
    limit 1`))
  if (!affected) return null
  return { code: 'merge_difference_lifecycle_conflict',
    message: `差异决定版本 ${affected.id}（企业 ${affected.enterpriseId}/${affected.titleCode}/${affected.direction}）已接管；归并将改变历史归属或写入旧解释，当前入口不支持保留原范围重放的归并，原 ID、历史和接管状态须保留` }
}

/** #99: inspect only affected alias IDs; never materialize audit payloads. */
function aliasMergeLifecycleConflict(db: Executor, sourceAlias: Pick<typeof schema.enterpriseAlias.$inferSelect, 'id' | 'verificationStatus'>, survivor: { id: number }): { code: string; message: string } | null {
  const survivorState = db.select({ verificationStatus: schema.enterpriseAlias.verificationStatus }).from(schema.enterpriseAlias).where(eq(schema.enterpriseAlias.id, survivor.id)).get()!
  const hasAudit = db.select({ id: schema.enterpriseAliasAudit.id }).from(schema.enterpriseAliasAudit)
    .where(inArray(schema.enterpriseAliasAudit.aliasId, [sourceAlias.id, survivor.id])).limit(1).get()
  if (sourceAlias.verificationStatus !== survivorState.verificationStatus &&
      (hasAudit || sourceAlias.verificationStatus === 'withdrawn' || survivorState.verificationStatus === 'withdrawn')) {
    return { code: 'merge_alias_lifecycle_conflict', message: `别名 ${sourceAlias.id}/${survivor.id} 核验状态不同，须显式处理后再归并` }
  }
  const sharedKey = db.get(sql`select a.id from enterprise_alias_audit a
    inner join enterprise_alias_audit b on b.alias_id=${survivor.id} and b.idempotency_key=a.idempotency_key
    where a.alias_id=${sourceAlias.id} limit 1`)
  if (sharedKey) return { code: 'merge_alias_audit_key_conflict', message: `别名 ${sourceAlias.id}/${survivor.id} 存在同幂等键审计，不能丢弃任何一条历史` }
  return null
}
function findMergeAliasLifecycleConflict(db: Executor, fromEnterpriseId: number, intoEnterpriseId: number) {
  if (fromEnterpriseId === intoEnterpriseId) return null
  for (const alias of db.select({ id: schema.enterpriseAlias.id, nameNorm: schema.enterpriseAlias.nameNorm, sourceKind: schema.enterpriseAlias.sourceKind, sourceRefId: schema.enterpriseAlias.sourceRefId, verificationStatus: schema.enterpriseAlias.verificationStatus }).from(schema.enterpriseAlias).where(eq(schema.enterpriseAlias.enterpriseId, fromEnterpriseId)).all()) {
    const survivor = findAliasRow(db, { enterpriseId: intoEnterpriseId, nameNorm: alias.nameNorm, sourceKind: alias.sourceKind, sourceRefId: alias.sourceRefId })
    if (!survivor) continue
    const conflict = aliasMergeLifecycleConflict(db, alias, survivor)
    if (conflict) return conflict
  }
  return null
}

function findMergeDifferenceConflict(
  db: Executor,
  fromEnterpriseId: number,
  intoEnterpriseId: number,
): DifferenceRow | null {
  const sourceRows = db
    .select()
    .from(schema.differenceReason)
    .where(eq(schema.differenceReason.enterpriseId, fromEnterpriseId))
    .all()
  for (const sourceRow of sourceRows) {
    const targetRow = findDifferenceContentRow(db, {
      enterpriseId: intoEnterpriseId,
      titleCode: sourceRow.titleCode,
      direction: sourceRow.direction,
      recordedAt: sourceRow.recordedAt,
    })
    if (targetRow && !sameDifferenceContent(sourceRow, targetRow)) return sourceRow
  }
  return null
}

// --- 别名 ------------------------------------------------------------------

function planAlias(
  db: Executor,
  pending: PendingEnterprises,
  pendingEnterpriseCreates: PendingEnterpriseCreate[],
  pendingRefs: PendingPlatformRefs,
  alias: RosterImportAlias,
  index: number,
  push: (item: PlannedItem) => void,
): void {
  const ref = `alias:${index}`
  const name = optionalString(alias?.name)
  if (!name) {
    push({ item: failure('alias', ref, 'alias_name_required', '别名缺少 name', 'aliases[].name'), action: 'skip', review: false })
    return
  }
  if (!ALIAS_SOURCE_KINDS.has(String(alias.sourceKind))) {
    push({ item: failure('alias', ref, 'alias_source_kind_unknown', `sourceKind 不在字典内：${String(alias.sourceKind)}`, 'sourceKind'), action: 'skip', review: false })
    return
  }
  if (alias.verificationStatus != null && !VERIFICATION_STATUSES.has(String(alias.verificationStatus))) {
    push({ item: failure('alias', ref, 'verification_status_unknown', `verificationStatus 必须是 confirmed / pending`, 'verificationStatus'), action: 'skip', review: false })
    return
  }
  // 来源证据：**裸 id 与自然键恰给其一**（两个都给 ⇒ 报错，不静默取一个）。
  const hasId = optionalInt(alias.sourceRefId) != null
  const hasRef = alias.sourceRelationRef != null
  if (hasId && hasRef) {
    push({ item: failure('alias', ref, 'source_ref_conflict', '同时给了 sourceRefId 与 sourceRelationRef；请只给其一', 'sourceRelationRef'), action: 'skip', review: false })
    return
  }
  let relationRef: NormalizedRef | null = null
  if (hasRef) {
    const normalized = normalizeRef(alias.sourceRelationRef, 'aliases[].sourceRelationRef')
    if (!normalized.ok) {
      push({ item: failure('alias', ref, normalized.error.code, normalized.error.message, normalized.error.field), action: 'skip', review: false })
      return
    }
    const resolved = resolveRelationRefPlan(db, pendingRefs, normalized.value, 'aliases[].sourceRelationRef')
    if (!resolved.ok) {
      push({ item: failure('alias', ref, resolved.error.code, resolved.error.message, resolved.error.field), action: 'skip', review: false })
      return
    }
    relationRef = normalized.value
  }
  const spec = { name: alias.enterpriseName, uscc: alias.uscc }
  if (!enterpriseKnown(db, pending, spec)) {
    push({ item: failure('alias', ref, 'enterprise_not_found', `别名找不到归属企业：${optionalString(alias.enterpriseName) ?? usccOrNull(alias.uscc) ?? '(空)'}`, 'enterpriseName'), action: 'skip', review: false })
    return
  }
  const nameNorm = normalizeName(name)
  const literalSourceRefId = optionalInt(alias.sourceRefId)
  const platformSource = alias.sourceKind === 'platform_business' || alias.sourceKind === 'platform_apply'
  const explicitUscc = usccOrNull(alias.uscc)
  const enterpriseName = optionalString(alias.enterpriseName)
  const existingByName = enterpriseName ? findEnterprisesByNorm(db, normalizeName(enterpriseName)) : []
  const pendingByName = enterpriseName
    ? pendingEnterpriseCreates.filter((create) => create.nameNorm === normalizeName(enterpriseName))
    : []
  if (platformSource && !explicitUscc && existingByName.length + pendingByName.length > 1) {
    push({
      item: failure('alias', ref, 'enterprise_ambiguous', `同名归属企业有 ${existingByName.length + pendingByName.length} 个候选 ⇒ 不猜是哪一家`, 'enterpriseName'),
      action: 'skip',
      review: false,
    })
    return
  }
  const target = explicitUscc
    ? findEnterpriseByUscc(db, explicitUscc)
    : existingByName[0] ?? null
  if (platformSource && explicitUscc && !target && !pending.has(usccKey(explicitUscc))) {
    push({ item: failure('alias', ref, 'enterprise_not_found', `统代 ${explicitUscc} 不存在且本批不创建该企业`, 'uscc'), action: 'skip', review: false })
    return
  }
  const targetUscc = explicitUscc ?? target?.usccNorm ?? pendingByName[0]?.uscc ?? null
  const plannedEnterpriseId = target?.id ?? (platformSource ? null : locateEnterprise(db, spec)?.id)
  let sourceEvidence: PlatformAliasRelationEvidence | null = null
  if (platformSource) {
    const verificationStatus = alias.verificationStatus ?? 'pending'
    if (literalSourceRefId != null && literalSourceRefId !== 0) {
      sourceEvidence = findPlatformAliasRelationEvidence(db, literalSourceRefId)
      if (!sourceEvidence) {
        push({ item: failure('alias', ref, 'alias_source_evidence_mismatch', `平台关系 id=${literalSourceRefId} 不存在`, 'sourceRefId'), action: 'skip', review: false })
        return
      }
    } else if (relationRef) {
      const relationId = resolveRelationIdAt(db, relationRef)
      sourceEvidence = relationId != null
        ? findPlatformAliasRelationEvidence(db, relationId)
        : findPendingPlatformAliasRelationEvidence(pendingRefs, relationRef)
      if (!sourceEvidence) {
        push({ item: failure('alias', ref, 'alias_source_evidence_mismatch', `自然键未能解析出唯一的平台关系事实：${describeRef(relationRef)}`, 'sourceRelationRef'), action: 'skip', review: false })
        return
      }
    } else if (verificationStatus === 'confirmed') {
      push({ item: failure('alias', ref, 'alias_source_evidence_required', 'confirmed 平台别名必须引用支持该统一社会信用代码与 qymc 的平台关系', 'sourceRefId'), action: 'skip', review: false })
      return
    }
    if (sourceEvidence) {
      const mismatch = platformAliasEvidenceMismatch(db, alias.sourceKind, name, targetUscc, target?.id ?? null, sourceEvidence)
      if (mismatch) {
        push({ item: failure('alias', ref, 'alias_source_evidence_mismatch', mismatch, relationRef ? 'sourceRelationRef' : 'sourceRefId'), action: 'skip', review: false })
        return
      }
    }
  }
  const existing =
    literalSourceRefId == null || plannedEnterpriseId == null
      ? undefined
      : findAliasRow(db, {
          enterpriseId: plannedEnterpriseId,
          nameNorm,
          sourceKind: alias.sourceKind,
          sourceRefId: literalSourceRefId,
        })
  push({
    item: success('alias', existing ? `alias:${existing.id}` : ref, { enterpriseId: plannedEnterpriseId ?? null }),
    action: existing ? 'skip' : 'add',
    review: (alias.verificationStatus ?? 'pending') !== 'confirmed',
    run: (tx) => {
      // 执行时解析真 id：同批先插入的企业此刻已在库里。
      const enterprise = locateEnterprise(tx, spec)
      if (!enterprise) return failure('alias', ref, 'enterprise_not_found', '别名归属企业在写入阶段不存在', 'enterpriseName')
      let sourceRefId = literalSourceRefId ?? 0
      if (relationRef) {
        const resolved = resolveRelationIdAt(tx, relationRef)
        if (resolved == null) {
          // 预检已判过可行；到这里仍解析不到说明批次内自相矛盾 —— 报错而不是落 0 哨兵。
          return failure('alias', ref, 'relation_ref_not_found', `执行阶段解析不到平台关系：${describeRef(relationRef)}`, 'sourceRelationRef')
        }
        sourceRefId = resolved
      }
      if (platformSource) {
        const verificationStatus = alias.verificationStatus ?? 'pending'
        const hasSourceReference = sourceRefId !== 0
        const evidence = hasSourceReference ? findPlatformAliasRelationEvidence(tx, sourceRefId) : null
        if (hasSourceReference && !evidence) {
          return failure('alias', ref, 'alias_source_evidence_mismatch', `平台关系 id=${sourceRefId} 不存在`, relationRef ? 'sourceRelationRef' : 'sourceRefId')
        }
        if (!evidence && verificationStatus === 'confirmed') {
          return failure('alias', ref, 'alias_source_evidence_required', 'confirmed 平台别名必须引用支持该统一社会信用代码与 qymc 的平台关系', 'sourceRefId')
        }
        if (evidence) {
          const mismatch = platformAliasEvidenceMismatch(tx, alias.sourceKind, name, enterprise.usccNorm, enterprise.id, evidence)
          if (mismatch) {
            return failure('alias', ref, 'alias_source_evidence_mismatch', mismatch, relationRef ? 'sourceRelationRef' : 'sourceRefId')
          }
        }
      }
      const already = findAliasRow(tx, {
        enterpriseId: enterprise.id,
        nameNorm,
        sourceKind: alias.sourceKind,
        sourceRefId,
      })
      if (already) return success('alias', `alias:${already.id}`, { enterpriseId: enterprise.id, rowsWritten: 0 })
      const identityBefore = identityMaterial113(tx, enterprise.id)
      const { id } = insertEnterpriseAlias(tx, {
          enterpriseId: enterprise.id,
          name,
          nameNorm,
          sourceKind: alias.sourceKind,
          sourceRefId,
          validFrom: optionalString(alias.validFrom),
          validTo: optionalString(alias.validTo),
          verificationStatus: alias.verificationStatus ?? 'pending',
          note: optionalString(alias.note),
        })
      captureIdentityRevision113(tx, { enterpriseId: enterprise.id, sourceKey: `enterprise:${enterprise.id}`, sourceVersion: `alias-import:${id}`, before: identityBefore, after: identityMaterial113(tx, enterprise.id) })
      return success('alias', `alias:${id}`, { enterpriseId: enterprise.id, sourceRefId, rowsWritten: 1 })
    },
  })
}

// --- 平台查询与关系 --------------------------------------------------------

function archivedPlatformQuerySource(db: Executor, queryId: number): PlatformQueryReplaySource {
  return collectionImportSource(db, queryId)
}

function planPlatformQuery(
  db: Executor,
  query: RosterImportPlatformQuery,
  index: number,
  push: (item: PlannedItem) => void,
  batchId?: number,
  stagedSource?: PlatformQueryReplaySource,
): PlatformQueryReplaySource | undefined {
  const ref = `query:${index}`
  if (!PLATFORM_INTERFACE_SET.has(String(query?.interface))) {
    push({ item: failure('platform_query', ref, 'interface_unknown', `interface 必须是 business_list / apply_list / recognized_list`, 'interface'), action: 'skip', review: false })
    return
  }
  const queryKey = optionalString(query.queryKey)
  if (!queryKey) {
    push({ item: failure('platform_query', ref, 'query_key_required', '平台查询缺少 queryKey', 'queryKey'), action: 'skip', review: false })
    return
  }
  const queriedAt = optionalString(query.queriedAt)
  if (!queriedAt) {
    push({ item: failure('platform_query', ref, 'queried_at_required', '平台查询缺少 queriedAt（查询时点）', 'queriedAt'), action: 'skip', review: false })
    return
  }
  const existing = findQueryRow(db, { interface: query.interface, queryKey, rdjb: optionalString(query.rdjb) ?? '', queriedAt })
  const originalSource = existing ? archivedPlatformQuerySource(db, existing.id) : stagedSource
  const evidenceMessage = queryEvidenceError(query, originalSource, {
    byId: id => findEnterpriseById(db, id),
    byUscc: raw => enterpriseByExactUscc(db, raw),
  })
  if (evidenceMessage) {
    push({ item: failure('platform_query', ref, 'collection_evidence_invalid', evidenceMessage, 'collectionEvidence'), action: 'skip', review: false })
    return
  }
  if (query.status != null && !QUERY_STATUSES.has(String(query.status))) {
    push({ item: failure('platform_query', ref, 'query_status_unknown', `status 不在四态内：${String(query.status)}`, 'status'), action: 'skip', review: false })
    return
  }
  if (query.titleCode != null && !TITLE_CODES.has(String(query.titleCode))) {
    push({ item: failure('platform_query', ref, 'title_unknown', `称号不在字典内：${String(query.titleCode)}`, 'titleCode'), action: 'skip', review: false })
    return
  }
  for (let i = 0; i < (query.relations ?? []).length; i += 1) {
    const relation = query.relations![i]!
    if (relation?.sequenceNo == null) {
      push({ item: failure('platform_relation', `${ref}/r${i}`, 'sequence_no_required', '关系缺少 sequenceNo', 'relations[].sequenceNo'), action: 'skip', review: false })
      return
    }
    if (!platformRelationInputSchema.shape.sequenceNo.safeParse(relation?.sequenceNo).success) {
      push({ item: failure('platform_relation', `${ref}/r${i}`, 'sequence_no_invalid', 'sequenceNo 必须是正安全整数，不截断小数', 'relations[].sequenceNo'), action: 'skip', review: false })
      return
    }
    if (!originalSource && relation.sequenceNo !== i + 1) {
      push({ item: failure('platform_relation', `${ref}/r${i}`, 'sequence_no_invalid', '新完整采集的 sequenceNo 必须按输入顺序从 1 连续编号', 'relations[].sequenceNo'), action: 'skip', review: false })
      return
    }
    if (!platformRelationInputSchema.shape.year.safeParse(relation.year).success) {
      push({ item: failure('platform_relation', `${ref}/r${i}`, 'year_invalid', 'year 必须是整数或 null，不截断小数', 'relations[].year'), action: 'skip', review: false })
      return
    }
    if (relation.matchBasis != null && !MATCH_BASES.has(String(relation.matchBasis))) {
      push({ item: failure('platform_relation', `${ref}/r${i}`, 'match_basis_unknown', `matchBasis 不在字典内：${String(relation.matchBasis)}`, 'relations[].matchBasis'), action: 'skip', review: false })
      return
    }
    const normalized = normalizePlatformRelation(query.interface, relation)
    if (normalized.normalizationConflicts.length) {
      push({ item: failure('platform_relation', `${ref}/r${i}`, 'platform_field_conflict', `标准字段与原档冲突：${normalized.normalizationConflicts.map(c => c.field).join(', ')}`, 'relations'), action: 'skip', review: false })
      return
    }
  }

  if (Object.hasOwn(query, 'reuseExisting') && query.reuseExisting !== true) {
    push({ item: failure('platform_query', ref, 'query_reuse_invalid', 'reuseExisting must be true when supplied', 'reuseExisting'), action: 'skip', review: false })
    return
  }
  if (!originalSource && query.reuseExisting) {
    push({ item: failure('platform_query', ref, 'query_reuse_missing', 'No original collection exists at these coordinates', 'reuseExisting'), action: 'skip', review: false })
    return
  }
  if (!originalSource && !query.collectionEvidence && query.rawResponse == null) {
    push({ item: failure('platform_query', ref, 'query_source_required', '新采集必须提供原始 rawResponse 或 collectionEvidence', 'rawResponse'), action: 'skip', review: false })
    return
  }
  const source = originalSource ?? stagedPlatformQuerySource(query, ref)
  const conflict = platformQuerySourceConflict(query, source)
  if (conflict) {
    push({ item: conflict, action: 'skip', review: false })
    return
  }
  const newRelationCount = originalSource ? 0 : source.relationCount

  push({
    item: success('platform_query', existing ? `query:${existing.id}` : ref, { relationCount: newRelationCount, canonicalProjection: (query.relations ?? []).map(relation => {
      const archived = source.relationAt(relation.sequenceNo)
      const projection = planPlatformObservation({ interface: query.interface, relationKey: optionalString(archived?.values.relationKey), rawFields: archived?.values.rawFields })
      if (archived?.id != null) return { ...collectionImportPreview(db, archived.id), identityState: projection.identityState, contentState: projection.contentState, keySource: projection.keySource }
      const apply = applyProjectionPreview(projection)
      const business = businessProjectionPreview(projection)
      const recognized = recognizedProjectionPreview(projection)
      return { relationId: archived?.id ?? null, identityState: projection.identityState, contentState: projection.contentState, keySource: projection.keySource, ...(apply ? { applyProjection: apply } : {}), ...(business ? { businessProjection: business } : {}), ...(recognized ? { recognizedProjection: recognized } : {}) }
    }) }),
    // Accepted references participate even when no stored observation can be returned.
    platformFieldReference: !!originalSource && (query.reuseExisting === true || (!query.relations?.length && originalSource.relationCount > 0) || query.relations?.some(row => !isObject(row.rawFields))),
    action: originalSource ? 'note' : 'add',
    review: query.status === 'failed',
    run: (tx) => writePlatformQuery(tx, query, batchId),
  })
  return source
}

function writePlatformQuery(
  tx: Executor,
  query: RosterImportPlatformQuery,
  batchId?: number,
): RosterImportItemResult {
  return writeImportedCollection(tx, query, batchId)
}

// --- 导出快照 --------------------------------------------------------------

/** Compare only the submitted snapshot's rows, in bounded chunks; never append to an old file. */
function exportReplayConflict(db: Executor, snapshot: RosterImportExportSnapshot, batchId: number): RosterImportItemResult | null {
  const count = db.get<{ n: number }>(sql`SELECT count(*) n FROM platform_export_row WHERE batch_id=${batchId}`)!.n
  const rows = snapshot.rows ?? []
  if (rows.length !== count) return failure('export_batch', `export:${batchId}`, 'export_row_set_conflict', 'Replay must retain the original file row set', 'rows')
  for (let start = 0; start < rows.length; start += 200) {
    const chunk = rows.slice(start, start + 200)
    const stored = new Map(db.select().from(schema.platformExportRow).where(and(eq(schema.platformExportRow.batchId, batchId), inArray(schema.platformExportRow.sourceRowNo, chunk.map(row => row.sourceRowNo)))).all().map(row => [row.sourceRowNo, row]))
    const issue = exportSnapshotRowConflict(chunk, stored)
    if (issue) return issue
  }
  return null
}

export function exportSnapshotRowConflict(rows: NonNullable<RosterImportExportSnapshot['rows']>, stored: ReadonlyMap<number, typeof schema.platformExportRow.$inferSelect>) {
  for (const row of rows) {
    const original = stored.get(row.sourceRowNo)
    if (!original) return failure('export_row', `export:row:${row.sourceRowNo}`, 'export_row_set_conflict', 'Existing file cannot acquire new source rows', 'rows')
    for (const field of ['nameRaw', 'usccRaw', 'district', 'province', 'city', 'regStatus', 'rawFields'] as const) {
      if (!Object.hasOwn(row, field)) continue
      const value = field === 'rawFields' ? row[field] ?? null : optionalString(row[field])
      if (!isDeepStrictEqual(original[field], value)) return failure('export_row', `export:row:${row.sourceRowNo}`, 'export_row_payload_conflict', `Existing file row has different ${field}`, `rows.${field}`)
    }
  }
  return null
}

export function projectExportSnapshotRow(batchId: number, row: NonNullable<RosterImportExportSnapshot['rows']>[number]) {
  return {
    batchId,
    sourceRowNo: optionalInt(row.sourceRowNo)!,
    usccRaw: optionalString(row.usccRaw),
    nameRaw: optionalString(row.nameRaw),
    district: optionalString(row.district),
    province: optionalString(row.province),
    city: optionalString(row.city),
    regStatus: optionalString(row.regStatus),
    rawFields: row.rawFields == null ? null : JSON.stringify(row.rawFields),
    createdAt: new Date().toISOString(),
  }
}

function findExportBatch(db: Executor, snapshot: RosterImportExportSnapshot) {
  return db.select({ id: schema.platformExportBatch.id }).from(schema.platformExportBatch)
    .where(and(eq(schema.platformExportBatch.titleCode, snapshot.titleCode), eq(schema.platformExportBatch.year, snapshot.year), eq(schema.platformExportBatch.sha256, snapshot.sha256)))
    .get()
}

function latestExportBatch(db: Executor, snapshot: RosterImportExportSnapshot, excludeSameSha = false) {
  return db.select({ id: schema.platformExportBatch.id }).from(schema.platformExportBatch)
    .where(and(eq(schema.platformExportBatch.titleCode, snapshot.titleCode), eq(schema.platformExportBatch.year, snapshot.year), excludeSameSha ? ne(schema.platformExportBatch.sha256, snapshot.sha256) : undefined))
    .orderBy(desc(schema.platformExportBatch.id)).limit(1).get()
}

export function validateExportSnapshot(snapshot: RosterImportExportSnapshot): RosterImportItemResult | null {
  const ref = 'export:snapshot'
  if (!TITLE_CODES.has(String(snapshot?.titleCode))) {
    return failure('export_batch', ref, 'title_unknown', `称号不在字典内：${String(snapshot?.titleCode)}`, 'titleCode')
  }
  if (!optionalInt(snapshot.year) || !optionalString(snapshot.collectedOn) || !optionalString(snapshot.originalFilename) || !optionalString(snapshot.sha256)) {
    return failure('export_batch', ref, 'export_identity_incomplete', '快照缺少 year / collectedOn / originalFilename / sha256', 'exportSnapshot')
  }
  const rows = Array.isArray(snapshot.rows) ? snapshot.rows : []
  const seen = new Set<number>()
  for (let i = 0; i < rows.length; i += 1) {
    const rowNo = optionalInt(rows[i]?.sourceRowNo)
    if (rowNo == null) {
      return failure('export_row', `export:row:${i}`, 'source_row_no_required', '快照行缺少 sourceRowNo', 'rows[].sourceRowNo')
    }
    if (seen.has(rowNo)) {
      return failure('export_row', `export:row:${rowNo}`, 'source_row_no_duplicate', `快照行号重复：${rowNo}`, 'rows[].sourceRowNo')
    }
    seen.add(rowNo)
  }

  return null
}

function planExportSnapshot(
  db: Executor,
  snapshot: RosterImportExportSnapshot,
  context: { batchId?: number },
  push: (item: PlannedItem) => void,
): void {
  const issue = validateExportSnapshot(snapshot)
  if (issue) { push({ item: issue, action: 'skip', review: false }); return }
  const ref = 'export:snapshot'
  const rows = Array.isArray(snapshot.rows) ? snapshot.rows : []
  const existing = findExportBatch(db, snapshot)
  // `replaced_batch_id` 的方向（父代理 2026-10-16 裁决 / 契约 §1.6「本批**替换**了哪一批」）：
  // **新批**记下它替换掉的那一批 = 同 (称号, 年度) 现有的**最新**批（不同 sha256）；
  // 首版为 null。同 sha256 重放会命中唯一键**不新建批**，两版并存。
  const previousLatest = latestExportBatch(db, snapshot, true)
  if (existing) {
    const conflict = exportReplayConflict(db, snapshot, existing.id)
    if (conflict) { push({ item: conflict, action: 'skip', review: false }); return }
  }
  const newRows = existing ? 0 : rows.length

  push({
    item: success('export_batch', existing ? `export:${existing.id}` : ref, {
      rowCount: newRows,
      replaced: previousLatest?.id ?? null,
    }),
    action: existing ? 'note' : 'add',
    review: false,
    run: (tx) => writeExportSnapshot(tx, snapshot, context),
  })
}

function writeExportSnapshot(
  tx: Executor,
  snapshot: RosterImportExportSnapshot,
  context: { batchId?: number },
): RosterImportItemResult {
  const beforeSelection113 = selectedSnapshot113(tx, snapshot.titleCode)
  const rows = snapshot.rows ?? []
  let batch = findExportBatch(tx, snapshot)
  if (batch) return exportReplayConflict(tx, snapshot, batch.id) ?? success('export_batch', `export:${batch.id}`, { rows: [], skipped: rows.length, rowsWritten: 0 })
  const batchCreated = !batch
  if (!batch) {
    // 换内容 ⇒ 新版本：本批记下它替换掉的**最新**旧版（两版并存，旧版不消失）。
    const previousLatest = latestExportBatch(tx, snapshot)
    batch = tx
      .insert(schema.platformExportBatch)
      .values({
        titleCode: snapshot.titleCode,
        year: snapshot.year,
        collectedOn: snapshot.collectedOn,
        originalFilename: snapshot.originalFilename,
        sha256: snapshot.sha256,
        rowCount: rows.length,
        importStatus: 'imported',
        importBatchId: context.batchId ?? null,
        replacedBatchId: previousLatest?.id ?? null,
      })
      .returning({ id: schema.platformExportBatch.id })
      .get()
  }
  // Bound SQL parameters and encoded text together; every chunk stays in the same transaction.
  const INSERT_CHUNK = 200
  const INSERT_BYTES = 1024 * 1024
  type InsertRow = Omit<typeof schema.platformExportRow.$inferInsert, 'rawFields'> & { rawFields: SQL | null }
  let chunk: InsertRow[] = []
  let chunkBytes = 0
  let pendingCount = 0
  const written: number[] = []
  const flush = () => {
    if (!chunk.length) return
    const inserted = tx.insert(schema.platformExportRow).values(chunk)
      .returning({ id: schema.platformExportRow.id }).all()
    written.push(...inserted.map(row => row.id))
    chunk = []
    chunkBytes = 0
  }
  for (const row of rows) {
    if (chunk.length === INSERT_CHUNK) flush()
    // Encode once and bind the JSON text directly: the JSON column encoder must not
    // stringify it again. Only this chunk plus the next single row is retained.
    const values = projectExportSnapshotRow(batch.id, row)
    const raw = values.rawFields
    const bytes = Object.values(values).reduce<number>((total, value) => total + Buffer.byteLength(String(value ?? '')), 0)
    if (chunk.length && chunkBytes + bytes > INSERT_BYTES) flush()
    chunk.push({ ...values, rawFields: raw == null ? null : sql`${raw}` })
    chunkBytes += bytes
    pendingCount += 1
    // An oversize single item is complete in its own statement, never truncated.
    // Synchronous flush is backpressure; no next chunk is produced until it finishes.
    if (chunkBytes >= INSERT_BYTES) flush()
  }
  flush()
  // 只报**本次真正插入**的源行（重放同一份快照时为空）—— 「本批写了哪些行」必须可查回，
  // 而不是把批次里已有的行也算成本次新增。
  written.sort((left, right) => left - right)
  captureSnapshotRevision113(tx, snapshot.titleCode, beforeSelection113)
  return success('export_batch', `export:${batch.id}`, {
    rows: written,
    skipped: rows.length - pendingCount,
    rowsWritten: (batchCreated ? 1 : 0) + pendingCount,
  })
}

// --- 差异原因与措施 --------------------------------------------------------

/** 差异项的证据指针（每列：裸 id 或自然键）。 */
interface EvidenceRefs {
  queryIdLiteral: number | null
  queryRef: NormalizedRef | null
  relationIdLiteral: number | null
  relationRef: NormalizedRef | null
}

/**
 * 校验并解析差异项的两列证据指针。返回 `null` 表示已把逐项错误 push 出去。
 * 规则：同一列**裸 id 与自然键恰给其一**（两个都给 ⇒ 逐项报错，不静默取一个）；
 * 自然键在预检阶段判可行性（查库 + 查本批将写入的索引）。
 */
function collectEvidenceRefs(
  db: Executor,
  pendingRefs: PendingPlatformRefs,
  difference: RosterImportDifference,
  ref: string,
  push: (item: PlannedItem) => void,
): EvidenceRefs | null {
  const reject = (code: string, message: string, field: string): null => {
    push({ item: failure('difference', ref, code, message, field), action: 'skip', review: false })
    return null
  }
  const queryIdLiteral = optionalInt(difference.evidenceQueryId)
  const relationIdLiteral = optionalInt(difference.evidenceRelationId)
  if (queryIdLiteral != null && difference.evidenceQueryRef != null) {
    return reject('evidence_ref_conflict', '同时给了 evidenceQueryId 与 evidenceQueryRef；请只给其一', 'differences[].evidenceQueryRef')
  }
  if (relationIdLiteral != null && difference.evidenceRelationRef != null) {
    return reject('evidence_ref_conflict', '同时给了 evidenceRelationId 与 evidenceRelationRef；请只给其一', 'differences[].evidenceRelationRef')
  }
  let queryRef: NormalizedRef | null = null
  if (difference.evidenceQueryRef != null) {
    const normalized = normalizeRef(difference.evidenceQueryRef, 'differences[].evidenceQueryRef')
    if (!normalized.ok) return reject(normalized.error.code, normalized.error.message, normalized.error.field)
    const resolved = resolveQueryRefPlan(db, pendingRefs, normalized.value, 'differences[].evidenceQueryRef')
    if (!resolved.ok) return reject(resolved.error.code, resolved.error.message, resolved.error.field)
    queryRef = normalized.value
  }
  let relationRef: NormalizedRef | null = null
  if (difference.evidenceRelationRef != null) {
    const normalized = normalizeRef(difference.evidenceRelationRef, 'differences[].evidenceRelationRef')
    if (!normalized.ok) return reject(normalized.error.code, normalized.error.message, normalized.error.field)
    const resolved = resolveRelationRefPlan(db, pendingRefs, normalized.value, 'differences[].evidenceRelationRef')
    if (!resolved.ok) return reject(resolved.error.code, resolved.error.message, resolved.error.field)
    relationRef = normalized.value
  }
  return { queryIdLiteral, queryRef, relationIdLiteral, relationRef }
}

/** Validate new-source evidence against its actual subject/title and query identity. */
function targetImportDifferenceEvidenceError(db: Executor, pending: PendingPlatformRefs, refs: EvidenceRefs, difference: RosterImportDifference): string | null {
  const queryAt = (id: number | null, ref: NormalizedRef | null) => {
    const resolved = id ?? (ref ? resolveQueryIdAt(db, ref) : null)
    if (resolved != null) {
      const selected = readDifferenceCollection(db, resolved)
      if (!selected) return undefined
      const { pages } = readDifferenceCollectionScope(db, selected.collection.id)
      return { ...selected.collection, pages: pages.map(p => ({ rdjb: p.rdjb, status: p.status, fetchedCount: p.fetchedCount ?? 0 })), relations: [] as PendingPlatformRef['relations'] }
    }
    const staged = ref ? pending.find(q => q.interface === ref.interface && q.queryKey === ref.queryKey && q.rdjb === ref.rdjb && (!ref.queriedAt || q.queriedAt === ref.queriedAt)) : undefined
    return staged ? { ...staged, pages: staged.collectionEvidence?.pages ?? [] } : undefined
  }
  const query = queryAt(refs.queryIdLiteral, refs.queryRef)
  const relationId = refs.relationIdLiteral ?? (refs.relationRef ? resolveRelationIdAt(db, refs.relationRef) : null)
  const stored = relationId == null ? null : readDifferenceObservation(db, relationId)
  const relationQuery = queryAt(stored?.queryId ?? null, stored ? null : refs.relationRef)
  if ((refs.queryIdLiteral != null || refs.queryRef) && !query) return 'Query evidence not found'
  if ((refs.relationIdLiteral != null || refs.relationRef) && !relationQuery) return 'Relation evidence not found'
  const identity = (q: NonNullable<typeof query>) => JSON.stringify([q.interface, q.queryKey, q.rdjb, q.queriedAt])
  if (query && relationQuery && identity(query) !== identity(relationQuery)) return 'Query and relation evidence must identify the same source query'
  const source = relationQuery ?? query
  if (!source) return null
  // Import's recognized evidence admission stays narrower than candidate membership.
  // The other two interfaces retain their original import admission rules.
  if (source.interface !== 'recognized_list') return null
  const target = locateEnterprise(db, { name: difference.enterpriseName, uscc: difference.uscc })
  const supplied = usccOrNull(difference.uscc)
  if (supplied && target && supplied !== target.usccNorm) return 'Supplied USCC conflicts with the resolved enterprise'
  const uscc = supplied ?? target?.usccNorm
  if (!uscc) return 'Recognized evidence cannot confirm subject by name alone'
  if (!source.rdjb.split(',').some(r => RDJB_TITLE_CODES[r] === difference.titleCode)) return 'Evidence title scope does not include decision title'
  if (refs.relationIdLiteral != null || refs.relationRef) {
    const relation = stored ? { ...stored, usccRaw: stored.uscc } : source.relations.find(r => r.sequenceNo === refs.relationRef?.sequenceNo && (!refs.relationRef.relationKey || r.relationKey === refs.relationRef.relationKey))
    if (!relation || usccOrNull(relation.usccRaw) !== uscc || (relation.enterpriseId != null && target && relation.enterpriseId !== target.id)) return 'Evidence relation belongs to another or unknown enterprise'
    let offset = 0
    let rdjb: string | null = null
    for (const page of source.pages) {
      if (page.status !== 'success') continue
      offset += page.fetchedCount
      if (relation.sequenceNo <= offset) { rdjb = page.rdjb; break }
    }
    if (RDJB_TITLE_CODES[rdjb ?? ''] !== difference.titleCode) return 'Evidence row belongs to another title'
  } else if (source.queryKey !== uscc) return 'Query-only evidence requires an exact subject USCC query'
  return null
}

function recognizedDifferenceEvidenceError(db: Executor, pending: PendingPlatformRefs, refs: EvidenceRefs, difference: RosterImportDifference): string | null {
  return targetImportDifferenceEvidenceError(db, pending, refs, difference)
}

function lifecycleOwnsDifference102(db: Executor, enterpriseId: number, titleCode: string, direction: string): boolean {
  return !!db.select({ id: schema.differenceReason.id }).from(schema.differenceReason).where(and(
    eq(schema.differenceReason.enterpriseId, enterpriseId), eq(schema.differenceReason.titleCode, titleCode),
    eq(schema.differenceReason.direction, direction as typeof schema.differenceReason.$inferSelect.direction),
    managedDecision102(),
  )).limit(1).get()
}

function planDifference(
  db: Executor,
  pending: PendingEnterprises,
  pendingRefs: PendingPlatformRefs,
  difference: RosterImportDifference,
  index: number,
  push: (item: PlannedItem) => void,
): void {
  const ref = `difference:${index}`
  if (!TITLE_CODES.has(String(difference?.titleCode))) {
    push({ item: failure('difference', ref, 'title_unknown', `称号不在字典内：${String(difference?.titleCode)}`, 'titleCode'), action: 'skip', review: false })
    return
  }
  if (!DIRECTIONS.has(String(difference.direction))) {
    push({ item: failure('difference', ref, 'direction_unknown', `direction 必须是 missing_in_miit / extra_in_miit`, 'direction'), action: 'skip', review: false })
    return
  }
  if (difference.status != null && !DIFFERENCE_STATUSES.has(String(difference.status))) {
    push({ item: failure('difference', ref, 'difference_status_unknown', `status 不在状态机内：${String(difference.status)}`, 'status'), action: 'skip', review: false })
    return
  }
  if (difference.reasonCode != null && !DIFFERENCE_REASONS.has(String(difference.reasonCode))) {
    push({ item: failure('difference', ref, 'reason_unknown', `reasonCode 不在字典内：${String(difference.reasonCode)}`, 'reasonCode'), action: 'skip', review: false })
    return
  }
  if (difference.measureCode != null && !DIFFERENCE_MEASURES.has(String(difference.measureCode))) {
    push({ item: failure('difference', ref, 'measure_unknown', `measureCode 不在字典内：${String(difference.measureCode)}`, 'measureCode'), action: 'skip', review: false })
    return
  }
  // 这里校验明确裁决的形状，不从平台行自动推断业务原因。
  if (difference.reasonCode === 'pending_review' && (
    difference.status !== 'confirmed_reason' || difference.verificationStatus !== 'confirmed' ||
    difference.measureCode !== 'follow_review'
  )) {
    push({ item: failure('difference', ref, 'pending_review_decision_invalid', '待审核须为 confirmed_reason + confirmed，并配 follow_review 保留历史及跟进审核', 'reasonCode'), action: 'skip', review: false })
    return
  }
  // 契约 §1.5：`recorded_at` 不默认（时态化的排序键），必须由来源给出。
  const recordedAt = optionalString(difference.recordedAt)
  if (!recordedAt) {
    push({ item: failure('difference', ref, 'recorded_at_required', '差异解释缺少 recordedAt（登记时点）', 'recordedAt'), action: 'skip', review: false })
    return
  }
  // 证据指针：每列**裸 id 与自然键恰给其一**。
  const refs = collectEvidenceRefs(db, pendingRefs, difference, ref, push)
  if (!refs) return
  const spec = { name: difference.enterpriseName, uscc: difference.uscc }
  if (!enterpriseKnown(db, pending, spec)) {
    push({ item: failure('difference', ref, 'enterprise_not_found', `差异找不到归属企业：${optionalString(difference.enterpriseName) ?? usccOrNull(difference.uscc) ?? '(空)'}`, 'enterpriseName'), action: 'skip', review: false })
    return
  }
  const evidenceMismatch = recognizedDifferenceEvidenceError(db, pendingRefs, refs, difference)
  if (evidenceMismatch) {
    push({ item: failure('difference', ref, 'evidence_subject_mismatch', evidenceMismatch, 'evidenceRelationRef'), action: 'skip', review: false })
    return
  }
  const current = locateEnterprise(db, spec)
  const existing = current
    ? findDifferenceRow(db, { enterpriseId: current.id, titleCode: difference.titleCode, direction: difference.direction, recordedAt })
    : undefined
  // Historical import remains compatible until the coordinate is explicitly adopted.
  // Once lifecycle metadata exists, this old path must never override its expected-version guard.
  if (current && lifecycleOwnsDifference102(db, current.id, difference.titleCode, difference.direction)) {
    push({ item: failure('difference', ref, 'decision_lifecycle_required', '该企业称号方向已采用差异决定生命周期；请用 /api/roster/decision-lifecycle/commands 或 save_difference_decision', 'differences'), action: 'skip', review: false })
    return
  }
  const status = difference.status ?? 'not_queried'
  push({
    item: success('difference', existing ? `difference:${existing.id}` : ref, { enterpriseId: current?.id ?? null }),
    action: existing ? 'skip' : 'add',
    review: status === 'needs_review' || (difference.verificationStatus ?? 'pending') !== 'confirmed',
    run: (tx) => {
      const enterprise = locateEnterprise(tx, spec)
      if (!enterprise) return failure('difference', ref, 'enterprise_not_found', '差异归属企业在写入阶段不存在', 'enterpriseName')
      if (lifecycleOwnsDifference102(tx, enterprise.id, difference.titleCode, difference.direction)) return failure('difference', ref, 'decision_lifecycle_required', '差异决定已由生命周期命令接管；旧导入不能覆盖当前版本', 'differences')
      // 执行阶段解析真 id（本批新建的查询/关系此刻已插入）。
      let evidenceQueryId = refs.queryIdLiteral
      if (refs.queryRef) {
        evidenceQueryId = resolveQueryIdAt(tx, refs.queryRef)
        if (evidenceQueryId == null) {
          return failure('difference', ref, 'query_ref_not_found', `执行阶段解析不到平台查询：${describeRef(refs.queryRef)}`, 'differences[].evidenceQueryRef')
        }
      }
      let evidenceRelationId = refs.relationIdLiteral
      if (refs.relationRef) {
        evidenceRelationId = resolveRelationIdAt(tx, refs.relationRef)
        if (evidenceRelationId == null) {
          return failure('difference', ref, 'relation_ref_not_found', `执行阶段解析不到平台关系：${describeRef(refs.relationRef)}`, 'differences[].evidenceRelationRef')
        }
      }
      const already = findDifferenceRow(tx, {
        enterpriseId: enterprise.id,
        titleCode: difference.titleCode,
        direction: difference.direction,
        recordedAt,
      })
      if (already) return success('difference', `difference:${already.id}`, { enterpriseId: enterprise.id, rowsWritten: 0 })
      const values = {
          enterpriseId: enterprise.id,
          titleCode: difference.titleCode,
          direction: difference.direction,
          status,
          reasonCode: (difference.reasonCode ?? null) as typeof schema.differenceReason.$inferInsert.reasonCode,
          reasonNote: optionalString(difference.reasonNote),
          measureCode: (difference.measureCode ?? null) as typeof schema.differenceReason.$inferInsert.measureCode,
          measureNote: optionalString(difference.measureNote),
          movedInCity: optionalString(difference.movedIn?.city),
          movedInTitleCode: optionalString(difference.movedIn?.titleCode),
          movedInYear: optionalInt(difference.movedIn?.year),
          movedInBatch: optionalInt(difference.movedIn?.batch),
          verificationStatus: difference.verificationStatus ?? 'pending',
          recordedAt,
      }
      const mismatch = recognizedDifferenceEvidenceError(tx, [], { queryIdLiteral: evidenceQueryId, relationIdLiteral: evidenceRelationId, queryRef: null, relationRef: null }, difference)
      if (mismatch) return failure('difference', ref, 'evidence_subject_mismatch', mismatch, 'evidenceRelationRef')
      const id = tx.insert(targetDifferenceReason).values({ ...values, evidenceCollectionId: evidenceQueryId == null ? null : readDifferenceCollection(tx, evidenceQueryId)?.collection.id, evidenceObservationId: evidenceRelationId == null ? null : readDifferenceObservation(tx, evidenceRelationId)?.observationId }).returning({ id: targetDifferenceReason.id }).get().id
      return success('difference', `difference:${id}`, { enterpriseId: enterprise.id, evidenceQueryId, evidenceRelationId, rowsWritten: 1 })
    },
  })
}

// --- 归并与回填（契约 §5.2）------------------------------------------------

/** 归并血缘：from → to，以及迁了哪些 record / event / evidence。 */
export interface MergeLineage {
  fromEnterpriseId: number
  fromEnterpriseName: string
  intoEnterpriseId: number
  intoUscc: string
  /** 规范行**最终**的名字（给了 `merges[].canonicalName` 就是导出表侧的名字）。 */
  canonicalName: string
  /**
   * **主名称改名**（§5.3 ①）：给 `canonicalName` 且与原名不同时记下 `from → to`，
   * 以及被顶掉原名落成的那条别名 id；没改名是 `null`。
   */
  rename: { from: string; to: string; aliasId: number | null } | null
  aliasId: number | null
  /** 支撑本次归并的查询证据（裸 id 或自然键解析所得）；未给为 null。 */
  evidenceQueryId: number | null
  childRowsMoved: { aliases: number; differences: number; relations: number; records: number }
  /** 直接改指规范行的记录 id（无同坐标冲突）。 */
  recordsMoved: number[]
  /** 折进规范行同坐标记录的记录 id → 规范行记录 id。 */
  recordsFolded: Array<{ fromRecordId: number; intoRecordId: number; fromRecordSnapshot?: typeof schema.record.$inferSelect; eventIds?: number[] }>
  /** 被并企业名下（原）事件 id —— 事件一条都没删，只是记录变了。 */
  eventsMoved: number[]
  /** 随之归入规范行的出处 id（含页码，供回溯「第几页」）。 */
  evidenceMoved: number[]
}

interface MergePlan {
  merge: RosterImportMerge
  /** 当时能唯一定位的来源主体；本批新建且唯一时保留 null，写入阶段再按名唯一解析。 */
  sourceEnterpriseId: number | null
  /** 曾用名来源关系的自然键（执行阶段解析成真 id）。 */
  sourceRelationRef: NormalizedRef | null
  /** 支撑归并的查询证据的自然键（执行阶段解析成真 id，只进血缘）。 */
  evidenceQueryRef: NormalizedRef | null
}

function planMerge(
  db: Executor,
  pending: PendingEnterprises,
  pendingEnterpriseCreates: PendingEnterpriseCreate[],
  pendingRefs: PendingPlatformRefs,
  merge: RosterImportMerge,
  index: number,
  push: (item: PlannedItem) => void,
): void {
  const ref = `merge:${index}`
  const intoUscc = usccOrNull(merge?.intoUscc)
  if (!intoUscc) {
    push({ item: failure('merge', ref, 'into_uscc_required', '归并缺少 intoUscc（规范行统代）', 'intoUscc'), action: 'skip', review: false })
    return
  }
  if (merge.sourceKind != null && !ALIAS_SOURCE_KINDS.has(String(merge.sourceKind))) {
    push({ item: failure('merge', ref, 'alias_source_kind_unknown', `sourceKind 不在字典内：${String(merge.sourceKind)}`, 'sourceKind'), action: 'skip', review: false })
    return
  }
  // 主名称：**不给就不改名**（缺省行为）；给了就必须是非空字符串，不静默忽略一个坏值。
  if (merge.canonicalName != null && !optionalString(merge.canonicalName)) {
    push({ item: failure('merge', ref, 'canonical_name_invalid', 'canonicalName 必须是非空字符串（不给则不改名）', 'merges[].canonicalName'), action: 'skip', review: false })
    return
  }
  // 证据指针：同别名/差异的规则 —— 每列**裸 id 与自然键恰给其一**。
  if (optionalInt(merge.sourceRefId) != null && merge.sourceRelationRef != null) {
    push({ item: failure('merge', ref, 'source_ref_conflict', '同时给了 sourceRefId 与 sourceRelationRef；请只给其一', 'merges[].sourceRelationRef'), action: 'skip', review: false })
    return
  }
  if (optionalInt(merge.evidenceQueryId) != null && merge.evidenceQueryRef != null) {
    push({ item: failure('merge', ref, 'evidence_ref_conflict', '同时给了 evidenceQueryId 与 evidenceQueryRef；请只给其一', 'merges[].evidenceQueryRef'), action: 'skip', review: false })
    return
  }
  let sourceRelationRef: NormalizedRef | null = null
  if (merge.sourceRelationRef != null) {
    const normalized = normalizeRef(merge.sourceRelationRef, 'merges[].sourceRelationRef')
    if (!normalized.ok) {
      push({ item: failure('merge', ref, normalized.error.code, normalized.error.message, normalized.error.field), action: 'skip', review: false })
      return
    }
    const resolved = resolveRelationRefPlan(db, pendingRefs, normalized.value, 'merges[].sourceRelationRef')
    if (!resolved.ok) {
      push({ item: failure('merge', ref, resolved.error.code, resolved.error.message, resolved.error.field), action: 'skip', review: false })
      return
    }
    sourceRelationRef = normalized.value
  }
  let evidenceQueryRef: NormalizedRef | null = null
  if (merge.evidenceQueryRef != null) {
    const normalized = normalizeRef(merge.evidenceQueryRef, 'merges[].evidenceQueryRef')
    if (!normalized.ok) {
      push({ item: failure('merge', ref, normalized.error.code, normalized.error.message, normalized.error.field), action: 'skip', review: false })
      return
    }
    const resolved = resolveQueryRefPlan(db, pendingRefs, normalized.value, 'merges[].evidenceQueryRef')
    if (!resolved.ok) {
      push({ item: failure('merge', ref, resolved.error.code, resolved.error.message, resolved.error.field), action: 'skip', review: false })
      return
    }
    evidenceQueryRef = normalized.value
  }
  const fromRaw = optionalInt(merge.fromEnterpriseId)
  const fromName = optionalString(merge.fromEnterpriseName)
  if (fromRaw == null && !fromName) {
    push({ item: failure('merge', ref, 'merge_source_required', '归并缺少 fromEnterpriseId 或 fromEnterpriseName', 'fromEnterpriseId'), action: 'skip', review: false })
    return
  }
  let sourceEnterpriseId: number | null = null
  if (fromRaw != null) {
    const byId = findEnterpriseById(db, fromRaw)
    if (!byId) {
      push({ item: failure('merge', ref, 'merge_source_not_found', `被并企业不存在：${fromRaw}`, 'fromEnterpriseId'), action: 'skip', review: false })
      return
    }
    if (fromName && normalizeName(fromName) !== byId.nameNorm) {
      push({ item: failure('merge', ref, 'enterprise_selector_conflict', `enterpriseId=${fromRaw} 的名称与给定 fromEnterpriseName 不一致`, 'fromEnterpriseName'), action: 'skip', review: false })
      return
    }
    sourceEnterpriseId = byId.id
  } else {
    const nameNorm = normalizeName(fromName!)
    const databaseMatches = findEnterprisesByNorm(db, nameNorm)
    const pendingMatches = pendingEnterpriseCreates.filter((create) => create.nameNorm === nameNorm)
    const candidateCount = databaseMatches.length + pendingMatches.length
    if (candidateCount > 1) {
      push({ item: failure('merge', ref, 'enterprise_ambiguous', `同名企业有 ${candidateCount} 个候选 ⇒ 不猜是哪一家`, 'fromEnterpriseName'), action: 'skip', review: false })
      return
    }
    if (candidateCount === 1) sourceEnterpriseId = databaseMatches[0]?.id ?? null
    if (candidateCount === 0 && !pending.has(nameKey(nameNorm))) {
      push({ item: failure('merge', ref, 'merge_source_not_found', `被并企业不存在：${fromName}`, 'fromEnterpriseName'), action: 'skip', review: false })
      return
    }
  }
  // 规范行可以已存在，也可以是**本批刚写进去**的企业（执行时解析）。
  if (!findEnterpriseByUscc(db, intoUscc) && !pending.has(`uscc:${intoUscc}`)) {
    push({ item: failure('merge', ref, 'merge_target_not_found', `规范行（统代 ${intoUscc}）不存在`, 'intoUscc'), action: 'skip', review: false })
    return
  }

  const targetEnterprise = findEnterpriseByUscc(db, intoUscc)
  if (sourceEnterpriseId != null) {
    const lifecycleConflict = findMergeDifferenceLifecycleConflict(db, sourceEnterpriseId, targetEnterprise?.id ?? null)
    if (lifecycleConflict) {
      push({ item: failure('merge', ref, lifecycleConflict.code, lifecycleConflict.message, 'merges'), action: 'skip', review: false })
      return
    }
  }
  if (sourceEnterpriseId != null && targetEnterprise) {
    const aliasConflict = findMergeAliasLifecycleConflict(db, sourceEnterpriseId, targetEnterprise.id)
    if (aliasConflict) {
      push({ item: failure('merge', ref, aliasConflict.code, aliasConflict.message, 'merges'), action: 'skip', review: false })
      return
    }
    const conflictingDifference = findMergeDifferenceConflict(db, sourceEnterpriseId, targetEnterprise.id)
    if (conflictingDifference) {
      push({
        item: failure(
          'merge',
          ref,
          'merge_difference_conflict',
          `差异唯一键已存在但内容不同：${conflictingDifference.titleCode}/${conflictingDifference.direction}/${conflictingDifference.recordedAt}`,
          'merges',
        ),
        action: 'skip',
        review: false,
      })
      return
    }
  }

  const plan: MergePlan = { merge, sourceEnterpriseId, sourceRelationRef, evidenceQueryRef }
  push({
    item: success('merge', `merge:${fromRaw ?? fromName}->${intoUscc}`, {
      intoUscc,
      /**
       * 请求里给的 `canonicalName`（`null` = 没要求改名）。
       *
       * ⚠️ 这是**请求**不是结论：真会不会改名取决于**执行时**规范行的现名（而规范行可能本批才建），
       * 且与现名逐字相同时不改。权威答案在血缘的 `rename`（`null` = 确实没改名）。
       */
      requestedCanonicalName: optionalString(merge.canonicalName),
    }),
    action: 'update',
    review: false,
    mergePlan: plan,
    run: (tx) => executeMerge(tx, plan),
  })
}

// --- 补录统一社会信用代码（RL-06，契约 §8.10）-------------------------------

/**
 * 一次补录的**血缘**（落 `import_batch.item_results[].detail.lineage`，与归并同一处可查）。
 *
 * 与归并血缘的分工很清楚：归并记「哪两行合成了一行、迁了哪些子行」；
 * 补录只记「哪一行被填上了哪个值，依据是哪条公开来源」——**没有**任何身份变更。
 */
export interface UsccBackfillLineage {
  enterpriseId: number
  enterpriseName: string
  uscc: string
  /** 补录前的统代 —— 恒为 `null`（已有统代的一律拒绝写入，不覆盖）。 */
  previousUscc: null
  /** 公开来源证据（URL / 查证日期 / 对应依据 / 来源名称 / 地区）。 */
  source: RosterImportUsccBackfill['source']
  note: string | null
}

interface UsccBackfillPlan {
  ref: string
  backfill: RosterImportUsccBackfill
  enterpriseId: number
  uscc: string
}

/**
 * 计划一条补录（契约 §8.10）。判据**全部是客观的**，一条都不靠名称相似：
 *
 *  - **代码格式/校验位**（GB 32100-2015，`usccFormatVerdict`）不合法 ⇒ 拒绝（不填猜测值）；
 *  - **公开来源三要素**（URL / 查证日期 / 对应依据）+ 来源名称，缺一 ⇒ `source_evidence_incomplete`；
 *  - 目标企业必须存在；**按名定位时要求同名行唯一**（同名多主体 ⇒ `enterprise_ambiguous`，不猜是哪一家）；
 *  - 目标企业**已有统代** ⇒ `uscc_already_present`（**不覆盖已有代码**）；
 *  - 该统代已被**别的**企业占用 ⇒ `uscc_taken`（冲突；要合并身份请走 `merges`，那是另一件事）。
 *
 * 任一项不过 ⇒ 逐项报错、整批 `failed`、业务数据一行不落（与其它载荷项同一条规则）。
 */
function planUsccBackfill(
  db: Executor,
  backfill: RosterImportUsccBackfill,
  index: number,
  push: (item: PlannedItem) => void,
): void {
  const ref = `uscc_backfill:${index}`
  const uscc = usccOrNull(backfill?.uscc)
  const verdict = usccFormatVerdict(backfill?.uscc)
  if (!uscc || verdict !== 'ok') {
    const why =
      verdict === 'length' ? '长度不是 18 位' : verdict === 'charset' ? '含字符集外的字符' : '校验位不符'
    push({
      item: failure('uscc_backfill', ref, 'uscc_format_invalid', `统一社会信用代码不合法（${why}）：${String(backfill?.uscc ?? '(空)')}`, 'uscc'),
      action: 'skip',
      review: false,
    })
    return
  }
  // 三要素的判据与计划侧**同一处实现**（`missingUsccSourceFields`）——两处各写一遍会漂，
  // 漂了以后「计划说能写、写入拒了」或反过来放行一条不可复核的来源都很难发现。
  const source = backfill?.source
  const missing = missingUsccSourceFields(source)
  if (missing.length) {
    push({
      item: failure('uscc_backfill', ref, 'source_evidence_incomplete', `补录缺少可复核的公开来源证据：${missing.join('、')}`, 'source'),
      action: 'skip',
      review: false,
    })
    return
  }

  const idRaw = optionalInt(backfill?.enterpriseId)
  const name = optionalString(backfill?.enterpriseName)
  if (idRaw == null && !name) {
    push({
      item: failure('uscc_backfill', ref, 'enterprise_required', '补录缺少 enterpriseId 或 enterpriseName', 'enterpriseId'),
      action: 'skip',
      review: false,
    })
    return
  }
  let target: ResolvedEnterprise | null = null
  if (idRaw != null) {
    target = findEnterpriseById(db, idRaw)
    if (target && name && normalizeName(name) !== target.nameNorm) {
      push({
        item: failure('uscc_backfill', ref, 'enterprise_selector_conflict', `enterpriseId=${idRaw} 的名称与给定 enterpriseName 不一致`, 'enterpriseName'),
        action: 'skip',
        review: false,
      })
      return
    }
  } else {
    // **按名定位必须唯一**：同名多主体时软件不猜是哪一家（票面第 4 条）。
    const sameName = findEnterprisesByNorm(db, normalizeName(name!))
    if (sameName.length > 1) {
      push({
        item: failure('uscc_backfill', ref, 'enterprise_ambiguous', `同名企业有 ${sameName.length} 家（${sameName.map((e) => e.id).join('、')}）⇒ 同名多主体，不猜是哪一家`, 'enterpriseName'),
        action: 'skip',
        review: false,
      })
      return
    }
    target = sameName[0] ?? null
  }
  if (!target) {
    push({
      item: failure('uscc_backfill', ref, 'enterprise_not_found', `补录找不到归属企业：${idRaw ?? name}`, 'enterpriseId'),
      action: 'skip',
      review: false,
    })
    return
  }
  if (target.usccNorm) {
    push({
      item: failure('uscc_backfill', ref, 'uscc_already_present', `企业 ${target.id} 已有统代 ${target.usccNorm} ⇒ 只补缺失值，不覆盖`, 'uscc'),
      action: 'skip',
      review: false,
    })
    return
  }
  const holder = findEnterpriseByUscc(db, uscc)
  if (holder && holder.id !== target.id) {
    push({
      item: failure('uscc_backfill', ref, 'uscc_taken', `统代 ${uscc} 已被企业 ${holder.id}「${holder.name}」占用 ⇒ 冲突，不覆盖、不自动合并身份`, 'uscc'),
      action: 'skip',
      review: false,
    })
    return
  }

  const plan: UsccBackfillPlan = { ref, backfill, enterpriseId: target.id, uscc }
  push({
    item: success('uscc_backfill', `uscc_backfill:${target.id}->${uscc}`, {
      enterpriseId: target.id,
      enterpriseName: target.name,
      uscc,
      sourceUrl: optionalString(source?.url),
    }),
    action: 'update',
    review: false,
    run: (tx) => executeUsccBackfill(tx, plan),
  })
}

/**
 * 执行一条补录：把 `uscc_norm` 填上，并摘掉 `quality_flags` 里的 `uscc_missing`。
 *
 * **只动这两处** —— 不写别名、不改名、不动 `record` / `record_event` / 出处 / 关系
 * （票面第 5 条：不因补代码自动合并身份）。写入阶段再校验一遍「企业还在、仍无统代、
 * 统代没被占」：计划与执行之间库状态可能变（同批更早的项就可能），任何一条不过就
 * 抛 `ExecStageFailure` 让整批回滚，**绝不**写出一个自相矛盾的状态。
 */
function executeUsccBackfill(tx: Executor, plan: UsccBackfillPlan): RosterImportItemResult {
  const row = tx.select().from(schema.enterprise).where(eq(schema.enterprise.id, plan.enterpriseId)).get()
  if (!row) {
    return failure('uscc_backfill', plan.ref, 'enterprise_not_found', `写入阶段找不到企业 ${plan.enterpriseId}`, 'enterpriseId')
  }
  if (row.usccNorm) {
    return failure('uscc_backfill', plan.ref, 'uscc_already_present', `企业 ${row.id} 在写入阶段已有统代 ${row.usccNorm} ⇒ 不覆盖`, 'uscc')
  }
  const holder = findEnterpriseByUscc(tx, plan.uscc)
  if (holder && holder.id !== row.id) {
    return failure('uscc_backfill', plan.ref, 'uscc_taken', `统代 ${plan.uscc} 在写入阶段已被企业 ${holder.id} 占用`, 'uscc')
  }
  const identityBefore = identityMaterial113(tx, row.id)
  const qualityFlags = (row.qualityFlags ?? []).filter((flag) => flag !== 'uscc_missing')
  updateEnterprise(tx, row.id, { usccNorm: plan.uscc, qualityFlags })
  captureIdentityRevision113(tx, { enterpriseId: row.id, sourceKey: `enterprise:${row.id}`, sourceVersion: `uscc:${plan.uscc}`, before: identityBefore, after: identityMaterial113(tx, row.id) })
  const lineage: UsccBackfillLineage = {
    enterpriseId: row.id,
    enterpriseName: row.name,
    uscc: plan.uscc,
    previousUscc: null,
    source: plan.backfill.source,
    note: optionalString(plan.backfill?.note),
  }
  return success('uscc_backfill', `uscc_backfill:${row.id}->${plan.uscc}`, {
    enterpriseId: row.id,
    uscc: plan.uscc,
    rowsWritten: 1,
    lineage,
  })
}

/**
 * 取或建一条曾用名 —— 唯一键 `(enterprise_id, name_norm, source_kind, source_ref_id)`（§1.2）。
 * 归并要写**两条**别名（被并方的名字、被顶掉的规范行原名），规则只此一份。
 */
function ensureEnterpriseAlias(
  tx: Executor,
  input: {
    enterpriseId: number
    name: string
    /** 来源类别取值**从冻结的表列派生**，不在这里再抄一遍枚举。 */
    sourceKind: (typeof schema.enterpriseAlias.sourceKind.enumValues)[number]
    sourceRefId: number
    note: string
    /**
     * **按 `(enterprise_id, name_norm)` 去重**（RL-06 增量）——先查同名 `confirmed` 别名，
     * 有就**复用**它、不再插第二条。
     *
     * 为什么归并要它：唯一键含 `source_ref_id`，所以「同一家企业、同一个名字、换一条来源关系」
     * 不撞唯一键，会实打实写出第二行。而归并是**按候选统代**触发的，一轮里同一个名字可能
     * 因为不同的关系行被写两遍（实测:一次 96 条的写回里 26 条命中）。那不算「逐条留证」，
     * 只是把同一个名字留了两遍 —— 搜索与展示上是纯噪音（详情页同名并列）。
     *
     * 只认 `confirmed`：`pending` 的同名别名换成 `confirmed` 是一次**升级**，该写还是要写。
     * 缺省 `false` ⇒ `aliases[]` 那条**显式**写别名的路保持契约 §1.2 的原行为
     * （调用方主动写一条来自某个来源的别名，本来就该在该来源下各成一条）。
     */
    dedupeByName?: boolean
  },
): { id: number; created: boolean } {
  const nameNorm = normalizeName(input.name)
  // 去重档（RL-06）：同一 `(企业, 别名)` 下若已有**已确认**的别名，直接复用 —— 归并两处启用。
  // 这一路**不是唯一键**，所以按列 `eq` 定位（不吃整表），与下面的唯一键定位同一纪律（RL-18）。
  if (input.dedupeByName) {
    const sameName = tx
      .select({ id: schema.enterpriseAlias.id })
      .from(schema.enterpriseAlias)
      .where(
        and(
          eq(schema.enterpriseAlias.enterpriseId, input.enterpriseId),
          eq(schema.enterpriseAlias.nameNorm, nameNorm),
          eq(schema.enterpriseAlias.verificationStatus, 'confirmed'),
        ),
      )
      .get()
    if (sameName) return { id: sameName.id, created: false }
  }
  // 按唯一键 `enterprise_alias_identity_uq` 定位（RL-18）:不再整表线性找，也不再把谓词抄一遍。
  const existing = findAliasRow(tx, {
    enterpriseId: input.enterpriseId,
    nameNorm,
    sourceKind: input.sourceKind,
    sourceRefId: input.sourceRefId,
  })
  if (existing) return { id: existing.id, created: false }
  const { id } = insertEnterpriseAlias(tx, {
      enterpriseId: input.enterpriseId,
      name: input.name,
      nameNorm,
      sourceKind: input.sourceKind,
      sourceRefId: input.sourceRefId,
      verificationStatus: 'confirmed',
      note: input.note,
    })
  return { id, created: true }
}

/**
 * 执行归并（契约 §5.2 五步）。**事件与出处一条都不合并、不折叠、不删除**：
 * 同坐标记录冲突时，把被并记录的事件**改指**规范行那条记录（`record_event.record_id`），
 * 出处挂在事件上随之归入规范行；最后删除被并的空企业行。
 */
function executeMerge(tx: Executor, plan: MergePlan): RosterImportItemResult {
  const { merge, sourceEnterpriseId, sourceRelationRef, evidenceQueryRef } = plan
  const ref0 = `merge:${optionalInt(merge.fromEnterpriseId) ?? optionalString(merge.fromEnterpriseName)}`

  const intoUscc = usccOrNull(merge.intoUscc)!
  const into = findEnterpriseByUscc(tx, intoUscc)
  const fromName = optionalString(merge.fromEnterpriseName)
  let from = sourceEnterpriseId != null ? findEnterpriseById(tx, sourceEnterpriseId) : null
  if (sourceEnterpriseId == null && fromName) {
    const matches = findEnterprisesByNorm(tx, normalizeName(fromName))
    if (matches.length > 1) return failure('merge', ref0, 'enterprise_ambiguous', `同名企业有 ${matches.length} 个候选 ⇒ 不猜是哪一家`, 'fromEnterpriseName')
    from = matches[0] ?? null
  }
  if (!from) return failure('merge', ref0, 'merge_source_not_found', '被并企业在写入阶段不存在', 'fromEnterpriseId')
  if (!into) return failure('merge', ref0, 'merge_target_not_found', '规范行在写入阶段不存在', 'intoUscc')
  if (from.id === into.id) return failure('merge', ref0, 'merge_same_enterprise', '被并企业与规范行是同一行', 'fromEnterpriseId')
  const identityBefore = identityMaterial113(tx, into.id)
  const ref = `merge:${from.id}->${into.id}`
  const lifecycleConflict = findMergeDifferenceLifecycleConflict(tx, from.id, into.id)
  if (lifecycleConflict) return failure('merge', ref, lifecycleConflict.code, lifecycleConflict.message, 'merges')
  const aliasConflict = findMergeAliasLifecycleConflict(tx, from.id, into.id)
  if (aliasConflict) return failure('merge', ref, aliasConflict.code, aliasConflict.message, 'merges')
  const conflictingDifference = findMergeDifferenceConflict(tx, from.id, into.id)
  if (conflictingDifference) {
    return failure(
      'merge',
      ref,
      'merge_difference_conflict',
      `差异唯一键已存在但内容不同：${conflictingDifference.titleCode}/${conflictingDifference.direction}/${conflictingDifference.recordedAt}`,
      'merges',
    )
  }

  // 2. 主名称与曾用名（§5.3）。证据指针：给了自然键就**必须**解析到真 id（解析不到 ⇒ 报错）。
  const sourceKind = merge.sourceKind ?? 'manual'
  let sourceRefId = optionalInt(merge.sourceRefId) ?? 0
  if (sourceRelationRef) {
    const resolved = resolveRelationIdAt(tx, sourceRelationRef)
    if (resolved == null) {
      return failure('merge', ref, 'relation_ref_not_found', `执行阶段解析不到平台关系：${describeRef(sourceRelationRef)}`, 'merges[].sourceRelationRef')
    }
    sourceRefId = resolved
  }
  let mergeEvidenceQueryId = optionalInt(merge.evidenceQueryId)
  if (evidenceQueryRef) {
    const resolved = resolveQueryIdAt(tx, evidenceQueryRef)
    if (resolved == null) {
      return failure('merge', ref, 'query_ref_not_found', `执行阶段解析不到平台查询：${describeRef(evidenceQueryRef)}`, 'merges[].evidenceQueryRef')
    }
    mergeEvidenceQueryId = resolved
  }

  // 2a. **主名称改名**（§5.3 ①：以导出表/最新平台态为准）。给了 `canonicalName` 且与原名不同
  //     ⇒ 规范行改名为它，**被顶掉的原名落成别名**（旧名同样不丢）；不给 ⇒ 保持不动（缺省行为）。
  const requestedName = optionalString(merge.canonicalName)
  const renamedFrom = requestedName && requestedName !== into.name ? into.name : null
  const canonicalName = requestedName ?? into.name
  if (renamedFrom && requestedName) {
    updateEnterprise(tx, into.id, { name: requestedName, nameNorm: normalizeName(requestedName) })
  }
  // 被顶掉的原名：来源与本次归并同一份证据（调用方给的关系行）。
  // 说明文字**不能**被调用方的 `note` 顶掉 —— 那条别名为什么存在，只在这里说得清。
  const renameNote = `主名称改为「${canonicalName}」（导出表侧）后被顶掉的原名`
  const renameAlias = renamedFrom
    ? ensureEnterpriseAlias(tx, {
        enterpriseId: into.id,
        name: renamedFrom,
        sourceKind,
        sourceRefId,
        note: optionalString(merge.note) ? `${renameNote}；${optionalString(merge.note)}` : renameNote,
        dedupeByName: true,
      })
    : { id: null, created: false }

  // 2b. 被并方的名字（§5.3）：**与规范行最终名称逐字相同则不造别名** —— 别名的用途是「旧名不丢」，
  //     名称一模一样时根本没有第二个名字可留（造一条同名别名只会污染搜索与展示）。
  //     判据用**逐字相等**（不是归一化相等）：归一化会抹掉括号、空白与「宁波」前缀，
  //     而「公布名写的是短名、导出表写的是全名」正是要靠别名留住的差异。
  //     实测的 4 例重名归并（公布名 == 导出表名，逐字相同）都走这一支。
  const aliasName = optionalString(merge.aliasName) ?? from.name
  const mergeAlias =
    aliasName === canonicalName
      ? { id: null, created: false }
      : ensureEnterpriseAlias(tx, {
          enterpriseId: into.id,
          name: aliasName,
          sourceKind,
          sourceRefId,
          note: optionalString(merge.note) ?? `归并自 enterprise:${from.id}（${from.name}）`,
          // 归并这一侧按 `(enterprise_id, name_norm)` 去重（见 `ensureEnterpriseAlias` 的注释）。
          dedupeByName: true,
        })
  const aliasId = mergeAlias.id

  // 3. 迁移子行（别名 / 差异 / 平台关系）。撞唯一键的**先删被并那条**（它在规范行已有等价行）。
  let aliasesMoved = 0
  for (const alias of tx
    .select()
    .from(schema.enterpriseAlias)
    .where(eq(schema.enterpriseAlias.enterpriseId, from.id))
    .all()) {
    const clash = findAliasRow(tx, {
      enterpriseId: into.id,
      nameNorm: alias.nameNorm,
      sourceKind: alias.sourceKind,
      sourceRefId: alias.sourceRefId,
    })
    if (clash) {
      const conflict = aliasMergeLifecycleConflict(tx, alias, clash)
      if (conflict) return failure('merge', ref, conflict.code, conflict.message, 'merges')
      // #99: keep immutable decision provenance; only its lookup target follows the survivor.
      moveEnterpriseAlias(tx, alias.id, { aliasId: clash.id })
    } else {
      moveEnterpriseAlias(tx, alias.id, { enterpriseId: into.id })
      aliasesMoved += 1
    }
  }

  let differencesMoved = 0
  for (const difference of tx
    .select()
    .from(schema.differenceReason)
    .where(eq(schema.differenceReason.enterpriseId, from.id))
    .all()) {
    const clash = findDifferenceRow(tx, {
      enterpriseId: into.id,
      titleCode: difference.titleCode,
      direction: difference.direction,
      recordedAt: difference.recordedAt,
    })
    if (clash) {
      const targetDifference = findDifferenceContentRow(tx, {
        enterpriseId: into.id,
        titleCode: difference.titleCode,
        direction: difference.direction,
        recordedAt: difference.recordedAt,
      })
      if (targetDifference && !sameDifferenceContent(difference, targetDifference)) {
        return failure(
          'merge',
          ref,
          'merge_difference_conflict',
          `差异唯一键已存在但内容不同：${difference.titleCode}/${difference.direction}/${difference.recordedAt}`,
          'merges',
        )
      }
      tx.delete(schema.differenceReason).where(eq(schema.differenceReason.id, difference.id)).run()
    } else {
      tx.update(schema.differenceReason).set({ enterpriseId: into.id }).where(eq(schema.differenceReason.id, difference.id)).run()
      differencesMoved += 1
    }
  }

  const relationsMoved = mergeTargetEnterpriseIdentity(tx, {
    fromEnterpriseId: from.id, intoEnterpriseId: into.id,
    basis: optionalString(merge.note) ?? `merge:${from.id}->${into.id}`,
  })

  // 4. 记录：同 (称号, 来源) 冲突时把事件折到规范行那条记录上。
  const recordsMoved: number[] = []
  const recordsFolded: Array<{ fromRecordId: number; intoRecordId: number; fromRecordSnapshot?: typeof schema.record.$inferSelect; eventIds?: number[] }> = []
  const eventsMoved: number[] = []
  const evidenceMoved: number[] = []
  for (const record of tx.select().from(schema.record).where(eq(schema.record.enterpriseId, from.id)).all()) {
    const events = tx.select().from(schema.recordEvent).where(eq(schema.recordEvent.recordId, record.id)).all()
    for (const event of events) {
      eventsMoved.push(event.id)
      for (const evidence of tx.select().from(schema.recordEvidence).where(eq(schema.recordEvidence.recordEventId, event.id)).all()) {
        evidenceMoved.push(evidence.id)
      }
    }
    const existing = tx
      .select()
      .from(schema.record)
      .where(and(eq(schema.record.enterpriseId, into.id), eq(schema.record.titleCode, record.titleCode), eq(schema.record.source, record.source)))
      .get()
    if (existing) {
      // 事件**改指**规范行记录（一条不丢、不折叠）；出处挂在事件上随之归入。
      for (const event of events) {
        tx.update(schema.recordEvent).set({ recordId: existing.id }).where(eq(schema.recordEvent.id, event.id)).run()
      }
      tx.delete(schema.record).where(eq(schema.record.id, record.id)).run()
      recordsFolded.push({ fromRecordId: record.id, intoRecordId: existing.id, fromRecordSnapshot: { ...record }, eventIds: events.map(event => event.id) })
    } else {
      tx.update(schema.record).set({ enterpriseId: into.id }).where(eq(schema.record.id, record.id)).run()
      recordsMoved.push(record.id)
    }
  }

  // The stable event/relation references survive; the lookup owner follows the identity merge.
  // Keep confirmation/provenance/fingerprint untouched so readers still require revalidation.
  tx.update(schema.recordCorrespondence).set({ enterpriseId: into.id }).where(eq(schema.recordCorrespondence.enterpriseId, from.id)).run()
  captureIdentityRevision113(tx, { enterpriseId: into.id, sourceKey: `merge:${from.id}:${into.id}`, sourceVersion: '1', before: { identity: identityBefore, from: from.id }, after: { identity: identityMaterial113(tx, into.id), merged: from.id }, fromEnterpriseId: from.id })
  // 5. 删除被并企业行（子行已全部迁走）。

  const lineage: MergeLineage = {
    fromEnterpriseId: from.id,
    fromEnterpriseName: from.name,
    intoEnterpriseId: into.id,
    intoUscc: into.usccNorm ?? '',
    canonicalName,
    rename: renamedFrom ? { from: renamedFrom, to: canonicalName, aliasId: renameAlias.id } : null,
    aliasId,
    evidenceQueryId: mergeEvidenceQueryId,
    childRowsMoved: {
      aliases: aliasesMoved,
      differences: differencesMoved,
      relations: relationsMoved,
      records: recordsMoved.length + recordsFolded.length,
    },
    recordsMoved,
    recordsFolded,
    eventsMoved,
    evidenceMoved,
  }
  // 归并**净新增的行**只有别名（子行是改指、事件是改指、被并企业行是删除）：
  // 被并方名与规范行最终名逐字相同时不造那条别名；改名时另加一条「被顶掉的原名」。
  return success('merge', ref, {
    lineage,
    rowsWritten: (mergeAlias.created ? 1 : 0) + (renameAlias.created ? 1 : 0),
  })
}

// ---------------------------------------------------------------------------
// 批次行（记账，独立于业务事务）
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 预检
// ---------------------------------------------------------------------------

/** 执行阶段有项返回 `ok:false` 时抛出 —— 用来回滚整批（绝不部分提交）。 */
class ExecStageFailure extends Error {
  constructor(readonly executed: RosterImportItemResult[]) {
    super('批次执行阶段有项失败')
    this.name = 'ExecStageFailure'
  }
}

/** Ancillary before/current readback: at most one complete shared assessment, never a write gate.
 * Other payload commands may affect additional subjects; this first slice does not certify them.
 */
function readPreflightQualification(db: Db, request: RosterImportRequest, plan: Plan): Pick<RosterImportPreflight, 'qualificationDiagnostics' | 'qualificationReadback'> {
  const candidates = plan.items.flatMap(item => item.qualificationCandidate ? [item.qualificationCandidate] : [])
  if (!candidates.some(candidate => candidate.diagnostics.length)) return {}
  const qualificationDiagnostics = candidates.flatMap(candidate => candidate.diagnostics)
  if (plan.conflicts.length) return { qualificationDiagnostics }
  if (Object.entries(request.payload).some(([key, value]) => key !== 'announcement' && key !== 'officialEvidencePlanHash' && value != null && (!Array.isArray(value) || value.length > 0))) {
    return { qualificationDiagnostics, qualificationReadback: { stage: 'before', status: 'not_retained', target: null, reason: 'scope_not_established' } }
  }
  const targets = new Map(candidates.map(candidate => [candidate.targetKey, candidate.enterpriseId]))
  if (targets.size > 1) {
    const enterpriseIds = [...new Set([...targets.values()].filter((id): id is number => id !== null))].sort((a, b) => a - b)
    return { qualificationDiagnostics, qualificationReadback: { stage: 'before', status: 'not_retained', reason: 'multiple_targets', target: null, enterpriseIds } }
  }
  const enterpriseId = [...targets.values()][0]!
  if (enterpriseId === null) return { qualificationDiagnostics, qualificationReadback: { stage: 'before', status: 'not_retained', reason: 'new_target', target: null } }
  const target = { enterpriseId }
  try {
    const assessment = readCurrentQualificationAssessment((db as Db & { $client: import('better-sqlite3').Database }).$client, enterpriseId, Date.now(), { assessmentVersion: 'enterprise-qualification-407-v1' })
    const qualificationReadback = { stage: 'before' as const, status: 'captured' as const, target, assessment }
    const requiredBytes = Buffer.byteLength(JSON.stringify(qualificationReadback), 'utf8')
    return { qualificationDiagnostics, qualificationReadback: requiredBytes <= 65536 ? qualificationReadback
      : { stage: 'before', status: 'unavailable', reason: 'response_limit', target, requiredBytes } }
  } catch {
    return { qualificationDiagnostics, qualificationReadback: { stage: 'before', status: 'unavailable', reason: 'read_unavailable', target } }
  }
}

/**
 * 只读预检（契约 §8.1）：**不写业务数据**，只算影响并落一条 `status='preflight'` 的批次。
 * 同一幂等键重复调用：复用既有批次行、刷新它的预检结果。
 *
 * ⚠️ **已 `committed` 的幂等键另有一套语义（RL-19）**：同键的 `commit` 会**直接返回既有摘要、
 * 一行不写**（§8.2 的幂等），所以对这样的请求报一份「会改 N 行」的计划是**假话** ——
 * 它既不会发生，还会**覆写**那条已提交批次的预检记账，于是批次行里留下
 * 「预检说改 N 行、摘要说改了 0 行」的自相矛盾记录（RL-19 的事故现场就是这个假象）。
 * 这里如实报「同键提交什么都不会发生」并把 `batchStatus: 'committed'` 带出去；
 * 真要补收敛就用 `POST /api/roster/import/replay`（§8.9.3）。
 */
function preflightRosterImportCore(
  db: Db,
  request: RosterImportRequest,
  pageCountErrors: readonly RosterImportItemResult[] = [],
  filesDir?: string,
): { batchId: number; status: 'preflight'; preflight: RosterImportPreflight } {
  const batch = ensureBatchRow(db, request)

  if (batch.status === 'committed') {
    return {
      batchId: batch.id,
      status: 'preflight',
      preflight: {
        add: 0,
        update: 0,
        remove: 0,
        review: 0,
        conflicts: [],
        evidenceRepoints: 0,
        batchStatus: 'committed',
      },
    }
  }

  const plan = planRosterImport(db, request, { batchId: batch.id, pageCountErrors, filesDir })
  const preflight = { ...summarizePlan(plan), ...readPreflightQualification(db, request, plan), batchStatus: batch.status }
  db.update(schema.importBatch)
    .set({ preflightResult: preflight })
    .where(eq(schema.importBatch.id, batch.id))
    .run()
  return { batchId: batch.id, status: 'preflight', preflight }
}

// ---------------------------------------------------------------------------
// 提交
// ---------------------------------------------------------------------------

/** Only successful execution results may identify an after target. Candidate IDs are not used.
 * Other command families remain explicitly outside this announcement-only capture slice.
 */
function captureAnnouncementDiagnostics(plan: Plan, items: readonly RosterImportItemResult[]): Record<string, StoredImportDiagnosticBinding> {
  const retained: Record<string, StoredImportDiagnosticBinding> = {}
  // The execution loop emits exactly one result per planned item, in this order.
  // Final record IDs/refs cannot recover the request index (two inputs may reuse one record).
  items.forEach((item, itemIndex) => {
    const candidate = plan.items[itemIndex]?.qualificationCandidate
    const enterpriseId = item.detail?.enterpriseId, recordId = item.detail?.recordId
    if (!item.ok || item.kind !== 'record_event' || !candidate
      || typeof enterpriseId !== 'number' || !Number.isSafeInteger(enterpriseId) || enterpriseId <= 0
      || typeof recordId !== 'number' || !Number.isSafeInteger(recordId) || recordId <= 0 || item.ref !== `record:${recordId}`
      || candidate.enterpriseId !== null && candidate.enterpriseId !== enterpriseId
      || !/^record:(0|[1-9]\d*)$/.test(candidate.ref)
      || candidate.diagnostics.some((diagnostic, eventIndex) => diagnostic.ref !== `${candidate.ref}#${eventIndex}`)) return
    const binding = { itemIndex, ref: item.ref, enterpriseId, recordId, candidateRef: candidate.ref }
    const diagnostics: RosterImportHistoricalQualificationDiagnostics = { status: 'captured', items: candidate.diagnostics }
    retained[String(itemIndex)] = { ...binding, diagnostics,
      digest: createHash('sha256').update(JSON.stringify([binding, diagnostics])).digest('hex') }
  })
  return retained
}

function captureAnnouncementQualification(db: Db, request: RosterImportRequest, items: readonly RosterImportItemResult[]): RosterImportAfterQualificationReadback {
  if (Object.entries(request.payload).some(([key, value]) => key !== 'announcement' && key !== 'officialEvidencePlanHash' && value != null && (!Array.isArray(value) || value.length > 0))) {
    return { stage: 'after', status: 'not_retained', reason: 'scope_not_established', target: null }
  }
  const records = request.payload.announcement?.records
  if (!Array.isArray(records)) return { stage: 'after', status: 'not_retained', reason: 'scope_not_established', target: null }
  if (!records.length) return { stage: 'after', status: 'not_retained', reason: 'no_targets', target: null }
  const executed = items.filter(item => item.ok && item.kind === 'record_event')
  const ids = executed.map(item => item.detail?.enterpriseId)
  if (executed.length !== records.length || ids.some(id => typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0)) {
    return { stage: 'after', status: 'not_retained', reason: 'scope_not_established', target: null }
  }
  const enterpriseIds = [...new Set(ids as number[])].sort((a, b) => a - b)
  if (enterpriseIds.length > 1) return { stage: 'after', status: 'not_retained', reason: 'multiple_targets', target: null, enterpriseIds }
  const enterpriseId = enterpriseIds[0]!
  const target = { enterpriseId }
  try {
    if (!findEnterpriseById(db, enterpriseId)) return { stage: 'after', status: 'unavailable', reason: 'read_unavailable', target }
    const asOf = Date.now()
    const assessment = readCurrentQualificationAssessment((db as Db & { $client: import('better-sqlite3').Database }).$client, enterpriseId, asOf, { assessmentVersion: 'enterprise-qualification-407-v1' })
    const capture = { stage: 'after' as const, status: 'captured' as const, target, assessment }
    const requiredBytes = Buffer.byteLength(JSON.stringify(capture), 'utf8')
    return requiredBytes <= 65536 ? capture : { stage: 'after', status: 'unavailable', reason: 'response_limit', target, requiredBytes }
  } catch {
    return { stage: 'after', status: 'unavailable', reason: 'read_unavailable', target }
  }
}

/**
 * 事务提交（契约 §8.2）。
 *
 * - **幂等**：同一键若已是 `committed`，直接返回既有摘要（不再写企业/事件）；
 * - **失败可重试**：`failed` 的批次不会留下半截数据（业务写入在事务里回滚），
 *   修好载荷后再以同一键调用即可重试；
 * - **单批事务**：任何一项不合法 ⇒ 整批 `failed`，业务数据一行不落，逐项错误照实回报。
 */
function commitRosterImportCore(
  db: Db,
  request: RosterImportRequest,
  pageCountErrors: readonly RosterImportItemResult[] = [],
  filesDir?: string,
  reviewedAnnouncement?: ReviewedAnnouncementPlan,
): { batchId: number; status: 'committed' | 'failed'; summary: StoredImportSummary; items: RosterImportItemResult[]; error: string | null; qualificationReadback?: RosterImportAfterQualificationReadback } {
  const batch = ensureBatchRow(db, request)

  if (batch.status === 'committed') {
    // 存的是**当次**写下的 JSON：在本票引入 `evidenceRepointed` 之前提交的批次没有这一项。
    // 摘要类型里它是必填，所以读回时补 0（「那一批没有收敛」是事实，不是缺失）——
    // 否则调用方拿到的是 `undefined`，把它当数字用就会静默算错。
    const summary = readSummaryOf(batch.summary) ?? { written: 0, skipped: 0, failed: 0, evidenceRepointed: 0 }
    const items = publicRosterImportItems((batch.itemResults as RosterImportItemResult[] | null) ?? [], batch.id)
    const storedCapture = isObject(batch.summary) && isObject(batch.summary.qualificationReadback) && batch.summary.qualificationReadback.stage === 'after'
      ? batch.summary.qualificationReadback as unknown as RosterImportAfterQualificationReadback : undefined
    const qualificationReadback = batch.sourceKind === 'announcement'
      ? storedCapture ?? { stage: 'after' as const, status: 'not_retained' as const, reason: 'legacy_receipt' as const, target: null }
      : undefined
    return { batchId: batch.id, status: 'committed', summary, items, error: null, ...(qualificationReadback ? { qualificationReadback } : {}) }
  }

  const plan = planRosterImport(db, request, { batchId: batch.id, pageCountErrors, filesDir, reviewedAnnouncement })
  const submittedPlanHash = reviewedAnnouncement ? reviewedAnnouncement.planHash : request.payload.officialEvidencePlanHash
  if (plan.officialEvidencePlanHash && submittedPlanHash !== plan.officialEvidencePlanHash) {
    const item = failure('official_evidence', 'payload', 'plan_mismatch', 'Matching opt-in preflight planHash required; sources or final plan changed')
    plan.conflicts.push(item); plan.items.push({ item, action: 'skip', review: false })
  }
  const conflicts = plan.conflicts

  if (conflicts.length > 0) {
    const items = plan.items.map((p) => p.item)
    const summary: RosterImportSummary = {
      written: 0,
      // 整批失败 ⇒ 一行没写、也没有「复用」发生；如实为 0。
      skipped: 0,
      failed: conflicts.length,
      // 整批回滚 ⇒ 出处指针一行也没动。
      evidenceRepointed: 0,
    }
    const error = `批次校验未通过：${conflicts.length} 项有误，未写入任何数据`
    db.update(schema.importBatch)
      .set({
        status: 'failed',
        itemResults: items,
        summary,
        error,
        preflightResult: summarizePlan(plan),
      })
      .where(eq(schema.importBatch.id, batch.id))
      .run()
    return { batchId: batch.id, status: 'failed', summary, items: publicRosterImportItems(items, batch.id), error }
  }

  let items: RosterImportItemResult[]
  let platformFields: RosterImportSummary['platformFields']
  try {
    items = db.transaction((tx) => {
      const out: RosterImportItemResult[] = []
      for (const planned of plan.items) {
        const result = planned.run ? planned.run(tx) : planned.item
        out.push(result)
        // 执行阶段（关系插入之后）解析自然键等**只能在这一刻**判定的失败：
        // 抛出去回滚整批 —— 绝不部分提交。
        if (!result.ok) throw new ExecStageFailure(out)
      }
      if (request.sourceKind === 'platform_archive') platformFields = verifyImportedCollectionFields(tx, out.flatMap(item => (item.detail?.canonicalProjection as PlatformProjectionResult[] | undefined) ?? []), plan.items.some(item => item.platformFieldReference))
      return out
    })
  } catch (cause) {
    if (cause instanceof ExecStageFailure) {
      // 已完成项 + 未执行项都如实标失败（整批已回滚，一行没写）。
      const executed = cause.executed.map((item) =>
        item.ok ? { ...item, ok: false, error: { code: 'commit_rolled_back', message: '整批回滚，本项未写入' } } : item,
      )
      const rest = plan.items.slice(executed.length).map((planned) => ({
        ...planned.item,
        ok: false,
        error: { code: 'not_executed', message: '整批回滚，本项未执行' },
      }))
      const items = [...executed, ...rest]
      const failed = items.filter((item) => !item.ok).length
      const error = '批次执行阶段有项失败（已整批回滚，未写入任何数据）'
      const summary: RosterImportSummary = { written: 0, skipped: 0, failed, evidenceRepointed: 0 }
      db.update(schema.importBatch)
        .set({ status: 'failed', itemResults: items, summary, error, preflightResult: summarizePlan(plan) })
        .where(eq(schema.importBatch.id, batch.id))
        .run()
      return { batchId: batch.id, status: 'failed', summary, items: publicRosterImportItems(items, batch.id), error }
    }
    const message = cause instanceof Error ? cause.message : String(cause)
    const error = `批次提交失败（已整批回滚，未写入任何数据）：${message}`
    const items = plan.items.map((p) =>
      p.item.ok ? { ...p.item, ok: false, error: { code: 'commit_rolled_back', message: '整批回滚，本项未写入' } } : p.item,
    )
    db.update(schema.importBatch)
      .set({ status: 'failed', itemResults: items, summary: { written: 0, skipped: 0, failed: plan.items.length, evidenceRepointed: 0 }, error })
      .where(eq(schema.importBatch.id, batch.id))
      .run()
    return {
      batchId: batch.id,
      status: 'failed',
      summary: { written: 0, skipped: 0, failed: plan.items.length, evidenceRepointed: 0 },
      items: publicRosterImportItems(items, batch.id),
      error,
    }
  }

  const summary: StoredImportSummary = summarizeCommit(plan, items)
  if (platformFields) summary.platformFields = platformFields
  // This is inside recordImportReceipt's business transaction, after every write closure
  // succeeded and before either the batch or durable receipt JSON is saved.
  const qualificationReadback = request.sourceKind === 'announcement' ? captureAnnouncementQualification(db, request, items) : undefined
  if (qualificationReadback) summary.qualificationReadback = qualificationReadback
  if (request.sourceKind === 'announcement') summary.qualificationDiagnosticsByItem = captureAnnouncementDiagnostics(plan, items)
  db.update(schema.importBatch)
    .set({
      status: 'committed',
      itemResults: items,
      summary,
      error: null,
      committedAt: new Date().toISOString(),
      preflightResult: summarizePlan(plan),
    })
    .where(eq(schema.importBatch.id, batch.id))
    .run()
  return { batchId: batch.id, status: 'committed', summary, items: publicRosterImportItems(items, batch.id), error: null, ...(qualificationReadback ? { qualificationReadback } : {}) }
}

/** Keep replay snapshots in the batch ledger, but expose only caller-facing item details. */
export function publicRosterImportItems(items: readonly RosterImportItemResult[], batchId?: number): RosterImportItemResult[] {
  return items.map((item, itemIndex) => {
    if (!item.detail) return item
    const detail = { ...item.detail }
    const lineage = detail.lineage as MergeLineage | undefined
    if (Array.isArray(lineage?.recordsFolded) && lineage.recordsFolded.some(fold => isObject(fold) && (fold.fromRecordSnapshot !== undefined || fold.eventIds !== undefined))) {
      detail.lineage = { ...lineage, recordsFolded: lineage.recordsFolded.map(fold => { if (!isObject(fold)) return fold; const { fromRecordSnapshot: _snapshot, eventIds: _events, ...old } = fold; return old }), ...(batchId !== undefined ? { snapshotRef: { source: 'private_batch', batchId, itemIndex } } : {}) }
    }
    delete detail.evidenceRepointTargets
    delete detail.evidenceRepointPlanFingerprint
    if (Object.keys(detail).length === Object.keys(item.detail).length && detail.lineage === item.detail.lineage) return item
    const publicItem = { ...item }
    delete publicItem.detail
    return Object.keys(detail).length > 0 ? { ...publicItem, detail } : publicItem
  })
}

// ---------------------------------------------------------------------------
// 出处指针收敛的**重放**（RL-19，契约 §8.9.3）
// ---------------------------------------------------------------------------

/**
 * 收敛重放的记账键：`<原幂等键>#repoint`。
 *
 * 为什么不是原键：`import_batch.idempotency_key` 唯一，而原键那条批次已经 `committed`；
 * 重放是**同一个请求的第二次动作**，它既要能重复跑（可重试），又要留下自己的账目。
 * 派生键确定了这个派生是**确定性的** —— 同一份请求重放多少次都是同一行记账，
 * 且一眼能看出它是哪一批的收敛。
 */
export function replayBatchKey(idempotencyKey: string): string {
  return `${idempotencyKey}#repoint`
}

/** 从原提交批次读取目标快照；旧批次没有快照时返回 undefined，保留兼容重算路径。 */
export function evidenceRepointPlanFromItems(items: unknown, fingerprint: string): EvidenceRepointTarget[] | undefined {
  if (!Array.isArray(items)) return undefined
  let hasPlan = false
  let samePayload = true
  const targets: EvidenceRepointTarget[] = []
  for (const item of items) {
    if (!isObject(item) || !isObject(item.detail) || !Array.isArray(item.detail.evidenceRepointTargets)) continue
    hasPlan = true
    if (item.detail.evidenceRepointPlanFingerprint !== fingerprint) samePayload = false
    for (const raw of item.detail.evidenceRepointTargets) {
      if (!isObject(raw)) continue
      const { id, recordId, recordEventId, fromSourceFile, sourceFile } = raw
      if (
        typeof id === 'number' && Number.isInteger(id) &&
        typeof recordId === 'number' && Number.isInteger(recordId) &&
        typeof recordEventId === 'number' && Number.isInteger(recordEventId) &&
        typeof fromSourceFile === 'string' && typeof sourceFile === 'string'
      ) {
        targets.push({ id, recordId, recordEventId, fromSourceFile, sourceFile })
      }
    }
  }
  return hasPlan && samePayload ? targets : undefined
}

/**
 * **出处指针收敛重放**（RL-19，契约 §8.9.3）。
 *
 * ── 它解决的事 ──────────────────────────────────────────────────────────
 * 幂等键被**消费**之后（批次已 `committed`），同键的 `commit` 永远直接返回既有摘要、
 * 一行不写（§8.2 的幂等 —— 这个行为本身要保留）。于是「那次提交跑的是旧构建 / 载荷当时
 * 还指着库外路径」这类情况下，库里受影响的出处指针**再也没有路径能修回来**。
 * 本函数就是那条路径：**显式**地再跑一次收敛。
 *
 * ── 它不做什么（为什么可以放心重复跑）──────────────────────────────────
 *  - 收敛 `record_evidence.source_file`；目标为非 PDF 时同时清除无效 `page`：不新建企业/记录/事件/出处，不归并，不删行；
 *  - **只认既有**：库里没有的事件/记录一律跳过 —— 收敛不补历史（补历史请走 commit）；
 *  - 载荷里那些**会写新行**的类别（平台查询 / 别名 / 差异 / 快照 / 归并）根本**不进计划**
 *    （`convergeOnly`），故没有可执行的东西；
 *  - 幂等：指针已经收敛过之后，谓词不再命中 ⇒ `evidenceRepointed` 为 0。
 *
 * 计划与执行在同一次调用里先后发生、且之间没有别的写入 ⇒ 预算与实改必然一致
 * （`update` / `evidenceRepointed` 与预检的 `update` / `evidenceRepoints` 同口径）。
 */
function replayRosterImportCore(db: Db, request: RosterImportRequest): RosterImportReplayResponse {
  const originalBatch = findBatchByKey(db, request.idempotencyKey)
  const sameCommittedSourceIdentity =
    originalBatch?.status === 'committed' &&
    originalBatch.sourceKind === request.sourceKind &&
    originalBatch.sourceIdentity === request.sourceIdentity &&
    (originalBatch.sourceSha256 ?? null) === (request.sourceSha256 ?? null)
  const evidenceRepointTargets = sameCommittedSourceIdentity
    ? evidenceRepointPlanFromItems(originalBatch.itemResults, evidenceRepointPlanFingerprint(request))
    : undefined
  const batch = ensureBatchRow(db, { ...request, idempotencyKey: replayBatchKey(request.idempotencyKey) })
  const plan = planRosterImport(db, request, {
    batchId: batch.id,
    convergeOnly: true,
    evidenceRepointTargets,
  })
  const preflight = summarizePlan(plan)

  if (plan.conflicts.length > 0) {
    const items = plan.items.map((planned) => planned.item)
    const error = `收敛重放未执行：载荷有 ${plan.conflicts.length} 项不合法，未改动任何行`
    db.update(schema.importBatch)
      .set({
        status: 'failed',
        itemResults: items,
        summary: { written: 0, skipped: 0, failed: plan.conflicts.length, evidenceRepointed: 0 },
        preflightResult: preflight,
        error,
      })
      .where(eq(schema.importBatch.id, batch.id))
      .run()
    return { batchId: batch.id, status: 'failed', update: 0, evidenceRepointed: 0, items: publicRosterImportItems(items, batch.id), error }
  }

  // 只跑「有收敛可做」的那些项（`run` 只挂在这些项上）—— 其余项连闭包都没有。
  const items = db.transaction((tx) =>
    plan.items.map((planned) => (planned.run ? planned.run(tx) : planned.item)),
  )
  const evidenceRepointed = items.reduce((n, item) => n + (item.ok ? rowsRepointed(item) : 0), 0)
  // 计划口径的「将收敛」= 有执行闭包的那些项（其余项连闭包都没有）。
  const update = plan.items.filter((planned) => planned.run != null).length

  db.update(schema.importBatch)
    .set({
      status: 'committed',
      itemResults: items,
      summary: { written: 0, skipped: 0, failed: 0, evidenceRepointed },
      preflightResult: preflight,
      error: null,
      committedAt: new Date().toISOString(),
    })
    .where(eq(schema.importBatch.id, batch.id))
    .run()

  return { batchId: batch.id, status: 'replayed', update, evidenceRepointed, items: publicRosterImportItems(items, batch.id), error: null }
}

export function preflightRosterImport(db: Db, request: RosterImportRequest, pageCountErrors: readonly RosterImportItemResult[] = [], context: import('../../../core/lib/logging').LogContext & { filesDir?: string } = {}) {
  return recordImportReceipt(db, 'preflight', request, () => withFingerprintVerificationSnapshot(sqliteConnection(db), () => preflightRosterImportCore(db, request, pageCountErrors, context.filesDir)), context)
}
export function commitRosterImport(db: Db, request: RosterImportRequest, pageCountErrors: readonly RosterImportItemResult[] = [], options: import('../../../core/lib/logging').LogContext & { deferCandidateTasks?: boolean; filesDir?: string; reviewedAnnouncement?: ReviewedAnnouncementPlan } = {}) {
  const result = recordImportReceipt(db, 'commit', request, () => withFingerprintVerificationSnapshot(sqliteConnection(db), () => db.transaction(() => {
    const result = commitRosterImportCore(db, request, pageCountErrors, options.filesDir, options.reviewedAnnouncement)
    const candidateTaskIds = result.status === 'committed'
      ? enqueueArchivedCandidates(db, request.payload.platformQueries ?? [], '', options.deferCandidateTasks, options) : []
    return { ...result, candidateTaskIds }
  })), options)
  // The ledger has saved its immutable internal summary. Expose the capture only once,
  // at the response root; duplicating it in the public summary would double its byte budget.
  const { qualificationReadback: _storedCapture, qualificationDiagnosticsByItem: _storedDiagnostics, ...summary } = result.summary
  return { ...result, summary }
}
export function replayRosterImport(db: Db, request: RosterImportRequest, context: import('../../../core/lib/logging').LogContext = {}) {
  return recordImportReceipt(db, 'replay', request, () => replayRosterImportCore(db, request), context)
}

/**
 * `written` = 本次**真正插进库里的行数**；`skipped` = 命中的既有行/重复事件。
 *
 * 口径由**执行器自报**：每个成功的执行结果在 `detail.rowsWritten` 里给出它这次到底插了几行
 * （新企业 / 新记录 / 新事件 / 新关系 / 新源行…，重放时全为 0）。这里只做求和 ——
 * **不再按「执行过的项」逐项 +1**：那会把「完全重复、一行没写」的项也计进去，
 * 于是「同内容换幂等键重放」会报出 `written = 计划项数` 而库里零新增，违反 RL-11 验收
 * 「应用后可查询**已写入数量**」。没自报的项一律算 0（宁可少报，不可虚报）。
 */
function summarizeCommit(plan: Plan, items: RosterImportItemResult[]): RosterImportSummary {
  let written = 0
  let skipped = 0
  let evidenceRepointed = 0
  for (const item of items) {
    if (!item.ok) continue
    written += rowsWritten(item)
    evidenceRepointed += rowsRepointed(item)
    const itemSkipped = item.detail?.skipped
    if (typeof itemSkipped === 'number') skipped += itemSkipped
  }
  // 命中的既有行（计划里判为 skip 的项）计入 skipped。
  for (const planned of plan.items) {
    if (planned.action === 'skip' && planned.item.ok) skipped += 1
  }
  const projections = items.flatMap(item => (item.detail?.canonicalProjection as PlatformProjectionResult[] | undefined) ?? [])
  const canonicalProjection: PlatformProjectionSummary = { recordsCreated: 0, versionsCreated: 0, observationsCreated: 0, observationsReused: 0, missingKey: 0, conflict: 0, unverifiable: 0 }
  let applyProjectionsCreated = 0, applyProjectionsReused = 0
  let businessProjectionsCreated = 0, businessProjectionsReused = 0
  let recognizedProjectionsCreated = 0, recognizedProjectionsReused = 0
  let hasApplyProjection = false
  let hasBusinessProjection = false
  let hasRecognizedProjection = false
  for (const projection of projections) {
    canonicalProjection.recordsCreated += Number(projection.recordCreated)
    canonicalProjection.versionsCreated += Number(projection.versionCreated)
    canonicalProjection.observationsCreated += Number(projection.observationCreated)
    canonicalProjection.observationsReused += Number(!projection.observationCreated)
    canonicalProjection.missingKey += Number(projection.identityState === 'missing_key')
    canonicalProjection.conflict += Number(projection.identityState === 'conflict')
    canonicalProjection.unverifiable += Number(projection.contentState === 'unverifiable')
    if (projection.applyProjectionCreated !== undefined || projection.applyProjectionReused !== undefined) hasApplyProjection = true
    applyProjectionsCreated += Number(projection.applyProjectionCreated ?? 0)
    applyProjectionsReused += Number(projection.applyProjectionReused ?? 0)
    if (projection.businessProjectionCreated !== undefined || projection.businessProjectionReused !== undefined) hasBusinessProjection = true
    businessProjectionsCreated += Number(projection.businessProjectionCreated ?? 0)
    businessProjectionsReused += Number(projection.businessProjectionReused ?? 0)
    if (projection.recognizedProjectionCreated !== undefined || projection.recognizedProjectionReused !== undefined) hasRecognizedProjection = true
    recognizedProjectionsCreated += Number(projection.recognizedProjectionCreated ?? 0)
    recognizedProjectionsReused += Number(projection.recognizedProjectionReused ?? 0)
  }
  if (hasApplyProjection) {
    canonicalProjection.applyProjectionsCreated = applyProjectionsCreated
    canonicalProjection.applyProjectionsReused = applyProjectionsReused
  }
  if (hasBusinessProjection) {
    canonicalProjection.businessProjectionsCreated = businessProjectionsCreated
    canonicalProjection.businessProjectionsReused = businessProjectionsReused
  }
  if (hasRecognizedProjection) {
    canonicalProjection.recognizedProjectionsCreated = recognizedProjectionsCreated
    canonicalProjection.recognizedProjectionsReused = recognizedProjectionsReused
  }
  return { written, skipped, failed: 0, evidenceRepointed, ...(projections.length ? { canonicalProjection } : {}) }
}

/** 执行器自报的**真正插入行数**（见 `summarizeCommit`）；未自报算 0。 */
function rowsWritten(item: RosterImportItemResult): number {
  const value = item.detail?.rowsWritten
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0
}

/**
 * 执行器自报的**真正收敛的出处行数**（RL-16/RL-19）；未自报算 0。
 * 与 {@link rowsWritten} **分开**：收敛不是新增，不该进 `written`；但也不能不收账 ——
 * 「预检答应的行数」与「提交真改的行数」要对得上，靠的就是这个求和。
 */
function rowsRepointed(item: RosterImportItemResult): number {
  const value = item.detail?.evidenceRepointed
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0
}

// ---------------------------------------------------------------------------
// 往返一致性（写入后可用它查回「写了什么」）-------------------------------
// ---------------------------------------------------------------------------

/**
 * 读回 `import_batch.summary`，把**本票之前**提交的批次缺的 `evidenceRepointed` 补成 0。
 *
 * 摘要 JSON 是**当次**写下的：RL-19 引入 `evidenceRepointed` 之前提交的行里没有这一项，
 * 而类型里它是必填 —— 不补，调用方就会拿到 `undefined` 并静默算错。缺这一项恰好等价于
 * 「那一批没收敛过任何出处行」，所以补 0 是**事实**，不是猜测。没有摘要则返回 `null`
 * （预检批还没提交过，与既有口径一致）。
 */
export function readSummaryOf(raw: unknown): RosterImportSummary | null {
  if (!isObject(raw)) return null
  const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0)
  return {
    written: num(raw.written),
    skipped: num(raw.skipped),
    failed: num(raw.failed),
    evidenceRepointed: num(raw.evidenceRepointed),
    ...(isObject(raw.platformFields) ? { platformFields: raw.platformFields as unknown as RosterImportSummary['platformFields'] } : {}),
    ...(isObject(raw.canonicalProjection) ? { canonicalProjection: raw.canonicalProjection as unknown as PlatformProjectionSummary } : {}),
  }
}

/** 从批次行读出可查询的结果摘要（契约：`item_results` / `summary` 可查）。 */
export function readImportBatchOutcome(db: Db, idempotencyKey: string) {
  const batch = findBatchByKey(db, idempotencyKey)
  if (!batch) return null
  return {
    batchId: batch.id,
    status: batch.status,
    sourceKind: batch.sourceKind,
    sourceIdentity: batch.sourceIdentity,
    preflight: (batch.preflightResult as RosterImportPreflight | null) ?? null,
    // 与 `commitRosterImport` 的读回同一份补法：本票之前提交的批次没有 `evidenceRepointed`。
    summary: readSummaryOf(batch.summary),
    items: batch.itemResults == null
      ? null
      : publicRosterImportItems((batch.itemResults as RosterImportItemResult[] | null) ?? [], batch.id),
    /** 本次导入报出的重名候选（RL-14；计数 + 明细都在这里，见 {@link readDuplicateCandidates}）。 */
    duplicateCandidates: readDuplicateCandidates(db, idempotencyKey),
    error: batch.error,
    committedAt: batch.committedAt,
  }
}

/**
 * 取回某批**新建企业时发现的重名候选**（RL-14）。
 *
 * 候选写在 `import_batch.item_results` 里（`kind: 'duplicate_candidate'`），所以这里
 * 只做一次过滤 —— 与 {@link readMergeLineage} 同一口径：报告不是另存的一份，是批次结果本身。
 * 预检批（`status='preflight'`）没有 `item_results`，此时退回读 `preflight_result` 里的那一份。
 */
export function readDuplicateCandidates(db: Db, idempotencyKey: string): DuplicateNameCandidate[] {
  const batch = findBatchByKey(db, idempotencyKey)
  if (!batch) return []
  return duplicateCandidatesFromBatch(batch.itemResults as RosterImportItemResult[] | null, batch.preflightResult as RosterImportPreflight | null)
}

/** 取回某条 item 的归并血缘（`merges` 项）。 */
export function readMergeLineage(db: Db, idempotencyKey: string, fromEnterpriseId: number): MergeLineage | null {
  const items = (findBatchByKey(db, idempotencyKey)?.itemResults as RosterImportItemResult[] | null) ?? []
  for (const item of items) {
    const lineage = item.detail?.lineage as MergeLineage | undefined
    if (item.kind === 'merge' && lineage && lineage.fromEnterpriseId === fromEnterpriseId) return lineage
  }
  return null
}

/** 供测试/调用方按 id 直接取企业（验证归并后只剩规范行）。 */
export function enterpriseExists(db: Db, id: number): boolean {
  return findEnterpriseById(db, id) != null
}

/** 归并后按现名或曾用名搜索命中同一企业（契约 §5.1 的搜索口径：现名 + **已确认**曾用名）。 */
export function searchEnterpriseIdsByName(db: Db, raw: string): number[] {
  const norm = normalizeName(raw)
  const ids = new Set<number>()
  // 按名定位走与写入侧**同一个** `name_norm` 查找，不在这里再抄一份谓词（RL-18 收敛）。
  for (const e of findEnterprisesByNorm(db, norm)) ids.add(e.id)
  for (const a of db.select().from(schema.enterpriseAlias).all()) {
    if (a.nameNorm === norm && a.verificationStatus === 'confirmed') ids.add(a.enterpriseId)
  }
  return [...ids].sort((a, b) => a - b)
}

/** 表名 → 行数（测试与预检自检用；不含批次表）。 */
export function rosterRowCounts(db: Db): Record<string, number> {
  return {
    enterprise: db.select().from(schema.enterprise).all().length,
    record: db.select().from(schema.record).all().length,
    record_event: db.select().from(schema.recordEvent).all().length,
    record_evidence: db.select().from(schema.recordEvidence).all().length,
    enterprise_alias: db.select().from(schema.enterpriseAlias).all().length,
    platform_query: db.select().from(importPlatformTables(db).q).all().length,
    platform_relation: db.select().from(importPlatformTables(db).r).all().length,
    platform_export_batch: db.select().from(schema.platformExportBatch).all().length,
    platform_export_row: db.select().from(schema.platformExportRow).all().length,
    difference_reason: db.select().from(schema.differenceReason).all().length,
    source_document: db.select().from(schema.sourceDocument).all().length,
  }
}
