import { normalizeName, normalizeUscc } from '#sme-roster/lib/domain'
import { coreWordOf, nameMatchLevel, type UsccChecklistRow, type UsccLibraryCandidate } from '#sme-roster/lib/roster/uscc-research'
import type { DuplicateMergeEvidence } from '#sme-roster/lib/roster/duplicate-merge'
import { findIndexedUsccEvidence, type PlatformEvidenceIndex } from '../../../utils/roster-duplicate-merge-model'
import type { UsccResearchDecisions } from './report'

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

export interface UsccResearchEvidence {
  index: PlatformEvidenceIndex
  exportName(uscc: string): string | null
}

export function createUsccResearchIdentity(dictionary: DictionaryEntry[], evidence: UsccResearchEvidence) {
  // Reuse the identity/confirmed-alias projection for every ready item. Keep
  // first-owner precedence for legacy differently formatted copies of a code.
  const holders = new Map<string, { id: number; name: string }>()
  const aliases = new Map(dictionary.map(entry => [entry.enterpriseId, entry.confirmedAliasNorms]))
  for (const entry of dictionary) if (!holders.has(entry.uscc)) holders.set(entry.uscc, { id: entry.enterpriseId, name: entry.name })
  const findHolder = (uscc: string) => holders.get(uscc) ?? null
  const hasAlias = (enterpriseId: number, name: string) => aliases.get(enterpriseId)?.has(normalizeName(name)) ?? false

  function preferredName(uscc: string, holderName: string) {
    const exportName = evidence.exportName(uscc)
    return exportName && exportName !== holderName ? exportName : null
  }

  function addPlannedAlias(enterpriseId: number, name: string) {
    const entry = dictionary.find((item) => item.enterpriseId === enterpriseId)
    if (entry && !entry.names.some((item) => item.value === name)) {
      entry.names.push({ value: name, norm: normalizeName(name), matchedBy: 'alias' })
    }
  }

  return { findHolder, hasAlias, preferredName, addPlannedAlias }
}

export type UsccResearchIdentity = ReturnType<typeof createUsccResearchIdentity>

export function applyUsccLibraryMatches(
  targets: readonly UsccChecklistRow[],
  dictionary: readonly DictionaryEntry[],
  evidenceIndex: PlatformEvidenceIndex,
  { resolved, pending }: UsccResearchDecisions,
  { findHolder, hasAlias, preferredName, addPlannedAlias }: UsccResearchIdentity,
) {
  const candidateCount = new Map<number, number>()
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
      const canonicalName = preferredName(candidate.uscc, into.name)
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
      if (!sameName) addPlannedAlias(into.id, target.name)
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

  return candidateCount.size
}
