import { createHash } from 'node:crypto'
import { normalizeName, normalizeUscc } from '../../lib/domain'
import { coreWordOf, isByteEqualName, judgeUsccClaim, nameMatchLevel, PLATFORM_INTERFACE_URLS, usccFormatVerdict, type NameMatchLevel, type UsccBasisKind, type UsccCrossSourceMerge, type UsccNameCorrection, type UsccChecklistFilter, type UsccChecklistResult, type UsccChecklistRow, type UsccInterfaceTrace, type UsccLibraryCandidate, type UsccQueryTrace, type UsccPlatformClaim, type UsccResearchClaim, type UsccSourceEvidence, type UsccTargetOutcome } from '../../lib/roster/uscc-research'
import type { RosterImportItemResult, RosterImportMerge, RosterImportPlatformQuery, RosterImportRelation, RosterImportRequest, RosterImportUsccBackfill, RosterPlatformRef } from '../../lib/roster-import-client'
import type { DuplicateMergeEvidence } from '../../lib/roster/duplicate-merge'
import { TITLE_ORDER } from '../../lib/labels'
import { MAX_PAGE_SIZE } from '../../lib/query-limits'
import { findIndexedUsccEvidence, type PlatformEvidenceIndex } from './roster-duplicate-merge-model'
import type { enterprise } from '../../../../db/postgresql/enterprise-tables'
import type { record, recordEvent, recordEvidence } from '../../../../db/postgresql/ledger-tables'
import type { differenceReason } from '../../../../db/postgresql/roster-selection-tables'
import type { PlatformStoredQuery } from '../../lib/platform/read'
import type { selectUsccTargetRows } from './uscc-target-selection'

const DEFAULT_PAGE_SIZE = 50

export function projectUsccTargets(snap: UsccTargetSnapshot): UsccChecklistRow[] {
  const missing = snap.rows
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
  for (const relation of snap.relationCounts) {
    relationsByQuery.set(relation.queryId, relation.count)
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

  return rows.sort((a, b) => titleRank(a.titles[0] ?? '') - titleRank(b.titles[0] ?? '') || a.enterpriseId - b.enterpriseId)
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
 * 与读侧（`layers/sme-roster/lib/roster/enterprise-roster.ts` 的 `currentExplanations`）同一口径。
 */
function currentTraces(snap: UsccTargetSnapshot): UsccInterfaceTrace[] {
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

export type UsccTargetSnapshot = {
  rows: ReturnType<typeof selectUsccTargetRows>
  enterprises: Pick<typeof enterprise.$inferSelect, 'id' | 'name' | 'nameNorm' | 'district' | 'city'>[]
  records: Pick<typeof record.$inferSelect, 'id' | 'enterpriseId' | 'titleCode' | 'source' | 'district'>[]
  events: Pick<typeof recordEvent.$inferSelect, 'id' | 'recordId'>[]
  evidence: Pick<typeof recordEvidence.$inferSelect, 'recordEventId' | 'sourceFile' | 'attachment' | 'listNo' | 'page'>[]
  differences: Pick<typeof differenceReason.$inferSelect, 'id' | 'enterpriseId' | 'titleCode' | 'direction' | 'recordedAt' | 'status' | 'reasonCode' | 'reasonNote'>[]
  queries: Pick<PlatformStoredQuery, 'id' | 'interface' | 'queryKey' | 'rdjb' | 'queriedAt' | 'status'>[]
  relationCounts: { queryId: number; count: number }[]
}

// ---------------------------------------------------------------------------
// 库内匹配字典（②：现名 + 已确认曾用名）
// ---------------------------------------------------------------------------

/** 字典里的一家**有统代**企业：它的全部可用名字（现名 + 已确认曾用名）。 */
export interface DictionaryEntry {
  enterpriseId: number
  name: string
  nameNorm: string
  uscc: string
  district: string | null
  /** 名称 → 命中方式（现名 / 已确认曾用名）。 */
  names: Array<{ value: string; norm: string; matchedBy: 'name' | 'alias' }>
  confirmedAliasNorms?: Set<string>
}

export function projectUsccDictionary(
  owners: Array<{ id: number; name: string; nameNorm: string; usccNorm: string | null; district: string | null }>,
  aliases: Array<{ enterpriseId: number; name: string; nameNorm: string }>,
): DictionaryEntry[] {
  const entries = new Map<number, DictionaryEntry>()
  for (const enterprise of owners) {
    const uscc = normalizeUscc(enterprise.usccNorm)
    if (!uscc) continue
    entries.set(enterprise.id, {
      enterpriseId: enterprise.id,
      name: enterprise.name,
      nameNorm: enterprise.nameNorm,
      uscc,
      district: enterprise.district,
      names: [{ value: enterprise.name, norm: enterprise.nameNorm, matchedBy: 'name' }],
      confirmedAliasNorms: new Set(),
    })
  }
  for (const alias of aliases) {
    const entry = entries.get(alias.enterpriseId)
    if (!entry) continue
    entry.confirmedAliasNorms!.add(alias.nameNorm)
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
  /**
   * 本项依据的**种类**：库内证据命中的档次（`byte` / `typographic` / `district_suffix`），
   * 或 `ocr_correction`（人工确认的用字纠错 —— **从不由字形相近自动推出**）。
   */
  basisKind: UsccBasisKind
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
   * （只并身份，不重复留名）。只认本次读取时已确认的别名。
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
    /** 每条可执行项**依据的种类**（逐字 / 字形 / 区县写法 / 人工确认的用字纠错 / 公开来源）。 */
    byBasisKind: Record<string, number>
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

export function prepareUsccResearch(
  allTargets: readonly UsccChecklistRow[],
  dictionary: DictionaryEntry[],
  options: UsccResearchOptions,
) {
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
  const codes = [
    ...targets.flatMap(target => findLibraryCandidates(target, dictionary).map(candidate => candidate.uscc)),
    ...(options.platformClaims ?? []).map(claim => claim.uscc),
    ...(options.claims ?? []).map(claim => claim.uscc),
  ]
  return { allTargets, targets, restrict, dictionary, codes }
}

export function* projectUsccResearch(
  { allTargets, targets, restrict, dictionary }: ReturnType<typeof prepareUsccResearch>,
  researchEvidence: { index: PlatformEvidenceIndex; exportName(uscc: string): string | null },
  options: UsccResearchOptions,
): Generator<RosterImportRequest, UsccResearchReport, RosterImportItemResult[]> {
  // Reuse the identity/confirmed-alias projection for every ready item. Keep
  // first-owner precedence for legacy differently formatted copies of a code.
  const holders = new Map<string, { id: number; name: string }>()
  const aliases = new Map(dictionary.map(entry => [entry.enterpriseId, entry.confirmedAliasNorms]))
  for (const entry of dictionary) if (!holders.has(entry.uscc)) holders.set(entry.uscc, { id: entry.enterpriseId, name: entry.name })
  const findHolder = (uscc: string) => holders.get(uscc) ?? null
  const hasAlias = (enterpriseId: number, name: string) => aliases.get(enterpriseId)?.has(normalizeName(name)) ?? false
  const evidenceIndex = researchEvidence.index

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
    const holder = findHolder(uscc)
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
      // 公开来源那一路的证据是内容页，不是名称比对 ⇒ 单列一档，不冒充任何一种「名称相等」。
      basisKind: 'public_source',
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
    const holder = findHolder(uscc)
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
    // 判据分层（父代理 2026-10-16 裁定）：
    //  - 默认：`nameMatchLevel` 的三档（逐字 / 全半角括号与空白 / 区县后缀有无）；
    //  - **人工确认的用字纠错**：`claim.correction` 显式给出时，改成与
    //    `correction.platformName`（平台原文）**逐字**比对 —— 那一档**绝不**由字形相近推出，
    //    只能由这件事的负责人显式交出（见 `UsccBasisKind` 的注释）。
    // 实际命中到哪一档记进 `evidence` / `note` / `basis`，报告里能一眼看出哪些回填依赖放宽判据。
    // ---- 两段来源拼成的归并（公开来源页 + 平台按码）-------------------------
    // 只认**显式**给的 `crossSource`（见 `UsccCrossSourceMerge`）；缺任何一段都不走这条。
    if (claim.crossSource) {
      const cross = claim.crossSource
      const holder = findHolder(uscc)
      const problemsWithCross: string | null = !cross.publicSource?.url?.trim()
        ? '第一段（公开来源页 url）缺失'
        : !cross.publicSource?.basis?.trim()
          ? '第一段（公开来源页 basis）缺失'
          : !/^\d{4}-\d{2}-\d{2}/.test(String(cross.publicSource?.fetchedAt ?? ''))
            ? '第一段（抓取时刻）缺失'
            : !cross.platformByCode?.qymc?.trim()
              ? '第二段（平台现名 qymc）缺失'
              : !(cross.platformByCode?.rowCount >= 1)
                ? '第二段（平台按码返回 0 行）不足以证明「代码↔现名」'
                : cross.nameQueryRowCount !== 0
                  ? '按公布名查平台返回了行 ⇒ 不满足「平台不索引旧名」这条前提，应改走平台名称匹配那一路'
                  : null
      if (problemsWithCross) {
        pending.set(target.enterpriseId, {
          targetId: target.enterpriseId,
          targetName: target.name,
          outcome: 'manual',
          code: 'cross_source_incomplete',
          message: `两段来源拼成的归并证据不完整：${problemsWithCross} ⇒ 不写（缺一段都不算证据）`,
          candidates: [],
        })
        continue
      }
      if (!holder) {
        pending.set(target.enterpriseId, {
          targetId: target.enterpriseId,
          targetName: target.name,
          outcome: 'conflict',
          code: 'uscc_taken',
          message:
            `代码 ${uscc} 在库里**没有**任何企业行持有 ⇒ 两段来源只证明了「代码↔现名」，` +
            '没有可并入的规范行（这种情况应按「纯补统代」处理，请核对证据）。',
          candidates: [],
        })
        continue
      }
      if (holder.id === target.enterpriseId) {
        pending.set(target.enterpriseId, {
          targetId: target.enterpriseId,
          targetName: target.name,
          outcome: 'manual',
          code: 'already_resolved',
          message: `企业 ${target.enterpriseId} 已持有统代 ${uscc} ⇒ 无需再补`,
          candidates: [],
        })
        continue
      }
      claimedCodes.set(uscc, target.enterpriseId)
      // 第二段**落成真的平台查询行**（代码为键），归并的 `evidenceQueryRef` 指向它 —— 血缘里能查回。
      const crossQuery: RosterImportPlatformQuery = {
        interface: cross.platformByCode.interface,
        queryKey: uscc,
        rdjb: cross.platformByCode.interface === 'business_list' ? cross.platformByCode.rdjb : '',
        queriedAt: cross.publicSource.fetchedAt,
        status: 'success',
        failureReason: null,
        rawResponse: null,
        relations: Array.from({ length: Math.max(1, Math.trunc(cross.platformByCode.rowCount)) }, (_, index) => ({
          sequenceNo: index + 1,
          relationKey: null,
          usccRaw: uscc,
          nameRaw: cross.platformByCode.qymc,
          matchBasis: 'uscc' as const,
          // 名称与公布名**不同** ⇒ 这一行本身不是曾用名证据（曾用名证据是第一段的公开来源页），
          // 所以标 `pending`，不冒充 `confirmed`。
          verificationStatus: 'pending' as const,
          sourceText:
            `平台按代码查询的返回（${claim.batchRef ?? '判定文件'} 转写）：` +
            `${cross.platformByCode.interface}${cross.platformByCode.rdjb ? ` rdjb=${cross.platformByCode.rdjb}` : ''} ` +
            `共 ${cross.platformByCode.rowCount} 行，qymc 逐字为「${cross.platformByCode.qymc}」——` +
            '即平台在该码下持有的**现名**，与公布名不同。' +
            `另：按公布名查平台 qymc 返回 ${cross.nameQueryRowCount} 行（平台不索引旧名）。` +
            '本行的名称与公布名不同，故不作为曾用名证据；曾用名证据是第一段的公开来源页。',
        })),
      }
      const exportName = researchEvidence.exportName(uscc)
      const canonicalName = exportName && exportName !== holder.name ? exportName : null
      const aliasAlready = hasAlias(holder.id, target.name)
      resolved.set(target.enterpriseId, {
        outcome: 'filled',
        targetId: target.enterpriseId,
        targetName: target.name,
        route: 'platform_claim',
        candidates: [],
        chosen: null,
        uscc,
        basisKind: 'public_source',
        evidence: null,
        evidenceRef: null,
        platformQueries: [crossQuery],
        platformQuery: crossQuery,
        aliasAlreadyPresent: aliasAlready,
        merge: {
          fromEnterpriseId: target.enterpriseId,
          intoUscc: uscc,
          ...(canonicalName ? { canonicalName } : {}),
          ...(aliasAlready ? {} : { aliasName: target.name }),
          // 曾用名的来源是**公开来源页**（不是某条平台关系）⇒ 落 `manual` + `sourceRefId = 0`
          //（§8.7.3：0 只表示「本就没给来源行」）。平台那一半走 `evidenceQueryRef` 进血缘。
          sourceKind: 'manual',
          sourceRefId: 0,
          evidenceQueryRef: {
            interface: crossQuery.interface,
            queryKey: uscc,
            rdjb: crossQuery.rdjb,
            queriedAt: crossQuery.queriedAt,
          },
          note: describeCrossSource(cross, target.name, uscc),
        },
        backfill: null,
      })
      continue
    }

    if (claim.correction && !claim.correction.confirmedBy?.trim()) {
      pending.set(target.enterpriseId, {
        targetId: target.enterpriseId,
        targetName: target.name,
        outcome: 'manual',
        code: 'correction_unattributed',
        message:
          '用字纠错（`ocr_correction`）必须**指名确认人** —— 空白的 `confirmedBy` 一律拒收，' +
          '不认无主的「这两个名字其实是同一个」。',
        candidates: [],
      })
      continue
    }
    const correctionMatch = claim.correction
      ? (a: unknown) => (!isByteEqualName(a, claim.correction!.platformName) ? null : ('byte' as const))
      : null
    const evidenceName = claim.correction ? claim.correction.platformName : target.name
    const stored = findIndexedUsccEvidence(
      evidenceIndex,
      { uscc, name: evidenceName },
      correctionMatch ?? nameMatchLevel,
    )
    const supplied = pickSuppliedEvidence(claim, evidenceName, uscc)
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
    // 整组写：判定文件里该 (接口, rdjb) 的全部行都进同一条 `platform_query`，
    // 于是命中那一行的序号**必然**存在于写进去的那组里，锚点解析得到。
    const groups = stored.ok ? [] : groupSuppliedEvidence(claim)
    const anchorGroup = groups.find(
      (group) => group.interface === supplied!.interface && group.rdjb === supplied!.rdjb,
    )
    const anchorRelation =
      anchorGroup?.relations.find((relation) => relation.nameRaw === supplied!.nameRaw) ?? null
    // 本项依据的种类：人工确认的用字纠错（显式给）> 库内证据命中的档次。
    const basisKind = claim.correction ? ('ocr_correction' as const) : (stored.ok ? stored.evidence.nameMatch ?? 'byte' : supplied!.nameMatch)
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
    if (platformQueries.length) {
      const conflicts = yield {
        idempotencyKey: `uscc-source:${target.enterpriseId}:${uscc}`,
        sourceKind: 'platform_archive', sourceIdentity: USCC_RESEARCH_SOURCE_IDENTITY,
        payload: { platformQueries },
      }
      if (conflicts.length) {
        pending.set(target.enterpriseId, {
          targetId: target.enterpriseId, targetName: target.name, outcome: 'manual',
          code: conflicts[0]!.error?.code ?? 'platform_source_invalid',
          message: conflicts.map(item => item.error?.message).filter(Boolean).join('；'),
          candidates: [],
        })
        continue
      }
    }
    claimedCodes.set(uscc, target.enterpriseId)

    if (holder) {
      // 该统代已挂在另一家企业行上 ⇒ §5.2 的**归并**（不是 UPDATE：会撞 enterprise_uscc_norm_uq）。
      const exportName = researchEvidence.exportName(uscc)
      const canonicalName = exportName && exportName !== holder.name ? exportName : null
      const sameName = target.name === holder.name
      // ① 别名去重：规范行上已有同名 confirmed 别名 ⇒ 不再写第二条（只并身份，不重复留名）。
      const aliasAlreadyPresent = !sameName && hasAlias(holder.id, target.name)
      resolved.set(target.enterpriseId, {
        outcome: 'filled',
        targetId: target.enterpriseId,
        targetName: target.name,
        route: 'platform_claim',
        candidates: [],
        chosen: null,
        uscc,
        evidence: stored.ok ? stored.evidence : null,
        basisKind,
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
            `平台证据认领（${claim.batchRef ?? '判定文件'}）：${describeEvidenceLine(stored, supplied, claim.correction)}` +
            `${claim.correction ? `；${describeCorrection(claim.correction)}` : ''}` +
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
      basisKind,
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
            `平台原始关系逐字证实：${describeEvidenceLine(stored, supplied, claim.correction)}` +
            `${claim.correction ? `；${describeCorrection(claim.correction)}` : ''}` +
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
        const found = findIndexedUsccEvidence(
          evidenceIndex,
          { uscc: candidate.uscc, name: target.name },
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
      const into = findHolder(candidate.uscc)
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
      const exportName = researchEvidence.exportName(candidate.uscc)
      const canonicalName = exportName && exportName !== into.name ? exportName : null
      const sameName = target.name === into.name
      // ① 别名去重（同上）：**库内按曾用名命中的那条路尤其容易撞** —— 名字既然能命中，
      // 说明它本来就已经是规范行的别名了，再写一条只是把同一个名字留第二遍。
      const aliasAlreadyPresent = !sameName && hasAlias(into.id, target.name)
      resolved.set(targetId, {
        outcome: 'filled',
        targetId,
        targetName: target.name,
        route: 'library',
        candidates,
        chosen: candidate,
        uscc: candidate.uscc,
        basisKind: evidence.nameMatch ?? 'byte',
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
      byBasisKind: ready.reduce<Record<string, number>>((acc, item) => {
        acc[item.basisKind ?? 'unknown'] = (acc[item.basisKind ?? 'unknown'] ?? 0) + 1
        return acc
      }, {}),
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
  correction?: UsccNameCorrection | null,
): string {
  if (stored.ok) {
    const e = stored.evidence
    // 用字纠错时**不能**写成「与公布名相等」—— 那条关系站的只是**平台记录的写法**，
    // 判定「公布名是误读」是人的事，写在后面那句纠错说明里。
    const how = correction ? `为「${e.nameRaw}」（平台记录写法，与公布名不一致，见下用字纠错）` : `${matchWords(e.nameMatch)}「${e.nameRaw}」`
    return (
      `${e.interface}${e.rdjb ? ` rdjb=${e.rdjb}` : ''} 序号 ${e.sequenceNo}` +
      `${e.relationKey ? `（${e.relationKey}）` : ''} 于 ${e.queriedAt} 返回的 qymc ${how}（库内关系 ${e.relationId}）`
    )
  }
  const e = supplied!
  const how = correction
    ? `为「${e.nameRaw}」（平台记录写法，与公布名不一致，见下用字纠错）`
    : `${matchWords(e.nameMatch)}「${e.nameRaw}」`
  return (
    `${e.interface}${e.rdjb ? ` rdjb=${e.rdjb}` : ''}` +
    `${e.relationKey ? ` relationKey=${e.relationKey}` : '（未给 relationKey）'} 返回的 qymc ` +
    `${how}（随本批写入，见本批 platformQueries）`
  )
}

/** 把比对档次写成一句可读的判据说明（逐字 / 字形等价 / 区县后缀写法 / 人工纠错）。 */
function matchWords(level: UsccBasisKind | undefined): string {
  if (level === 'ocr_correction') return '经人工确认的用字纠错后等于'
  if (level === 'typographic') return '仅字形等价（全/半角括号、空白差异）于'
  if (level === 'district_suffix') return '仅区县后缀写法差异于'
  return '逐字等于'
}

/**
 * **两段来源拼成的归并**的记档文案（父代理 2026-10-16 要求「不许省略、不许含糊」的两句，
 * 在这里只拼一次）。两段**分开写**，且**绝不出现**「名称相等 / 归一化后相等 / 名称相似」。
 */
function describeCrossSource(cross: UsccCrossSourceMerge, announcedName: string, uscc: string): string {
  const site = cross.publicSource.site ? `${cross.publicSource.site}；` : ''
  const control = cross.controlNote ?? '「宁波劦群」'
  return (
    '两段**互相独立**的来源拼成（**不是**由平台名称匹配触发）：' +
    `① 公布名「${announcedName}」↔ 代码 ${uscc}：公开来源页 ${cross.publicSource.url}` +
    `（${site}抓取于 ${cross.publicSource.fetchedAt}），basisKind=public_source；核实依据（原样）：${cross.publicSource.basis}` +
    ` ② 代码 ${uscc} ↔ 现名「${cross.platformByCode.qymc}」：平台 ` +
    `${cross.platformByCode.interface}${cross.platformByCode.rdjb ? ` rdjb=${cross.platformByCode.rdjb}` : ''} ` +
    `返回 ${cross.platformByCode.rowCount} 行，qymc 逐字为「${cross.platformByCode.qymc}」（见本批 platformQueries）。` +
    `**平台在该码下持有的现名为「${cross.platformByCode.qymc}」，与公布名不同**；` +
    `**按公布名查平台 qymc 返回 ${cross.nameQueryRowCount} 行 —— 平台不索引旧名**` +
    `（对照组${control}证明了真匹配也会 0 行），故本归并**不是**由平台名称匹配触发的，` +
    '而是由公开来源页的「公布名↔代码」配对 + 平台「代码↔现名」两段拼成。' +
    // 措辞中性：**不**预判「毫不相干」（那只是 221 那一类的情形）。
    (cross.renameNote ? ` ⚠ 现名与公布名的差异说明：${cross.renameNote}` : '') +
    // ⚠️ 措辞上**连否定句也不许出现**「名称相等 / 归一化后相等 / 名称相似」这三个词 ——
    // 审计要求是「检索不到这三个词」，不是「读起来是否定」。所以这里只说「不做模糊推断」。
    ' ⚠ 本题不做模糊推断：系统不自动比较字形或名字的接近程度；两段证据缺一不可。'
  )
}

/**
 * `ocr_correction` 那一档的**记档文案**（契约 §8.10 要求写清的三件事，只在这里拼一次）：
 * 谁确认的、公布名的写法是误读、平台记录的写法为准。
 *
 * ⚠️ 不写成「名称相等」也不写成「归一化后相等」—— 它两样都不是（归一化不会把「荔」变成「劦」）。
 */
function describeCorrection(correction: UsccNameCorrection): string {
  return (
    `用字纠错（人工确认，非自动判定字形相近）：公布名「${correction.announcedName}」` +
    `经${correction.confirmedBy}确认为 OCR 误读，平台记录「${correction.platformName}」为准` +
    (correction.note ? `；裁定原话：${correction.note}` : '')
  )
}
