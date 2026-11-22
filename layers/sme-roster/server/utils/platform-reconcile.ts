/**
 * 批量采集平台查询与关系，经统一导入路径保存证据和待核处理状态。
 * 原因、迁移方向、曾用名和归并由代理/用户查证后显式提交。
 * 本任务按USCC查询四个槽位；缺码目标交给名称搜索流程，不代表平台不支持名称查询。
 */

import { createHash } from 'node:crypto'
import type { platformCollection as PlatformCollectionTable } from '../../../../db/postgresql/platform-tables'
import type { ComparisonRow, ComparisonDirection } from '../../lib/comparison'
import { normalizeName } from '../../lib/domain'
import type { PlatformInterface } from '../../lib/labels'
import {
type PlatformFetch,
type PlatformQueryOutcome,
resolveCookie,
queryPlatformSlots,
type LegacySlotCollection,
} from '../../lib/platform/client'
import type { PlatformRdjb,PlatformRow } from '../../lib/platform/adapter'
import { relationFromRow } from '../../lib/platform/identity'
import { type StoredReplayInput } from '../../lib/platform/reconcile-replay-input'
import {
type DifferenceDecision,
type KnownEnterprise,
type PlatformQueryInput,
type RelationRef,
buildPlatformWritePayload,
} from '../../lib/platform/payload'
import {
DEFAULT_FRESHNESS_MS,
type DifferenceVerdict,
RDJB_TITLE,
type ReconcileQueryEvidence,
type ReconcileTarget,
decideDifference,
} from '../../lib/platform/reconcile'
import type {
RosterImportCommitResponse,
RosterImportPreflightResponse,
RosterImportRequest,
} from '../../lib/roster-import-client'


/** 四个查询槽位:`businessList` 的 `rdjb=1/2/3` 加申报接口。 */
const SLOTS: { interface: PlatformInterface; rdjb: string }[] = [
  { interface: 'business_list', rdjb: '1' },
  { interface: 'business_list', rdjb: '2' },
  { interface: 'business_list', rdjb: '3' },
  { interface: 'apply_list', rdjb: '' },
]

const slotKey = (slot: { interface: string; rdjb: string }) => `${slot.interface}|${slot.rdjb}`
const slotOrder = (slot: { interface: string; rdjb: string }) => SLOTS.findIndex((item) => slotKey(item) === slotKey(slot))

// ---------------------------------------------------------------------------
// 写入口(端口):默认走统一 API 的**核心函数**;脚本也可换成真实 HTTP 客户端
// ---------------------------------------------------------------------------

/**
 * 回写端口。
 *
 * `POST /api/roster/import/{preflight,commit}` 的两条路由都只是
 * `preflightRosterImport` / `commitRosterImport` 的**薄转调**(路由再加 h3 粘合与鉴权,
 * `handleRosterImportRequest` 再加状态码)。任务与服务进程共用同一个库实例,
 * 所以进程内直接调这两个函数 = **走的是同一条写入路径**,不是绕开 API 直写 SQL:
 * 校验、单批事务、幂等键、§8.7 自然键解析、逐项错误全都在里面。
 * 脚本连远端 app 时用真实 HTTP 客户端(`createRosterImportClient`),见脚本的 `--base-url`。
 */
export interface ReconcileWriter {
  preflight(request: RosterImportRequest): Promise<RosterImportPreflightResponse>
  commit(request: RosterImportRequest): Promise<RosterImportCommitResponse>
}



// ---------------------------------------------------------------------------
// 选项与报告
// ---------------------------------------------------------------------------

export interface ReconcileRunOptions {
  /** 只处理这些称号;缺省全部。 */
  titles?: string[]
  /** 只处理这些方向;缺省双向。 */
  directions?: ComparisonDirection[]
  /**
   * **只处理这几个统一社会信用代码**(小样本实查用)。
   *
   * 与 {@link ReconcileRunOptions.limit} 的分工:`limit` 按比对口径的顺序截前 N 个差异目标
   * (分批长跑);`usccs` 明确点名要看哪几家(验收/复现用 —— 「挑 2–3 个 USCC 实查一遍」
   * 这事没法靠 `limit` 表达)。给了它,无统代的目标自然一个都不命中。
   */
  usccs?: string[]
  /** **最多处理多少个差异目标**(分批长跑用);缺省不限。 */
  limit?: number
  /**
   * **跳过前 N 个差异目标**(与 {@link ReconcileRunOptions.limit} 配成一对分页)。
   *
   * 为什么有它:长跑的用法是 `--limit N` 一片一片地跑,而只有 `limit` 没有 `offset` 时,
   * 第二片会**又从头处理同一批目标**(它们已新鲜 ⇒ 0 请求 0 写入,原地打转)。
   *
   * ⚠️ **分片的理由在 RL-18(#19)之后变了。** 这里以前写的是「写入侧的计划阶段是
   * O(批内查询数²)(每条查询都要在已存在的查询里找同键的行),四千多条查询的那个批次会慢到
   * 跑不完」—— 那个根因**已修掉**:「找既有行」改为**按键定位**(谓词进 `WHERE` 命中既有
   * 唯一索引,且不再把 不可变响应归档 那几十 KB 一并读出来)。
   * 于是分批**不再是为了规避计划阶段的复杂度**,只是控制**单次事务时长与失败重试代价**的
   * **可选上限**。
   */
  offset?: number
  /** 同时打开的平台连接上限(每次查询 = 1 个连接)。实测 0.3–1.1 秒/次,默认 4。 */
  concurrency?: number
  /** 复用**新鲜**查询与判定的时间窗(毫秒);默认 24h。 */
  freshnessMs?: number
  fetchImpl?: PlatformFetch
  cookie?: string | (() => string) | null
  /** 网络错误与 5xx 的退避重试次数(默认 2);4xx 与会话过期不重试。 */
  retries?: number
  sleep?: (ms: number) => Promise<void>
  /** `false` = 只采集预览不回写(试跑)。默认回写。 */
  write?: boolean
  /** Explicit completed capture target, bound to this service's native connection. */
  now?: () => Date
  onProgress?: (done: number, total: number) => void | Promise<void>
  shouldCancel?: () => boolean | Promise<boolean>
  isWriteCancelled?: () => boolean | Promise<boolean>
}

/** 报告的分项计数(票面要求的六个桶)。 */
export interface ReconcileReportCounts {
  /** 已凭证据确认原因或确认无差异的目标数。 */
  confirmed: number
  /** 按原因码分类的已确认原因。 */
  byReason: Record<string, number>
  noRecord: number
  needsReview: number
  queryFailed: number
  /** 未查询:无统代 ⇒ 平台按统代查,查不了。 */
  notQueried: number
  /** 复用新鲜处理状态或保留已有已确认结论的目标数（兼容字段名）。 */
  reusedFresh: number
  total: number
}

export interface ReconcileReport {
  startedAt: string
  finishedAt: string
  sourceIdentity: string
  filters: {
    titles: string[] | null
    directions: string[] | null
    usccs: string[] | null
    limit: number | null
    offset: number | null
    freshnessMs: number
  }
  /** 本次纳入判定的差异目标数(去重后,受 `limit` 影响)。 */
  targetCount: number
  /** 实际打开过平台连接的统一社会信用代码数。 */
  usccCount: number
  queries: {
    /** 本次实查的槽位数；分页/重试次数见 collection.positions。 */
    network: number
    /** 复用「新鲜」既有查询、没再打平台的槽位数。 */
    reused: number
    byInterface: Record<string, number>
  }
  relations: number
  collection: {
    complete: number; partial: number; failed: number; unknown: number
    positions: (Pick<LegacySlotCollection, 'interface' | 'rdjb' | 'queryKey' | 'queriedAt' | 'completedAt' | 'completeness' | 'declaredTotal' | 'unfinished' | 'failureReason' | 'requestCount'> & { pages: Omit<LegacySlotCollection['pages'][number], 'raw'>[] })[]
  }
  counts: ReconcileReportCounts
  /** 无统代、平台查不了的差异(逐条列出,供人工接手)。 */
  unqueryable: Array<{ enterpriseId: number; name: string; titleCode: string; direction: string }>
  /** 兼容旧报告字段；自动采集不生成身份归并候选，始终为空。 */
  mergeCandidates: Array<{
    fromEnterpriseId: number
    fromName: string
    intoEnterpriseId: number
    intoName: string
    uscc: string
    aliasName: string
  }>
  /** 兼容旧报告字段；自动采集不写曾用名，始终为0。 */
  aliases: number
  write: { batchId: number; status: string; written: number; skipped: number } | null
  cancelled: boolean
}

// ---------------------------------------------------------------------------
// 并发池
// ---------------------------------------------------------------------------

/** 有上限的并发映射:保持结果顺序,`limit` 至少 1。模块内自用(不是本模块对外的 API)。 */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const size = Math.max(1, Math.floor(limit))
  const results = new Array<R>(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    for (;;) {
      const index = next++
      if (index >= items.length) return
      results[index] = await fn(items[index]!, index)
    }
  })
  const settled = await Promise.allSettled(workers)
  const failed = settled.find(result => result.status === 'rejected')
  if (failed) throw failed.reason
  return results
}

// ---------------------------------------------------------------------------
// 读既有证据(新鲜性复用)
// ---------------------------------------------------------------------------

/** Comparison/mapping projections are independent of the selected immutable originals. */
export type StoredSlot = {
  /** Reused queries own their saved value (including NULL); fetched slots use the rdjb mapping. */
  titleCode: typeof PlatformCollectionTable.$inferSelect.titleCode
  collection?: LegacySlotCollection
  evidence: ReconcileQueryEvidence
  /** Legacy string projection, used only for old page/row validation. */
  rawRows: PlatformRow[]
  /** Typed payload of the selected original or fresh platform rows. */
  payloadRows: Record<string, unknown>[]
  /** 本次实查拿到的**原始响应原文**(落 不可变响应归档);复用时为空串。 */
  raw: string
} & ({ kind: 'fresh' } | { kind: 'stored'; original: StoredReplayInput })

// ---------------------------------------------------------------------------
// 目标收集
// ---------------------------------------------------------------------------

export interface CollectedTargets {
  /** 有统代、可直查的差异目标。 */
  targets: ReconcileTarget[]
  /** 无统代:平台按统代查,查不了 ⇒ 直接 `not_queried`。 */
  unqueryable: ReconcileTarget[]
  /** 统一社会信用代码 → 该统代下的目标。 */
  byUscc: Map<string, ReconcileTarget[]>
  /** 全部企业(供载荷按名称/统代解析归属)。 */
  enterprises: KnownEnterprise[]
}

/**
 * 取比对口径的差异行。
 *
 * `getComparison` 的 `direction` 是**单值**筛选,所以多方向要各调一次再合并 ——
 * 判据本身仍然只有 `layers/sme-roster/lib/comparison.ts` 一份(不在这里另写一套差异口径)。
 */


type ReconcileTargetFilter = Pick<ReconcileRunOptions, 'titles'|'directions'|'usccs'|'limit'|'offset'>
export function projectReconcileTargets(
  comparison: ComparisonRow[], enterprises: KnownEnterprise[], filter: ReconcileTargetFilter,
): CollectedTargets {
  const byId = new Map(enterprises.map((enterprise) => [enterprise.id, enterprise]))

  const seen = new Set<string>()
  const all: ReconcileTarget[] = []
  const only = filter.usccs?.length ? new Set(filter.usccs) : null
  for (const row of comparison) {
    const signature = `${row.enterpriseId}|${row.titleCode}|${row.direction}`
    if (seen.has(signature)) continue
    seen.add(signature)
    const enterprise = byId.get(row.enterpriseId)
    const uscc = enterprise?.uscc ?? row.uscc
    // 点名了 USCC 就只留它们;无统代的目标永远不命中(它没有可比的键)。
    if (only && (uscc == null || !only.has(uscc))) continue
    all.push({
      enterpriseId: row.enterpriseId,
      enterpriseName: enterprise?.name ?? row.name,
      enterpriseNameNorm: enterprise?.nameNorm ?? normalizeName(row.name),
      uscc,
      titleCode: row.titleCode,
      direction: row.direction,
    })
  }

  // 分页:先跳过 `offset`,再截 `limit`(顺序与 `getComparison` 的排序一致 ⇒ 片与片不重叠、
  // 也不漏 —— 本流程不新建 record / enterprise,所以比对集合在片与片之间是稳定的)。
  const from = filter.offset && filter.offset > 0 ? filter.offset : 0
  const limited = filter.limit && filter.limit > 0 ? all.slice(from, from + filter.limit) : all.slice(from)
  const targets: ReconcileTarget[] = []
  const unqueryable: ReconcileTarget[] = []
  for (const target of limited) {
    if (target.uscc) targets.push(target)
    else unqueryable.push(target)
  }

  const byUscc = new Map<string, ReconcileTarget[]>()
  for (const target of targets) {
    const bucket = byUscc.get(target.uscc!)
    if (bucket) bucket.push(target)
    else byUscc.set(target.uscc!, [target])
  }
  return { targets, unqueryable, byUscc, enterprises }
}

// ---------------------------------------------------------------------------
// 证据构造
// ---------------------------------------------------------------------------

function toEvidence(outcome: PlatformQueryOutcome): ReconcileQueryEvidence {
  return {
    interface: outcome.interface,
    rdjb: outcome.rdjb,
    queriedAt: outcome.queriedAt,
    status: outcome.status,
    completeness: outcome.collection?.completeness,
    failureReason: outcome.failureReason,
    relations: outcome.rows.map((row, index) =>
      relationFromRow(row, {
        interface: outcome.interface,
        rdjb: outcome.rdjb,
        queryKey: outcome.queryKey,
        sequenceNo: index + 1,
      }),
    ),
  }
}

/**
 * 把槽位证据翻成契约 §8.3 的 `platformQueries[]` 一项。
 *
 * `relations` 走 `rawRows`(平台原始行),让 `buildPlatformWritePayload` 用**同一套**
 * 字段映射与匹配依据规则构造关系项 —— 不在这里另写一份映射。
 *
 * `titleCode` 由槽位来源确定：复用查询保留原值，新采集按 rdjb 映射。
 */
function toQueryInput(slot: StoredSlot, queryKey: string): PlatformQueryInput {
  const { evidence } = slot
  return {
    ...(slot.kind === 'stored' ? { kind: 'stored' as const, original: slot.original } : { kind: 'fresh' as const }),
    interface: evidence.interface,
    queryKey,
    rdjb: evidence.rdjb,
    queriedAt: evidence.queriedAt,
    titleCode: slot.titleCode,
    outcome: {
      interface: evidence.interface,
      rdjb: evidence.rdjb,
      queryKey,
      queriedAt: evidence.queriedAt,
      status: evidence.status,
      failureReason: evidence.failureReason ?? null,
      rows: slot.rawRows,
      rawRows: slot.payloadRows,
      maxCount: slot.collection?.declaredTotal ?? 0,
      collection: slot.collection,
      source: null,
      // 复用库里已有查询时不重传原文:写入侧按 `(interface, queryKey, rdjb, queriedAt)`
      // 唯一键判为已存在,不覆盖库里的原文(也免得把几 MB 的 HTML 再发一遍)。
      raw: slot.raw,
    },
  }
}

// ---------------------------------------------------------------------------
// 幂等键与新鲜性
// ---------------------------------------------------------------------------

/**
 * 幂等键由**证据内容**派生(不是当前时间):同一目标集 + 同一份证据重放给同一个键
 * ⇒ 统一 API 的幂等重放返回既有批次摘要,**不重复堆行**;证据变了(新时点的新查询、
 * 新的关系集合)自然得到另一个键,新解释形成新行(旧解释不丢)。
 */
export function reconcileIdempotencyKey(input: {
  queries: ReconcileQueryEvidence[]
  differences: { enterpriseId: number; titleCode: string; direction: string; status: string; reasonCode: string | null }[]
  aliases: { enterpriseId: number; name: string }[]
}): string {
  const queries = [...input.queries]
    .map(
      (query) =>
        `${query.interface}|${query.rdjb}|${query.queriedAt}|${query.status}|${query.completeness ?? 'unknown'}|` +
        query.relations
          .map((relation) => `${relation.sequenceNo}:${relation.relationKey ?? ''}:${relation.nameRaw ?? ''}`)
          .join(','),
    )
    .sort()
  const differences = [...input.differences]
    .map(
      (difference) =>
        `${difference.enterpriseId}|${difference.titleCode}|${difference.direction}|${difference.status}|${difference.reasonCode ?? ''}`,
    )
    .sort()
  const aliases = [...input.aliases].map((alias) => `${alias.enterpriseId}|${alias.name}`).sort()
  return `platform_reconcile:${createHash('sha256').update(JSON.stringify({ queries, differences, aliases })).digest('hex').slice(0, 32)}`
}

/** 已确认结论由代理维护；采集只复用处理状态，不用新查询覆盖确认。失败仍可重试。 */


export function isFreshReconcileDecision(latest: { verificationStatus: string; recordedAt: string; status:string } | undefined,
  cutoffIso: string, complete: boolean) {
  return latest !== undefined && (latest.verificationStatus === 'confirmed' || (complete && latest.recordedAt >= cutoffIso))
    && latest.status !== 'query_failed'
}

export async function runPlatformReconcileWithStore(options: ReconcileRunOptions, store: {
  prepare(filter: ReconcileTargetFilter, cutoffIso: string): Promise<{ collected: CollectedTargets; reused?: Map<string, Map<string, StoredSlot>> }>
  freshDecision(target: ReconcileTarget, cutoffIso: string, complete: boolean): boolean | Promise<boolean>
  writer(): ReconcileWriter
}): Promise<ReconcileReport> {
  const now = options.now ?? (() => new Date())
  const startedAt = now().toISOString()
  const freshnessMs = options.freshnessMs ?? DEFAULT_FRESHNESS_MS
  const cutoffIso = new Date(now().getTime() - freshnessMs).toISOString()
  const sourceIdentity = `platform/reconcile${
    options.titles?.length ? `:${[...options.titles].sort().join('+')}` : ''
  }${options.directions?.length ? `/${[...options.directions].sort().join('+')}` : ''}`

  const { collected, reused: storedSlots } = await store.prepare({
    titles: options.titles,
    directions: options.directions,
    usccs: options.usccs,
    limit: options.limit,
    offset: options.offset,
  }, cutoffIso)
  const usccs = [...collected.byUscc.keys()]
  const total = usccs.length
  await options.onProgress?.(0, total)

  // 先按槽位判「哪些新鲜可复用、哪些必须实查」—— 一次都不查的话不需要凭据。
  const planned = new Map<string, { reused: Map<string, StoredSlot>; missing: typeof SLOTS }>()
  for (const uscc of usccs) {
    const reused = storedSlots?.get(uscc) ?? new Map<string, StoredSlot>()
    planned.set(uscc, { reused, missing: SLOTS.filter((slot) => !reused.has(slotKey(slot))) })
  }
  const missingSlots = [...planned.values()].reduce((sum, entry) => sum + entry.missing.length, 0)

  // 凭据:拿不到就**不发请求、不写半截结果**,直接以明确原因失败 —— 绝不产出
  // 「一片未查询」的假证据(pipeline 的同一条纪律)。判据用**有效凭据**:调用方显式给的
  // 优先，其次是 MIIT_COOKIE。
  const cookie = missingSlots > 0 ? resolveCookie(options.cookie) : ''
  if (missingSlots > 0 && !cookie) {
    throw new Error(
      '未配置平台会话凭据:请在密钥配置页保存 Cookie，或设置 MIIT_COOKIE。' +
        '凭据不进入查询证据或日志；本次不写任何结果。',
    )
  }

  const slotsByUscc = new Map<string, StoredSlot[]>()
  const networkByInterface: Record<string, number> = { business_list: 0, apply_list: 0 }
  let networkCount = 0
  let reusedCount = 0
  let cancelled = false
  let completed = 0

  await mapWithConcurrency(usccs, options.concurrency ?? 4, async (uscc) => {
    if (await options.shouldCancel?.()) {
      cancelled = true
      return
    }
    const entry = planned.get(uscc)!
    const slots: StoredSlot[] = []
    for (const slot of SLOTS) {
      const reused = entry.reused.get(slotKey(slot))
      if (reused) {
        slots.push(reused)
        reusedCount += 1
      }
    }
    if (entry.missing.length > 0) {
      // 只补**缺的**槽位:已经新鲜的那几档直接用库里的证据,不重复打平台。
      const outcomes = await queryPlatformSlots(
        {
          uscc,
          fetchImpl: options.fetchImpl,
          cookie: () => cookie,
          retries: options.retries,
          shouldCancel: options.shouldCancel,
          sleep: options.sleep,
          // `queried_at` 用**请求前的真实时点**(注入时钟时用注入的,便于固定断言)。
          ...(options.now ? { now: () => options.now!().toISOString() } : {}),
        },
        entry.missing.map((slot) => ({ interface: slot.interface, rdjb: slot.rdjb as PlatformRdjb | undefined })),
      )
      for (const outcome of outcomes) {
        if (outcome.collection?.requestCount) {
          networkCount += 1
          networkByInterface[outcome.interface] = (networkByInterface[outcome.interface] ?? 0) + 1
        }
        slots.push({
          kind: 'fresh',
          titleCode: outcome.interface === 'business_list' ? (RDJB_TITLE[outcome.rdjb] ?? null) : null,
          evidence: toEvidence(outcome), rawRows: outcome.rows, payloadRows: outcome.rows, raw: outcome.raw, collection: outcome.collection,
        })
      }
    }
    if (await options.shouldCancel?.()) cancelled = true
    slots.sort((a, b) => slotOrder(a.evidence) - slotOrder(b.evidence))
    slotsByUscc.set(uscc, slots)
    await options.onProgress?.(++completed, total)
  })

  // 只分类查询处理状态。confirmed_* 与业务原因仅由显式确认写入。
  const counts: ReconcileReportCounts = {
    confirmed: 0,
    byReason: {},
    noRecord: 0,
    needsReview: 0,
    queryFailed: 0,
    notQueried: 0,
    reusedFresh: 0,
    total: collected.targets.length + collected.unqueryable.length,
  }
  let relations = 0
  for (const slots of slotsByUscc.values()) {
    relations += slots.reduce((sum, slot) => sum + slot.evidence.relations.length, 0)
  }

  const differenceDecisions: DifferenceDecision[] = []
  const mergeCandidates: ReconcileReport['mergeCandidates'] = []

  // 无统代的目标:平台按统代查,查不了 ⇒ 直接落 `not_queried` + 转人工。
  // 「新鲜」规则对它们同样适用 —— 否则每次重跑都会给同一批查不了的差异再堆一行。
  for (const target of collected.unqueryable) {
    if (await store.freshDecision(target, cutoffIso, true)) {
      counts.reusedFresh += 1
      continue
    }
    const verdict = decideDifference(target, [])
    counts.notQueried += 1
    differenceDecisions.push(toDifferenceDecision(target, verdict, startedAt))
  }

  for (const [uscc, targets] of collected.byUscc) {
    const evidence = (slotsByUscc.get(uscc) ?? []).map((slot) => slot.evidence)
    for (const target of targets) {
      if (await store.freshDecision(target, cutoffIso, evidence.length === SLOTS.length && evidence.every(q => q.completeness === 'complete'))) {
        counts.reusedFresh += 1
        continue
      }
      const verdict = decideDifference(target, evidence)
      tally(counts, verdict)
      differenceDecisions.push(toDifferenceDecision(target, verdict, startedAt))
    }
  }

  const collection: ReconcileReport['collection'] = { complete: 0, partial: 0, failed: 0, unknown: 0, positions: [] }
  // Workers skipped at the cancellation boundary have no executed pages, but
  // their planned scope is still unfinished and must remain visible in the report.
  for (const uscc of usccs.filter(key => !slotsByUscc.has(key))) {
    for (const slot of SLOTS) {
      collection.unknown++
      collection.positions.push({ ...slot, queryKey: uscc, queriedAt: startedAt, completedAt: now().toISOString(),
        completeness: 'not_queried', declaredTotal: null, unfinished: [{ source: slot.interface === 'business_list' ? 'businessList' : 'queryList', rdjb: slot.rdjb || null, page: 1 }],
        failureReason: '任务已取消，该槽位尚未查询。', requestCount: 0, pages: [] })
    }
  }
  for (const slot of [...slotsByUscc.values()].flat()) {
    const c = slot.collection
    if (!c || c.completeness === 'not_queried') collection.unknown++
    else if (c.completeness === 'complete') collection.complete++
    else if (slot.evidence.status === 'failed') collection.failed++
    else collection.partial++
    if (c) {
      const { kind: _kind, pages, ...position } = c
      collection.positions.push({ ...position, pages: pages.map(({ raw: _raw, ...page }) => page) })
    }
  }
  const report: ReconcileReport = {
    startedAt,
    finishedAt: now().toISOString(),
    sourceIdentity,
    filters: {
      titles: options.titles ?? null,
      directions: options.directions ?? null,
      usccs: options.usccs ?? null,
      limit: options.limit ?? null,
      offset: options.offset ?? null,
      freshnessMs,
    },
    targetCount: collected.targets.length + collected.unqueryable.length,
    usccCount: usccs.length,
    queries: { network: networkCount, reused: reusedCount, byInterface: networkByInterface },
    relations,
    collection,
    counts,
    unqueryable: collected.unqueryable.map((target) => ({
      enterpriseId: target.enterpriseId,
      name: target.enterpriseName,
      titleCode: target.titleCode,
      direction: target.direction,
    })),
    mergeCandidates,
    aliases: 0,
    write: null,
    cancelled,
  }

  if (await options.shouldCancel?.()) { cancelled = true; report.cancelled = true }
  if (cancelled || options.write === false || (differenceDecisions.length === 0 && networkCount === 0)) {
    report.finishedAt = now().toISOString()
    return report
  }

  // 一批保存原始查询/关系及未确认处理状态；已有确认可只刷新证据。
  const queries: PlatformQueryInput[] = []
  for (const [uscc, slots] of slotsByUscc) {
    for (const slot of slots) queries.push(toQueryInput(slot, uscc))
  }

  const request = buildPlatformWritePayload({
    sourceIdentity,
    idempotencyKey: reconcileIdempotencyKey({
      queries: [...slotsByUscc.values()].flat().map((slot) => slot.evidence),
      differences: differenceDecisions.map((decision) => ({
        enterpriseId: decision.enterpriseId,
        titleCode: decision.titleCode,
        direction: decision.direction,
        status: decision.status,
        reasonCode: decision.reasonCode ?? null,
      })),
      aliases: [],
    }),
    queries,
    enterprises: collected.enterprises,
    differences: differenceDecisions,
  })

  const writer = store.writer()
  await writer.preflight(request)
  if (await options.shouldCancel?.() || await options.isWriteCancelled?.()) {
    report.cancelled = true
    report.finishedAt = now().toISOString()
    return report
  }
  const committed = await writer.commit(request)
  report.write = {
    batchId: committed.batchId,
    status: committed.status,
    written: committed.summary.written,
    skipped: committed.summary.skipped,
  }
  report.finishedAt = now().toISOString()
  return report
}

function toDifferenceDecision(
  target: ReconcileTarget,
  verdict: DifferenceVerdict,
  recordedAt: string,
): DifferenceDecision {
  return {
    enterpriseId: target.enterpriseId,
    titleCode: target.titleCode,
    direction: target.direction,
    status: verdict.status,
    reasonCode: verdict.reasonCode,
    reasonNote: verdict.reasonNote,
    measureCode: verdict.measureCode,
    measureNote: verdict.measureNote,
    evidenceQuery: verdict.evidenceQuery ?? undefined,
    evidenceRelation: (verdict.evidenceRelation as RelationRef | null) ?? undefined,
    movedIn: verdict.movedIn,
    verificationStatus: verdict.verificationStatus,
    recordedAt,
  }
}

/** 按**状态**分桶计数(票面要求的六个桶;原因再按 `reasonCode` 细分)。 */
function tally(counts: ReconcileReportCounts, verdict: DifferenceVerdict): void {
  switch (verdict.status) {
    case 'confirmed_reason':
      counts.confirmed += 1
      if (verdict.reasonCode) {
        counts.byReason[verdict.reasonCode] = (counts.byReason[verdict.reasonCode] ?? 0) + 1
      }
      break
    case 'confirmed_no_diff':
      counts.confirmed += 1
      break
    case 'no_record':
      counts.noRecord += 1
      break
    case 'query_failed':
      counts.queryFailed += 1
      break
    case 'not_queried':
      counts.notQueried += 1
      break
    default:
      counts.needsReview += 1
  }
}
