import { createHash } from 'node:crypto'
import type { UsccBasisKind, UsccChecklistRow, UsccLibraryCandidate, UsccTargetOutcome } from '#sme-roster/lib/roster/uscc-research'
import type { RosterImportMerge, RosterImportPlatformQuery, RosterImportRequest, RosterImportUsccBackfill, RosterPlatformRef } from '#sme-roster/lib/roster-import-client'
import type { DuplicateMergeEvidence } from '#sme-roster/lib/roster/duplicate-merge'

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

export interface UsccResearchDecisions {
  resolved: Map<number, UsccResearchReady>
  pending: Map<number, UsccResearchPending>
}

/** 幂等键：**公开来源查证内容**的哈希 ⇒ 同证据重放不增行，补了新证据才是新批次。 */
export function usccResearchIdempotencyKey(entries: unknown): string {
  const digest = createHash('sha256').update(JSON.stringify(entries)).digest('hex').slice(0, 16)
  return `uscc_research#sha256:${digest}`
}

/** 来源身份（逻辑标识，**不含凭证**）。 */
export const USCC_RESEARCH_SOURCE_IDENTITY = 'roster/uscc-research'

export function buildUsccResearchReport(
  allTargets: readonly UsccChecklistRow[],
  targets: readonly UsccChecklistRow[],
  { resolved, pending }: UsccResearchDecisions,
  withCandidates: number,
): UsccResearchReport {
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
      withCandidates,
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
