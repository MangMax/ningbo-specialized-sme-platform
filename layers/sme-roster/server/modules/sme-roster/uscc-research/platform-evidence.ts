import { normalizeUscc } from '#sme-roster/lib/domain'
import { nameMatchLevel, type NameMatchLevel, type UsccBasisKind, type UsccNameCorrection, type UsccPlatformClaim } from '#sme-roster/lib/roster/uscc-research'
import type { RosterImportRelation } from '#sme-roster/lib/roster-import-client'
import type { DuplicateMergeEvidence } from '#sme-roster/lib/roster/duplicate-merge'

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
export function groupSuppliedEvidence(claim: UsccPlatformClaim): Array<{
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
export function pickSuppliedEvidence(
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
export function describeEvidenceLine(
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
 * `ocr_correction` 那一档的**记档文案**（契约 §8.10 要求写清的三件事，只在这里拼一次）：
 * 谁确认的、公布名的写法是误读、平台记录的写法为准。
 *
 * ⚠️ 不写成「名称相等」也不写成「归一化后相等」—— 它两样都不是（归一化不会把「荔」变成「劦」）。
 */
export function describeCorrection(correction: UsccNameCorrection): string {
  return (
    `用字纠错（人工确认，非自动判定字形相近）：公布名「${correction.announcedName}」` +
    `经${correction.confirmedBy}确认为 OCR 误读，平台记录「${correction.platformName}」为准` +
    (correction.note ? `；裁定原话：${correction.note}` : '')
  )
}
