import { type PlatformEvidenceIndex, type PlatformEvidenceQuery, type PlatformEvidenceRelation, type UsccNameEvidenceInput, type EvidenceResult, findIndexedUsccEvidence, duplicateMergeSourceIdentity, projectDuplicateMerge } from './roster-duplicate-merge-model'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '../../../../db/schema'
import { normalizeUscc } from '../../lib/domain'
import type { NameMatchLevel } from '../../lib/roster/uscc-research'
import { getPlatformExportRows, listPlatformSnapshots } from '../../lib/platform-snapshots'
import type { DuplicateMergeReport } from '../../lib/roster/duplicate-merge'
import type { DuplicateNameCandidate } from '../../lib/roster-import-client'
import { findEnterpriseById, findEnterpriseByUscc, readImportBatchOutcome } from './roster-import'
import { targetCandidateTables } from './candidate-target-sources'
type Db = BetterSQLite3Database<typeof schema>
/**
 * 以该统代为查询键的**全部**查询（只读）。
 *
 * 为什么不用 `layers/sme-roster/lib/platform/read.ts` 的 `listPlatformQueries`：那个是**分页**的呈现读接口
 * （默认 25 条），拿它当证据查找会在查询很多时**静默截断**掉真正的证据 —— 归并的判据不能
 * 受分页影响。这里只做一次全量取数 + 归一化比较（查询键可能是小写/带空格的写法）。
 */
export function evidenceQueries(db: Db) {
  const { q } = targetCandidateTables(db)
  return db.select({ id: q.id, interface: q.interface, queryKey: q.queryKey, rdjb: q.rdjb, queriedAt: q.queriedAt }).from(q).all()
}
export function evidenceRelations(db: Db) {
  const { r } = targetCandidateTables(db)
  return db.select({ id: r.id, queryId: r.queryId, sequenceNo: r.sequenceNo, relationKey: r.relationKey, nameRaw: r.nameRaw, usccRaw: r.usccRaw }).from(r).all()
}
/** 建索引：一次读两张表，之后所有证据查找都在这份快照上做。 */
export function buildPlatformEvidenceIndex(db: Db): PlatformEvidenceIndex {
  return indexPlatformEvidence(evidenceQueries(db), evidenceRelations(db))
}
function indexPlatformEvidence(queries: PlatformEvidenceQuery[], relations: PlatformEvidenceRelation[]): PlatformEvidenceIndex {
  const queriesByUscc: PlatformEvidenceIndex['queriesByUscc'] = new Map()
  for (const query of queries) {
    const key = normalizeUscc(query.queryKey)
    const bucket = queriesByUscc.get(key)
    if (bucket) bucket.push(query)
    else queriesByUscc.set(key, [query])
  }
  const relationsByQuery: PlatformEvidenceIndex['relationsByQuery'] = new Map()
  for (const relation of relations) {
    const bucket = relationsByQuery.get(relation.queryId)
    if (bucket) bucket.push(relation)
    else relationsByQuery.set(relation.queryId, [relation])
  }
  for (const bucket of relationsByQuery.values()) bucket.sort((a, b) => a.sequenceNo - b.sequenceNo)
  return { queriesByUscc, relationsByQuery }
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
  if (index) return findIndexedUsccEvidence(index, input, match)
  const queries = evidenceQueries(db).filter(query => normalizeUscc(query.queryKey) === input.uscc)
  const queryIds = new Set(queries.map(query => query.id))
  const relations = queryIds.size ? evidenceRelations(db).filter(relation => queryIds.has(relation.queryId)) : []
  return findIndexedUsccEvidence(indexPlatformEvidence(queries, relations), input, match)
}
/** 重名候选那一侧的入口：只多一道「候选有没有统代」的前置判断。 */
export function findDuplicateMergeEvidence(db: Db, candidate: DuplicateNameCandidate): EvidenceResult {
  const uscc = normalizeUscc(candidate.newUscc)
  if (!uscc) {
    return { ok: false, reason: 'no_target_uscc', message: '候选的新建行没有统一社会信用代码，没有可回填的规范行' }
  }
  return findUsccKeyedRelationEvidence(db, { uscc, name: candidate.existingEnterpriseName })
}
/**
 * **导出表侧的主名称**（§5.3 ①，只读）：该统代在工信部导出快照里的企业名。
 *
 * 取**最新情况** —— 判据与读侧**同一套**（`layers/sme-roster/lib/roster/enterprise-roster.ts` 的
 * `latestBatchByTitle`：**年份大者新,同年按批 id**),不另立一套「最新」的定义。
 * 批内取该统代**源行号最小**的那一行的名字；名字为空的批次不算（空值优于错误值）。
 * **取不到就返回 `null`,绝不猜** —— 调用方据此不改规范行名。
 *
 * 表的读走 `layers/sme-roster/lib/platform-snapshots.ts` 的两个读函数（导出快照的读侧在那边），
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
export async function planDuplicateMerge(db: Db, batchKey: string): Promise<DuplicateMergeReport> {
  const batch = readImportBatchOutcome(db, batchKey)
  const executed = db.select().from(schema.importBatch).all()
    .filter(item => item.sourceIdentity === duplicateMergeSourceIdentity(batchKey) && item.status === 'committed')
    .sort((a, b) => b.id - a.id)[0]
  let index: PlatformEvidenceIndex | undefined
  return projectDuplicateMerge(batchKey, batch, executed, {
    byId: id => findEnterpriseById(db, id),
    byUscc: uscc => findEnterpriseByUscc(db, uscc),
    evidence: (uscc, name) => findIndexedUsccEvidence(index ??= buildPlatformEvidenceIndex(db), { uscc, name }),
    exportName: uscc => findExportSideName(db, uscc),
  })
}
export { type PlatformEvidenceQuery, type PlatformEvidenceRelation, type PlatformEvidenceIndex, type UsccNameEvidenceInput, findIndexedUsccEvidence, duplicateMergeIdempotencyKey, duplicateMergeSourceIdentity, projectDuplicateMerge } from './roster-duplicate-merge-model'
