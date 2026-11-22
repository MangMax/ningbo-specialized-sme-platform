import { normalizeName, normalizeUscc } from '#sme-roster/lib/domain'
import { judgeUsccClaim, type UsccChecklistRow, type UsccResearchClaim } from '#sme-roster/lib/roster/uscc-research'
import type { UsccResearchIdentity } from './library'
import type { UsccResearchDecisions } from './report'

export interface UsccClaimContext extends UsccResearchDecisions {
  allTargets: readonly UsccChecklistRow[]
  restrict: ReadonlySet<number> | null
  /**
   * **本计划内已经认领的统代** → 认领它的企业 id。
   *
   * 为什么必须查这一条：两条 claim 可能各自「看起来很干净」（库里此刻没有任何一行持有那个统代），
   * 于是双双进载荷。执行时第一条把代码补上，第二条就会撞唯一键 ⇒ 写入阶段报 `uscc_taken`、
   * 整批回滚 —— 结果没错但很吵，而且计划报的「补齐 2」跟提交真会发生的事对不上
   * （预检报的就是提交真会改的，这条不能破）。所以**在计划里就判掉**：同一轮第二个认领者
   * 直接落冲突。库内路径不需要这条 —— 那条路的多个目标都并进**同一个规范行**，本来就合法。
   */
  claimedCodes: Map<string, number>
}

/**
 * 认领归属的企业：给 id 用 id，否则按归一化名找。
 *
 * 两种认领（公开来源 `UsccResearchClaim` / 平台证据 `UsccPlatformClaim`）共用这一处 ——
 * 「这条认领讲的是哪家企业」只有一种解法，两边各写一遍迟早会漂。
 */
export function locateTarget(
  targets: readonly UsccChecklistRow[],
  claim: { enterpriseId?: number; enterpriseName?: string },
): UsccChecklistRow | null {
  if (claim.enterpriseId != null) return targets.find((row) => row.enterpriseId === claim.enterpriseId) ?? null
  const norm = claim.enterpriseName ? normalizeName(claim.enterpriseName) : ''
  if (!norm) return null
  return targets.find((row) => normalizeName(row.name) === norm) ?? null
}

export function applyUsccPublicSourceClaims(
  claims: readonly UsccResearchClaim[],
  { allTargets, restrict, resolved, pending, claimedCodes }: UsccClaimContext,
  { findHolder }: UsccResearchIdentity,
): void {
  // ---- 公开来源 claim（路径二）：先判，避免同一目标两条路都出结论 -------------
  for (const claim of claims) {
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
}
