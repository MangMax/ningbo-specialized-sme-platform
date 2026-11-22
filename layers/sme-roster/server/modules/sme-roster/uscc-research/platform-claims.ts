import { normalizeUscc } from '#sme-roster/lib/domain'
import { isByteEqualName, nameMatchLevel, PLATFORM_INTERFACE_URLS, usccFormatVerdict, type UsccPlatformClaim } from '#sme-roster/lib/roster/uscc-research'
import type { RosterImportItemResult, RosterImportPlatformQuery, RosterImportRequest, RosterPlatformRef } from '#sme-roster/lib/roster-import-client'
import { findIndexedUsccEvidence, type PlatformEvidenceIndex } from '../../../utils/roster-duplicate-merge-model'
import { locateTarget, type UsccClaimContext } from './claims'
import type { UsccResearchIdentity } from './library'
import { applyUsccCrossSourceClaim } from './platform-cross-source'
import { describeCorrection, describeEvidenceLine, groupSuppliedEvidence, pickSuppliedEvidence } from './platform-evidence'
import { USCC_RESEARCH_SOURCE_IDENTITY } from './report'

export function* applyUsccPlatformClaims(
  claims: readonly UsccPlatformClaim[],
  context: UsccClaimContext,
  identity: UsccResearchIdentity,
  evidenceIndex: PlatformEvidenceIndex,
): Generator<RosterImportRequest, void, RosterImportItemResult[]> {
  const { allTargets, restrict, resolved, pending, claimedCodes } = context
  const { findHolder, hasAlias, preferredName, addPlannedAlias } = identity

  // ---- 平台证据认领（路径一 ④⑤；批次判断代理的判定文件走这条）---------------
  //
  // ⚠️ **判定文件只是线索，不是证据**：文件说 `resolved` / `qymcEqualsAnnouncedName=true` 都不算数，
  // 这里要**在库里对得上**才算 —— 库里已有那条关系就直接用；库里还没有、而文件带来了
  // `evidence` 摘要，就把这批查询/关系**连同证据指针一起写进同一批**（§8.7 的批内自然键），
  // 归属由本批自己写下的行证明。两边都没有 ⇒ **不写**（`no_platform_evidence`）。
  for (const claim of claims) {
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
    if (claim.crossSource) {
      applyUsccCrossSourceClaim(claim, claim.crossSource, target, uscc, context, identity)
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
      const canonicalName = preferredName(uscc, holder.name)
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
      if (!sameName) addPlannedAlias(holder.id, target.name)
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
}
