/**
 * 契约 §8.3 的**统一写入载荷**构造(RL-03)。
 *
 * 本模块只构造**载荷**,不碰数据库、不写 SQL —— 真正落库由 RL-11 的
 * `POST /api/roster/import/{preflight,commit}`(契约 §8)完成。这正是 SPEC
 * 「一切写入走应用公开 API」的要求:适配层产出 §8.3 形状,由统一批次 API 事务提交。
 *
 * ── 形状的**唯一来源**是 RL-11 的契约类型 ────────────────────────────────
 * 本模块**不再自定义** payload 类型,而是直接产出 `lib/roster-import-client.ts` 里的
 * `RosterImportPayload` / `RosterImportRequest`(`platformQueries` / `aliases` /
 * `differences` / `merges` 四段)。RL-11 的 `validateImportRequest` 就是按那组类型收的,
 * 两边共用一个定义 ⇒ 不存在「我按临时约定发的、写入侧不认」的漂移。
 *
 * ── 三处**必须遵守**的既有口径 ───────────────────────────────────────────
 *  - `alias_name_raw` **恒为 null**(父代理澄清 C1):平台没有「曾用名」列,
 *    不得把 `qymc` 复制进去充数。曾用名由**同一 `tyshxydm` 下 `qymc` 不同**的关系行承载。
 *  - 差异项与别名项的**归属用 `enterpriseName` / `uscc`**(写入侧按归一化名或统代解析),
 *    不是 `enterpriseId` —— 这样「同一批先建企业、再引用它」也合法(契约 §8.3 的形状即按此序)。
 *  - 不能确认的候选**降级为 `pending`**:同名多主体 / 来源与目标统代不符 / 归属企业解析不到。
 *    软件不猜、不自动回填;原因写进 `note`,不新增契约里没有的字段。
 *
 * ── 关系证据怎么指认(`sourceRelationRef` / `evidenceQueryRef`)──────────────
 * `enterprise_alias.source_ref_id` 与 `difference_reason.evidence_query_id` 是**整数**行 id,
 * 而 `platform_query` / `platform_relation` 的 id 由写入侧在**本批事务内**生成 —— 客户端构造
 * 载荷时不可能预知。契约 §8.7 为此补了**批内自然键引用**:`sourceRelationRef` /
 * `evidenceQueryRef` / `evidenceRelationRef` 直接用
 * `(interface, queryKey, rdjb, queriedAt, sequenceNo)` 指认,写入侧在**同一批**里解析成真 id。
 * ⇒ 「查询 → 关系 → 别名/差异证据」**一个批次**就能写完,不必拆两批。
 *
 * 两条通路并存,优先级明确:
 *   ① 传了 {@link BuildPayloadInput.refs} 且解析到了 id ⇒ 发**裸 id**(§8.7.4 的兼容写法);
 *   ② 否则有自然键 ⇒ 发**自然键引用**(绝不同时发两者 —— 写入侧会把「都给了」判为
 *      `source_ref_conflict` / `evidence_ref_conflict`,不静默取一个);
 *   ③ 两者都没有 ⇒ 退回契约 §1.2 的 `0` 哨兵(「无具体来源行引用」),绝不填假 id。
 */

/** 关系/查询的**自然键** → 契约 §8.7.1 的 `RosterPlatformRef` 形状。 */
function toPlatformRef(
  ref: { interface: 'business_list' | 'apply_list'; queryKey: string; rdjb: string; queriedAt?: string; sequenceNo?: number },
  withSequence: boolean,
): RosterPlatformRef {
  return {
    interface: ref.interface,
    queryKey: ref.queryKey,
    rdjb: ref.rdjb,
    ...(ref.queriedAt ? { queriedAt: ref.queriedAt } : {}),
    ...(withSequence ? { sequenceNo: ref.sequenceNo } : {}),
  }
}
import { createHash } from 'node:crypto'
import { normalizeName } from '../domain'
import type { ComparisonDirection } from '../comparison'
import type {
  RosterImportAlias,
  RosterImportDifference,
  RosterImportMerge,
  RosterImportPayload,
  RosterImportPlatformQuery,
  RosterImportRelation,
  RosterImportRequest,
  RosterPlatformRef,
} from '../roster-import-client'
import type { PlatformQueryOutcome } from './client'
import { type PlatformRelationRecord, relationFromRow } from './identity'

// ---------------------------------------------------------------------------
// 输入
// ---------------------------------------------------------------------------

/** 已登记企业(用于判定关系的匹配依据与解析归属)。 */
export interface KnownEnterprise {
  id: number
  name: string
  nameNorm?: string
  uscc: string | null
}

/** 一次平台查询的输入:身份(§1.3 唯一键前缀)+ 已归类的响应。 */
export interface PlatformQueryInput {
  interface: 'business_list' | 'apply_list'
  queryKey: string
  rdjb: string
  queriedAt: string
  outcome: PlatformQueryOutcome
  titleCode?: string | null
}

/** 平台关系的**自然键**:写入侧在本批事务内才生成行 id,客户端只能先用它指认。 */
export interface RelationRef {
  queryKey: string
  interface: 'business_list' | 'apply_list'
  rdjb: string
  sequenceNo: number
  /**
   * 查询时点。**给了就精确匹配那一次查询**(契约 §8.7.2)——同一
   * `(interface, queryKey, rdjb)` 查过多次时,不给就会命中多次而报 `*_ref_ambiguous`。
   */
  queriedAt?: string
}

export interface AliasDecision {
  /** 归属企业;给 `enterpriseName` 亦可(写入侧按归一化名解析)。 */
  enterpriseId?: number
  enterpriseName?: string
  /** 别名原值(来源里的写法)。 */
  name: string
  sourceKind: 'platform_business' | 'platform_apply' | 'announcement' | 'manual'
  /** 来源关系(自然键);有 {@link BuildPayloadInput.refs} 时解析成真 id。 */
  sourceRelation?: RelationRef
  /** 已知的真实关系 id;未知时留空(契约 §1.2 的 `0` 哨兵)。 */
  sourceRefId?: number
  validFrom?: string | null
  note?: string | null
  verificationStatus?: 'confirmed' | 'pending'
}

export type DifferenceReasonCode =
  | 'moved_out'
  | 'deregistered'
  | 'renamed'
  | 'platform_stale'
  | 'moved_in'
  | 'other'

export type DifferenceMeasureCode =
  | 'keep_history'
  | 'mark_platform_snapshot'
  | 'mark_moved_out'
  | 'mark_deregistered'
  | 'update_current_name'
  | 'record_moved_in'
  | 'manual_review'
  | 'none'

export type DifferenceStatus =
  | 'not_queried'
  | 'query_failed'
  | 'no_record'
  | 'confirmed_no_diff'
  | 'confirmed_reason'
  | 'needs_review'

export interface DifferenceDecision {
  enterpriseId: number
  titleCode: string
  direction: ComparisonDirection
  status: DifferenceStatus
  reasonCode?: DifferenceReasonCode | null
  reasonNote?: string | null
  measureCode?: DifferenceMeasureCode | null
  measureNote?: string | null
  /** 证据:平台查询 / 平台关系。自然键见 {@link DifferenceDecision.evidenceRelation}。 */
  evidenceQuery?: { interface: 'business_list' | 'apply_list'; queryKey: string; rdjb: string; queriedAt?: string }
  evidenceRelation?: RelationRef
  evidenceQueryId?: number | null
  evidenceRelationId?: number | null
  /** 迁入承载;缺项留空待核(§1.5)。 */
  movedIn?: {
    city?: string | null
    titleCode?: string | null
    year?: number | null
    batch?: number | null
  } | null
  verificationStatus?: 'confirmed' | 'pending'
  recordedAt: string
}

export interface MergeDecision {
  fromEnterpriseId?: number
  fromEnterpriseName?: string
  /** 规范行已有的统一社会信用代码(被并方回填到它)。 */
  intoUscc: string
  /** 被并方的名称,写成规范行的曾用名(旧名不丢,§5.2 第 2 步);不给则用被并企业现名。 */
  aliasName?: string
  sourceKind?: 'platform_business' | 'platform_apply' | 'announcement' | 'manual'
  sourceRelation?: RelationRef
  sourceRefId?: number
  evidenceQuery?: { interface: 'business_list' | 'apply_list'; queryKey: string; rdjb: string; queriedAt?: string }
  evidenceQueryId?: number | null
  note?: string | null
}

export interface BuildPayloadInput {
  /** 来源身份:文件相对路径 / 逻辑标识(**不含凭证**)。 */
  sourceIdentity: string
  /** 源文件内容 SHA-256;给不出留空。 */
  sourceSha256?: string
  /** 幂等键;缺省由**载荷内容**派生(同内容重放给同一个值)。 */
  idempotencyKey?: string
  queries: PlatformQueryInput[]
  enterprises: KnownEnterprise[]
  aliases?: AliasDecision[]
  differences?: DifferenceDecision[]
  merges?: MergeDecision[]
  /**
   * 把自然键换成**已落库**的行 id(先写查询、读回 id 后再写别名/差异/归并时用)。
   * 不提供时退回 `0` 哨兵与 `null`,绝不填假 id。
   */
  refs?: {
    relationIdOf?: (ref: RelationRef) => number | null | undefined
    queryIdOf?: (ref: { interface: 'business_list' | 'apply_list'; queryKey: string; rdjb: string }) => number | null | undefined
  }
}

// ---------------------------------------------------------------------------
// 构造
// ---------------------------------------------------------------------------

function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16)
}

/**
 * 缺省幂等键:**来源身份 + 载荷内容**的哈希。
 *
 * 由内容派生(而不是 `Date.now()`)⇒ 同一来源、同一内容的重复调用给同一个键,重放不重复写;
 * 内容不同(如「先写查询、再补别名与归并」的第二批)自然得到**另一个**键,两批各自幂等。
 * 需要覆盖这个行为时由调用方显式传 `idempotencyKey`。
 */
export function defaultPlatformIdempotencyKey(input: {
  sourceIdentity: string
  payload: RosterImportPayload
}): string {
  return `alias_evidence:${input.sourceIdentity}#sha256:${shortHash(JSON.stringify(input.payload))}`
}

/** 收集全部关系(带查询身份与**同查询内的**序号),供匹配与冲突判定使用。 */
function collectRelations(
  queries: PlatformQueryInput[],
): { query: PlatformQueryInput; relation: PlatformRelationRecord }[] {
  return queries.flatMap((query) =>
    query.outcome.rows.map((row, index) => ({
      query,
      relation: relationFromRow(row, {
        interface: query.interface,
        rdjb: query.rdjb,
        queryKey: query.queryKey,
        sequenceNo: index + 1,
      }),
    })),
  )
}

function resolveEnterprise(
  decision: { enterpriseId?: number; enterpriseName?: string },
  enterprises: KnownEnterprise[],
): KnownEnterprise | null {
  if (decision.enterpriseId != null) {
    return enterprises.find((e) => e.id === decision.enterpriseId) ?? null
  }
  if (decision.enterpriseName) {
    const norm = normalizeName(decision.enterpriseName)
    return enterprises.find((e) => (e.nameNorm ?? normalizeName(e.name)) === norm) ?? null
  }
  return null
}

/**
 * 关系匹配依据(证据驱动,无模糊打分):
 *  1. 关系统代命中已登记企业 ⇒ `uscc` + `confirmed`;
 *  2. 否则名字命中某企业的**已确认别名** ⇒ `alias` + `confirmed`;
 *  3. 否则 `none` + `pending`(待核实,不自动归属)。
 */
function matchRelation(
  relation: PlatformRelationRecord,
  enterprises: KnownEnterprise[],
  confirmedAliasNames: Map<string, KnownEnterprise>,
): { enterpriseId: number | null; matchBasis: 'uscc' | 'alias' | 'none'; verificationStatus: 'confirmed' | 'pending' } {
  if (relation.usccRaw) {
    const byUscc = enterprises.find((e) => e.uscc != null && e.uscc === relation.usccRaw)
    if (byUscc) return { enterpriseId: byUscc.id, matchBasis: 'uscc', verificationStatus: 'confirmed' }
  }
  if (relation.nameRaw) {
    const byAlias = confirmedAliasNames.get(normalizeName(relation.nameRaw))
    if (byAlias) return { enterpriseId: byAlias.id, matchBasis: 'alias', verificationStatus: 'confirmed' }
  }
  return { enterpriseId: null, matchBasis: 'none', verificationStatus: 'pending' }
}

function toRelationItem(
  relation: PlatformRelationRecord,
  match: ReturnType<typeof matchRelation>,
): RosterImportRelation {
  return {
    sequenceNo: relation.sequenceNo,
    relationKey: relation.relationKey,
    enterpriseId: match.enterpriseId,
    usccRaw: relation.usccRaw,
    nameRaw: relation.nameRaw,
    // C1:平台没有独立的「曾用名」列 —— 绝不把 qymc 复制进 alias_name_raw 充数。
    aliasNameRaw: null,
    province: relation.province,
    status: relation.status,
    batch: relation.batch,
    declareKind: relation.declareKind,
    appliedAt: relation.appliedAt,
    awardBatchLabel: relation.awardBatchLabel,
    year: relation.year,
    matchBasis: match.matchBasis,
    verificationStatus: match.verificationStatus,
    rawFields: relation.rawFields,
  }
}

/** 证据指针的两种写法:**恰给其一**(同给会被写入侧判 `*_ref_conflict`)。 */
type RelationRefFields = { sourceRefId?: number; sourceRelationRef?: RosterPlatformRef }

/**
 * 别名/归并的**来源关系**指针。
 * 有自然键就发自然键(指向**本批新建**的关系行);传了 `refs` 且解析到 id 才发裸 id。
 */
function relationRefFields(
  input: BuildPayloadInput,
  decision: { sourceRelation?: RelationRef; sourceRefId?: number },
): RelationRefFields {
  const relation = decision.sourceRelation
  if (relation) {
    const resolved = input.refs?.relationIdOf?.(relation)
    if (resolved != null) return { sourceRefId: resolved }
    return { sourceRelationRef: toPlatformRef(relation, true) }
  }
  return { sourceRefId: decision.sourceRefId ?? 0 }
}

/** 差异项的**查询证据**指针。 */
function queryRefFields(
  input: BuildPayloadInput,
  decision: {
    evidenceQuery?: { interface: 'business_list' | 'apply_list'; queryKey: string; rdjb: string; queriedAt?: string }
    evidenceQueryId?: number | null
  },
): { evidenceQueryId?: number | null; evidenceQueryRef?: RosterPlatformRef } {
  const query = decision.evidenceQuery
  if (query) {
    const resolved = input.refs?.queryIdOf?.(query)
    if (resolved != null) return { evidenceQueryId: resolved }
    return { evidenceQueryRef: toPlatformRef(query, false) }
  }
  return { evidenceQueryId: decision.evidenceQueryId ?? null }
}

/** 差异项的**关系证据**指针。 */
function relationEvidenceFields(
  input: BuildPayloadInput,
  decision: { evidenceRelation?: RelationRef; evidenceRelationId?: number | null },
): { evidenceRelationId?: number | null; evidenceRelationRef?: RosterPlatformRef } {
  const relation = decision.evidenceRelation
  if (relation) {
    const resolved = input.refs?.relationIdOf?.(relation)
    if (resolved != null) return { evidenceRelationId: resolved }
    return { evidenceRelationRef: toPlatformRef(relation, true) }
  }
  return { evidenceRelationId: decision.evidenceRelationId ?? null }
}

/**
 * 别名决策 → 契约 §8.3 的 `aliases[]` 项。
 * **同名多主体 / 来源与目标统代不符 / 归属企业解析不到 ⇒ 一律降级 `pending`**:
 * 决策里写的 `confirmed` 不会被照单全收 —— 冲突必须先由人解决(原因落在 `note`)。
 */
function toAliasItem(
  input: BuildPayloadInput,
  decision: AliasDecision,
  enterprises: KnownEnterprise[],
  all: { query: PlatformQueryInput; relation: PlatformRelationRecord }[],
): RosterImportAlias {
  const enterprise = resolveEnterprise(decision, enterprises)
  const evidence = all.filter(({ relation }) => relation.nameRaw === decision.name)
  const usccs = [...new Set(evidence.map(({ relation }) => relation.usccRaw).filter(Boolean))] as string[]

  const unresolved = enterprise == null
  const mismatch = enterprise?.uscc != null && usccs.some((uscc) => uscc !== enterprise.uscc)
  const ambiguous = usccs.length > 1
  const conflict = unresolved || ambiguous || mismatch

  const reason = unresolved
    ? '归属企业无法确定(未给出可解析的企业 id / 名称),不自动回填'
    : ambiguous
      ? `同一名称出现在 ${usccs.length} 个统一社会信用代码下,不自动归并`
      : mismatch
        ? '来源统代与目标企业统代不一致,不自动回填'
        : null

  return {
    enterpriseName: enterprise?.name ?? decision.enterpriseName,
    uscc: enterprise?.uscc ?? usccs[0] ?? null,
    name: decision.name,
    sourceKind: decision.sourceKind,
    ...relationRefFields(input, decision),
    verificationStatus: conflict ? 'pending' : (decision.verificationStatus ?? 'confirmed'),
    validFrom: decision.validFrom ?? null,
    note: reason ? [decision.note, reason].filter(Boolean).join(' —— ') : (decision.note ?? null),
  }
}

/** 构造契约 §8.1/§8.2 的完整请求体(预检与提交共用同一份 payload)。 */
export function buildPlatformWritePayload(input: BuildPayloadInput): RosterImportRequest {
  const all = collectRelations(input.queries)
  const enterprises = input.enterprises

  const aliasItems = (input.aliases ?? []).map((decision) => toAliasItem(input, decision, enterprises, all))
  // 只有 `confirmed` 的别名参与「按曾用名匹配」——`pending` 不参与(契约 §1.2)。
  const confirmedAliasNames = new Map<string, KnownEnterprise>()
  for (const item of aliasItems) {
    if (item.verificationStatus !== 'confirmed') continue
    const enterprise = enterprises.find(
      (e) => e.name === item.enterpriseName && (item.uscc == null || e.uscc === item.uscc),
    )
    if (enterprise) confirmedAliasNames.set(normalizeName(item.name), enterprise)
  }

  const platformQueries: RosterImportPlatformQuery[] = input.queries.map((query) => ({
    interface: query.interface,
    queryKey: query.queryKey,
    rdjb: query.rdjb,
    titleCode: query.titleCode ?? null,
    queriedAt: query.queriedAt,
    status: query.outcome.status,
    failureReason: query.outcome.failureReason,
    rawResponse: query.outcome.raw || null,
    relations: all
      .filter((entry) => entry.query === query)
      .map((entry) => toRelationItem(entry.relation, matchRelation(entry.relation, enterprises, confirmedAliasNames))),
  }))

  // 差异项的归属用 `enterpriseName` / `uscc`(写入侧按归一化名或统代解析)。
  const differences: RosterImportDifference[] = (input.differences ?? []).map((decision) => {
    const enterprise = resolveEnterprise({ enterpriseId: decision.enterpriseId }, enterprises)
    return {
      enterpriseName: enterprise?.name,
      uscc: enterprise?.uscc ?? null,
      titleCode: decision.titleCode,
      direction: decision.direction,
      status: decision.status,
      reasonCode: decision.reasonCode ?? null,
      reasonNote: decision.reasonNote ?? null,
      measureCode: decision.measureCode ?? null,
      measureNote: decision.measureNote ?? null,
      ...queryRefFields(input, decision),
      ...relationEvidenceFields(input, decision),
      movedIn: decision.movedIn
        ? {
            city: decision.movedIn.city ?? null,
            titleCode: decision.movedIn.titleCode ?? null,
            year: decision.movedIn.year ?? null,
            batch: decision.movedIn.batch ?? null,
          }
        : null,
      verificationStatus: decision.verificationStatus ?? 'pending',
      recordedAt: decision.recordedAt,
    }
  })

  // 归并项:`fromEnterpriseId` 与 `fromEnterpriseName` **恰给其一**(契约 §8.4)。
  const merges: RosterImportMerge[] = (input.merges ?? []).map((decision) => {
    const base: RosterImportMerge = {
      intoUscc: decision.intoUscc,
      aliasName: decision.aliasName,
      sourceKind: decision.sourceKind,
      ...relationRefFields(input, decision),
      ...queryRefFields(input, decision),
      note: decision.note ?? null,
    }
    return decision.fromEnterpriseId != null
      ? { ...base, fromEnterpriseId: decision.fromEnterpriseId }
      : { ...base, fromEnterpriseName: decision.fromEnterpriseName }
  })

  const payload: RosterImportPayload = {
    platformQueries,
    ...(input.aliases?.length ? { aliases: aliasItems } : {}),
    ...(input.differences?.length ? { differences } : {}),
    ...(input.merges?.length ? { merges } : {}),
  }

  return {
    idempotencyKey: input.idempotencyKey ?? defaultPlatformIdempotencyKey({ sourceIdentity: input.sourceIdentity, payload }),
    sourceKind: 'alias_evidence',
    sourceIdentity: input.sourceIdentity,
    ...(input.sourceSha256 ? { sourceSha256: input.sourceSha256 } : {}),
    payload,
  }
}

/**
 * 回归案例的候选曾用名 → 别名决策(证据齐备但**仍需人确认**时才调用)。
 * 单独一个工厂是为了让「候选 → 决策」这一步在代码里显式可见:
 * 它接收的是**已经确认过**的候选,不在这里做任何判断。
 */
export function aliasDecisionFromCandidate(
  enterpriseId: number,
  candidate: { name: string; sourceKind: AliasDecision['sourceKind']; relations: PlatformRelationRecord[]; validFrom: string | null },
  note?: string,
): AliasDecision {
  const first = candidate.relations[0]
  return {
    enterpriseId,
    name: candidate.name,
    sourceKind: candidate.sourceKind,
    sourceRelation: first
      ? {
          queryKey: first.usccRaw ?? '',
          interface: first.interface,
          rdjb: first.rdjb,
          sequenceNo: first.sequenceNo,
        }
      : undefined,
    validFrom: candidate.validFrom,
    note: note ?? null,
    verificationStatus: 'confirmed',
  }
}
