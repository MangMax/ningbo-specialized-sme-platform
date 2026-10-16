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
  judgeUsccClaim,
  type UsccChecklistFilter,
  type UsccChecklistResult,
  type UsccChecklistRow,
  type UsccInterfaceTrace,
  type UsccLibraryCandidate,
  type UsccQueryTrace,
  type UsccResearchClaim,
  type UsccSourceEvidence,
  type UsccTargetOutcome,
} from '../../lib/roster/uscc-research'
import type {
  RosterImportMerge,
  RosterImportRequest,
  RosterImportUsccBackfill,
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

/** 一条**可以执行**的补齐项。`merge` 与 `backfill` 恰给其一。 */
export interface UsccResearchReady {
  outcome: 'filled'
  targetId: number
  targetName: string
  /** `library` = 库内候选 + 平台按统代验证；`public_source` = 公开来源查证（票面路径二）。 */
  route: 'library' | 'public_source'
  /** 库内候选（`public_source` 路线为 `[]`）。 */
  candidates: UsccLibraryCandidate[]
  /** 被平台原始关系证实的**那一个**候选（候选多个时说明凭什么是它：凭证据，不凭名字像）。 */
  chosen: UsccLibraryCandidate | null
  uscc: string
  /** 让身份成立的那条**平台原始关系**（`library` 路线必有；`public_source` 路线为 `null`）。 */
  evidence: DuplicateMergeEvidence | null
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
    byRoute: { library: number; public_source: number }
    /** 可执行项（写入载荷里的条数）。 */
    ready: number
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
  const restrict = options.enterpriseIds ? new Set(options.enterpriseIds) : null
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
        const found = findUsccKeyedRelationEvidence(db, { uscc: candidate.uscc, name: target.name }, evidenceIndex)
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
      resolved.set(targetId, {
        outcome: 'filled',
        targetId,
        targetName: target.name,
        route: 'library',
        candidates,
        chosen: candidate,
        uscc: candidate.uscc,
        evidence,
        merge: {
          fromEnterpriseId: targetId,
          intoUscc: candidate.uscc,
          ...(canonicalName ? { canonicalName } : {}),
          ...(sameName ? {} : { aliasName: target.name }),
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
  const outcomes: UsccTargetOutcome[] = []
  for (const row of targets) {
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
              `${filled.evidence?.relationKey ? ` ${filled.evidence.relationKey}` : ''}）里的 qymc 逐字等于企业名 ⇒ 归并补录`
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

  const merges = ready.map((item) => item.merge).filter((item): item is RosterImportMerge => item != null)
  const backfills = ready.map((item) => item.backfill).filter((item): item is RosterImportUsccBackfill => item != null)

  const countOf = (outcome: UsccTargetOutcome['outcome']) => outcomes.filter((row) => row.outcome === outcome).length
  return {
    counts: {
      // 「本次计划覆盖的目标数」——给了 `enterpriseIds` 就是那几个（`outcomes` 与四桶计数
      // 都以此为分母，四者相加恒等于它；不受分页影响）。
      targets: targets.length,
      withCandidates: candidateCount.size,
      filled: countOf('filled'),
      conflict: countOf('conflict'),
      notFound: countOf('not_found'),
      manual: countOf('manual'),
      closed: countOf('filled'),
      byRoute: {
        library: ready.filter((item) => item.route === 'library').length,
        public_source: ready.filter((item) => item.route === 'public_source').length,
      },
      ready: ready.length,
    },
    outcomes,
    ready,
    pending: pendingRows,
    request:
      ready.length === 0
        ? null
        : {
            idempotencyKey: usccResearchIdempotencyKey({ merges, backfills }),
            sourceKind: 'alias_evidence',
            sourceIdentity: USCC_RESEARCH_SOURCE_IDENTITY,
            payload: {
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

/** claim 归属的企业：给 id 用 id，否则按归一化名找（同名多主体时返回第一条并让写入层拒绝）。 */
function locateTarget(targets: readonly UsccChecklistRow[], claim: UsccResearchClaim): UsccChecklistRow | null {
  if (claim.enterpriseId != null) return targets.find((row) => row.enterpriseId === claim.enterpriseId) ?? null
  const norm = claim.enterpriseName ? normalizeName(claim.enterpriseName) : ''
  if (!norm) return null
  return targets.find((row) => normalizeName(row.name) === norm) ?? null
}

/** 单条按统代找企业（与写入层同一个身份键；只读，返回最小形状）。 */
function findEnterpriseByUscc(db: Db, uscc: string): { id: number; name: string } | null {
  const row = db.select().from(schema.enterprise).all().find((e) => normalizeUscc(e.usccNorm) === uscc)
  return row ? { id: row.id, name: row.name } : null
}
