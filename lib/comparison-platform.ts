import type { PlatformStoredRelation } from './platform/read'
import { differencePublicColumns } from './platform/difference-reference-target'
import { readTargetDeclarationFacts } from '../server/utils/platform-declarations-target'
import { readTargetBusinessProcessFacts } from '../server/utils/platform-business-processes-target'
import { readTargetRecognizedFacts } from '../server/utils/platform-recognized-target'
import { readCorrespondenceTargetQueries, readCorrespondenceTargetSources } from '../server/utils/record-correspondence-target-sources'
import { targetSchema as target } from './platform/target-schema'
import type { PlatformObservationFact } from './platform/observation-facts'
import { sourcePositionForSequence } from './platform/recognized-evidence'
import { type PlatformNormalizationConflict } from './platform/normalization'
/**
 * 比对行 × 平台证据的**接缝**(RL-03 交付物 3;RL-15 收口为**以库内为准**)。
 *
 * 比对页原来只把 `data/platform-reconcile.json` 的**离线解释缓存**挂在行上
 * (见 `lib/reconcile.ts`,那条路径**保持兼容、一字不改**)。本模块是**库内**那条路:
 *  - 该企业的**现名 / 曾用名**(`enterprise_alias`);
 *  - 该差异的**已核验处置**(`difference_reason`,原因 + 配对措施,取 `recordedAt` 最新那条);
 *  - 该企业的**平台查询与原始关系**(`platform_query` / `platform_relation`)—— 可展开的接口证据。
 *
 * ── RL-15 改了什么(以及为什么) ────────────────────────────────────────────
 * 用户 2026-10-16 反馈「三个称号从平台获取的数据都没了」。根因是**解释缓存缺失**
 * (`data/platform-reconcile.json` 在某环境不存在)时,旧的「平台解释」列整列退化成 `—`,
 * 而库里其实有 `difference_reason` / `platform_query` / `platform_relation` —— 页面却把它
 * 当成空。所以:
 *
 *  1. **每一行都带 `platform`**(不再有 `null`):状态机的**默认态**是 `not_queried`
 *     (「还没查过」,不是「没有」),由 `disposition.explanationId === null` 说清
 *     「还没存下解释」。这与 `lib/roster/enterprise-roster.ts` 的差异读模型**同一口径**
 *     (父代理 2026-10-16 裁决 #1:展示态**只从 `difference_reason.status` 取**)。
 *  2. **读侧绝不二次推导**:不从查询/关系反推「无记录」或「已确认」,也不改写原因 ——
 *     接口有记录时库里的 `confirmed_reason` + `platform_stale` 原样带出,
 *     **不得**显示成 `no_record` / `confirmed_no_diff`。
 *  3. 旧 JSON 缓存仍由 `lib/reconcile.ts` 照旧挂 `explanation`,页面只把它当**对照**。
 *
 * 取数一次读完(与 `enterprise-roster.ts` 同一取舍:台账是几千级,拼 join 不如内存组织)。
 */
import { and, eq, inArray, max, or } from 'drizzle-orm'
import { alias } from 'drizzle-orm/sqlite-core'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '../db/schema'
import type { ComparisonDirection } from './comparison'
import { normalizeUscc } from './domain'

export interface ComparisonAlias {
  id: number
  name: string
  nameNorm: string
  sourceKind: string
  sourceRefId: number
  verificationStatus: string
  validFrom: string | null
  note: string | null
}

export interface ComparisonDisposition {
  /**
   * 存下来的解释行 id;**`null` = 还没有解释记录** —— 此时 `status` 就是状态机的
   * 默认态 `not_queried`(与 `lib/roster/enterprise-roster.ts` 的 `explanationId` 同义)。
   */
  explanationId: number | null
  status: string
  reasonCode: string | null
  reasonNote: string | null
  measureCode: string | null
  measureNote: string | null
  movedIn: { city: string | null; titleCode: string | null; year: number | null; batch: number | null } | null
  verificationStatus: string
  /** 该解释的登记时点;没有解释记录时为 `null`。 */
  recordedAt: string | null
  evidenceQueryId: number | null
  evidenceRelationId: number | null
}

/** 一条**平台原始关系**(`platform_relation`)—— 可展开的接口证据原文。 */
export interface ComparisonRelation {
  normalizationConflicts?: PlatformNormalizationConflict[]
  enterpriseId?: number | null
  rawFields?: Record<string, unknown> | null
  sourceRdjb?: string | null
  sourcePage?: number | null
  id: number
  queryId: number
  sequenceNo: number
  relationKey: string | null
  usccRaw: string | null
  nameRaw: string | null
  aliasNameRaw: string | null
  province: string | null
  status: string | Buffer | null
  batch: string | null
  declareKind: string | null
  appliedAt: string | null
  awardBatchLabel: string | null
  year: number | null
  matchBasis: string
  verificationStatus: string
}

export interface ComparisonQuerySummary {
  collectionEvidence?: import('./platform/live-query').PlatformLiveQueryResult | null
  titleCode?: string | null
  id: number
  interface: string
  queryKey: string
  rdjb: string
  queriedAt: string
  status: string
  failureReason: string | null
  relationCount: number
  /** 这次查询返回的**全部**关系(逐条原文;不按企业二次过滤 —— 查询本身就是证据)。 */
  relations: ComparisonRelation[]
}

export interface ComparisonPlatformEvidence {
  aliases: ComparisonAlias[]
  /**
   * **当前**处置 = `recordedAt` 最新的那条(时态化,旧解释不丢但只展示最新)。
   * 没有解释记录时也给一条:状态即状态机的默认态 `not_queried`。
   */
  disposition: ComparisonDisposition
  queries: ComparisonQuerySummary[]
  /** Included queries' original source-row count, independent of confirmed ownership. */
  relationCount: number
}

interface RowKey {
  enterpriseId: number
  titleCode: string
  direction: ComparisonDirection
}

/**
 * 给比对行附加库内平台证据。按 `enterpriseId` **批量取数**(不是每行一次查询),
 * 并只把「对得上 `(企业, 称号, 方向)`」的那条处置挂到行上。
 *
 * **每一行都返回 `platform`**(永不为 `null`):没有解释记录时,处置就是状态机的
 * 默认态 `not_queried` + `explanationId: null`。页面因此不会再有「整列 —」的观感。
 */
/**
 * 归一化统代后比对:`''` → `null` 表示「这个值给不出统代」。
 * 规则本身在 `lib/domain.ts` 的 `normalizeUscc`(**单一来源**)—— 与写入侧落
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

  // 企业自身的查询键 —— 与 `lib/roster/enterprise-roster.ts` 同一口径。
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
    const selected = interfaceName === 'apply_list' ? readTargetDeclarationFacts(db, ids, { scope: 'selected' })
      : interfaceName === 'business_list' ? readTargetBusinessProcessFacts(db, ids, { scope: 'selected' })
      : readTargetRecognizedFacts(db, ids)
    for (const [id, fact] of selected) facts.set(id, fact)
  }

  const aliasesByEnterprise = new Map<number, ComparisonAlias[]>()
  for (const alias of aliases) {
    const item: ComparisonAlias = {
      id: alias.id,
      name: alias.name,
      nameNorm: alias.nameNorm,
      sourceKind: alias.sourceKind,
      sourceRefId: alias.sourceRefId,
      verificationStatus: alias.verificationStatus,
      validFrom: alias.validFrom,
      note: alias.note,
    }
    const bucket = aliasesByEnterprise.get(alias.enterpriseId)
    if (bucket) bucket.push(item)
    else aliasesByEnterprise.set(alias.enterpriseId, [item])
  }

  const queryById = new Map(queries.map(query => [query.id, query]))
  const toRelation = (archived: PlatformStoredRelation): ComparisonRelation => {
    const query = queryById.get(archived.queryId)
    const fact = facts.get(archived.id)
    if (!fact?.archiveProcessFacts) throw new Error(`missing_archive_process_facts:${archived.id}`)
    const row = { ...archived, ...fact.archiveProcessFacts, normalizationConflicts: fact.normalizationConflicts }
    return {
      ...(query?.interface === 'recognized_list' ? { enterpriseId: row.enterpriseId } : {}),
      normalizationConflicts: row.normalizationConflicts,
      id: row.id,
      queryId: row.queryId,
      sequenceNo: row.sequenceNo,
      relationKey: row.relationKey,
      rawFields: row.rawFields,
      ...sourcePositionForSequence(query?.collectionEvidence, row.sequenceNo),
      usccRaw: row.usccRaw,
      nameRaw: row.nameRaw,
      aliasNameRaw: row.aliasNameRaw,
      province: row.province,
      status: row.status,
      batch: row.batch,
      declareKind: row.declareKind,
      appliedAt: row.appliedAt,
      awardBatchLabel: row.awardBatchLabel,
      year: row.year,
      matchBasis: row.matchBasis,
      verificationStatus: row.verificationStatus,
    }
  }

  const relationsByQuery = new Map<number, ComparisonRelation[]>()
  /** 查询 → 有关系归到它的企业集合(用于把查询摘要挂到每个相关企业上)。 */
  const enterprisesByQuery = new Map<number, Set<number>>()
  for (const row of relationRows) {
    const list = relationsByQuery.get(row.queryId)
    if (list) list.push(toRelation(row))
    else relationsByQuery.set(row.queryId, [toRelation(row)])
    if (row.enterpriseId != null) {
      const bucket = enterprisesByQuery.get(row.queryId)
      if (bucket) bucket.add(row.enterpriseId)
      else enterprisesByQuery.set(row.queryId, new Set([row.enterpriseId]))
    }
  }

  const queriesByEnterprise = new Map<number, ComparisonQuerySummary[]>()
  for (const query of queries) {
    const relations = relationsByQuery.get(query.id) ?? []
    const summary: ComparisonQuerySummary = {
      id: query.id,
      interface: query.interface,
      queryKey: query.queryKey,
      rdjb: query.rdjb,
      queriedAt: query.queriedAt,
      collectionEvidence: query.collectionEvidence,
      titleCode: query.titleCode,
      status: query.status,
      failureReason: query.failureReason,
      relationCount: relations.length,
      relations,
    }
    // 一个查询可能同时有关系归到多个企业;按关系归属逐个企业挂。
    const owners = new Set<number>(enterprisesByQuery.get(query.id) ?? [])
    // 再加上「查询键就是它」的企业 —— 没有关系的那种查询靠这一条才挂得上。
    for (const enterpriseId of queriedEnterpriseByKey.get(query.queryKey) ?? queriedEnterpriseByKey.get(normUscc(query.queryKey) ?? query.queryKey) ?? []) {
      owners.add(enterpriseId)
    }
    for (const enterpriseId of owners) {
      const bucket = queriesByEnterprise.get(enterpriseId)
      if (bucket) bucket.push(summary)
      else queriesByEnterprise.set(enterpriseId, [summary])
    }
  }

  const latestDisposition = new Map<string, ComparisonDisposition>()
  for (const row of dispositions) {
    const key = `${row.enterpriseId}|${row.titleCode}|${row.direction}`
    const previous = latestDisposition.get(key)
    if (previous && previous.recordedAt != null && previous.recordedAt >= row.recordedAt) continue
    latestDisposition.set(key, {
      explanationId: row.id,
      status: row.status,
      reasonCode: row.reasonCode,
      reasonNote: row.reasonNote,
      measureCode: row.measureCode,
      measureNote: row.measureNote,
      movedIn: {
        city: row.movedInCity,
        titleCode: row.movedInTitleCode,
        year: row.movedInYear,
        batch: row.movedInBatch,
      },
      verificationStatus: row.verificationStatus,
      recordedAt: row.recordedAt,
      evidenceQueryId: row.evidenceQueryId,
      evidenceRelationId: row.evidenceRelationId,
    })
  }

  /**
   * 没有解释记录时的处置:**状态机的默认态**(契约 §3.2 的 `not_queried`)。
   * 这里**不**看查询、不看关系 —— 展示态只从 `difference_reason.status` 取。
   */
  const defaultDisposition: ComparisonDisposition = {
    explanationId: null,
    status: 'not_queried',
    reasonCode: null,
    reasonNote: null,
    measureCode: null,
    measureNote: null,
    movedIn: null,
    verificationStatus: 'pending',
    recordedAt: null,
    evidenceQueryId: null,
    evidenceRelationId: null,
  }

  return rows.map((row) => {
    const rowAliases = aliasesByEnterprise.get(row.enterpriseId) ?? []
    const rowQueries = queriesByEnterprise.get(row.enterpriseId) ?? []
    const disposition =
      latestDisposition.get(`${row.enterpriseId}|${row.titleCode}|${row.direction}`) ?? defaultDisposition
    const relationCount = rowQueries.reduce((count, query) => count + query.relations.length, 0)
    return {
      ...row,
      platform: { aliases: rowAliases, disposition, queries: rowQueries, relationCount },
    }
  })
}
