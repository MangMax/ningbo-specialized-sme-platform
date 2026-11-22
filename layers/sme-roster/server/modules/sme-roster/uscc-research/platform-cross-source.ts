import type { UsccChecklistRow, UsccCrossSourceMerge, UsccPlatformClaim } from '#sme-roster/lib/roster/uscc-research'
import type { RosterImportPlatformQuery } from '#sme-roster/lib/roster-import-client'
import type { UsccClaimContext } from './claims'
import type { UsccResearchIdentity } from './library'

// 两段来源拼成的归并只认显式给的 crossSource（公开来源页 + 平台按码）。
export function applyUsccCrossSourceClaim(
  claim: UsccPlatformClaim,
  cross: UsccCrossSourceMerge,
  target: UsccChecklistRow,
  uscc: string,
  { pending, resolved, claimedCodes }: UsccClaimContext,
  { findHolder, preferredName, hasAlias }: UsccResearchIdentity,
): void {
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
    return
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
    return
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
    return
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
  const canonicalName = preferredName(uscc, holder.name)
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
