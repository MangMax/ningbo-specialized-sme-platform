/**
 * **重名候选 → 可执行的归并**（RL-14，契约 §5.3 / §8.8）。
 *
 * ── 分工 ────────────────────────────────────────────────────────────────
 *  - 导入侧（`server/utils/roster-import.ts`）负责**报出**候选：新建企业时库里已有同名行。
 *  - 本模块负责把候选**判成**「可并 / 待核」，并编出一份可提交的 `payload.merges`。
 *  - 真正落库仍然只有一条路径：`POST /api/roster/import/commit`（契约 §8.2/§8.4）。
 *    本模块**只读**库（候选 + 已落库的平台关系），不写一行 —— 于是「读计划」与
 *    「提交计划」之间不存在第二套写入口，也不存在第二种事实。
 *
 * ── 为什么证据取「已落库的平台关系」而不是现查接口 ──────────────────────
 * 平台实查属 RL-03 的领地（`lib/platform/*`），本票不碰；而且证据必须是**可复核的落库行**
 * （有 `platform_relation.id` 可回指），否则归并血缘就没有出处。所以判据是：
 * **同一统代下存在一条 `qymc` 逐字等于被并方名称的关系行** ⇒ 归并；否则待核。
 *
 * ── 可重放 ──────────────────────────────────────────────────────────────
 * 幂等键由**源批次键 + 归并内容**派生：同样的证据 ⇒ 同样的键 ⇒ 第二次调用命中已提交批次、
 * 一行不增；补了新证据 ⇒ 内容不同 ⇒ 新键 ⇒ 新批次（待核的那几条此时才可能被并）。
 */
import { createHash } from 'node:crypto'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '../../db/schema'
import { normalizeUscc } from '../../lib/domain'
import type { DuplicateMergeEvidence, DuplicateMergePendingReason, DuplicateMergeReport } from '../../lib/roster/duplicate-merge'
import type { DuplicateNameCandidate, RosterImportMerge, RosterImportRequest } from '../../lib/roster-import-client'
import { readImportBatchOutcome } from './roster-import'

type Db = BetterSQLite3Database<typeof schema>

/** 接口 → 曾用名来源类别（契约 §1.2 的 `source_kind` 取值）。 */
const ALIAS_SOURCE_KIND: Record<string, 'platform_business' | 'platform_apply'> = {
  business_list: 'platform_business',
  apply_list: 'platform_apply',
}

type EvidenceResult =
  | { ok: true; evidence: DuplicateMergeEvidence }
  | { ok: false; reason: DuplicateMergePendingReason; message: string }

/**
 * 找「这个统代就叫这个名字」的**平台关系证据**（只读）。
 *
 * 只在**以该统代查询**的查询下找（按名查询的键是 `name:<nameNorm>`，不构成证据）。
 * 多个查询/多条关系都成立时取**确定性**的一条：查询按 `queriedAt` 新→旧（并列按 id 大→小），
 * 查询内按 `sequenceNo` 小→大取第一条命中 —— 同样的库 ⇒ 同样的证据 ⇒ 同样的归并（可重放）。
 *
 * 关系的 `tyshxydm` 若存在且**不是**该统代 ⇒ 这条讲的是别的企业，跳过（不拿它当证据）。
 */
export function findDuplicateMergeEvidence(db: Db, candidate: DuplicateNameCandidate): EvidenceResult {
  const uscc = normalizeUscc(candidate.newUscc)
  if (!uscc) {
    return { ok: false, reason: 'no_target_uscc', message: '候选的新建行没有统一社会信用代码，没有可回填的规范行' }
  }
  const queries = db
    .select()
    .from(schema.platformQuery)
    .all()
    .filter((query) => normalizeUscc(query.queryKey) === uscc)
  if (queries.length === 0) {
    return { ok: false, reason: 'no_platform_query', message: `统代 ${uscc} 一次都没查过（未查询 ≠ 查了没有）` }
  }
  const ordered = [...queries].sort((a, b) => (a.queriedAt === b.queriedAt ? b.id - a.id : a.queriedAt < b.queriedAt ? 1 : -1))
  for (const query of ordered) {
    const relations = db
      .select()
      .from(schema.platformRelation)
      .all()
      .filter((relation) => relation.queryId === query.id)
      .sort((a, b) => a.sequenceNo - b.sequenceNo)
    for (const relation of relations) {
      // **逐字相等**才是证据 —— 不做归一化、不做相似度。
      if (relation.nameRaw !== candidate.existingEnterpriseName) continue
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
          sourceKind: ALIAS_SOURCE_KIND[query.interface] ?? 'platform_business',
        },
      }
    }
  }
  return {
    ok: false,
    reason: 'name_not_evidenced',
    message: `统代 ${uscc} 的 ${queries.length} 次查询里，没有一条关系的 qymc 逐字等于「${candidate.existingEnterpriseName}」`,
  }
}

/** 候选的**去重键**：同一（既有行 → 新统代）只处理一次。 */
function candidateKey(candidate: DuplicateNameCandidate): string {
  const from = candidate.existingEnterpriseId != null ? `enterprise:${candidate.existingEnterpriseId}` : `uscc:${candidate.existingUscc ?? candidate.nameNorm}`
  return `${from}->${normalizeUscc(candidate.newUscc) ?? candidate.nameNorm}`
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
export function planDuplicateMerge(db: Db, batchKey: string): DuplicateMergeReport {
  const batch = readImportBatchOutcome(db, batchKey)
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
    const from = db.select().from(schema.enterprise).all().find((e) => e.id === fromId)
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
    const into = uscc ? db.select().from(schema.enterprise).all().find((e) => e.usccNorm === uscc) : undefined
    if (!into) {
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
    const evidence = findDuplicateMergeEvidence(db, candidate)
    if (!evidence.ok) {
      pending.push({ candidate, reason: evidence.reason, message: evidence.message })
      continue
    }
    claimed.add(from.id)
    ready.push({ candidate, evidence: evidence.evidence, merge: buildMerge(candidate, evidence.evidence, uscc!) })
  }

  const merges = ready.map((item) => item.merge)
  // 本批候选是不是**已经执行过**：来源身份是派生的、稳定的，所以直接按它找那一次批次。
  const executed = db
    .select()
    .from(schema.importBatch)
    .all()
    .filter((batch) => batch.sourceIdentity === duplicateMergeSourceIdentity(batchKey) && batch.status === 'committed')
    .sort((a, b) => b.id - a.id)[0]
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
 * **两侧同名不给 `aliasName`**（契约 §5.3）：规范行的 `name` 是**导出表侧**（最新）的那个名字，
 * 被并的公布名与之逐字相同时没有第二个名字可留，别名只会污染搜索 —— `executeMerge` 也会跳过。
 * 两侧不同名时才写别名（`verification_status='confirmed'`，来源 = 这条平台关系）。
 */
function buildMerge(
  candidate: DuplicateNameCandidate,
  evidence: DuplicateMergeEvidence,
  uscc: string,
): RosterImportMerge {
  const sameName = candidate.existingEnterpriseName === candidate.name
  return {
    fromEnterpriseId: candidate.existingEnterpriseId!,
    intoUscc: uscc,
    ...(sameName ? {} : { aliasName: candidate.existingEnterpriseName }),
    sourceKind: evidence.sourceKind,
    sourceRefId: evidence.relationId,
    evidenceQueryId: evidence.queryId,
    note: `重名候选（同名 ${candidate.nameNorm}）；证据：${evidence.interface}${evidence.rdjb ? ` rdjb=${evidence.rdjb}` : ''} 序号 ${evidence.sequenceNo} 的 qymc 逐字等于「${evidence.nameRaw}」`,
  }
}
