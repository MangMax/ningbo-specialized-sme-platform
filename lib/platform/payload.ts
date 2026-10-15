/**
 * 契约 §8.3 的**统一写入载荷**构造(RL-03)。
 *
 * 本模块只构造**载荷**,不碰数据库、不写 SQL —— 真正落库由 RL-11 的
 * `POST /api/roster/import/preflight|commit`(契约 §8)完成。这正是 SPEC
 * 「一切写入走应用公开 API」的要求:适配层产出 §8.3 形状,由统一批次 API 事务提交。
 *
 * ── 与冻结契约的关系 ─────────────────────────────────────────────────────
 * §8.3 已定义 `platformQueries` / `aliases` / `differences` 三段的形状,本模块照它产出。
 * 两处**增量扩展**(父代理澄清 C2 要求以 RL-11 为准协调):
 *  - `payload.merges[]` —— 「确认主体后的归并与回填」的显式写入形状(§5.2 只定义了语义);
 *  - `aliases[].sourceRelationRef` —— 用**自然键**指认来源关系(`queryKey`/`interface`/`rdjb`/
 *    `sequenceNo`)。`enterprise_alias.source_ref_id` 要的是 `platform_relation.id`,而该 id
 *    由写入侧在本批事务里生成,客户端构造时**不可能知道** —— 所以额外给一个可解析的自然键,
 *    `sourceRefId` 仍按契约填 `0`(「无具体来源行引用」哨兵)。
 *
 * ── 不猜填 ───────────────────────────────────────────────────────────────
 *  - `alias_name_raw` **恒为 null**(C1):平台没有「曾用名」列,不得把 `qymc` 复制进去充数;
 *  - 同名多主体 / 来源与目标统代不一致 ⇒ 别名**降级为 `pending`** 并带 `conflict` 说明,
 *    绝不自动回填;
 *  - 匹配依据只有 `uscc` / `alias` / `none`(没有模糊打分);`manual` 由人工在别处给出。
 */
import { createHash } from 'node:crypto'
import { normalizeName } from '../domain'
import type { ComparisonDirection } from '../comparison'
import type {
  PlatformQueryOutcome,
} from './client'
import {
  type PlatformRelationRecord,
  relationFromRow,
} from './identity'

// ---------------------------------------------------------------------------
// 输入
// ---------------------------------------------------------------------------

/** 已登记企业(用于判定关系的匹配依据)。 */
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

/** 代理确认过的曾用名来源关系(自然键)。 */
export interface RelationRef {
  queryKey: string
  interface: 'business_list' | 'apply_list'
  rdjb: string
  sequenceNo: number
}

export interface AliasDecision {
  /** 归属企业;给 `enterpriseName` 亦可(按名解析)。 */
  enterpriseId?: number
  enterpriseName?: string
  /** 别名原值(来源里的写法)。 */
  name: string
  sourceKind: 'platform_business' | 'platform_apply' | 'announcement' | 'manual'
  /** 来源关系(自然键);写入侧解析成 `platform_relation.id`。 */
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
  /** 被并方的名称,写成规范行的曾用名(旧名不丢,§5.2 第 2 步)。 */
  aliasName: string
  sourceRefId?: number
  evidenceQueryId?: number
}

export interface BuildPayloadInput {
  /** 来源身份:文件相对路径 / 逻辑标识(**不含凭证**)。 */
  sourceIdentity: string
  /** 源文件内容 SHA-256;给不出留空。 */
  sourceSha256?: string
  /** 幂等键;缺省由来源身份 + 查询集合派生(同来源重放给同一个值)。 */
  idempotencyKey?: string
  queries: PlatformQueryInput[]
  enterprises: KnownEnterprise[]
  aliases?: AliasDecision[]
  differences?: DifferenceDecision[]
  merges?: MergeDecision[]
}

// ---------------------------------------------------------------------------
// 输出(§8.3 形状)
// ---------------------------------------------------------------------------

export interface RelationWriteItem {
  sequenceNo: number
  relationKey: string | null
  usccRaw: string | null
  nameRaw: string | null
  /** 契约 §1.4:源文本中明确给出的曾用名。平台没有此列 ⇒ **恒为 null**(C1)。 */
  aliasNameRaw: null
  province: string | null
  status: string | null
  batch: string | null
  declareKind: string | null
  appliedAt: string | null
  awardBatchLabel: string | null
  year: number | null
  matchBasis: 'uscc' | 'alias' | 'manual' | 'none'
  verificationStatus: 'confirmed' | 'pending'
  rawFields: Record<string, string>
  sourceText: string | null
}

export interface PlatformQueryWriteItem {
  interface: 'business_list' | 'apply_list'
  queryKey: string
  rdjb: string
  titleCode: string | null
  queriedAt: string
  status: 'success' | 'no_record' | 'failed'
  failureReason: string | null
  rawResponse: string | null
  relations?: RelationWriteItem[]
}

export interface AliasWriteItem {
  enterpriseName: string
  uscc: string | null
  name: string
  sourceKind: AliasDecision['sourceKind']
  sourceRefId: number
  verificationStatus: 'confirmed' | 'pending'
  validFrom: string | null
  note?: string | null
  /** C2 增量:来源关系自然键,供写入侧解析成 `platform_relation.id`。 */
  sourceRelationRef?: RelationRef
  /** 被降级为待核的原因(同名多主体 / 来源与目标统代不符)。 */
  conflict?: { code: 'ambiguous_subject'; usccs: string[]; note: string }
}

export interface DifferenceWriteItem {
  enterpriseId: number
  titleCode: string
  direction: ComparisonDirection
  status: DifferenceStatus
  reasonCode: DifferenceReasonCode | null
  reasonNote: string | null
  measureCode: DifferenceMeasureCode | null
  measureNote: string | null
  evidenceQueryId: number | null
  evidenceRelationId: number | null
  movedIn: { city: string | null; titleCode: string | null; year: number | null; batch: number | null } | null
  verificationStatus: 'confirmed' | 'pending'
  recordedAt: string
}

export interface MergeWriteItem {
  fromEnterpriseId: number | null
  fromEnterpriseName: string | null
  intoUscc: string
  aliasName: string
  sourceRefId: number
  evidenceQueryId: number
}

export interface PlatformWritePayload {
  platformQueries: PlatformQueryWriteItem[]
  aliases?: AliasWriteItem[]
  differences?: DifferenceWriteItem[]
  merges?: MergeWriteItem[]
}

/** 契约 §8.1/§8.2 的请求体(预检与提交共用)。 */
export interface PlatformWriteRequest {
  idempotencyKey: string
  sourceKind: 'alias_evidence'
  sourceIdentity: string
  /** 源文件内容 SHA-256;平台证据给不出时留空(契约 §8.1 允许)。 */
  sourceSha256?: string
  payload: PlatformWritePayload
}

// ---------------------------------------------------------------------------
// 构造
// ---------------------------------------------------------------------------

function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16)
}

/**
 * 缺省幂等键:来源身份 + **查询集合**(接口/键/rdjb,排序后)。
 * 由它派生而非按 `Date.now()` —— 同一来源重复调用必须给同一个值,否则重放会重复写。
 * 需要把同来源拆成多批(如后续追加解释)时,由调用方显式传 `idempotencyKey`。
 */
export function defaultPlatformIdempotencyKey(input: Pick<BuildPayloadInput, 'sourceIdentity' | 'queries'>): string {
  const queries = input.queries
    .map((q) => `${q.interface}|${q.queryKey}|${q.rdjb}`)
    .sort()
    .join('\n')
  return `alias_evidence:${input.sourceIdentity}#${shortHash(queries)}`
}

/** 收集全部关系(带查询身份),供匹配与冲突判定使用。 */
function collectRelations(queries: PlatformQueryInput[]): { query: PlatformQueryInput; relation: PlatformRelationRecord }[] {
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

function resolveEnterpriseId(
  decision: Pick<AliasDecision, 'enterpriseId' | 'enterpriseName'>,
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
 * 别名决策 → 写入项。**同名多主体 / 来源与目标统代不一致时降级为 `pending`**:
 * 决策里写的 `confirmed` 不会被照单全收 —— 冲突必须先由人解决。
 */
function toAliasItem(
  decision: AliasDecision,
  enterprises: KnownEnterprise[],
  all: { query: PlatformQueryInput; relation: PlatformRelationRecord }[],
): AliasWriteItem {
  const enterprise = resolveEnterpriseId(decision, enterprises)
  const evidence = all.filter(({ relation }) => relation.nameRaw === decision.name)
  const usccs = [...new Set(evidence.map(({ relation }) => relation.usccRaw).filter(Boolean))] as string[]

  // 三种「不能确认」都降级为待核:目标企业解析不到 / 同名多主体 / 来源统代与目标不一致。
  const unresolved = enterprise == null
  const mismatch = enterprise?.uscc != null && usccs.some((uscc) => uscc !== enterprise.uscc)
  const ambiguous = usccs.length > 1
  const conflict = unresolved || ambiguous || mismatch

  const item: AliasWriteItem = {
    enterpriseName: enterprise?.name ?? decision.enterpriseName ?? '',
    uscc: enterprise?.uscc ?? usccs[0] ?? null,
    name: decision.name,
    sourceKind: decision.sourceKind,
    sourceRefId: decision.sourceRefId ?? 0,
    verificationStatus: conflict ? 'pending' : (decision.verificationStatus ?? 'confirmed'),
    validFrom: decision.validFrom ?? null,
    note: decision.note ?? null,
  }
  if (decision.sourceRelation) item.sourceRelationRef = decision.sourceRelation
  if (conflict) {
    item.conflict = {
      code: 'ambiguous_subject',
      usccs,
      note: unresolved
        ? '归属企业无法确定(未给出可解析的企业 id / 名称),不自动回填'
        : ambiguous
          ? `同一名称出现在 ${usccs.length} 个统一社会信用代码下,不自动归并`
          : '来源统代与目标企业统代不一致,不自动回填',
    }
  }
  return item
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
): Pick<RelationWriteItem, 'matchBasis' | 'verificationStatus'> {
  if (relation.usccRaw) {
    const byUscc = enterprises.find((e) => e.uscc != null && e.uscc === relation.usccRaw)
    if (byUscc) return { matchBasis: 'uscc', verificationStatus: 'confirmed' }
  }
  if (relation.nameRaw) {
    const byAlias = confirmedAliasNames.get(normalizeName(relation.nameRaw))
    if (byAlias) return { matchBasis: 'alias', verificationStatus: 'confirmed' }
  }
  return { matchBasis: 'none', verificationStatus: 'pending' }
}

function toRelationItem(
  relation: PlatformRelationRecord,
  match: Pick<RelationWriteItem, 'matchBasis' | 'verificationStatus'>,
): RelationWriteItem {
  return {
    sequenceNo: relation.sequenceNo,
    relationKey: relation.relationKey,
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
    ...match,
    rawFields: relation.rawFields,
    sourceText: null,
  }
}

/** 构造契约 §8.1/§8.2 的完整请求体(预检与提交共用同一份 payload)。 */
export function buildPlatformWritePayload(input: BuildPayloadInput): PlatformWriteRequest {
  const all = collectRelations(input.queries)
  const enterprises = input.enterprises

  const aliasItems = (input.aliases ?? []).map((decision) =>
    toAliasItem(decision, enterprises, all),
  )
  // 只有 `confirmed` 的别名参与「按曾用名匹配」——`pending` 不参与(契约 §1.2)。
  const confirmedAliasNames = new Map<string, KnownEnterprise>()
  for (const item of aliasItems) {
    if (item.verificationStatus !== 'confirmed') continue
    const enterprise = enterprises.find(
      (e) => e.name === item.enterpriseName && (item.uscc == null || e.uscc === item.uscc),
    )
    if (enterprise) confirmedAliasNames.set(normalizeName(item.name), enterprise)
  }

  const platformQueries: PlatformQueryWriteItem[] = input.queries.map((query) => ({
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

  const differences: DifferenceWriteItem[] = (input.differences ?? []).map((decision) => ({
    enterpriseId: decision.enterpriseId,
    titleCode: decision.titleCode,
    direction: decision.direction,
    status: decision.status,
    reasonCode: decision.reasonCode ?? null,
    reasonNote: decision.reasonNote ?? null,
    measureCode: decision.measureCode ?? null,
    measureNote: decision.measureNote ?? null,
    evidenceQueryId: decision.evidenceQueryId ?? null,
    evidenceRelationId: decision.evidenceRelationId ?? null,
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
  }))

  const merges: MergeWriteItem[] = (input.merges ?? []).map((decision) => ({
    fromEnterpriseId: decision.fromEnterpriseId ?? null,
    fromEnterpriseName: decision.fromEnterpriseName ?? null,
    intoUscc: decision.intoUscc,
    aliasName: decision.aliasName,
    sourceRefId: decision.sourceRefId ?? 0,
    evidenceQueryId: decision.evidenceQueryId ?? 0,
  }))

  return {
    idempotencyKey: input.idempotencyKey ?? defaultPlatformIdempotencyKey(input),
    sourceKind: 'alias_evidence',
    sourceIdentity: input.sourceIdentity,
    ...(input.sourceSha256 ? { sourceSha256: input.sourceSha256 } : {}),
    payload: {
      platformQueries,
      ...(input.aliases?.length ? { aliases: aliasItems } : {}),
      ...(input.differences?.length ? { differences } : {}),
      ...(input.merges?.length ? { merges } : {}),
    },
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
