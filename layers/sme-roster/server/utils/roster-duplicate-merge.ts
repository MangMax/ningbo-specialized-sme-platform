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
import * as schema from '../../../../db/schema'
import { normalizeUscc } from '../../lib/domain'
import type { NameMatchLevel } from '../../lib/roster/uscc-research'
import { getPlatformExportRows,listPlatformSnapshots } from '../../../../lib/platform-snapshots'
import {
duplicateTwinKey,
type DuplicateMergeEvidence,
type DuplicateMergePendingReason,
type DuplicateMergeReport,
} from '../../lib/roster/duplicate-merge'
import type { DuplicateNameCandidate,RosterImportMerge } from '../../../../lib/roster-import-client'
import { findEnterpriseById,findEnterpriseByUscc,readImportBatchOutcome } from '../../../../server/utils/roster-import'
import { targetCandidateTables } from '../../../../server/utils/candidate-target-sources'

type Db = BetterSQLite3Database<typeof schema>

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
 * 以该统代为查询键的**全部**查询（只读）。
 *
 * 为什么不用 `lib/platform/read.ts` 的 `listPlatformQueries`：那个是**分页**的呈现读接口
 * （默认 25 条），拿它当证据查找会在查询很多时**静默截断**掉真正的证据 —— 归并的判据不能
 * 受分页影响。这里只做一次全量取数 + 归一化比较（查询键可能是小写/带空格的写法）。
 */
function evidenceQueries(db: Db) {
  const { q } = targetCandidateTables(db)
  return db.select({ id: q.id, interface: q.interface, queryKey: q.queryKey, rdjb: q.rdjb, queriedAt: q.queriedAt }).from(q).all()
}

function evidenceRelations(db: Db) {
  const { r } = targetCandidateTables(db)
  return db.select({ id: r.id, queryId: r.queryId, sequenceNo: r.sequenceNo, relationKey: r.relationKey, nameRaw: r.nameRaw, usccRaw: r.usccRaw }).from(r).all()
}

function platformQueriesForUscc(db: Db, uscc: string) {
  return evidenceQueries(db).filter((query) => normalizeUscc(query.queryKey) === uscc)
}

/**
 * 证据查找的**预建索引**（只读快照）。
 *
 * 为什么要有它：{@link findUsccKeyedRelationEvidence} 每调用一次就要扫一遍 `platform_query`
 * 与 `platform_relation`。单次归并只查几条候选，无所谓；但 RL-06 的补录计划会对**上百个**
 * 候选逐个查找，实测真实库上 `platform_relation` 一次全扫约 126ms，于是几十次查找要十几秒。
 * 索引一次建好、多次复用，**判据一个字没变**（索引里放的正是原来每次现算的那两张表）。
 */
export interface PlatformEvidenceIndex {
  /** 归一化查询键 → 以它为键的查询。 */
  queriesByUscc: Map<string, ReturnType<typeof evidenceQueries>>
  /** query_id → 该次查询的关系（按 `sequenceNo` 升序）。 */
  relationsByQuery: Map<number, ReturnType<typeof evidenceRelations>>
}

/** 建索引：一次读两张表，之后所有证据查找都在这份快照上做。 */
export function buildPlatformEvidenceIndex(db: Db): PlatformEvidenceIndex {
  const queriesByUscc: PlatformEvidenceIndex['queriesByUscc'] = new Map()
  for (const query of evidenceQueries(db)) {
    const key = normalizeUscc(query.queryKey)
    const bucket = queriesByUscc.get(key)
    if (bucket) bucket.push(query)
    else queriesByUscc.set(key, [query])
  }
  const relationsByQuery: PlatformEvidenceIndex['relationsByQuery'] = new Map()
  for (const relation of evidenceRelations(db)) {
    const bucket = relationsByQuery.get(relation.queryId)
    if (bucket) bucket.push(relation)
    else relationsByQuery.set(relation.queryId, [relation])
  }
  for (const bucket of relationsByQuery.values()) bucket.sort((a, b) => a.sequenceNo - b.sequenceNo)
  return { queriesByUscc, relationsByQuery }
}

type EvidenceResult =
  | { ok: true; evidence: DuplicateMergeEvidence }
  | { ok: false; reason: DuplicateMergePendingReason; message: string }

/** 判据的输入：**一个统代 + 一个名称**（判断平台是否说过「这个统代就叫这个名字」）。 */
export interface UsccNameEvidenceInput {
  /** 已归一化的统一社会信用代码（查询键）。 */
  uscc: string
  /** 要验的名称（**逐字**比较，不归一化）。 */
  name: string
}

/**
 * 找「这个统代就叫这个名字」的**平台关系证据**（只读）—— **判据本体**。
 *
 * 两个入口共用它：重名候选的归并（{@link findDuplicateMergeEvidence}）与
 * 缺统代企业的库内核心词补录（RL-06 的 `layers/sme-roster/server/utils/uscc-research.ts`）。
 * 抽出来是为了让「什么算证据」**只有一处实现** —— 两个票各写一遍迟早会漂，
 * 而漂了以后同一份平台数据在两个入口会给出不同结论。
 *
 * 只在**以该统代查询**的查询下找（按名查询的键是 `name:<nameNorm>`，不构成证据）。
 * 多个查询/多条关系都成立时取**确定性**的一条：
 *  1. **用户实测过的那一类形状优先**（`business_list` + `rdjb=3`，实测的 4 例就在这里）；
 *  2. 其余按 `queriedAt` 新→旧（并列按行 id 大→小）；
 *  3. 查询内按 `sequenceNo` 小→大取第一条命中。
 * 同一个库 ⇒ 同一条证据 ⇒ 同样的结论（可重放）。
 *
 * 判据只有一条：关系的 `qymc`（`name_raw`）与目标名称**逐字相等**。别的接口（如 `apply_list`）
 * 同样带 `tyshxydm` + `qymc`，「平台说这个统代叫什么」这句话并不因接口而不同，所以也认；
 * 用了哪一条**如实记进报告**（`interface` / `rdjb` / `sequenceNo` / `relationKey` / `queriedAt`）。
 * 关系的 `tyshxydm` 若存在且**不是**该统代 ⇒ 这条讲的是别的企业，跳过（不拿它当证据）。
 */
export function findUsccKeyedRelationEvidence(
  db: Db,
  input: UsccNameEvidenceInput,
  index?: PlatformEvidenceIndex,
  /**
   * 名称比对档次。**缺省 = 逐字相等**（RL-14 的归并判据一个字没变）。
   * RL-06 会传入放宽到「字形/区县写法」的比对（父代理 2026-10-16 裁定），
   * 并把实际命中到哪一档**记进证据**（`nameMatch`），使「哪些回填依赖放宽判据」可审。
   */
  match: (a: unknown, b: unknown) => NameMatchLevel | null = (a, b) => (a === b ? 'byte' : null),
): EvidenceResult {
  const uscc = input.uscc
  const queries = index ? (index.queriesByUscc.get(uscc) ?? []) : platformQueriesForUscc(db, uscc)
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
    const relations = index
      ? (index.relationsByQuery.get(query.id) ?? [])
      : evidenceRelations(db)
          .filter((relation) => relation.queryId === query.id)
          .sort((a, b) => a.sequenceNo - b.sequenceNo)
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

/** 重名候选那一侧的入口：只多一道「候选有没有统代」的前置判断。 */
export function findDuplicateMergeEvidence(db: Db, candidate: DuplicateNameCandidate): EvidenceResult {
  const uscc = normalizeUscc(candidate.newUscc)
  if (!uscc) {
    return { ok: false, reason: 'no_target_uscc', message: '候选的新建行没有统一社会信用代码，没有可回填的规范行' }
  }
  return findUsccKeyedRelationEvidence(db, { uscc, name: candidate.existingEnterpriseName })
}

/** 候选的**去重键**：同一（既有行 → 新统代）只处理一次。 */
function candidateKey(candidate: DuplicateNameCandidate): string {
  return `${duplicateTwinKey(candidate)}->${normalizeUscc(candidate.newUscc) ?? candidate.nameNorm}`
}

/**
 * **导出表侧的主名称**（§5.3 ①，只读）：该统代在工信部导出快照里的企业名。
 *
 * 取**最新情况** —— 判据与读侧**同一套**（`layers/sme-roster/lib/roster/enterprise-roster.ts` 的
 * `latestBatchByTitle`：**年份大者新,同年按批 id**),不另立一套「最新」的定义。
 * 批内取该统代**源行号最小**的那一行的名字；名字为空的批次不算（空值优于错误值）。
 * **取不到就返回 `null`,绝不猜** —— 调用方据此不改规范行名。
 *
 * 表的读走 `lib/platform-snapshots.ts` 的两个读函数（导出快照的读侧在那边），
 * 本函数不自己扫表 —— 「导出快照长什么样」只有一处知识。
 */
export function findExportSideName(db: Db, usccRaw: string | null): string | null {
  const uscc = normalizeUscc(usccRaw)
  if (!uscc) return null
  // 读侧返回的是 (称号 → 年份 → 批 id) 升序,这里要的是「最新」:按同一组字段重排一次(纯算术比较,
  // 不在比较器里查库),命中即返回 ⇒ 通常只读一个批次的快照行。
  const batches = [...listPlatformSnapshots(db)].sort((a, b) =>
    a.batch.year !== b.batch.year ? b.batch.year - a.batch.year : b.batch.id - a.batch.id,
  )
  for (const item of batches) {
    const row = getPlatformExportRows(db, item.batch.id).find(
      (candidate) => normalizeUscc(candidate.usccRaw) === uscc && !!candidate.nameRaw?.trim(),
    )
    if (row?.nameRaw) return row.nameRaw.trim()
  }
  return null
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
    const from = findEnterpriseById(db, fromId)
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
    const into = uscc ? findEnterpriseByUscc(db, uscc) : null
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
    // 主名称（§5.3 ①）：导出表侧记了另一个现名 ⇒ 显式带 `canonicalName`，让归并**改名**并把
    // 被顶掉的原名落成别名。导出表侧没有这个名字（或与现名相同）⇒ 不带，规范行保持不动。
    const exportName = findExportSideName(db, uscc)
    const canonicalName = exportName && exportName !== into.name ? exportName : null
    ready.push({ candidate, evidence: evidence.evidence, exportName, merge: buildMerge(candidate, evidence.evidence, uscc!, canonicalName) })
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
