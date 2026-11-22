import { createHash } from 'node:crypto'
import { normalizeUscc } from '../../lib/domain'
import type { NameMatchLevel } from '../../lib/roster/uscc-research'
import { duplicateTwinKey, type DuplicateMergeEvidence, type DuplicateMergePendingReason, type DuplicateMergeReport } from '../../lib/roster/duplicate-merge'
import type { DuplicateNameCandidate, RosterImportMerge } from '../../lib/roster-import-client'
import type { PlatformStoredQuery, PlatformStoredRelation } from '../../lib/platform/read'

/**
 * 接口 → 曾用名来源类别（契约 §1.2 的 `source_kind` 取值）。
 *
 * 字典外的接口（手工改库才可能出现）**不静默降级**：拿不到可记录的来源类别就不拿它当证据
 * （见 {@link findDuplicateMergeEvidence}），它会落到「证据不成立」而不是被标成某个接口。
 */
const ALIAS_SOURCE_KIND: Record<string, 'platform_business' | 'platform_apply' | undefined> = {
  business_list: 'platform_business',
  apply_list: 'platform_apply',
}

/**
 * 证据查找的**预建索引**（只读快照）。
 *
 * 为什么要有它：{@link findUsccKeyedRelationEvidence} 每调用一次就要扫一遍 `platform_query`
 * 与 `platform_relation`。单次归并只查几条候选，无所谓；但 RL-06 的补录计划会对**上百个**
 * 候选逐个查找，实测真实库上 `platform_relation` 一次全扫约 126ms，于是几十次查找要十几秒。
 * 索引一次建好、多次复用，**判据一个字没变**（索引里放的正是原来每次现算的那两张表）。
 */
export type PlatformEvidenceQuery = Pick<PlatformStoredQuery, 'id' | 'interface' | 'queryKey' | 'rdjb' | 'queriedAt'>

export type PlatformEvidenceRelation = Pick<PlatformStoredRelation, 'id' | 'queryId' | 'sequenceNo' | 'relationKey' | 'nameRaw' | 'usccRaw'>

export interface PlatformEvidenceIndex {
  /** 归一化查询键 → 以它为键的查询。 */
  queriesByUscc: Map<string, PlatformEvidenceQuery[]>
  /** query_id → 该次查询的关系（按 `sequenceNo` 升序）。 */
  relationsByQuery: Map<number, PlatformEvidenceRelation[]>
}

export type EvidenceResult =
  | { ok: true; evidence: DuplicateMergeEvidence }
  | { ok: false; reason: DuplicateMergePendingReason; message: string }

/** 判据的输入：**一个统代 + 一个名称**（判断平台是否说过「这个统代就叫这个名字」）。 */
export interface UsccNameEvidenceInput {
  /** 已归一化的统一社会信用代码（查询键）。 */
  uscc: string
  /** 要验的名称（**逐字**比较，不归一化）。 */
  name: string
}

export function findIndexedUsccEvidence(
  index: PlatformEvidenceIndex,
  input: UsccNameEvidenceInput,
  match: (a: unknown, b: unknown) => NameMatchLevel | null = (a, b) => a === b ? 'byte' : null,
): EvidenceResult {
  const uscc = input.uscc
  const queries = index.queriesByUscc.get(uscc) ?? []
  if (queries.length === 0) {
    return { ok: false, reason: 'no_platform_query', message: `统代 ${uscc} 一次都没查过（未查询 ≠ 查了没有）` }
  }
  const authorized = (query: (typeof queries)[number]) => query.interface === 'business_list' && query.rdjb === '3'
  const ordered = [...queries].sort((a, b) => {
    if (authorized(a) !== authorized(b)) return authorized(a) ? -1 : 1
    if (a.queriedAt !== b.queriedAt) return a.queriedAt < b.queriedAt ? 1 : -1
    return b.id - a.id
  })
  for (const query of ordered) {
    const sourceKind = ALIAS_SOURCE_KIND[query.interface]
    if (!sourceKind) continue
    // 一次查询的关系按 `sequenceNo` 升序取第一条 `qymc` 逐字相等的（索引已排好序）。
    const relations = index.relationsByQuery.get(query.id) ?? []
    for (const relation of relations) {
      // 判据：`match`（缺省逐字相等）—— 不做归一化、不做相似度、不算分数。
      const level = match(relation.nameRaw, input.name)
      if (!level) continue
      const relationUscc = normalizeUscc(relation.usccRaw)
      if (relationUscc && relationUscc !== uscc) continue
      return {
        ok: true,
        evidence: {
          relationId: relation.id,
          queryId: query.id,
          interface: query.interface,
          queryKey: query.queryKey,
          rdjb: query.rdjb,
          queriedAt: query.queriedAt,
          sequenceNo: relation.sequenceNo,
          relationKey: relation.relationKey,
          nameRaw: relation.nameRaw ?? '',
          usccRaw: relation.usccRaw,
          sourceKind,
          nameMatch: level,
        },
      }
    }
  }
  return {
    ok: false,
    reason: 'name_not_evidenced',
    message: `统代 ${uscc} 的 ${queries.length} 次查询里，没有一条关系的 qymc 逐字等于「${input.name}」`,
  }
}

/** 候选的**去重键**：同一（既有行 → 新统代）只处理一次。 */
function candidateKey(candidate: DuplicateNameCandidate): string {
  return `${duplicateTwinKey(candidate)}->${normalizeUscc(candidate.newUscc) ?? candidate.nameNorm}`
}

/** 幂等键：源批次 + **归并内容**（同证据同键 ⇒ 重放不增行；新证据新键 ⇒ 可再跑一批）。 */
export function duplicateMergeIdempotencyKey(batchKey: string, merges: RosterImportMerge[]): string {
  const digest = createHash('sha256').update(JSON.stringify(merges)).digest('hex').slice(0, 16)
  return `duplicate_merge:${batchKey}#sha256:${digest}`
}

/** 来源身份（逻辑标识，**不含凭证**）。 */
export function duplicateMergeSourceIdentity(batchKey: string): string {
  return `roster/duplicate-merge/${batchKey}`
}

/**
 * 把某批导入报出的重名候选编成一份**可提交**的归并计划（只读，不写一行）。
 *
 * 逐条判定、逐条给理由：证据不足的**绝不**进 `ready`，一律留在 `pending` 里说明原因。
 * 同一既有行被多条候选认领（同名多主体）时，**第一认领者进 `ready`、其余留待核** ——
 * 一条归并会删掉被并行，两条都执行只会让整批回滚，且「谁才是本体」本就不该由软件猜。
 */
type DuplicateSubject = { id: number; usccNorm: string | null; name: string }

export async function projectDuplicateMerge(
  batchKey: string,
  batch: { batchId: number; duplicateCandidates: DuplicateNameCandidate[] } | null,
  executed: { id: number; idempotencyKey: string } | undefined,
  read: {
    byId(id: number): DuplicateSubject | null | Promise<DuplicateSubject | null>
    byUscc(uscc: string): DuplicateSubject | null | Promise<DuplicateSubject | null>
    evidence(uscc: string, name: string): EvidenceResult
    exportName(uscc: string): string | null
  },
): Promise<DuplicateMergeReport> {
  const seen = new Set<string>()
  const candidates: DuplicateNameCandidate[] = []
  for (const candidate of batch?.duplicateCandidates ?? []) {
    const key = candidateKey(candidate)
    if (seen.has(key)) continue
    seen.add(key)
    candidates.push(candidate)
  }

  const ready: DuplicateMergeReport['ready'] = []
  const pending: DuplicateMergeReport['pending'] = []
  const claimed = new Set<number>()

  for (const candidate of candidates) {
    const fromId = candidate.existingEnterpriseId
    if (fromId == null) {
      pending.push({ candidate, reason: 'source_gone', message: '候选里没有记录被并企业的行 id（无法安全归并）' })
      continue
    }
    const from = await read.byId(fromId)
    if (!from) {
      pending.push({ candidate, reason: 'source_gone', message: `被并企业行 ${fromId} 已不在库里` })
      continue
    }
    // 被并方**自己就带统代** ⇒ 它是**另一个已识别的主体**：同名只说明同名（同名多主体），
    // 合并它会把两家公司并成一家。这种一律不并，留待核（判据是**库里的当前状态**，不是候选里的记录）。
    if (from.usccNorm) {
      pending.push({
        candidate,
        reason: 'source_has_uscc',
        message: `被并企业行 ${from.id} 自带统代 ${from.usccNorm} ⇒ 与规范行是两个已识别的不同主体（同名多主体），不并`,
      })
      continue
    }
    const uscc = normalizeUscc(candidate.newUscc)
    const into = uscc ? await read.byUscc(uscc) : null
    if (!uscc || !into) {
      pending.push({ candidate, reason: 'target_gone', message: `规范行（统代 ${uscc ?? '(空)'}）不在库里` })
      continue
    }
    if (into.id === from.id) {
      pending.push({ candidate, reason: 'same_enterprise', message: '被并企业与规范行是同一行' })
      continue
    }
    if (claimed.has(from.id)) {
      pending.push({
        candidate,
        reason: 'source_claimed',
        message: `企业行 ${from.id} 已被本批另一条候选认领 ⇒ 同名多主体，逐条待核（不猜）`,
      })
      continue
    }
    const evidence = read.evidence(uscc, candidate.existingEnterpriseName)
    if (!evidence.ok) {
      pending.push({ candidate, reason: evidence.reason, message: evidence.message })
      continue
    }
    claimed.add(from.id)
    // 主名称（§5.3 ①）：导出表侧记了另一个现名 ⇒ 显式带 `canonicalName`，让归并**改名**并把
    // 被顶掉的原名落成别名。导出表侧没有这个名字（或与现名相同）⇒ 不带，规范行保持不动。
    const exportName = read.exportName(uscc)
    const canonicalName = exportName && exportName !== into.name ? exportName : null
    ready.push({ candidate, evidence: evidence.evidence, exportName, merge: buildMerge(candidate, evidence.evidence, uscc, canonicalName) })
  }

  const merges = ready.map((item) => item.merge)
  return {
    batchKey,
    batchId: batch?.batchId ?? null,
    counts: { candidates: candidates.length, ready: ready.length, pending: pending.length },
    candidates,
    ready,
    pending,
    previous: executed ? { batchId: executed.id, idempotencyKey: executed.idempotencyKey } : null,
    request:
      merges.length === 0
        ? null
        : {
            idempotencyKey: duplicateMergeIdempotencyKey(batchKey, merges),
            sourceKind: 'alias_evidence',
            sourceIdentity: duplicateMergeSourceIdentity(batchKey),
            payload: { merges },
          },
  }
}

/**
 * 编一条 `merges` 项。
 *
 * **两侧逐字同名不给 `aliasName`**（契约 §5.3）：规范行的 `name` 是**导出表侧**（最新）的那个名字，
 * 被并的公布名与之逐字相同时没有第二个名字可留，别名只会污染搜索 ——
 * `executeMerge` 也用同一判据兜底（`aliasName === canonicalName` ⇒ 不造别名）。
 * 两侧逐字不同名时才写别名（`verification_status='confirmed'`，来源 = 这条平台关系）。
 *
 * `canonicalName`（§5.3 ①）只在**导出表侧记了另一个现名**时才给（见 {@link findExportSideName}）
 * —— 给了就把规范行改成导出表的名字、被顶掉的原名落成别名；不给则不改名。
 */
function buildMerge(
  candidate: DuplicateNameCandidate,
  evidence: DuplicateMergeEvidence,
  uscc: string,
  canonicalName: string | null,
): RosterImportMerge {
  const sameName = candidate.existingEnterpriseName === candidate.name
  const where = `${evidence.interface}${evidence.rdjb ? ` rdjb=${evidence.rdjb}` : ''} 序号 ${evidence.sequenceNo}${
    evidence.relationKey ? `（${evidence.relationKey}）` : ''
  }`
  return {
    fromEnterpriseId: candidate.existingEnterpriseId!,
    intoUscc: uscc,
    ...(canonicalName ? { canonicalName } : {}),
    ...(sameName ? {} : { aliasName: candidate.existingEnterpriseName }),
    sourceKind: evidence.sourceKind,
    sourceRefId: evidence.relationId,
    evidenceQueryId: evidence.queryId,
    note: `重名候选（同名 ${candidate.nameNorm}）；证据：${where} 于 ${evidence.queriedAt} 返回的 qymc 逐字等于「${evidence.nameRaw}」`,
  }
}
