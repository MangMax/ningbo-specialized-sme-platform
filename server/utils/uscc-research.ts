/**
 * **缺统一社会信用代码企业：待查清单 + 库内核心词候选 + 可执行补录计划**（RL-06）。
 *
 * ── 用户的原始方法（顺序有意义：**先库内、后平台**）──────────────────────
 *
 *   ① 从公布名抓核心词（`coreWordOf`：去区划前缀 + 去组织形式后缀）；
 *   ② 在**我们自己的库**里搜这个词（企业**现名** + **已确认曾用名** —— 曾用名表就是匹配字典的一部分）；
 *   ③ 代理从命中的候选里判断哪些最可能是同一家，**取它的统一社会信用代码**；
 *   ④ 拿这个统代**去平台按统代查**（`businessList` rdjb=1/2/3 + `queryList`）验证；
 *   ⑤ 关系里 `qymc` **逐字等于**公布名 ⇒ 独立原始证据成立 ⇒ 回填统代 + 建曾用名。
 *
 * 库内搜不出时才退到**辅助**手段：平台 `queryList?qymc=<名称>` 子串反查（`claim` 那条路）。
 *
 * ── 红线：本模块**不是**模糊推断引擎 ────────────────────────────────────
 * 名称（核心词）**只出现在第 ② 步「生成候选」**。第 ③→⑤ 步一件相似度判断都没有：
 *  - 候选只要**唯一一个**能被平台原始关系逐字证实，就补录；**两个都自称这个名字** ⇒ 冲突待核；
 *  - **一个都证不出来** ⇒ 待人工（**绝不**按名字挑一个最像的）；
 *  - 库里搜不到候选 ⇒ 未找到。
 * 全库没有任何编辑距离、相似度打分或「像即同一家」的判据；每个补录都能指回一条 `platform_relation`
 * 行（`source_ref_id`）或一条带 URL/日期的公开来源。
 *
 * ── 只读 ───────────────────────────────────────────────────────────────
 * 本模块不写一行。可执行项编成契约 §8.3 的 `payload`（`merges` + `usccBackfills`），
 * 经 `POST /api/roster/import/commit` 落库 —— 与其它写入**同一条**路径、同一份幂等键语义。
 */
import { createHash } from 'node:crypto'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '../../db/schema'
import { normalizeName, normalizeUscc } from '../../lib/domain'
import {
  coreWordOf,
  isByteEqualName,
  judgeUsccClaim,
  nameMatchLevel,
  missingUsccSourceFields,
  PLATFORM_INTERFACE_URLS,
  usccFormatVerdict,
  type NameMatchLevel,
  type UsccChecklistFilter,
  type UsccChecklistResult,
  type UsccChecklistRow,
  type UsccInterfaceTrace,
  type UsccLibraryCandidate,
  type UsccQueryTrace,
  type UsccPlatformClaim,
  type UsccResearchClaim,
  type UsccSourceEvidence,
  type UsccTargetOutcome,
} from '../../lib/roster/uscc-research'
import type {
  RosterImportMerge,
  RosterImportPlatformQuery,
  RosterImportRelation,
  RosterImportRequest,
  RosterImportUsccBackfill,
  RosterPlatformRef,
} from '../../lib/roster-import-client'
import { allRosterEnterprises } from '../../lib/roster/enterprise-roster'
import type { DuplicateMergeEvidence } from '../../lib/roster/duplicate-merge'
import { TITLE_ORDER } from '../../lib/labels'
import { MAX_PAGE_SIZE } from '../../lib/query'
import { findExportSideName, buildPlatformEvidenceIndex, findUsccKeyedRelationEvidence } from './roster-duplicate-merge'

type Db = BetterSQLite3Database<typeof schema>

const DEFAULT_PAGE_SIZE = 50

// ---------------------------------------------------------------------------
// 待查清单（票面：企业名 / 地区 / 称号 / 来源文件与可用页码 / 接口匹配追溯）
// ---------------------------------------------------------------------------

/**
 * 取**全部**仍缺统代的企业（不分页）—— 清单与计划共用这一处取数。
 *
 * 为什么要抽出来：`allRosterEnterprises`（RL-04 的读模型）一次要读全表并给每家企业建画像，
 * 实测真实库上约 3.3 秒。读接口既要返回分页清单、又要返回计划，若各取一次就是两遍全表扫描
 * （这正是「接口 20 秒」的来源）。所以**取数只做一次**，分页与计划都在这份行上算。
 */
export function collectUsccTargets(
  db: Db,
  filter: Omit<UsccChecklistFilter, 'page' | 'pageSize'> = {},
): UsccChecklistRow[] {
  const { rows: rosterRows } = allRosterEnterprises(db, { rosterState: 'current' })
  const missing = rosterRows.filter((row) => !normalizeUscc(row.uscc))

  const snap = readSnapshot(db)
  const recordsByEnterprise = new Map<number, (typeof snap.records)[number][]>()
  for (const record of snap.records) {
    const bucket = recordsByEnterprise.get(record.enterpriseId)
    if (bucket) bucket.push(record)
    else recordsByEnterprise.set(record.enterpriseId, [record])
  }
  // 索引一次后再按企业取：出处要沿 record → event → evidence 走三层，
  // 逐企业在全表里 filter 会把 133 × 记录数 × 事件数 × 出处数 变成天文数字。
  const eventsByRecord = new Map<number, (typeof snap.events)[number][]>()
  for (const event of snap.events) {
    const bucket = eventsByRecord.get(event.recordId)
    if (bucket) bucket.push(event)
    else eventsByRecord.set(event.recordId, [event])
  }
  const evidenceByEvent = new Map<number, (typeof snap.evidence)[number][]>()
  for (const item of snap.evidence) {
    const bucket = evidenceByEvent.get(item.recordEventId)
    if (bucket) bucket.push(item)
    else evidenceByEvent.set(item.recordEventId, [item])
  }
  const tracesByEnterprise = new Map<number, UsccInterfaceTrace[]>()
  for (const row of currentTraces(snap)) {
    const bucket = tracesByEnterprise.get(row.enterpriseId)
    if (bucket) bucket.push(row)
    else tracesByEnterprise.set(row.enterpriseId, [row])
  }
  // 平台**按名**查过的查询（`queryKey = name:<nameNorm>`）—— 无统代企业唯一可能查得到的形态。
  const nameQueries = snap.queries.filter((query) => query.queryKey.startsWith('name:'))
  const relationsByQuery = new Map<number, number>()
  for (const relation of snap.relations) {
    relationsByQuery.set(relation.queryId, (relationsByQuery.get(relation.queryId) ?? 0) + 1)
  }
  const queryTraceByEnterprise = new Map<number, UsccQueryTrace[]>()
  for (const query of nameQueries) {
    const norm = query.queryKey.slice('name:'.length)
    for (const enterprise of snap.enterprises) {
      if (enterprise.nameNorm !== norm) continue
      const bucket = queryTraceByEnterprise.get(enterprise.id) ?? []
      bucket.push({
        interface: query.interface,
        queryKey: query.queryKey,
        rdjb: query.rdjb,
        queriedAt: query.queriedAt,
        status: query.status,
        relationCount: relationsByQuery.get(query.id) ?? 0,
      })
      queryTraceByEnterprise.set(enterprise.id, bucket)
    }
  }

  const rows: UsccChecklistRow[] = missing.map((row) => {
    const evidence: UsccSourceEvidence[] = []
    for (const record of recordsByEnterprise.get(row.enterpriseId) ?? []) {
      for (const event of eventsByRecord.get(record.id) ?? []) {
        for (const item of evidenceByEvent.get(event.id) ?? []) {
          evidence.push({
            titleCode: record.titleCode,
            sourceFile: item.sourceFile,
            attachment: item.attachment,
            listNo: item.listNo,
            page: item.page,
          })
        }
      }
    }
    return {
      enterpriseId: row.enterpriseId,
      name: row.name,
      district: row.district,
      city: row.city,
      titles: row.titles,
      aliasNames: row.aliasNames,
      traces: (tracesByEnterprise.get(row.enterpriseId) ?? []).sort(
        (a, b) => titleRank(a.titleCode) - titleRank(b.titleCode) || a.direction.localeCompare(b.direction),
      ),
      evidence: evidence.sort(
        (a, b) =>
          titleRank(a.titleCode) - titleRank(b.titleCode) ||
          a.sourceFile.localeCompare(b.sourceFile) ||
          (a.listNo ?? 0) - (b.listNo ?? 0) ||
          (a.page ?? 0) - (b.page ?? 0),
      ),
      queries: (queryTraceByEnterprise.get(row.enterpriseId) ?? []).sort((a, b) =>
        a.queriedAt < b.queriedAt ? -1 : a.queriedAt > b.queriedAt ? 1 : 0,
      ),
      coreWord: coreWordOf(row.name),
    }
  })

  const needle = filter.q?.trim() ? normalizeName(filter.q) : null
  return rows
    .filter((row) => {
      if (filter.title?.length && !row.titles.some((title) => filter.title!.includes(title))) return false
      if (filter.district && row.district !== filter.district) return false
      if (needle) {
        const hit =
          normalizeName(row.name).includes(needle) ||
          row.aliasNames.some((alias) => normalizeName(alias).includes(needle))
        if (!hit) return false
      }
      return true
    })
    .sort((a, b) => titleRank(a.titles[0] ?? '') - titleRank(b.titles[0] ?? '') || a.enterpriseId - b.enterpriseId)
}

/**
 * **待查清单**：仍缺统一社会信用代码的企业。
 *
 * 判据是**「缺统代」**（`enterprise.uscc_norm IS NULL`，与 `GET /api/quality?kind=uscc_missing`
 * 同一口径）**且仍在当前总表里**（`rosterState === 'current'`）。「接口曾用名匹配后仍未解决」
 * 在数据上就落在这里：实测库里 133 家无统代企业**全部**停在 `not_queried`（平台两接口按
 * `tyshxydm` 取数，无统代直查不了），所以两者是同一集合 —— 但清单**按缺统代筛**，
 * 因为那才是「还没解决」的定义，而「未查询」只是它当前的表现。补齐/归并之后该企业自然
 * 离开清单（票面第 6 条），不需要额外的排除规则。
 *
 * 每行带上「为什么它还没解决」：① `traces`（该企业的差异解释行，状态机取值原样）；
 * ② `queries`（以它为查询键的平台查询 —— 无统代时通常查不了，有 `name:` 查询时照实列出）；
 * ③ `evidence`（公布来源，带页码，供人工回到原文核对）。
 */
export function listUsccChecklist(db: Db, filter: UsccChecklistFilter = {}): UsccChecklistResult {
  return pageUsccChecklist(collectUsccTargets(db, filter), filter)
}

/** 在**已取好的**清单行上分页（与 `listUsccChecklist` 同一口径，只是不重复全表扫描）。 */
export function pageUsccChecklist(
  targets: readonly UsccChecklistRow[],
  filter: Pick<UsccChecklistFilter, 'page' | 'pageSize'> = {},
): UsccChecklistResult {
  const titles: Record<string, number> = Object.fromEntries(TITLE_ORDER.map((code) => [code, 0]))
  for (const row of targets) for (const code of row.titles) titles[code] = (titles[code] ?? 0) + 1

  const page = Number.isFinite(filter.page) && (filter.page as number) >= 1 ? Math.floor(filter.page as number) : 1
  const size =
    Number.isFinite(filter.pageSize) && (filter.pageSize as number) >= 1
      ? Math.min(Math.floor(filter.pageSize as number), MAX_PAGE_SIZE)
      : DEFAULT_PAGE_SIZE
  return {
    rows: [...targets].slice((page - 1) * size, page * size),
    counts: { total: targets.length, titles },
    page,
    pageSize: size,
  }
}

function titleRank(code: string): number {
  const i = TITLE_ORDER.indexOf(code)
  return i === -1 ? TITLE_ORDER.length : i
}

/**
 * 每 (企业 × 称号 × 方向) 的**当前**解释 = `recordedAt` 最新那条。
 * 与读侧（`lib/roster/enterprise-roster.ts` 的 `currentExplanations`）同一口径。
 */
function currentTraces(snap: Snapshot): UsccInterfaceTrace[] {
  const current = new Map<string, (typeof snap.differences)[number]>()
  for (const row of snap.differences) {
    const key = `${row.enterpriseId}|${row.titleCode}|${row.direction}`
    const kept = current.get(key)
    if (!kept || row.recordedAt > kept.recordedAt) current.set(key, row)
  }
  return [...current.values()].map((row) => ({
    explanationId: row.id,
    enterpriseId: row.enterpriseId,
    titleCode: row.titleCode,
    direction: row.direction,
    status: row.status,
    reasonCode: row.reasonCode,
    reasonNote: row.reasonNote,
  }))
}

interface Snapshot {
  enterprises: (typeof schema.enterprise)['$inferSelect'][]
  records: (typeof schema.record)['$inferSelect'][]
  events: (typeof schema.recordEvent)['$inferSelect'][]
  evidence: (typeof schema.recordEvidence)['$inferSelect'][]
  aliases: (typeof schema.enterpriseAlias)['$inferSelect'][]
  queries: (typeof schema.platformQuery)['$inferSelect'][]
  relations: (typeof schema.platformRelation)['$inferSelect'][]
  differences: (typeof schema.differenceReason)['$inferSelect'][]
}

function readSnapshot(db: Db): Snapshot {
  return {
    enterprises: db.select().from(schema.enterprise).all(),
    records: db.select().from(schema.record).all(),
    events: db.select().from(schema.recordEvent).all(),
    evidence: db.select().from(schema.recordEvidence).all(),
    aliases: db.select().from(schema.enterpriseAlias).all(),
    queries: db.select().from(schema.platformQuery).all(),
    relations: db.select().from(schema.platformRelation).all(),
    differences: db.select().from(schema.differenceReason).all(),
  }
}

// ---------------------------------------------------------------------------
// 库内匹配字典（②：现名 + 已确认曾用名）
// ---------------------------------------------------------------------------

/** 字典里的一家**有统代**企业：它的全部可用名字（现名 + 已确认曾用名）。 */
interface DictionaryEntry {
  enterpriseId: number
  name: string
  nameNorm: string
  uscc: string
  district: string | null
  /** 名称 → 命中方式（现名 / 已确认曾用名）。 */
  names: Array<{ value: string; norm: string; matchedBy: 'name' | 'alias' }>
}

/**
 * 建**匹配字典**：库里全部**有统代**企业 + 它们的**已确认**曾用名。
 *
 * 为什么必须含已确认曾用名：用户 2026-10-16 明确「这次过后这个名称就会进入曾用名表中，
 * 之后就能匹配上了」—— 曾用名表**就是**匹配字典的一部分；`pending` 的别名**不入字典**
 * （契约 §1.2：未确认的别名不参与搜索/归并，证据不足宁可待核）。
 */
function buildDictionary(db: Db): DictionaryEntry[] {
  const entries = new Map<number, DictionaryEntry>()
  for (const enterprise of db.select().from(schema.enterprise).all()) {
    const uscc = normalizeUscc(enterprise.usccNorm)
    if (!uscc) continue
    entries.set(enterprise.id, {
      enterpriseId: enterprise.id,
      name: enterprise.name,
      nameNorm: enterprise.nameNorm,
      uscc,
      district: enterprise.district,
      names: [{ value: enterprise.name, norm: enterprise.nameNorm, matchedBy: 'name' }],
    })
  }
  for (const alias of db.select().from(schema.enterpriseAlias).all()) {
    if (alias.verificationStatus !== 'confirmed') continue
    const entry = entries.get(alias.enterpriseId)
    if (!entry) continue
    if (!alias.nameNorm || !alias.name.trim()) continue
    if (entry.names.some((item) => item.norm === alias.nameNorm && item.value === alias.name)) continue
    entry.names.push({ value: alias.name, norm: alias.nameNorm, matchedBy: 'alias' })
  }
  return [...entries.values()]
}

/**
 * 库内核心词检索（用户方法的 ①→②）：找出「现名或**已确认**曾用名包含目标核心词」的有统代企业。
 *
 * **唯一的判据是「字符串包含」**——没有相似度、没有编辑距离、没有拼音。命中只说明
 * 「值得拿它的统代去平台问一问」，**不说明**是同一家（那是第 ④⑤ 步的事）。
 * 目标自己没有核心词（空名 / 只剩前后缀）时返回 `[]`（不拿全名去猜）。
 */
export function findLibraryCandidates(
  target: { enterpriseId: number; name: string; coreWord?: string },
  dictionary: readonly DictionaryEntry[],
): UsccLibraryCandidate[] {
  const coreWord = target.coreWord ?? coreWordOf(target.name)
  if (!coreWord) return []
  const out: UsccLibraryCandidate[] = []
  for (const entry of dictionary) {
    if (entry.enterpriseId === target.enterpriseId) continue
    const hit = entry.names.find((item) => item.value.includes(coreWord))
    if (!hit) continue
    out.push({
      enterpriseId: entry.enterpriseId,
      name: entry.name,
      uscc: entry.uscc,
      district: entry.district,
      matchedBy: hit.matchedBy,
      matchedName: hit.value,
      matchedCoreWord: coreWord,
    })
  }
  return out.sort((a, b) => a.enterpriseId - b.enterpriseId)
}

// ---------------------------------------------------------------------------
// 计划（只读；产出可提交的 payload）
// ---------------------------------------------------------------------------

/** 一条**可以执行**的补齐项。`merge` / `backfill` 至少给其一。 */
export interface UsccResearchReady {
  outcome: 'filled'
  targetId: number
  targetName: string
  /**
   * 候选是**怎么找到的**：
   *  - `library` —— 库内核心词检索命中候选，再由平台按统代逐字证实；
   *  - `platform_claim` —— 批次判断代理的判定文件带来候选统代（库里可能还没有那条关系）；
   *  - `public_source` —— 公开来源查证（票面路径二）。
   */
  route: 'library' | 'platform_claim' | 'public_source'
  /** 库内候选（`library` 之外为空数组）。 */
  candidates: UsccLibraryCandidate[]
  /** 被平台原始关系证实的**那一个**候选（候选多个时说明凭什么是它：凭证据，不凭名字像）。 */
  chosen: UsccLibraryCandidate | null
  uscc: string
  /** 让身份成立的那条**平台原始关系**（库里已有 ⇒ 真实行；批内新写 ⇒ 见 `evidenceRef`）。 */
  evidence: DuplicateMergeEvidence | null
  /** 批内新写时的**自然键**（契约 §8.7）；库里已有真实行时为 `null`。 */
  evidenceRef: RosterPlatformRef | null
  /**
   * 本项需要**写入**的平台查询（判定文件带来证据、库里还没有时）；否则 `null`。
   *
   * 一个认领可能带多组证据（`business_list rdjb=2`、`query_list` …），**整组**都写，
   * 所以这里是数组。
   */
  platformQueries: RosterImportPlatformQuery[]
  /** 便捷字段 = `platformQueries[0] ?? null`（只关心「有没有新证据」时看它）。 */
  platformQuery: RosterImportPlatformQuery | null
  /**
   * 规范行上**已经有**同名（`name_norm`）的 `confirmed` 曾用名 ⇒ 本轮**不再写**第二条
   * （只并身份，不重复留名）。见 `hasConfirmedAlias` 的注释。
   */
  aliasAlreadyPresent: boolean
  /** 规范行（该统代的企业行）已存在 ⇒ 归并（§8.4）。 */
  merge: RosterImportMerge | null
  /** 该统代库里还没有任何一行持有 ⇒ 只补一个缺失值（§8.10）。 */
  backfill: RosterImportUsccBackfill | null
}

/** 一条**不能执行**的目标：逐条给可读理由，绝不静默跳过。 */
export interface UsccResearchPending {
  targetId: number
  targetName: string
  outcome: 'conflict' | 'not_found' | 'manual'
  code: string
  message: string
  candidates: UsccLibraryCandidate[]
}

export interface UsccResearchReport {
  counts: {
    /** 本清单里的目标数（缺统代、仍在当前总表）。 */
    targets: number
    /** 库内核心词命中过候选的家数（含最终未补齐的）。 */
    withCandidates: number
    filled: number
    conflict: number
    notFound: number
    manual: number
    /** **闭合数量** = 本次补齐的家数（写完这些目标就不再缺统代）。 */
    closed: number
    /** 补齐走的是哪条路。 */
    byRoute: { library: number; platform_claim: number; public_source: number }
    /** 可执行项（写入载荷里的条数）。 */
    ready: number
    /** 其中「规范行已有同名 confirmed 曾用名 ⇒ 不再重复写别名」的条数。 */
    aliasAlreadyPresent: number
  }
  /** 按目标逐条给出结论（`filled` / `conflict` / `not_found` / `manual` 四桶）。 */
  outcomes: UsccTargetOutcome[]
  ready: UsccResearchReady[]
  pending: UsccResearchPending[]
  /**
   * 可直接 **POST `/api/roster/import/commit`** 的请求体（含幂等键）。
   * 没有任何可执行项时是 `null`（**不发空批**：空载荷只会白记一条批次）。
   */
  request: RosterImportRequest | null
}

export interface UsccResearchOptions {
  /** 公开来源查证结果（票面路径二）。不传则只跑库内路径。 */
  claims?: UsccResearchClaim[]
  /**
   * **平台证据认领**（路径一 ④⑤）：批次判断代理的判定文件经 {@link normalizeUsccVerdicts}
   * 归一化后从这里进来。文件只是线索 —— 证据仍要在库里对得上（见处理块的注释）。
   */
  platformClaims?: UsccPlatformClaim[]
  /** 只处理这些企业（按 id）；不传则处理清单里的全部。 */
  enterpriseIds?: number[]
  /**
   * 已经取好的清单行（清单筛选已在里面做过）。**读接口与计划共用一次全表扫描**时用
   * —— 不传则自己取（`collectUsccTargets`）。
   */
  targets?: readonly UsccChecklistRow[]
  /** 清单筛选（`q` / `title` / `district`）—— 与读接口共用同一份口径。传给 `collectUsccTargets`。 */
  filter?: Omit<UsccChecklistFilter, 'page' | 'pageSize'>
}

/** 幂等键：**公开来源查证内容**的哈希 ⇒ 同证据重放不增行，补了新证据才是新批次。 */
export function usccResearchIdempotencyKey(entries: unknown): string {
  const digest = createHash('sha256').update(JSON.stringify(entries)).digest('hex').slice(0, 16)
  return `uscc_research#sha256:${digest}`
}

/** 来源身份（逻辑标识，**不含凭证**）。 */
export const USCC_RESEARCH_SOURCE_IDENTITY = 'roster/uscc-research'

/**
 * 出一份**只读**的补录计划：清单 → 库内候选 → 平台原始关系证据 → 可提交载荷。
 *
 * ── 一个目标怎么落桶（四桶互斥、逐条有理由）──────────────────────────────
 *
 * | 情形 | 结论 |
 * |---|---|
 * | 公开来源 claim 带来一个**库里没人占用**的合法统代 | `filled`（`usccBackfills`，路径二） |
 * | claim 的代码被别的企业占用 / 格式不合法 / 地区不符 | `conflict` |
 * | claim 证据三要素不齐 | `manual` |
 * | 库内核心词**搜不到**候选 | `not_found` |
 * | 有候选，但**没有一个**被平台原始关系逐字证实 | `manual`（**不按名字挑最像的**） |
 * | **恰好一个**候选被逐字证实 | `filled`（`merges`，路径一） |
 * | **两个及以上**不同统代都被逐字证实 | `conflict`（**同名多主体**，不猜） |
 *
 * ── 同一轮内也要收敛 ───────────────────────────────────────────────────
 * 第 ⑤ 步写出的曾用名**立刻进字典**：某目标一旦被补齐，它的名字就成为规范行的一条已确认曾用名，
 * 于是**本轮**后续目标的核心词检索就能命中它（用户：「之后就能匹配上了」）。实现方式是
 * 反复扫未决目标直到某一轮没有任何新补齐 —— 不把收敛推到「下一次运行」。
 *
 * ── 只读 ───────────────────────────────────────────────────────────────
 * 全程不写库；`merges` / `usccBackfills` 只是**载荷**，落库仍由统一导入 API 完成。
 */
export function planUsccResearch(db: Db, options: UsccResearchOptions = {}): UsccResearchReport {
  const allTargets = listAllTargets(db, options)
  // ── 范围：给了**认领**（公开来源 claim / 平台证据认领）就**只判这些目标** ──────────
  // 为什么必须这样：认领是「逐家查证的结果」，调用方要的是「把这些查到的写进去」。
  // 若还顺手跑全库库内计划，就会**顺带**把库内路径能解决的几十家也一起归并了 ——
  // 那不是这次要写的东西（真实数据上库内路径能并 31 家，全跑会让一次「判定文件写回」
  // 变成一次全量归并）。要全库跑就**不给认领**，或显式给 `enterpriseIds`。
  //
  // ⚠️ 范围必须按**认领最终落到的企业**来算，不能只看认领里那个数值 `enterpriseId`：
  // 认领也可以用 `enterpriseName` 指企业（§7.9 明写「或 `enterpriseName`」），
  // 而 `locateTarget` 会把它解析到某一家。若范围集只装数值 id，这种认领就会
  // **进了 `ready`/载荷、却不在 `targets` 里** ⇒ 不进 `outcomes`、四桶之和不等于
  // `counts.targets`、`counts.filled` 小于载荷条数。而且它还能绕过显式 `enterpriseIds`：
  // 认领里写另一个企业的名字，就把不在范围内的目标带进载荷了。
  // 所以先把认领**解析**成企业 id（与后面处理时同一个 `locateTarget`），再据此限定范围。
  const claimedTargetIds = new Set<number>()
  for (const claim of [...(options.claims ?? []), ...(options.platformClaims ?? [])]) {
    const resolvedTarget = locateTarget(allTargets, claim)
    if (resolvedTarget) claimedTargetIds.add(resolvedTarget.enterpriseId)
  }
  const restrict = options.enterpriseIds
    ? new Set(options.enterpriseIds)
    : options.claims?.length || options.platformClaims?.length
      ? claimedTargetIds
      : null
  const targets = allTargets.filter((row) => (restrict ? restrict.has(row.enterpriseId) : true))
  const dictionary = buildDictionary(db)
  // 证据查找的索引**只建一次**：判据不变，但不必对上百个候选各扫一遍平台两张表
  // （实测真实库上 `platform_relation` 一次全扫约 126ms）。
  const evidenceIndex = buildPlatformEvidenceIndex(db)

  const resolved = new Map<number, UsccResearchReady>()
  const pending = new Map<number, UsccResearchPending>()
  const candidateCount = new Map<number, number>()
  /**
   * **本计划内已经认领的统代** → 认领它的企业 id。
   *
   * 为什么必须查这一条：两条 claim 可能各自「看起来很干净」（库里此刻没有任何一行持有那个统代），
   * 于是双双进载荷。执行时第一条把代码补上，第二条就会撞唯一键 ⇒ 写入阶段报 `uscc_taken`、
   * 整批回滚 —— 结果没错但很吵，而且计划报的「补齐 2」跟提交真会发生的事对不上
   * （预检报的就是提交真会改的，这条不能破）。所以**在计划里就判掉**：同一轮第二个认领者
   * 直接落冲突。库内路径不需要这条 —— 那条路的多个目标都并进**同一个规范行**，本来就合法。
   */
  const claimedCodes = new Map<string, number>()

  // ---- 公开来源 claim（路径二）：先判，避免同一目标两条路都出结论 -------------
  for (const claim of options.claims ?? []) {
    const target = locateTarget(allTargets, claim)
    if (target && restrict && !restrict.has(target.enterpriseId)) {
      pending.set(target.enterpriseId, {
        targetId: target.enterpriseId,
        targetName: target.name,
        outcome: 'manual',
        code: 'out_of_scope',
        message: `本条目不在本次范围内（显式 enterpriseIds 未包含企业 ${target.enterpriseId}）⇒ 未处理`,
        candidates: [],
      })
      continue
    }
    if (!target) {
      // 找不到目标企业：如实报一条「待人工」，而不是静默丢掉这条查证结果。
      pending.set(claim.enterpriseId ?? -1, {
        targetId: claim.enterpriseId ?? -1,
        targetName: claim.enterpriseName ?? '(未指定)',
        outcome: 'manual',
        code: 'claim_target_not_found',
        message: `公开来源查证结果找不到归属企业：${claim.enterpriseId ?? claim.enterpriseName ?? '(空)'}`,
        candidates: [],
      })
      continue
    }
    const verdict = judgeUsccClaim(claim)
    if (!verdict.ok) {
      pending.set(target.enterpriseId, {
        targetId: target.enterpriseId,
        targetName: target.name,
        outcome: verdict.code === 'source_evidence_incomplete' ? 'manual' : 'conflict',
        code: verdict.code,
        message: verdict.message,
        candidates: [],
      })
      continue
    }
    const uscc = normalizeUscc(claim.uscc)
    const holder = findEnterpriseByUscc(db, uscc)
    if (holder && holder.id !== target.enterpriseId) {
      pending.set(target.enterpriseId, {
        targetId: target.enterpriseId,
        targetName: target.name,
        outcome: 'conflict',
        code: 'uscc_taken',
        message: `统代 ${uscc} 已被企业 ${holder.id}「${holder.name}」占用 ⇒ 冲突（不覆盖、不自动合并身份）`,
        candidates: [],
      })
      continue
    }
    const claimedBy = claimedCodes.get(uscc)
    if (claimedBy != null && claimedBy !== target.enterpriseId) {
      pending.set(target.enterpriseId, {
        targetId: target.enterpriseId,
        targetName: target.name,
        outcome: 'conflict',
        code: 'uscc_taken',
        message: `统代 ${uscc} 本轮已被企业 ${claimedBy} 认领 ⇒ 冲突（同一轮内不重复认领同一个代码，也不自动合并身份）`,
        candidates: [],
      })
      continue
    }
    claimedCodes.set(uscc, target.enterpriseId)
    resolved.set(target.enterpriseId, {
      outcome: 'filled',
      targetId: target.enterpriseId,
      targetName: target.name,
      route: 'public_source',
      candidates: [],
      chosen: null,
      uscc,
      evidence: null,
      evidenceRef: null,
      platformQueries: [],
      platformQuery: null,
      aliasAlreadyPresent: false,
      merge: null,
      backfill: {
        enterpriseId: target.enterpriseId,
        uscc,
        source: {
          url: claim.source.url.trim(),
          checkedOn: claim.source.checkedOn.trim(),
          basis: claim.source.basis.trim(),
          name: claim.source.name.trim(),
          region: claim.source.region ?? null,
        },
        note: claim.note ?? null,
      },
    })
  }

  // ---- 平台证据认领（路径一 ④⑤；批次判断代理的判定文件走这条）---------------
  //
  // ⚠️ **判定文件只是线索，不是证据**：文件说 `resolved` / `qymcEqualsAnnouncedName=true` 都不算数，
  // 这里要**在库里对得上**才算 —— 库里已有那条关系就直接用；库里还没有、而文件带来了
  // `evidence` 摘要，就把这批查询/关系**连同证据指针一起写进同一批**（§8.7 的批内自然键），
  // 归属由本批自己写下的行证明。两边都没有 ⇒ **不写**（`no_platform_evidence`）。
  for (const claim of options.platformClaims ?? []) {
    const target = locateTarget(allTargets, claim)
    // 解析到企业、却**不在本次范围**内（调用方显式给了 `enterpriseIds`）⇒ 如实报一条，
    // 不静默丢掉这份判定结果。
    if (target && restrict && !restrict.has(target.enterpriseId)) {
      pending.set(target.enterpriseId, {
        targetId: target.enterpriseId,
        targetName: target.name,
        outcome: 'manual',
        code: 'out_of_scope',
        message: `本条目不在本次范围内（显式 enterpriseIds 未包含企业 ${target.enterpriseId}）⇒ 未处理`,
        candidates: [],
      })
      continue
    }
    if (!target) {
      pending.set(claim.enterpriseId ?? -2, {
        targetId: claim.enterpriseId ?? -2,
        targetName: claim.enterpriseName ?? '(未指定)',
        outcome: 'manual',
        code: 'claim_target_not_found',
        message: `平台证据认领找不到归属企业：${claim.enterpriseId ?? claim.enterpriseName ?? '(空)'}`,
        candidates: [],
      })
      continue
    }
    const uscc = normalizeUscc(claim.uscc)
    if (usccFormatVerdict(claim?.uscc) !== 'ok' || !uscc) {
      pending.set(target.enterpriseId, {
        targetId: target.enterpriseId,
        targetName: target.name,
        outcome: 'conflict',
        code: 'uscc_format_invalid',
        message: `统一社会信用代码 ${String(claim?.uscc ?? '(空)')} 的格式或校验位不合法（GB 32100-2015）`,
        candidates: [],
      })
      continue
    }
    const holder = findEnterpriseByUscc(db, uscc)
    if (holder && holder.id === target.enterpriseId) {
      pending.set(target.enterpriseId, {
        targetId: target.enterpriseId,
        targetName: target.name,
        outcome: 'manual',
        code: 'already_resolved',
        message: `企业 ${target.enterpriseId} 已持有统代 ${uscc} ⇒ 无需再补（只补缺失值）`,
        candidates: [],
      })
      continue
    }
    const claimedBy = claimedCodes.get(uscc)
    if (claimedBy != null && claimedBy !== target.enterpriseId) {
      pending.set(target.enterpriseId, {
        targetId: target.enterpriseId,
        targetName: target.name,
        outcome: 'conflict',
        code: 'uscc_taken',
        message: `统代 ${uscc} 本轮已被企业 ${claimedBy} 认领 ⇒ 冲突（同一轮内不重复认领同一个代码，也不自动合并身份）`,
        candidates: [],
      })
      continue
    }

    // 证据解析：先看库里已有的关系，再看判定文件带来的摘要。
    // 判据：父代理 2026-10-16 裁定「归一化后相等即成立，A 类仍不抹平」——
    // 即逐字之外还认「全/半角括号与空白」与「区县后缀有无」两类**可命名的字形/写法差异**。
    // 实际命中到哪一档会记进 `evidence.nameMatch`，报告里能一眼看出哪些回填依赖放宽判据。
    const stored = findUsccKeyedRelationEvidence(db, { uscc, name: target.name }, evidenceIndex, nameMatchLevel)
    const supplied = pickSuppliedEvidence(claim, target.name, uscc)
    if (!stored.ok && !supplied) {
      const why = stored.reason === 'no_platform_query' ? '库里没有以该统代为查询键的平台查询' : stored.message
      pending.set(target.enterpriseId, {
        targetId: target.enterpriseId,
        targetName: target.name,
        outcome: 'manual',
        code: 'no_platform_evidence',
        message:
          `判定文件说 ${uscc} 就是本企业的统代，但**平台原始证据对不上**：${why}；` +
          '判定文件里也没有一条 qymc 逐字等于公布名的关系摘要 ⇒ 不写（文件不是证据）。',
        candidates: [],
      })
      continue
    }
    claimedCodes.set(uscc, target.enterpriseId)

    // 整组写：判定文件里该 (接口, rdjb) 的全部行都进同一条 `platform_query`，
    // 于是命中那一行的序号**必然**存在于写进去的那组里，锚点解析得到。
    const groups = stored.ok ? [] : groupSuppliedEvidence(claim)
    const anchorGroup = groups.find(
      (group) => group.interface === supplied!.interface && group.rdjb === supplied!.rdjb,
    )
    const anchorRelation =
      anchorGroup?.relations.find((relation) => relation.nameRaw === supplied!.nameRaw) ?? null
    const evidenceRef: RosterPlatformRef | null =
      stored.ok || !anchorRelation
        ? null
        : {
            interface: supplied!.interface,
            queryKey: uscc,
            rdjb: supplied!.rdjb,
            queriedAt: supplied!.queriedAt,
            sequenceNo: anchorRelation.sequenceNo,
            // **权威锚点**：序号只作参考，`relationKey` 说话（父代理 2026-10-16）。
            relationKey: anchorRelation.relationKey ?? null,
          }
    const platformQueries: RosterImportPlatformQuery[] = stored.ok
      ? []
      : groups.map((group) => ({
          interface: group.interface,
          queryKey: uscc,
          rdjb: group.rdjb,
          queriedAt: supplied!.queriedAt,
          status: 'success',
          failureReason: null,
          rawResponse: null,
          relations: group.relations,
        }))
    const platformQuery: RosterImportPlatformQuery | null = platformQueries[0] ?? null

    if (holder) {
      // 该统代已挂在另一家企业行上 ⇒ §5.2 的**归并**（不是 UPDATE：会撞 enterprise_uscc_norm_uq）。
      const exportName = findExportSideName(db, uscc)
      const canonicalName = exportName && exportName !== holder.name ? exportName : null
      const sameName = target.name === holder.name
      // ① 别名去重：规范行上已有同名 confirmed 别名 ⇒ 不再写第二条（只并身份，不重复留名）。
      const aliasAlreadyPresent = !sameName && hasConfirmedAlias(db, holder.id, target.name)
      resolved.set(target.enterpriseId, {
        outcome: 'filled',
        targetId: target.enterpriseId,
        targetName: target.name,
        route: 'platform_claim',
        candidates: [],
        chosen: null,
        uscc,
        evidence: stored.ok ? stored.evidence : null,
        evidenceRef,
        platformQueries,
        platformQuery,
        aliasAlreadyPresent,
        merge: {
          fromEnterpriseId: target.enterpriseId,
          intoUscc: uscc,
          ...(canonicalName ? { canonicalName } : {}),
          ...(sameName || aliasAlreadyPresent ? {} : { aliasName: target.name }),
          sourceKind: supplied?.sourceKind ?? 'platform_business',
          ...(evidenceRef ? { sourceRelationRef: evidenceRef } : { sourceRefId: stored.ok ? stored.evidence.relationId : 0 }),
          ...(evidenceRef
            ? {
                evidenceQueryRef: {
                  interface: evidenceRef.interface,
                  queryKey: uscc,
                  rdjb: evidenceRef.rdjb,
                  queriedAt: evidenceRef.queriedAt,
                },
              }
            : stored.ok
              ? { evidenceQueryId: stored.evidence.queryId }
              : {}),
          note:
            `平台证据认领（${claim.batchRef ?? '判定文件'}）：${describeEvidenceLine(stored, supplied)}` +
            `${claim.reason ? `；判定依据：${claim.reason}` : ''}` +
            `${claim.flagState && claim.flagState !== 'true' ? `；⚠ 判定文件里 qymcEqualsAnnouncedName ${claim.flagState === 'absent' ? '缺席' : '标 false'}（采纳依据是库里对得上的关系，不是这句话）` : ''}`,
        },
        backfill: null,
      })
      if (!sameName) {
        const entry = dictionary.find((item) => item.enterpriseId === holder.id)
        if (entry && !entry.names.some((item) => item.value === target.name)) {
          entry.names.push({ value: target.name, norm: normalizeName(target.name), matchedBy: 'alias' })
        }
      }
      continue
    }

    // 库里没有任何一行持有该统代 ⇒ 只补一个缺失值（§8.10）。
    // **不写曾用名**：判据要求 `qymc` 逐字等于本企业名，而本企业名不会因为补个统代而变 ——
    // 写出来的别名会与现名逐字相同，那是个自指的别名（§5.3 只在两侧名称不同时才留别名）。
    resolved.set(target.enterpriseId, {
      outcome: 'filled',
      targetId: target.enterpriseId,
      targetName: target.name,
      route: 'platform_claim',
      candidates: [],
      chosen: null,
      uscc,
      evidence: stored.ok ? stored.evidence : null,
      evidenceRef,
      platformQueries,
      platformQuery,
      aliasAlreadyPresent: false,
      merge: null,
      backfill: {
        enterpriseId: target.enterpriseId,
        uscc,
        // `usccBackfills.source` 的三要素是**公开来源**的形状；这一条的证据是**平台原始关系**，
        // 所以把 URL 位放平台接口地址、依据位放「哪条关系逐字相等」，如实说明来源是平台。
        source: {
          // 这一路的证据是**平台原始关系**，不是公开内容页：`url` 记平台接口地址，
          // `basis` 写清是哪条关系（§8.10 对两种证据的说明）。如实标出，不假装是内容页。
          url: PLATFORM_INTERFACE_URLS[supplied!.interface],
          checkedOn: supplied!.checkedOn,
          basis:
            `平台原始关系逐字证实：${describeEvidenceLine(stored, supplied)}` +
            `${claim.reason ? `；判定依据：${claim.reason}` : ''}` +
            `${claim.flagState && claim.flagState !== 'true' ? `；⚠ 判定文件里 qymcEqualsAnnouncedName ${claim.flagState === 'absent' ? '缺席' : '标 false'}（采纳依据是库里对得上的关系，不是这句话）` : ''}`,
          name: target.name,
          region: target.city ?? '宁波市',
        },
        note: `平台证据认领（${claim.batchRef ?? '判定文件'}）`,
      },
    })
  }

  // ---- 库内核心词 → 平台原始关系验证（路径一）------------------------------
  //
  // 反复扫未决目标，直到某一轮没有任何新的补齐：新写的曾用名**立刻**参与下一轮检索
  // （同一轮内收敛，见本节顶部）。轮数上限 = 目标数（每轮至少解决一个才会继续）。
  const unresolved = new Set(
    targets.filter((row) => !resolved.has(row.enterpriseId) && !pending.has(row.enterpriseId)).map((row) => row.enterpriseId),
  )
  const byId = new Map(targets.map((row) => [row.enterpriseId, row]))
  for (let pass = 0; pass < targets.length + 1 && unresolved.size > 0; pass += 1) {
    let progressed = false
    for (const targetId of [...unresolved]) {
      const target = byId.get(targetId)!
      const candidates = findLibraryCandidates(target, dictionary)
      if (candidates.length) candidateCount.set(targetId, candidates.length)
      if (!candidates.length) continue // 本轮先放进「未找到」，等曾用名字典长大后再扫
      // 拿候选统代**去平台按统代查**（已落库的查询/关系就是那次实查的证据）。
      const evidenced = new Map<string, { candidate: UsccLibraryCandidate; evidence: DuplicateMergeEvidence }>()
      for (const candidate of candidates) {
        const found = findUsccKeyedRelationEvidence(
          db,
          { uscc: candidate.uscc, name: target.name },
          evidenceIndex,
          nameMatchLevel,
        )
        if (found.ok && !evidenced.has(candidate.uscc)) {
          evidenced.set(candidate.uscc, { candidate, evidence: found.evidence })
        }
      }
      if (evidenced.size === 0) {
        // 有候选、却一条都证不出来 ⇒ **待人工**（绝不按名字挑一个最像的）。
        unresolved.delete(targetId)
        pending.set(targetId, {
          targetId,
          targetName: target.name,
          outcome: 'manual',
          code: 'candidate_without_platform_evidence',
          message:
            `库内核心词「${target.coreWord}」命中 ${candidates.length} 条候选` +
            `（${candidates.map((c) => `企业 ${c.enterpriseId}「${c.name}」`).join('、')}），` +
            '但没有一条候选的统代在**已落库的平台关系**里写出过逐字等于本企业名的 qymc ⇒ 证据不足，待人工核实。',
          candidates,
        })
        progressed = true
        continue
      }
      if (evidenced.size > 1) {
        // 两个及以上统代都自称这个名字 ⇒ **同名多主体**，不猜。
        unresolved.delete(targetId)
        pending.set(targetId, {
          targetId,
          targetName: target.name,
          outcome: 'conflict',
          code: 'multiple_subjects',
          message:
            `有 ${evidenced.size} 个不同统代的平台关系都写出 qymc 逐字等于「${target.name}」` +
            `（${[...evidenced.values()].map((item) => `${item.candidate.uscc}(企业 ${item.candidate.enterpriseId})`).join('、')}）` +
            '⇒ 同名多主体，不猜是哪一家。',
          candidates,
        })
        progressed = true
        continue
      }
      const picked = [...evidenced.values()][0]!
      const { candidate, evidence } = picked
      const into = findEnterpriseByUscc(db, candidate.uscc)
      if (!into) {
        // 候选来自字典（字典只装**有统代**的企业），走到这里说明库在计划期间变了。
        unresolved.delete(targetId)
        pending.set(targetId, {
          targetId,
          targetName: target.name,
          outcome: 'manual',
          code: 'candidate_gone',
          message: `候选统代 ${candidate.uscc} 的企业行在计划期间不在了 ⇒ 待人工复核`,
          candidates,
        })
        progressed = true
        continue
      }
      // 主名称（§5.3 ①）：导出表侧记了另一个现名 ⇒ 显式带 `canonicalName`；取不到就不改名。
      const exportName = findExportSideName(db, candidate.uscc)
      const canonicalName = exportName && exportName !== into.name ? exportName : null
      const sameName = target.name === into.name
      // ① 别名去重（同上）：**库内按曾用名命中的那条路尤其容易撞** —— 名字既然能命中，
      // 说明它本来就已经是规范行的别名了，再写一条只是把同一个名字留第二遍。
      const aliasAlreadyPresent = !sameName && hasConfirmedAlias(db, into.id, target.name)
      resolved.set(targetId, {
        outcome: 'filled',
        targetId,
        targetName: target.name,
        route: 'library',
        candidates,
        chosen: candidate,
        uscc: candidate.uscc,
        evidence,
        evidenceRef: null,
        platformQueries: [],
        platformQuery: null,
        aliasAlreadyPresent,
        merge: {
          fromEnterpriseId: targetId,
          intoUscc: candidate.uscc,
          ...(canonicalName ? { canonicalName } : {}),
          ...(sameName || aliasAlreadyPresent ? {} : { aliasName: target.name }),
          sourceKind: evidence.sourceKind,
          sourceRefId: evidence.relationId,
          evidenceQueryId: evidence.queryId,
          note:
            `库内核心词「${target.coreWord}」命中企业 ${candidate.enterpriseId}「${candidate.matchedName}」；` +
            `证据：${evidence.interface}${evidence.rdjb ? ` rdjb=${evidence.rdjb}` : ''} 序号 ${evidence.sequenceNo}` +
            `${evidence.relationKey ? `（${evidence.relationKey}）` : ''} 于 ${evidence.queriedAt} 返回的 qymc 逐字等于「${evidence.nameRaw}」`,
        },
        backfill: null,
      })
      // 第 ⑤ 步写出的曾用名**立刻进字典** ⇒ 同一轮内后续目标即可命中（自我增强）。
      if (!sameName) {
        const entry = dictionary.find((item) => item.enterpriseId === into.id)
        if (entry && !entry.names.some((item) => item.value === target.name)) {
          entry.names.push({ value: target.name, norm: normalizeName(target.name), matchedBy: 'alias' })
        }
      }
      unresolved.delete(targetId)
      progressed = true
    }
    if (!progressed) break
  }
  // 扫完之后仍未决的：库内核心词一个候选都搜不到 ⇒ **未找到**。
  for (const targetId of unresolved) {
    const target = byId.get(targetId)!
    pending.set(targetId, {
      targetId,
      targetName: target.name,
      outcome: 'not_found',
      code: 'no_candidate',
      message: target.coreWord
        ? `库内核心词「${target.coreWord}」在现名与已确认曾用名里都搜不到候选 ⇒ 未找到（下一步退到平台 queryList?qymc= 子串反查）`
        : `企业名「${target.name}」抓不出核心词（只剩区划前缀/组织形式后缀）⇒ 无法做库内检索`,
      candidates: [],
    })
  }

  // ---- 汇总 ---------------------------------------------------------------
  const ready = [...resolved.values()].sort((a, b) => a.targetId - b.targetId)
  const pendingRows = [...pending.values()].sort((a, b) => a.targetId - b.targetId)
  // 逐条给出结论：以 `targets` 为分母。**保险丝**：若还有解析到企业的结论不在 `targets` 里
  // （范围算错、或将来加了新的认领种类），按 id 补进来 —— 四桶之和不等于 `counts.targets`
  // 是这份报告最不能出的错（「预检报的就是提交真会改的」从这句开始）。
  const covered = new Set(targets.map((row) => row.enterpriseId))
  const extra = [...new Set([...resolved.keys(), ...pending.keys()])]
    .filter((id) => id > 0 && !covered.has(id))
    .map((id) => allTargets.find((row) => row.enterpriseId === id) ?? null)
    .filter((row): row is UsccChecklistRow => row != null)
  const outcomes: UsccTargetOutcome[] = []
  for (const row of [...targets, ...extra]) {
    const filled = resolved.get(row.enterpriseId)
    if (filled) {
      outcomes.push({
        enterpriseId: row.enterpriseId,
        name: row.name,
        outcome: 'filled',
        code: filled.route,
        message:
          filled.route === 'library'
            ? `库内核心词「${row.coreWord}」命中候选企业 ${filled.chosen?.enterpriseId ?? ''}「${filled.chosen?.matchedName ?? ''}」，` +
              `其统代 ${filled.uscc} 在已落库的平台关系（${filled.evidence?.interface ?? ''}` +
              `${filled.evidence?.rdjb ? ` rdjb=${filled.evidence.rdjb}` : ''} 序号 ${filled.evidence?.sequenceNo ?? ''}` +
              `${filled.evidence?.relationKey ? ` ${filled.evidence.relationKey}` : ''}）里的 qymc 逐字等于企业名 ⇒ ` +
              (filled.aliasAlreadyPresent ? '规范行已有同名曾用名 ⇒ 只并身份、不重复写别名' : '归并补录')
            : `公开来源查证给出统代 ${filled.uscc} ⇒ 补录（来源 ${filled.backfill?.source.url ?? ''}）`,
        candidates: filled.candidates,
        uscc: filled.uscc,
      })
      continue
    }
    const row2 = pending.get(row.enterpriseId)
    if (row2) {
      outcomes.push({
        enterpriseId: row.enterpriseId,
        name: row.name,
        outcome: row2.outcome,
        code: row2.code,
        message: row2.message,
        candidates: row2.candidates,
        uscc: null,
      })
      continue
    }
    outcomes.push({
      enterpriseId: row.enterpriseId,
      name: row.name,
      outcome: 'manual',
      code: 'not_evaluated',
      message: '本目标未被评估（可能被 enterpriseIds 之外的选项排除）',
      candidates: [],
      uscc: null,
    })
  }

  // 载荷顺序不敏感（写入侧的执行顺序固定：platformQueries → aliases → … → merges，见 §8.7.2），
  // 但**都必须在同一批里**，否则批内自然键引用解析不到（"有证据的曾用名"就会落成 0 哨兵）。
  const platformQueries = ready.flatMap((item) => item.platformQueries)
  const merges = ready.map((item) => item.merge).filter((item): item is RosterImportMerge => item != null)
  const backfills = ready.map((item) => item.backfill).filter((item): item is RosterImportUsccBackfill => item != null)

  const countOf = (outcome: UsccTargetOutcome['outcome']) => outcomes.filter((row) => row.outcome === outcome).length
  return {
    counts: {
      // 「本次计划覆盖的目标数」——给了 `enterpriseIds` 就是那几个（`outcomes` 与四桶计数
      // 都以此为分母，四者相加恒等于它；不受分页影响）。
      targets: outcomes.length,
      withCandidates: candidateCount.size,
      filled: countOf('filled'),
      conflict: countOf('conflict'),
      notFound: countOf('not_found'),
      manual: countOf('manual'),
      closed: countOf('filled'),
      byRoute: {
        library: ready.filter((item) => item.route === 'library').length,
        platform_claim: ready.filter((item) => item.route === 'platform_claim').length,
        public_source: ready.filter((item) => item.route === 'public_source').length,
      },
      ready: ready.length,
      aliasAlreadyPresent: ready.filter((item) => item.aliasAlreadyPresent).length,
    },
    outcomes,
    ready,
    pending: pendingRows,
    request:
      ready.length === 0
        ? null
        : {
            idempotencyKey: usccResearchIdempotencyKey({ platformQueries, merges, backfills }),
            sourceKind: 'alias_evidence',
            sourceIdentity: USCC_RESEARCH_SOURCE_IDENTITY,
            payload: {
              ...(platformQueries.length ? { platformQueries } : {}),
              ...(merges.length ? { merges } : {}),
              ...(backfills.length ? { usccBackfills: backfills } : {}),
            },
          },
  }
}

/** 清单（不分页）—— 计划要的是全部目标，不是当前页。 */
function listAllTargets(db: Db, options: UsccResearchOptions): UsccChecklistRow[] {
  return options.targets ? [...options.targets] : collectUsccTargets(db, options.filter ?? {})
}

/**
 * 认领归属的企业：给 id 用 id，否则按归一化名找。
 *
 * 两种认领（公开来源 `UsccResearchClaim` / 平台证据 `UsccPlatformClaim`）共用这一处 ——
 * 「这条认领讲的是哪家企业」只有一种解法，两边各写一遍迟早会漂。
 */
function locateTarget(
  targets: readonly UsccChecklistRow[],
  claim: { enterpriseId?: number; enterpriseName?: string },
): UsccChecklistRow | null {
  if (claim.enterpriseId != null) return targets.find((row) => row.enterpriseId === claim.enterpriseId) ?? null
  const norm = claim.enterpriseName ? normalizeName(claim.enterpriseName) : ''
  if (!norm) return null
  return targets.find((row) => normalizeName(row.name) === norm) ?? null
}

/**
 * 规范行上是不是**已经有**同名（`name_norm`）的已确认曾用名？
 *
 * 为什么要在计划里判这一条：`enterprise_alias` 的唯一键是
 * `(enterprise_id, name_norm, source_kind, source_ref_id)` —— 含 `source_ref_id`，
 * 所以「同一家企业、同一个名字、换一条来源关系」**不撞唯一键**，会实打实写出第二条别名行。
 * 那不算错（§1.2 有意让不同来源各自成条留证），但对**搜索与展示**是纯噪音：
 * 名字已经能被搜到、详情页上却同名并列两行。批次 5 实测 `335 / 783 / 1448` 三家就是这样。
 *
 * 所以：**写别名之前按 `(enterprise_id, name_norm)` 查一次**，已有 `confirmed` 的同名别名
 * 就不再写（并在报告里标 `aliasAlreadyPresent`）。只认 `confirmed`：`pending` 的同名别名
 * 换成 `confirmed` 是一次**升级**，该写还是要写。
 */
function hasConfirmedAlias(db: Db, enterpriseId: number, name: string): boolean {
  const norm = normalizeName(name)
  return db
    .select()
    .from(schema.enterpriseAlias)
    .all()
    .some((row) => row.enterpriseId === enterpriseId && row.nameNorm === norm && row.verificationStatus === 'confirmed')
}

/** 单条按统代找企业（与写入层同一个身份键；只读，返回最小形状）。 */
function findEnterpriseByUscc(db: Db, uscc: string): { id: number; name: string } | null {
  const row = db.select().from(schema.enterprise).all().find((e) => normalizeUscc(e.usccNorm) === uscc)
  return row ? { id: row.id, name: row.name } : null
}

// ---------------------------------------------------------------------------
// 平台证据认领的证据解析
// ---------------------------------------------------------------------------

/** 判定文件带来的一条**可用的**证据（字段已归一化；`queriedAt` 来自认领的 `observedAt`）。 */
interface SuppliedEvidence {
  interface: 'business_list' | 'apply_list'
  rdjb: string
  /**
   * 平台关联主键 —— **权威锚点**（父代理 2026-10-16：序号只作参考）。
   *
   * ⚠️ 这里**不再放序号**：序号是由「本次要写入的那一组」决定的（见 `groupSuppliedEvidence`），
   * 一条关系摘要单看不知道自己在组里排第几。真正的序号由 `anchorRelation.sequenceNo` 给出，
   * 审计文案改用 `relationKey` —— 它才是锚点，也不会因为组顺序变化而失真。
   */
  relationKey: string | null
  nameRaw: string
  status: string | null
  sourceKind: 'platform_business' | 'platform_apply'
  /** 名称比对到了哪一档（`byte` / `typographic` / `district_suffix`）。 */
  nameMatch: NameMatchLevel
  /** 代理实际发出的那次查询（如 `qymc=…`）；判定文件没给就留空。 */
  query: string | null
  queriedAt: string
  /** 公开来源形状的 `checkedOn`（`usccBackfills` 必填）—— 取产出时刻的日期部分。 */
  checkedOn: string
}

/**
 * 把一枚认领带来的证据**按 (接口, rdjb) 分组**，每组整组写进一条 `platform_query`。
 *
 * 为什么整组写、而不是只写命中的那一条：判定文件给的是平台**一次返回的全部行**
 * （含同一统代下的现名行）。只挑一条写，`platform_relation` 里就少了「这个统代还叫过什么」
 * 的背景，而且 `sequenceNo` 会失去原本的页内位置；整组写则与平台那次返回同形。
 *
 * 只收**字典内**的接口（`business_list` / `apply_list`）；判定文件里写成 `query_list`
 * 的一律在归一化那一步映射成 `apply_list`（它就是 queryList 端点），映射事实记在 `source_text`。
 */
function groupSuppliedEvidence(claim: UsccPlatformClaim): Array<{
  interface: 'business_list' | 'apply_list'
  rdjb: string
  relations: RosterImportRelation[]
}> {
  const groups = new Map<string, { interface: 'business_list' | 'apply_list'; rdjb: string; relations: RosterImportRelation[] }>()
  for (const item of claim.evidence ?? []) {
    if (!item || typeof item !== 'object') continue
    if (item.interface !== 'business_list' && item.interface !== 'apply_list') continue
    if (!item.nameRaw) continue
    const rdjb = item.interface === 'business_list' ? (item.rdjb ?? '') : ''
    const key = `${item.interface}|${rdjb}`
    const group = groups.get(key) ?? { interface: item.interface, rdjb, relations: [] }
    const level = nameMatchLevel(item.nameRaw, claim.enterpriseName ?? '')
    // 序号**保留判定文件给的页内序号**（extra-1/2 里它是「按平台返回 pageSet 的顺序、绑 pageSize=50」），
    // 因为那是来源事实；只有在缺席/非法/与本组内已有行**撞号**时才补一个空位
    //（`platform_relation` 的唯一键是 `(query_id, sequence_no)`，撞号会插不进去），
    // 并把这次「补号」写进 `source_text` —— 不静默改来源数字。
    const given = Number(item.sequenceNo)
    const taken = new Set(group.relations.map((relation) => relation.sequenceNo))
    let sequenceNo = Number.isInteger(given) && given >= 1 && !taken.has(given) ? given : 1
    while (taken.has(sequenceNo)) sequenceNo += 1
    group.relations.push({
      sequenceNo,
      relationKey: item.relationKey ?? null,
      usccRaw: claim.uscc,
      nameRaw: item.nameRaw,
      status: item.status ?? null,
      // 这个统代的行都属于这家企业；名称对得上公布名的那条标 `alias`（它就是「曾用名证据」），
      // 其余（现名行等）标 `uscc` —— 两者都是「平台说这些行属于这个统代」，没有推断成分。
      matchBasis: level ? 'alias' : 'uscc',
      verificationStatus: level ? 'confirmed' : 'pending',
      sourceText:
        `由批次判断代理交接的判定文件（${claim.batchRef ?? '(未标批次)'}）转写；` +
        `原始平台响应**未随文件交接**，此行的 queried_at 取该判定文件的产出时刻。` +
        `${item.query ? `代理实发查询：${item.query}。` : ''}` +
        `${level ? `名称比对档次：${level}。` : '本行名称与公布名不同档（例如现名行）。'}` +
        `依据：${claim.reason ?? '(未给理由)'}` +
        (sequenceNo === given ? '' : `（判定文件里该行的序号为 ${String(item.sequenceNo ?? '(空)')}，与本组内已有行撞号或非法，已补为 ${sequenceNo}）`),
      rawFields: null,
    })
    groups.set(key, group)
  }
  return [...groups.values()]
}

/**
 * 从一枚认领里挑出**能当证据用的**那条关系（判据本体）。
 *
 * 必需条件：
 *  1. `nameRaw` 与公布名**同档**（逐字 / 字形 / 区县写法，见 `nameMatchLevel`）—— 判据本体；
 *  2. `usccRaw` 缺席或**等于**本认领的统代 —— 否则这条讲的是别的企业；
 *  3. 认领带 `observedAt` —— 平台查询行的 `queried_at` 是 NOT NULL，**不编时间**（不猜）。
 *
 * 多条同档时**优先逐字相等那条**（`equalsAnnouncedNameByte` 或 `nameMatchLevel === 'byte'`），
 * 否则取判定文件里第一条 —— 顺序固定，保证可重放。
 */
function pickSuppliedEvidence(
  claim: UsccPlatformClaim,
  targetName: string,
  uscc: string,
): SuppliedEvidence | null {
  const observedAt = typeof claim.observedAt === 'string' ? claim.observedAt.trim() : ''
  if (!/^\d{4}-\d{2}-\d{2}/.test(observedAt)) return null
  const candidates: SuppliedEvidence[] = []
  for (const item of claim.evidence ?? []) {
    if (!item || typeof item !== 'object') continue
    if (item.interface !== 'business_list' && item.interface !== 'apply_list') continue
    const level = nameMatchLevel(item.nameRaw, targetName)
    if (!level) continue
    const rawUscc = normalizeUscc(item.usccRaw)
    if (rawUscc && rawUscc !== uscc) continue
    candidates.push({
      interface: item.interface,
      rdjb: item.interface === 'business_list' ? (item.rdjb ?? '') : '',
      relationKey: item.relationKey ?? null,
      nameRaw: item.nameRaw,
      status: item.status ?? null,
      sourceKind: item.interface === 'business_list' ? 'platform_business' : 'platform_apply',
      nameMatch: level,
      query: typeof item.query === 'string' && item.query.trim() ? item.query.trim() : null,
      queriedAt: observedAt,
      checkedOn: observedAt.slice(0, 10),
    })
  }
  if (!candidates.length) return null
  return candidates.find((item) => item.nameMatch === 'byte') ?? candidates[0]!
}

/** 把「证据是哪一条」写成一句可读的话（进 `note` / `source.basis`），供复核。 */
function describeEvidenceLine(
  stored: { ok: true; evidence: DuplicateMergeEvidence } | { ok: false; reason: string; message: string },
  supplied: SuppliedEvidence | null,
): string {
  if (stored.ok) {
    const e = stored.evidence
    return (
      `${e.interface}${e.rdjb ? ` rdjb=${e.rdjb}` : ''} 序号 ${e.sequenceNo}` +
      `${e.relationKey ? `（${e.relationKey}）` : ''} 于 ${e.queriedAt} 返回的 qymc ${matchWords(e.nameMatch)}「${e.nameRaw}」（库内关系 ${e.relationId}）`
    )
  }
  const e = supplied!
  return (
    `${e.interface}${e.rdjb ? ` rdjb=${e.rdjb}` : ''}` +
    `${e.relationKey ? ` relationKey=${e.relationKey}` : '（未给 relationKey）'} 返回的 qymc ` +
    `${matchWords(e.nameMatch)}「${e.nameRaw}」（随本批写入，见本批 platformQueries）`
  )
}

/** 把比对档次写成一句可读的判据说明（逐字 / 字形等价 / 区县后缀写法）。 */
function matchWords(level: NameMatchLevel | undefined): string {
  if (level === 'typographic') return '仅字形等价（全/半角括号、空白差异）于'
  if (level === 'district_suffix') return '仅区县后缀写法差异于'
  return '逐字等于'
}
