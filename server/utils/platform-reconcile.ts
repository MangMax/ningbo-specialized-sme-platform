/**
 * **可运行的平台比对与原因回写**(RL-03 实施切片 ③「证据写回」的未完部分)。
 *
 * ── 这个模块补的是什么 ────────────────────────────────────────────────────
 * RL-03 已交付两接口适配器、§8.3 载荷构造、统一写入客户端与读接口,但**没有一个可运行的
 * 入口**把「实查工信部两接口 → 落库关系证据 → 逐条判定差异原因与后置动作 → 经统一 API
 * 写回」串起来:项目外 `pipeline` 的 `pnpm reconcile` 只写 JSON 缓存、不写库。
 * 这里就是那条链的**唯一一份核心逻辑**;`kind: 'reconcile'` 的异步任务与
 * `scripts/reconcile-live.mjs` 都只是它的入口(不各自再实现一遍)。
 *
 * ── 已实测的事实(不按推测设计)────────────────────────────────────────────
 *  - 平台真实延迟 **0.3–1.1 秒/次**;
 *  - **两接口只认 `tyshxydm`**(`businessList` 要 `rdjb` + `tyshxydm`;`applyList` 只要
 *    `tyshxydm`)——**不支持按名称查**。所以公布侧无统代的差异条目**查不了**,
 *    一律留 `needs_review` 并说明「缺什么证据」,**不为它们编造查询键**;
 *  - **必须 `rdjb=1/2/3` 全查再合并**:同一 USCC 在不同 `rdjb` 下返回**不同集合**,
 *    旧 pipeline 只查本地称号映射出的那一个 ⇒ 整条曾用名证据被漏掉
 *    (实测 `91330211255994457P` 的 rdjb=1/2 各 0 行、rdjb=3 有 6 行);
 *  - 会话过期是 **HTTP 200 + `{"statusCode":"301",...}`** ⇒ `failed`,不是 `no_record`。
 *
 * ── 凭据 ──────────────────────────────────────────────────────────────────
 * 应用传入数据库凭据快照；独立 CLI 从 `MIIT_COOKIE` 读取。原值不进入查询证据或日志。
 * 拿不到凭据时**不发请求、也不写「一片未查询」的假结果**:直接以明确原因失败。
 *
 * ── 不建模糊推断引擎 ─────────────────────────────────────────────────────
 * 原因与措施的判定全部落在 `lib/platform/reconcile.ts` 的纯函数里,每一类都必须指回
 * 一条可读的来源字段(`qymc` / `szsfmc` / `cszt` / `sqsj`),否则 `needs_review`。
 */

import { createHash } from 'node:crypto'
import { eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '../../db/schema'
import { getComparison, type ComparisonDirection } from '../../lib/comparison'
import { normalizeName } from '../../lib/domain'
import type { PlatformInterface } from '../../lib/labels'
import {
  type PlatformFetch,
  type PlatformQueryOutcome,
  resolveCookie,
  queryPlatformSlots,
} from '../../lib/platform/client'
import type { PlatformRdjb, PlatformRow } from '../../lib/platform/adapter'
import { type PlatformRelationRecord, relationFromRow } from '../../lib/platform/identity'
import {
  type AliasDecision,
  type BuildPayloadInput,
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
import { commitRosterImport, preflightRosterImport } from './roster-import'

type Db = BetterSQLite3Database<typeof schema>

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

export function inProcessReconcileWriter(db: Db): ReconcileWriter {
  return {
    async preflight(request) {
      return preflightRosterImport(db, request)
    },
    async commit(request) {
      const result = commitRosterImport(db, request)
      if (result.status !== 'committed') {
        const detail = result.items
          .filter((item) => !item.ok)
          .map((item) => `${item.kind}${item.ref ? ` ${item.ref}` : ''}:${item.error?.code ?? '?'} ${item.error?.message ?? ''}`)
          .join(';')
        throw new Error(`名录导入批次未提交(${result.status}):${result.error ?? ''} ${detail}`.trim())
      }
      return result
    },
  }
}

// ---------------------------------------------------------------------------
// 选项与报告
// ---------------------------------------------------------------------------

export interface ReconcileRunOptions {
  db: Db
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
   * 唯一索引,且不再把 `platform_query.raw_response` 那几十 KB 一并读出来)。
   * 于是分批**不再是为了规避计划阶段的复杂度**,只是控制**单次事务时长与失败重试代价**的
   * **可选上限**(修后单批 4400 条查询 = 票面全量规模,实测在秒级)。实测口径与数字见
   * `docs/roster-lifecycle-contract.md` §3.1c。
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
  /** `false` = 只判定不回写(试跑)。默认回写。 */
  write?: boolean
  writer?: ReconcileWriter
  now?: () => Date
  onProgress?: (done: number, total: number) => void
  shouldCancel?: () => boolean
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
  /** 本次判定被「新鲜」规则跳过、直接复用既有结论的目标数。 */
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
    /** 本次真正打出去的 HTTP 请求数。 */
    network: number
    /** 复用「新鲜」既有查询、没再打平台的槽位数。 */
    reused: number
    byInterface: Record<string, number>
  }
  relations: number
  counts: ReconcileReportCounts
  /** 无统代、平台查不了的差异(逐条列出,供人工接手)。 */
  unqueryable: Array<{ enterpriseId: number; name: string; titleCode: string; direction: string }>
  /** 证据显示「同一 USCC 的旧名 = 库里另一家无统代企业的现名」——**仅提示,不自动归并**。 */
  mergeCandidates: Array<{
    fromEnterpriseId: number
    fromName: string
    intoEnterpriseId: number
    intoName: string
    uscc: string
    aliasName: string
  }>
  /** 本次写出的曾用名条数。 */
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
  await Promise.all(workers)
  return results
}

// ---------------------------------------------------------------------------
// 读既有证据(新鲜性复用)
// ---------------------------------------------------------------------------

function textOf(value: unknown): string {
  return value == null ? '' : String(value)
}

/**
 * 从库里读回一条 `platform_relation` 的**原始字段**。
 *
 * 落库时 `raw_fields` 存的就是平台那一行的全部字段(§1.4),所以能原样还原成 `PlatformRow`;
 * 万一某行没有 `raw_fields`(例如早期直接写库的演示数据),就按列**合成**一份等价字段 ——
 * 这样重建出来的载荷与列值一致,写入侧按 `(query_id, sequence_no)` 判为已存在而**跳过**,
 * 不会覆盖库里的原文,也不会丢掉关系。
 */
function rawRowOf(row: typeof schema.platformRelation.$inferSelect): PlatformRow {
  if (row.rawFields && Object.keys(row.rawFields).length > 0) {
    const out: PlatformRow = {}
    for (const [key, value] of Object.entries(row.rawFields)) out[key] = textOf(value)
    return out
  }
  const synthesized: PlatformRow = {}
  if (row.relationKey) synthesized.id = row.relationKey
  if (row.nameRaw) synthesized.qymc = row.nameRaw
  if (row.usccRaw) synthesized.tyshxydm = row.usccRaw
  if (row.province) synthesized.szsfmc = row.province
  if (row.status) synthesized.cszt = row.status
  if (row.batch) synthesized.whpc = row.batch
  if (row.declareKind) synthesized.sblx = row.declareKind
  if (row.appliedAt) synthesized.sqsj = row.appliedAt
  if (row.awardBatchLabel) synthesized.personuuid = row.awardBatchLabel
  if (row.year != null) synthesized.year = String(row.year)
  return synthesized
}

/**
 * 库里已有的、仍**新鲜**且已成功执行过的查询(按槽位)。
 *
 * 「新鲜」的判据是 `queried_at >= now - freshnessMs`,默认 24 小时 —— 命中就不重复打平台
 * (票面要求:已有新鲜查询可复用)。失败(`failed`)的查询**从不复用**:它代表「这次没查成」,
 * 重跑就该再试一次。
 */
function freshStoredSlots(db: Db, queryKey: string, cutoffIso: string): Map<string, StoredSlot> {
  const out = new Map<string, StoredSlot>()
  const queries = db
    .select()
    .from(schema.platformQuery)
    .where(eq(schema.platformQuery.queryKey, queryKey))
    .all()
  for (const query of queries) {
    if (query.status !== 'success' && query.status !== 'no_record') continue
    if (query.queriedAt < cutoffIso) continue
    const key = slotKey({ interface: query.interface, rdjb: query.rdjb })
    const previous = out.get(key)
    // 同一槽位有多条新鲜查询时取最新那时点(重复查询各占一行,不覆盖)。
    if (previous && previous.evidence.queriedAt >= query.queriedAt) continue
    const relations = db
      .select()
      .from(schema.platformRelation)
      .where(eq(schema.platformRelation.queryId, query.id))
      .all()
      .sort((a, b) => a.sequenceNo - b.sequenceNo)
    out.set(key, {
      rawRows: relations.map(rawRowOf),
      raw: '',
      evidence: {
        interface: query.interface,
        rdjb: query.rdjb,
        queriedAt: query.queriedAt,
        status: query.status,
        failureReason: query.failureReason,
        relations: relations.map((row) => ({
          interface: query.interface,
          rdjb: query.rdjb,
          sequenceNo: row.sequenceNo,
          relationKey: row.relationKey,
          nameRaw: row.nameRaw,
          usccRaw: row.usccRaw,
          province: row.province,
          status: row.status,
          batch: row.batch,
          declareKind: row.declareKind,
          appliedAt: row.appliedAt,
          awardBatchLabel: row.awardBatchLabel,
          year: row.year,
          sourceKind: query.interface === 'business_list' ? 'platform_business' : 'platform_apply',
          rawFields: rawRowOf(row),
        })),
      },
    })
  }
  return out
}

/** 一个槽位的证据:判定引擎用 `evidence`,载荷构造用 `rawRows`。 */
interface StoredSlot {
  evidence: ReconcileQueryEvidence
  rawRows: PlatformRow[]
  /** 本次实查拿到的**原始响应原文**(落 `platform_query.raw_response`);复用时为空串。 */
  raw: string
}

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
 * 判据本身仍然只有 `lib/comparison.ts` 一份(不在这里另写一套差异口径)。
 */
function getComparisonAllDirections(
  db: Db,
  filter: { titles?: string[]; directions?: ComparisonDirection[] },
): ReturnType<typeof getComparison>['rows'] {
  const directions: (ComparisonDirection | undefined)[] = filter.directions?.length
    ? filter.directions
    : [undefined]
  const rows: ReturnType<typeof getComparison>['rows'] = []
  const seen = new Set<string>()
  for (const direction of directions) {
    for (const row of getComparison(db, { title: filter.titles, direction }).rows) {
      const signature = `${row.enterpriseId}|${row.titleCode}|${row.direction}`
      if (seen.has(signature)) continue
      seen.add(signature)
      rows.push(row)
    }
  }
  return rows
}

export function collectReconcileTargets(
  db: Db,
  filter: { titles?: string[]; directions?: ComparisonDirection[]; usccs?: string[]; limit?: number; offset?: number } = {},
): CollectedTargets {
  const comparison = getComparisonAllDirections(db, filter)
  const enterprises = db
    .select({
      id: schema.enterprise.id,
      name: schema.enterprise.name,
      nameNorm: schema.enterprise.nameNorm,
      uscc: schema.enterprise.usccNorm,
    })
    .from(schema.enterprise)
    .all()
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
 * `titleCode` 用 `rdjb` ↔ 称号的对应关系填(`businessList` 确实是按认定级别查的);
 * 申报接口不按称号查,留空。它描述的是「**这次查询**查的是哪一档」,不是目标企业。
 */
function toQueryInput(slot: StoredSlot, queryKey: string): PlatformQueryInput {
  const { evidence } = slot
  return {
    interface: evidence.interface,
    queryKey,
    rdjb: evidence.rdjb,
    queriedAt: evidence.queriedAt,
    titleCode: evidence.interface === 'business_list' ? (RDJB_TITLE[evidence.rdjb] ?? null) : null,
    outcome: {
      interface: evidence.interface,
      rdjb: evidence.rdjb,
      queryKey,
      queriedAt: evidence.queriedAt,
      status: evidence.status,
      failureReason: evidence.failureReason ?? null,
      rows: slot.rawRows,
      maxCount: slot.rawRows.length,
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
        `${query.interface}|${query.rdjb}|${query.queriedAt}|${query.status}|` +
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

/** 该目标是否已有**新鲜且有效**的最新差异判定(失败不复用,也不被旧结论遮盖)。 */
function hasFreshDecision(db: Db, target: ReconcileTarget, cutoffIso: string): boolean {
  const matching = db
    .select()
    .from(schema.differenceReason)
    .where(eq(schema.differenceReason.enterpriseId, target.enterpriseId))
    .all()
    .filter((row) => row.titleCode === target.titleCode && row.direction === target.direction)
    .sort((left, right) => left.recordedAt.localeCompare(right.recordedAt))
  const latest = matching[matching.length - 1]

  return (
    latest !== undefined &&
    latest.recordedAt >= cutoffIso &&
    // A failed attempt is not a reusable conclusion. Checking only the latest row also prevents
    // an older successful explanation from hiding a newer failure for the same target.
    latest.status !== 'query_failed'
  )
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

export async function runPlatformReconcile(options: ReconcileRunOptions): Promise<ReconcileReport> {
  const { db } = options
  const now = options.now ?? (() => new Date())
  const startedAt = now().toISOString()
  const freshnessMs = options.freshnessMs ?? DEFAULT_FRESHNESS_MS
  const cutoffIso = new Date(now().getTime() - freshnessMs).toISOString()
  const sourceIdentity = `platform/reconcile${
    options.titles?.length ? `:${[...options.titles].sort().join('+')}` : ''
  }${options.directions?.length ? `/${[...options.directions].sort().join('+')}` : ''}`

  const collected = collectReconcileTargets(db, {
    titles: options.titles,
    directions: options.directions,
    usccs: options.usccs,
    limit: options.limit,
    offset: options.offset,
  })
  const usccs = [...collected.byUscc.keys()]
  const total = usccs.length
  options.onProgress?.(0, total)

  // 先按槽位判「哪些新鲜可复用、哪些必须实查」—— 一次都不查的话不需要凭据。
  const planned = new Map<string, { reused: Map<string, StoredSlot>; missing: typeof SLOTS }>()
  for (const uscc of usccs) {
    const reused = freshStoredSlots(db, uscc, cutoffIso)
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

  await mapWithConcurrency(usccs, options.concurrency ?? 4, async (uscc, index) => {
    if (options.shouldCancel?.()) {
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
          sleep: options.sleep,
          // `queried_at` 用**请求前的真实时点**(注入时钟时用注入的,便于固定断言)。
          ...(options.now ? { now: () => options.now!().toISOString() } : {}),
        },
        entry.missing.map((slot) => ({ interface: slot.interface, rdjb: slot.rdjb as PlatformRdjb | undefined })),
      )
      for (const outcome of outcomes) {
        networkCount += 1
        networkByInterface[outcome.interface] = (networkByInterface[outcome.interface] ?? 0) + 1
        slots.push({ evidence: toEvidence(outcome), rawRows: outcome.rows, raw: outcome.raw })
      }
    }
    slots.sort((a, b) => slotOrder(a.evidence) - slotOrder(b.evidence))
    slotsByUscc.set(uscc, slots)
    options.onProgress?.(index + 1, total)
  })

  // 判定(纯函数 `decideDifference`;编排层只负责把证据递给它)。
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
  const aliasDecisions: AliasDecision[] = []
  const aliasSeen = new Set<string>()
  const mergeCandidates: ReconcileReport['mergeCandidates'] = []
  const enterpriseByName = new Map(collected.enterprises.map((enterprise) => [enterprise.nameNorm, enterprise]))

  // 无统代的目标:平台按统代查,查不了 ⇒ 直接落 `not_queried` + 转人工。
  // 「新鲜」规则对它们同样适用 —— 否则每次重跑都会给同一批查不了的差异再堆一行。
  for (const target of collected.unqueryable) {
    if (hasFreshDecision(db, target, cutoffIso)) {
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
      if (hasFreshDecision(db, target, cutoffIso)) {
        counts.reusedFresh += 1
        continue
      }
      const verdict = decideDifference(target, evidence)
      tally(counts, verdict)
      differenceDecisions.push(toDifferenceDecision(target, verdict, startedAt))

      for (const alias of verdict.aliases) {
        const signature = `${target.enterpriseId}|${alias.name}|${alias.sourceRelation.interface}|${alias.sourceRelation.sequenceNo}`
        if (aliasSeen.has(signature)) continue
        aliasSeen.add(signature)
        aliasDecisions.push({
          enterpriseId: target.enterpriseId,
          name: alias.name,
          sourceKind: alias.sourceKind,
          sourceRelation: alias.sourceRelation as RelationRef,
          validFrom: alias.validFrom,
          note: alias.note,
          verificationStatus: alias.verificationStatus,
        })
        // 旧名恰好等于库里另一家企业的现名 ⇒ 只**提示**「这里可能是一次归并」。
        // 归并会删行、会改归属,不自动做(契约 §5.2 由人确认)。
        const counterpart = enterpriseByName.get(normalizeName(alias.name))
        if (counterpart && counterpart.id !== target.enterpriseId && counterpart.uscc == null) {
          mergeCandidates.push({
            fromEnterpriseId: counterpart.id,
            fromName: counterpart.name,
            intoEnterpriseId: target.enterpriseId,
            intoName: target.enterpriseName,
            uscc,
            aliasName: alias.name,
          })
        }
      }
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
    counts,
    unqueryable: collected.unqueryable.map((target) => ({
      enterpriseId: target.enterpriseId,
      name: target.enterpriseName,
      titleCode: target.titleCode,
      direction: target.direction,
    })),
    mergeCandidates,
    aliases: aliasDecisions.length,
    write: null,
    cancelled,
  }

  if (cancelled || options.write === false || differenceDecisions.length === 0) {
    report.finishedAt = now().toISOString()
    return report
  }

  // 写回:**一份载荷、一个批次**。§8.7 的自然键让证据指针在批内指到本批新建的查询/关系,
  // 不必拆成「先写查询、读回 id、再写别名」两批。
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
      aliases: aliasDecisions.map((alias) => ({ enterpriseId: alias.enterpriseId!, name: alias.name })),
    }),
    queries,
    enterprises: collected.enterprises,
    aliases: aliasDecisions,
    differences: differenceDecisions,
  })

  const writer = options.writer ?? inProcessReconcileWriter(db)
  await writer.preflight(request)
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
