import { differencePublicColumns } from './platform/difference-reference-target'
import { readTargetDeclarationFacts } from '../server/utils/platform-declarations-target'
import { readTargetBusinessProcessFacts } from '../server/utils/platform-business-processes-target'
import { readTargetRecognizedFacts } from '../server/utils/platform-recognized-target'
import { readCorrespondenceTargetQueries, readCorrespondenceTargetSources } from '../server/utils/record-correspondence-target-sources'
import { targetSchema as target } from './platform/target-schema'
import type { PlatformObservationFact } from './platform/observation-facts'
/** Batch native evidence for comparison rows; stored decisions remain authoritative. */
import { and, eq, inArray, max, or } from 'drizzle-orm'
import { alias } from 'drizzle-orm/sqlite-core'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '../../../db/schema'
import { normalizeUscc } from './domain'

import { projectPlatformComparisonEvidence, type ComparisonPlatformEvidence, type RowKey } from './comparison-platform-projection'

export * from './comparison-platform-projection'

/**
 * 归一化统代后比对:`''` → `null` 表示「这个值给不出统代」。
 * 规则本身在 `layers/sme-roster/lib/domain.ts` 的 `normalizeUscc`(**单一来源**)—— 与写入侧落
 * `uscc_norm`、与 `enterprise-roster.ts` 的 `normUscc` 是同一条,不另写一份。
 */
function normUscc(uscc: string | null | undefined): string | null {
  return normalizeUscc(uscc) || null
}

/** Scalar membership shared by full evidence and summary; no archives. */
export function readComparisonTargetMemberships(db: BetterSQLite3Database<typeof schema>, enterpriseIds: number[]) {
  if (!enterpriseIds.length) return []
  const c = target.platformCollection, qa = target.platformLegacyQueryAlias
  const o = target.platformBusinessObservation, a = target.platformObservationAssignment
  const newer = alias(a, 'comparison_membership_newer')
  const current = and(eq(a.observationId, o.id), eq(a.revision,
    db.select({ revision: max(newer.revision) }).from(newer).where(eq(newer.observationId, o.id))))
  const owned = db.selectDistinct({ enterpriseId: a.enterpriseId, queryId: qa.oldId, collectionId: c.id })
    .from(a).innerJoin(o, current).innerJoin(c, eq(c.id, o.collectionId))
    .innerJoin(qa, eq(qa.collectionId, c.id)).where(inArray(a.enterpriseId, enterpriseIds)).all()
    .flatMap(row => row.enterpriseId === null ? [] : [{ ...row, enterpriseId: row.enterpriseId }])
  const keys = db.select({ id: schema.enterprise.id, name: schema.enterprise.nameNorm, uscc: schema.enterprise.usccNorm })
    .from(schema.enterprise).where(inArray(schema.enterprise.id, enterpriseIds)).all()
  const ownersByKey = new Map<string, number[]>()
  for (const row of keys) {
    const uscc = normUscc(row.uscc)
    for (const key of [`name:${row.name}`, ...(uscc ? [uscc] : [])]) {
      const owners = ownersByKey.get(key) ?? []
      owners.push(row.id); ownersByKey.set(key, owners)
    }
  }
  const queried = ownersByKey.size ? db.select({ queryId: qa.oldId, collectionId: c.id, key: c.queryKey }).from(c)
    .innerJoin(qa, eq(qa.collectionId, c.id)).where(inArray(c.queryKey, [...ownersByKey.keys()])).all() : []
  const memberships = [...owned, ...queried.flatMap(row => (ownersByKey.get(row.key) ?? [])
    .map(enterpriseId => ({ enterpriseId, queryId: row.queryId, collectionId: row.collectionId })))]
  return [...new Map(memberships.map(row => [`${row.enterpriseId}:${row.queryId}`, row])).values()]
}

export function attachPlatformEvidence<T extends RowKey>(
  rows: T[],
  db: BetterSQLite3Database<typeof schema>,
): (T & { platform: ComparisonPlatformEvidence })[] {
  return db.transaction(tx => attachPlatformEvidenceSnapshot(rows, tx as typeof db))
}

function attachPlatformEvidenceSnapshot<T extends RowKey>(
  rows: T[],
  db: BetterSQLite3Database<typeof schema>,
): (T & { platform: ComparisonPlatformEvidence })[] {
  const enterpriseIds = [...new Set(rows.map((row) => row.enterpriseId))]
  if (!enterpriseIds.length) return []

  const aliases = db
    .select()
    .from(schema.enterpriseAlias)
    .where(inArray(schema.enterpriseAlias.enterpriseId, enterpriseIds))
    .orderBy(schema.enterpriseAlias.nameNorm)
    .all()

  const dispositions = db
    .select(differencePublicColumns(db))
    .from(schema.differenceReason)
    .where(inArray(schema.differenceReason.enterpriseId, enterpriseIds))
    .all()

  // 企业自身的查询键 —— 与 `layers/sme-roster/lib/roster/enterprise-roster.ts` 同一口径。
  const enterprises = db
    .select({
      id: schema.enterprise.id,
      nameNorm: schema.enterprise.nameNorm,
      usccNorm: schema.enterprise.usccNorm,
    })
    .from(schema.enterprise)
    .where(inArray(schema.enterprise.id, enterpriseIds))
    .all()
  /** 企业 → 自己的查询键(统一社会信用代码 / `name:<nameNorm>`)。 */
  const ownKeysByEnterprise = new Map<number, Set<string>>()
  for (const enterprise of enterprises) {
    const keys = new Set<string>([`name:${enterprise.nameNorm}`])
    const uscc = normUscc(enterprise.usccNorm)
    if (uscc) keys.add(uscc)
    ownKeysByEnterprise.set(enterprise.id, keys)
  }
  const queriedEnterpriseByKey = new Map<string, number[]>()
  for (const [enterpriseId, keys] of ownKeysByEnterprise) {
    for (const key of keys) {
      const bucket = queriedEnterpriseByKey.get(key)
      if (bucket) bucket.push(enterpriseId)
      else queriedEnterpriseByKey.set(key, [enterpriseId])
    }
  }

  // 查询 = **按关系归属的** ∪ **查询键就是它的**。后者是必须的:`no_record` / `failed`
  // 这类查询**一条关系都不返回**,只看关系就把它们整条丢掉了 —— 而「查过、接口确无记录」
  // 与「查询没成功执行」正是要看得见的四态里的两态(契约 §3.1)。
  // 判定键与 `enterprise-roster.ts` 的 `ownKeys` 逐字一致(先用过 `normUscc`)。
  const memberships = readComparisonTargetMemberships(db, enterpriseIds)
  const queries = [...readCorrespondenceTargetQueries(db, [...new Set(memberships.map(row => row.queryId))], { rawResponse: false }).values()]
    .map(row => row.query).sort((a, b) => a.id - b.id)

  // Read original rows for the selected queries, including archives saved before a master existed.
  // Query inclusion above remains scoped to this enterprise set; no identity is inferred here.
  const recognizedQueryIds = queries.filter(query => query.interface === 'recognized_list').map(query => query.id)
  const o = target.platformBusinessObservation, a = target.platformObservationAssignment
  const ra = target.platformLegacyRelationAlias, qa = target.platformLegacyQueryAlias
  const newer = alias(a, 'comparison_evidence_newer')
  const current = and(eq(a.observationId, o.id), eq(a.revision,
    db.select({ revision: max(newer.revision) }).from(newer).where(eq(newer.observationId, o.id))))
  const ownedCollections = db.select({ id: o.collectionId }).from(o).innerJoin(a, current)
    .where(inArray(a.enterpriseId, enterpriseIds))
  const targetRelations = db.select({ id: ra.oldId }).from(o)
    .innerJoin(ra, eq(ra.observationId, o.id)).innerJoin(qa, eq(qa.collectionId, o.collectionId))
    .innerJoin(a, current).where(or(inArray(o.collectionId, ownedCollections),
      recognizedQueryIds.length ? inArray(qa.oldId, recognizedQueryIds) : undefined))
    .orderBy(qa.oldId, o.sequenceNo).all()
  const relationRows = readCorrespondenceTargetSources(db, targetRelations.map(row => row.id)).map(row => row.relation)
    .sort((a, b) => a.queryId - b.queryId || a.sequenceNo - b.sequenceNo)
  const facts = new Map<number, PlatformObservationFact>()
  for (const interfaceName of ['apply_list', 'business_list', 'recognized_list'] as const) {
    const queryIds = new Set(queries.filter(q => q.interface === interfaceName).map(q => q.id))
    const ids = relationRows.filter(r => queryIds.has(r.queryId)).map(r => r.id)
    const selected = interfaceName === 'apply_list' ? readTargetDeclarationFacts(db, ids)
      : interfaceName === 'business_list' ? readTargetBusinessProcessFacts(db, ids, { scope: 'selected' })
      : readTargetRecognizedFacts(db, ids)
    for (const [id, fact] of selected) facts.set(id, fact)
  }

  return projectPlatformComparisonEvidence(rows, aliases, dispositions, queriedEnterpriseByKey, queries, relationRows, facts)
}
