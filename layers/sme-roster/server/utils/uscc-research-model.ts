import type { UsccChecklistFilter, UsccChecklistRow, UsccPlatformClaim, UsccResearchClaim } from '../../lib/roster/uscc-research'
import type { RosterImportItemResult, RosterImportRequest } from '../../lib/roster-import-client'
import { applyUsccPublicSourceClaims, locateTarget } from '../modules/sme-roster/uscc-research/claims'
import { applyUsccLibraryMatches, createUsccResearchIdentity, findLibraryCandidates, type DictionaryEntry, type UsccResearchEvidence } from '../modules/sme-roster/uscc-research/library'
import { applyUsccPlatformClaims } from '../modules/sme-roster/uscc-research/platform-claims'
import { buildUsccResearchReport, type UsccResearchDecisions, type UsccResearchReport } from '../modules/sme-roster/uscc-research/report'

export { pageUsccChecklist, projectUsccTargets, type UsccTargetSnapshot } from '../modules/sme-roster/uscc-research/checklist'
export { findLibraryCandidates, projectUsccDictionary, type DictionaryEntry } from '../modules/sme-roster/uscc-research/library'
export { USCC_RESEARCH_SOURCE_IDENTITY, usccResearchIdempotencyKey, type UsccResearchPending, type UsccResearchReady, type UsccResearchReport } from '../modules/sme-roster/uscc-research/report'

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
  researchEvidence: UsccResearchEvidence,
  options: UsccResearchOptions,
): Generator<RosterImportRequest, UsccResearchReport, RosterImportItemResult[]> {
  const identity = createUsccResearchIdentity(dictionary, researchEvidence)
  const decisions: UsccResearchDecisions = { resolved: new Map(), pending: new Map() }
  const context = { allTargets, restrict, ...decisions, claimedCodes: new Map<string, number>() }

  applyUsccPublicSourceClaims(options.claims ?? [], context, identity)
  yield* applyUsccPlatformClaims(options.platformClaims ?? [], context, identity, researchEvidence.index)
  const withCandidates = applyUsccLibraryMatches(targets, dictionary, researchEvidence.index, decisions, identity)

  return buildUsccResearchReport(allTargets, targets, decisions, withCandidates)
}
