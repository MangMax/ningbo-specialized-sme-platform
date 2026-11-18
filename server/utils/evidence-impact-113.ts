/** Durable, explicitly drained evidence work. Call capture functions inside the fact transaction. */
import { and,asc,desc,eq,gt,inArray,or,sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { createHash } from 'node:crypto'
import * as s from '../../db/schema'
import { orderDifferenceEnvelopeConditions,readDifferenceRevisionMaterials } from '../../layers/sme-roster/lib/platform/difference-hash-inputs'
import { differenceEvidenceColumns } from '../../layers/sme-roster/lib/platform/difference-reference-target'
import { readDifferenceCollection,readDifferenceCollectionScope,readDifferenceObservations } from '../../layers/sme-roster/lib/platform/difference-sources'
import { readLatestDecisionHead102 as latestDecisionHead102 } from '../../layers/sme-roster/server/utils/decision-lifecycle-102/head'

type Db = BetterSQLite3Database<typeof s>
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]
export type EvidenceExecutor113 = Db | Tx
export type EvidenceScope113 = { enterpriseId: number; titleCode: string; direction: 'missing_in_miit' | 'extra_in_miit' }
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)]))
  return value
}
export const evidenceDigest113 = (value: unknown) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
const empty = evidenceDigest113([])
function bound(value: number | undefined) {
  const n = value ?? 50
  if (!Number.isInteger(n) || n < 1 || n > 100) throw new Error('Evidence work limit must be 1..100')
  return n
}
const scopeKey113 = (enterpriseId: number | null, titleCode: string | null, direction: string | null) => JSON.stringify([enterpriseId, titleCode, direction])
interface RevisionInput {
  sourceKind: string; sourceKey: string; sourceVersion: string
  enterpriseId?: number | null; titleCode?: string | null; direction?: string | null; eventId?: number | null
  coverageDigest?: string; factDigest: string; beforeFactDigest?: string; queryExecuted?: boolean; preserveFacts?: boolean
  metadata?: Record<string, unknown>
}
function register(db: EvidenceExecutor113, input: RevisionInput) {
  const sourceKey = `${input.sourceKind}:${input.sourceKey}`
  const prior = db.select({ id: s.evidenceRevision113.id }).from(s.evidenceRevision113).where(and(eq(s.evidenceRevision113.sourceKind, input.sourceKind), eq(s.evidenceRevision113.sourceKey, sourceKey), eq(s.evidenceRevision113.sourceVersion, input.sourceVersion))).get()
  if (prior) return prior.id
  const head = db.select().from(s.evidenceSemanticHead113).where(eq(s.evidenceSemanticHead113.sourceKey, sourceKey)).get()
  const factDigest = input.preserveFacts ? head?.factDigest ?? empty : input.factDigest
  const coverageDigest = input.coverageDigest ?? empty
  const coverageChanged = coverageDigest !== (head?.coverageDigest ?? empty)
  const factChanged = factDigest !== (input.beforeFactDigest ?? head?.factDigest ?? empty)
  if (!coverageChanged && !factChanged) return null
  const metadata = input.metadata ?? {}
  if (Buffer.byteLength(JSON.stringify(metadata)) > 16384) throw new Error('Evidence revision metadata exceeds 16KiB')
  const maxDecisionId = db.get<{ id: number }>(sql`select coalesce(max(id),0) id from difference_reason`)!.id
  const revision = db.insert(s.evidenceRevision113).values({
    sourceKind: input.sourceKind, sourceKey, sourceVersion: input.sourceVersion,
    enterpriseId: input.enterpriseId ?? null, titleCode: input.titleCode ?? null, direction: input.direction ?? null, eventId: input.eventId ?? null,
    coverageDigest, factDigest, coverageChanged, factChanged, queryExecuted: input.queryExecuted ?? false,
    metadata, maxDecisionId, createdAt: new Date().toISOString(),
  }).returning({ id: s.evidenceRevision113.id }).get()
  db.insert(s.evidenceSemanticHead113).values({ sourceKey, coverageDigest, factDigest, latestRevisionId: revision.id }).onConflictDoUpdate({ target: s.evidenceSemanticHead113.sourceKey, set: { coverageDigest, factDigest, latestRevisionId: revision.id } }).run()
  db.insert(s.evidenceImpactProgress113).values({ revisionId: revision.id }).run()
  const v = s.evidenceScopeVersion113
  db.insert(v).values({ scopeKey: scopeKey113(input.enterpriseId ?? null, input.titleCode ?? null, input.direction ?? null), latestRevisionId: revision.id, pendingCount: 1 })
    .onConflictDoUpdate({ target: v.scopeKey, set: { latestRevisionId: revision.id, pendingCount: sql`${v.pendingCount}+1` } }).run()
  if (input.eventId != null && input.enterpriseId != null && input.titleCode != null) db.insert(s.evidenceRevisionEvent113).values({ revisionId: revision.id, eventId: input.eventId, enterpriseId: input.enterpriseId, titleCode: input.titleCode }).onConflictDoNothing().run()
  return revision.id
}
/** Scalar before/after identity material only; notes and audit timestamps are not semantic changes. */
export function captureIdentityRevision113(db: EvidenceExecutor113, input: { enterpriseId: number; sourceKey: string; sourceVersion: string; before: unknown; after: unknown; fromEnterpriseId?: number }) {
  if (evidenceDigest113(input.before) === evidenceDigest113(input.after)) return null
  const revisionId = register(db, { sourceKind: 'identity', sourceKey: input.sourceKey, sourceVersion: input.sourceVersion, enterpriseId: input.enterpriseId,
    beforeFactDigest: evidenceDigest113(input.before), factDigest: evidenceDigest113(input.after), metadata: { fromEnterpriseId: input.fromEnterpriseId ?? null } })
  if (revisionId != null) db.run(sql`insert or ignore into evidence_revision_event_113(revision_id,event_id,enterprise_id,title_code)
    select ${revisionId},e.id,r.enterprise_id,r.title_code from record r join record_event e on e.record_id=r.id where r.enterprise_id=${input.enterpriseId}`)
  return revisionId
}

export function processEvidenceImpacts113(db: Db, input: { limit?: number } = {}) {
  const limit = bound(input.limit)
  return db.transaction(tx => {
    let processed = 0
    while (processed < limit) {
      const progress = tx.select().from(s.evidenceImpactProgress113).where(eq(s.evidenceImpactProgress113.done, false)).orderBy(asc(s.evidenceImpactProgress113.revisionId)).limit(1).get()
      if (!progress) break
      const revision = tx.select().from(s.evidenceRevision113).where(eq(s.evidenceRevision113.id, progress.revisionId)).get()!
      const remaining = limit - processed
      const publicQuery = differenceEvidenceColumns(tx, 'd').evidenceQueryId
      const candidates = tx.all<{ id: number; enterpriseId: number; titleCode: string; direction: string; status: string; evidenceQueryId: number | null }>(sql`
        select d.id, d.enterprise_id enterpriseId, d.title_code titleCode, d.direction, d.status,${publicQuery} evidenceQueryId from difference_reason d
        where d.id > ${progress.cursor} and d.id <= ${revision.maxDecisionId}
        and ${revision.enterpriseId == null ? sql`1` : sql`d.enterprise_id = ${revision.enterpriseId}`}
        and ${revision.titleCode == null ? sql`1` : sql`d.title_code = ${revision.titleCode}`}
        and ${revision.direction == null ? sql`1` : sql`d.direction = ${revision.direction}`}
        and coalesce(d.lifecycle_action,'') != 'withdraw'
        and not exists (select 1 from difference_reason n where n.enterprise_id=d.enterprise_id and n.title_code=d.title_code and n.direction=d.direction and (n.recorded_at>d.recorded_at or (n.recorded_at=d.recorded_at and n.id>d.id)))
        order by d.id limit ${remaining}`)
      for (const d of candidates) {
        const classification = evaluateEvidenceImpact113(tx, revision, d)
        if (classification !== 'no_review') {
          const t = s.explanationImpact113
          const state = tx.insert(t).values({ enterpriseId: d.enterpriseId, titleCode: d.titleCode, direction: d.direction, decisionId: d.id, latestRevisionId: revision.id, pendingSinceRevisionId: revision.id, classification })
            .onConflictDoUpdate({ target: [t.enterpriseId, t.titleCode, t.direction, t.decisionId], set: { latestRevisionId: revision.id,
              classification: sql`case when ${t.classification}='premise_invalid' then 'premise_invalid' else ${classification} end`,
              pendingSinceRevisionId: sql`case when ${t.reviewedRevisionId} >= ${t.latestRevisionId} then ${revision.id} else ${t.pendingSinceRevisionId} end`,
            } }).returning({ id: t.id }).get()
          tx.insert(s.evidenceImpactLink113).values({ revisionId: revision.id, impactId: state.id, classification }).onConflictDoNothing().run()
        }
      }
      processed += Math.max(1, candidates.length)
      const done = candidates.length < remaining
      tx.update(s.evidenceImpactProgress113).set({ cursor: candidates.at(-1)?.id ?? progress.cursor, done }).where(eq(s.evidenceImpactProgress113.revisionId, revision.id)).run()
      if (done) tx.update(s.evidenceScopeVersion113).set({ pendingCount: sql`${s.evidenceScopeVersion113.pendingCount}-1` }).where(eq(s.evidenceScopeVersion113.scopeKey, scopeKey113(revision.enterpriseId, revision.titleCode, revision.direction))).run()
    }
    const pending = tx.select({ id: s.evidenceImpactProgress113.revisionId }).from(s.evidenceImpactProgress113).where(eq(s.evidenceImpactProgress113.done, false)).orderBy(asc(s.evidenceImpactProgress113.revisionId)).limit(1).get()
    const last = tx.select({ id: s.evidenceRevision113.id }).from(s.evidenceRevision113).orderBy(desc(s.evidenceRevision113.id)).limit(1).get()?.id ?? 0
    return { processed, unfinished: !!pending, watermark: pending ? pending.id - 1 : last }
  }, { behavior: 'immediate' })
}
/** Internal bounded staging read for #114, not a public API or an implicit drain. */
export function listEvidenceImpacts113(db: EvidenceExecutor113, input: { enterpriseId?: number; afterId?: number; limit?: number } = {}) {
  const t = s.explanationImpact113
  return db.select().from(t).where(and(input.enterpriseId == null ? undefined : eq(t.enterpriseId, input.enterpriseId), gt(t.id, input.afterId ?? 0))).orderBy(asc(t.id)).limit(bound(input.limit)).all()
}
function evidenceKeys113(scope: EvidenceScope113) {
  return [scope.enterpriseId, null].flatMap(e => [scope.titleCode, null].flatMap(t => [scope.direction, null].map(d => scopeKey113(e, t, d))))
}
function evidenceToken113(scope: EvidenceScope113, decisionId: number | null, versions: Array<typeof s.evidenceScopeVersion113.$inferSelect>) {
  return { ...scope, decisionId, latestRevisionId: Math.max(0, ...versions.map(v => v.latestRevisionId)), projectionReady: versions.every(v => v.pendingCount === 0) }
}
/** Trusted lifecycle heads from the same transaction; latest includes withdrawal. */
export function readEvidenceImpacts113(db: EvidenceExecutor113, inputs: readonly { scope: EvidenceScope113; decisionId: number | null; latestDecisionId: number | null }[]) {
  if (!inputs.length) return []
  const keys = [...new Set(inputs.flatMap(input => evidenceKeys113(input.scope)))]
  const versions = new Map(db.select().from(s.evidenceScopeVersion113).where(inArray(s.evidenceScopeVersion113.scopeKey, keys)).all().map(row => [row.scopeKey, row]))
  const t = s.explanationImpact113
  const active = [...new Map(inputs.filter(input => input.decisionId != null).map(input => [scopeKey113(input.scope.enterpriseId, input.scope.titleCode, input.scope.direction), input])).values()]
  const rows = active.length ? db.select().from(t).where(or(...active.map(({ scope, decisionId }) => and(eq(t.enterpriseId, scope.enterpriseId), eq(t.titleCode, scope.titleCode), eq(t.direction, scope.direction), eq(t.decisionId, decisionId!))))).all() : []
  const states = new Map(rows.map(row => [scopeKey113(row.enterpriseId, row.titleCode, row.direction), row]))
  return inputs.map(({ scope, decisionId, latestDecisionId }) => {
    const state = decisionId == null ? null : states.get(scopeKey113(scope.enterpriseId, scope.titleCode, scope.direction)) ?? null
    const selected = evidenceKeys113(scope).flatMap(key => versions.has(key) ? [versions.get(key)!] : [])
    return { state, token: evidenceToken113(scope, latestDecisionId, selected), hasReviewedBaseline: state?.reviewedRevisionId != null }
  })
}
export function readEvidenceToken113(db: EvidenceExecutor113, scope: EvidenceScope113) {
  const keys = evidenceKeys113(scope)
  const versions = db.select().from(s.evidenceScopeVersion113).where(inArray(s.evidenceScopeVersion113.scopeKey, keys)).all()
  return evidenceToken113(scope, latestDecisionHead102(db, scope)?.id ?? null, versions)
}

/** Original archive projections, never raw_response, collection_evidence.rows or whole raw_fields. */
export function captureQueryRevision113(db: EvidenceExecutor113, queryId: number) {
  const source = readDifferenceCollection(db, queryId)
  if (!source) throw new Error('Query evidence not found')
  const scope = readDifferenceCollectionScope(db, source.collection.id)
  if (scope && !scope.conditionsKnown) throw new Error('Difference revision conditions are unknown; original structured values are unavailable')
  // Target structured owners supply all membership, attribution and coverage.
  // The original hash material is isolated in its evidence owner below.
  const q = {
    ...source.collection, id: queryId,
    conditions: JSON.stringify(orderDifferenceEnvelopeConditions(db, source.collection.id, scope.conditions)),
    pages: JSON.stringify(scope.pages.map(p => ({ rdjb: p.rdjb, page: p.pageNo, status: p.status, fetchedCount: p.fetchedCount, declaredTotal: p.declaredTotal, maxPage: p.maxPage }))),
    completeness: source.collection.completeness === 'unknown' ? null : source.collection.completeness,
    unfinished: JSON.stringify(scope.unfinished.map(p => ({ rdjb: p.rdjb, page: p.pageNo }))),
  }
  const titleFor: Record<string, string> = { '1': 'innovative_sme', '2': 'specialized_sme', '3': 'little_giant' }
  type Page = { rdjb: string | null; page: number; status: string; fetchedCount: number; declaredTotal: number | null; maxPage?: number | null }
  const pages: Page[] = JSON.parse(q.pages ?? '[]'), conditions = JSON.parse(q.conditions ?? '{}')
  const titles = [...new Set([...(q.titleCode ? [q.titleCode] : []), ...q.rdjb.split(',').flatMap(r => titleFor[r] ? [titleFor[r]!] : []), ...pages.flatMap(p => p.rdjb && titleFor[p.rdjb] ? [titleFor[p.rdjb]!] : [])])]
  // queryList has no title partition. Preserve unknown scope without claiming title coverage.
  const partitions: Array<string | null> = q.interface === 'apply_list' ? [null] : titles.length ? titles : [null]
  const owners = db.select({ id: s.enterprise.id }).from(s.enterprise).where(q.queryKey.startsWith('name:') ? eq(s.enterprise.nameNorm, q.queryKey.slice(5)) : eq(s.enterprise.usccNorm, q.queryKey)).limit(2).all()
  const exactOwner = owners.length === 1 ? owners[0]!.id : null
  const facts = new Map<string, { enterpriseId: number; titleCode: string | null; hashes: string[] }>()
  const get = (enterpriseId: number, titleCode: string | null) => {
    const key = `${enterpriseId}:${titleCode ?? '*'}`
    if (!facts.has(key)) facts.set(key, { enterpriseId, titleCode, hashes: [] })
    return facts.get(key)!
  }
  if (exactOwner) for (const title of partitions) get(exactOwner, title)
  let cursor = 0, lastRelationId = 0
  for (;;) {
    const observations = readDifferenceObservations(db, source.collection.id, cursor)
    const materials = readDifferenceRevisionMaterials(db, observations.map(r => r.observationId))
    const rows = observations.map(row => ({ ...row, material: JSON.stringify(materials!.get(row.observationId)) }))
    for (const row of rows) {
      lastRelationId = row.id
      if (row.enterpriseId == null) continue
      let title: string | null = partitions.length === 1 ? partitions[0]! : null
      if (pages.length) {
        let offset = 0
        for (const page of pages) { if (page.status !== 'success') continue; offset += page.fetchedCount; if (row.sequenceNo <= offset) { title = page.rdjb ? titleFor[page.rdjb] ?? null : null; break } }
      }
      // An unpartitioned multi-title relation is not attributed to every requested title.
      if (partitions.length > 1 && title === null) continue
      get(row.enterpriseId, title).hashes.push(evidenceDigest113(JSON.parse(row.material)))
    }
    if (rows.length < 200) break
    cursor = rows.at(-1)!.id
  }
  for (const group of facts.values()) {
    const rdjb = Object.keys(titleFor).find(r => titleFor[r] === group.titleCode)
    const ownPages = pages.filter(p => p.rdjb == null || p.rdjb === rdjb).map(p => ({ rdjb: p.rdjb, page: p.page, status: p.status, fetchedCount: p.fetchedCount, declaredTotal: p.declaredTotal, maxPage: p.maxPage ?? null }))
    const unfinished = (JSON.parse(q.unfinished ?? '[]') as Array<{ rdjb: string | null; page: number }>).filter(p => p.rdjb == null || p.rdjb === rdjb)
    // Page positions and explicit filters/time windows are part of scope; occurrence time is history only.
    const partition = { interface: q.interface, queryKey: q.queryKey, title: group.titleCode, conditions, positions: ownPages.map(p => [p.rdjb, p.page]), pageSize: q.pageSize }
    const ownStatus = ownPages.length ? ownPages.some(p => p.status === 'success') ? 'executed' : 'failed' : q.status
    const coverage = { status: ownStatus, queryStatus: q.status, pages: ownPages, completeness: q.completeness, fullRange: q.fullRange, unfinished }
    const completeEmpty = q.completeness === 'complete' && q.fullRange === 1 && ownPages.length > 0 && ownPages.every(p => p.status === 'success' && p.fetchedCount === 0 && (p.declaredTotal ?? 0) === 0)
    const revisionId = register(db, { sourceKind: 'query_archive', sourceKey: `${group.enterpriseId}:${evidenceDigest113(partition)}`, sourceVersion: `${queryId}:${lastRelationId}`, enterpriseId: group.enterpriseId, titleCode: group.titleCode,
      factDigest: evidenceDigest113(group.hashes.length ? [...new Set(group.hashes)].sort() : completeEmpty ? ['complete_no_record'] : []), preserveFacts: group.hashes.length === 0 && !completeEmpty, coverageDigest: evidenceDigest113(coverage),
      queryExecuted: group.titleCode != null && q.status !== 'not_queried' && (group.hashes.length > 0 || !q.queryKey.startsWith('name:') && group.enterpriseId === exactOwner),
      metadata: { queryId, interface: q.interface, titleCode: group.titleCode, conditions, pagePositions: ownPages.map(p => p.page), fullRange: q.fullRange, coverageOnly: group.hashes.length === 0 },
    })
    // A new archive has new relation IDs. Existing confirmed event dependencies stay
    // relevant at this exact owner/title even when they point to an older occurrence.
    if (revisionId != null) db.run(sql`insert or ignore into evidence_revision_event_113(revision_id,event_id,enterprise_id,title_code)
      select ${revisionId},e.id,rec.enterprise_id,rec.title_code from record rec join record_event e on e.record_id=rec.id
      where rec.enterprise_id=${group.enterpriseId} and (${group.titleCode} is null or rec.title_code=${group.titleCode})
      and exists(select 1 from record_correspondence c where c.status='confirmed' and (c.event_id=e.id or c.predecessor_event_id=e.id))`)
  }
}

/** Identity material includes only exact stable identity and effective confirmed aliases. */
export function identityMaterial113(db: EvidenceExecutor113, enterpriseId: number) {
  const enterprise = db.select({ uscc: s.enterprise.usccNorm, name: s.enterprise.nameNorm }).from(s.enterprise).where(eq(s.enterprise.id, enterpriseId)).get()
  const hashes = new Set<string>()
  let cursor = 0
  for (;;) {
    const rows = db.select({ id: s.enterpriseAlias.id, name: s.enterpriseAlias.nameNorm, from: s.enterpriseAlias.validFrom, to: s.enterpriseAlias.validTo }).from(s.enterpriseAlias)
      .where(and(eq(s.enterpriseAlias.enterpriseId, enterpriseId), eq(s.enterpriseAlias.verificationStatus, 'confirmed'), gt(s.enterpriseAlias.id, cursor))).orderBy(asc(s.enterpriseAlias.id)).limit(200).all()
    for (const { id, ...material } of rows) hashes.add(evidenceDigest113(material))
    if (rows.length < 200) break
    cursor = rows.at(-1)!.id
  }
  return evidenceDigest113({ enterprise: enterprise ?? null, aliases: [...hashes].sort() })
}

type Snapshot113 = { id: number; year: number; collectedOn: string | null; maxRowId: number }
/** Matches the actual roster selector: highest year, then highest ID within a title. */
export function selectedSnapshot113(db: EvidenceExecutor113, titleCode: string): Snapshot113 | null {
  return db.get<Snapshot113>(sql`select b.id,b.year,b.collected_on collectedOn,coalesce((select max(id) from platform_export_row where batch_id=b.id),0) maxRowId from platform_export_batch b where b.title_code=${titleCode} order by b.year desc,b.id desc limit 1`) ?? null
}
function snapshotDigest(db: EvidenceExecutor113, ref: Snapshot113 | null, enterpriseId?: number) {
  if (!ref) return empty
  const hashes = new Set<string>()
  let cursor = 0
  // Exact code first. Name-only rows require an unambiguous exact current/confirmed alias name.
  const ownership = enterpriseId === undefined ? sql`1` : sql`(
    r.id in (select x.id from platform_export_row x where x.batch_id=${ref.id} and upper(trim(x.uscc_raw))=(select uscc_norm from enterprise where id=${enterpriseId}))
    or r.id in (select x.id from platform_export_row x where x.batch_id=${ref.id} and (x.uscc_raw is null or trim(x.uscc_raw)='')
      and x.name_raw in (select name from enterprise where id=${enterpriseId} union select name from enterprise_alias where enterprise_id=${enterpriseId} and verification_status='confirmed')
      and not exists (select 1 from enterprise e where e.id!=${enterpriseId} and e.name=x.name_raw)
      and not exists (select 1 from enterprise_alias a where a.enterprise_id!=${enterpriseId} and a.name=x.name_raw and a.verification_status='confirmed')))`
  for (;;) {
    const rows = db.all<{ id: number; material: string }>(sql`select r.id,json_array(r.uscc_raw,r.name_raw,r.district,r.province,r.city,r.reg_status) material from platform_export_row r where r.batch_id=${ref.id} and r.id>${cursor} and r.id<=${ref.maxRowId} and ${ownership} order by r.id limit 200`)
    for (const row of rows) hashes.add(evidenceDigest113(JSON.parse(row.material)))
    if (rows.length < 200) break
    cursor = rows.at(-1)!.id
  }
  return evidenceDigest113({ year: ref.year, collectedOn: ref.collectedOn, rows: [...hashes].sort() })
}
export function captureSnapshotRevision113(db: EvidenceExecutor113, titleCode: string, before: Snapshot113 | null) {
  const after = selectedSnapshot113(db, titleCode)
  if (!after || before?.id === after.id && before.maxRowId === after.maxRowId) return null
  const revisionId = register(db, { sourceKind: 'selected_snapshot', sourceKey: titleCode, sourceVersion: `${after.id}:${after.maxRowId}`, titleCode,
    beforeFactDigest: snapshotDigest(db, before), factDigest: snapshotDigest(db, after), metadata: { before, after },
  })
  if (revisionId != null) db.run(sql`insert or ignore into evidence_revision_event_113(revision_id,event_id,enterprise_id,title_code)
    select ${revisionId},e.id,rec.enterprise_id,rec.title_code from platform_export_row x join record_correspondence c on c.export_row_id=x.id and c.status='confirmed'
    join record_event e on (e.id=c.event_id or e.id=c.predecessor_event_id) join record rec on rec.id=e.record_id
    where (x.batch_id=${before?.id ?? null} and x.id<=${before?.maxRowId ?? 0} or x.batch_id=${after.id} and x.id<=${after.maxRowId}) and rec.title_code=${titleCode}`)
  return revisionId
}

export function listImpactEvidence113(db: EvidenceExecutor113, impactId: number, input: { afterRevisionId?: number; limit?: number } = {}) {
  return db.select({ revisionId: s.evidenceRevision113.id, sourceKind: s.evidenceRevision113.sourceKind, sourceKey: s.evidenceRevision113.sourceKey, sourceVersion: s.evidenceRevision113.sourceVersion,
    eventId: s.evidenceRevision113.eventId, enterpriseId: s.evidenceRevision113.enterpriseId, titleCode: s.evidenceRevision113.titleCode,
    coverageChanged: s.evidenceRevision113.coverageChanged, factChanged: s.evidenceRevision113.factChanged, classification: s.evidenceImpactLink113.classification, metadata: s.evidenceRevision113.metadata,
  }).from(s.evidenceImpactLink113).innerJoin(s.evidenceRevision113, eq(s.evidenceRevision113.id, s.evidenceImpactLink113.revisionId))
    .where(and(eq(s.evidenceImpactLink113.impactId, impactId), gt(s.evidenceRevision113.id, input.afterRevisionId ?? 0))).orderBy(asc(s.evidenceRevision113.id)).limit(bound(input.limit)).all()
}

/** #101 event and evidence corrections share the formal-event revision transaction. */
export function captureOfficialEventRevision113(db: EvidenceExecutor113, eventId: number, beforeRevision: number, afterRevision: number) {
  const owner = db.select({ enterpriseId: s.record.enterpriseId, titleCode: s.record.titleCode }).from(s.recordEvent).innerJoin(s.record, eq(s.recordEvent.recordId, s.record.id)).where(eq(s.recordEvent.id, eventId)).get()
  if (!owner) throw new Error('Official event owner missing')
  return register(db, { sourceKind: 'official_event', sourceKey: String(eventId), sourceVersion: String(afterRevision), ...owner, eventId,
    beforeFactDigest: evidenceDigest113([eventId, beforeRevision]), factDigest: evidenceDigest113([eventId, afterRevision]), metadata: { eventId, beforeRevision, afterRevision },
  })
}

/** #114 composes this into readQueryAssessment; absence is no baseline, never `valid`. */
export function readEvidenceImpact113(db: EvidenceExecutor113, scope: EvidenceScope113, decisionId: number | null) {
  const t = s.explanationImpact113
  const state = decisionId == null ? null : db.select().from(t).where(and(eq(t.enterpriseId, scope.enterpriseId), eq(t.titleCode, scope.titleCode), eq(t.direction, scope.direction), eq(t.decisionId, decisionId))).get() ?? null
  return { state, token: readEvidenceToken113(db, scope), hasReviewedBaseline: state?.reviewedRevisionId != null }
}

export function listRevisionEvents113(db: EvidenceExecutor113, revisionId: number, input: { enterpriseId?: number; afterEventId?: number; limit?: number } = {}) {
  const t = s.evidenceRevisionEvent113
  return db.select().from(t).where(and(eq(t.revisionId, revisionId), input.enterpriseId == null ? undefined : eq(t.enterpriseId, input.enterpriseId), gt(t.eventId, input.afterEventId ?? 0))).orderBy(asc(t.eventId)).limit(bound(input.limit)).all()
}

/** Explicit scoped rule-release primitive for #114's unified command transaction. No startup caller. */
export function captureRuleRevision113(db: EvidenceExecutor113, input: { ruleId: string; version: string; scope: EvidenceScope113; previousEvaluationDigest: string; evaluationDigest: string }) {
  if (!input.ruleId.trim() || input.ruleId.length > 200 || !input.version.trim() || input.version.length > 200 || !Number.isSafeInteger(input.scope.enterpriseId) || input.scope.enterpriseId < 1 || !['innovative_sme', 'specialized_sme', 'little_giant'].includes(input.scope.titleCode) || !['missing_in_miit', 'extra_in_miit'].includes(input.scope.direction) || ![input.previousEvaluationDigest, input.evaluationDigest].every(d => /^[a-f0-9]{64}$/.test(d))) throw new Error('Explicit rule version, exact scope and evaluation digests required')
  if (!db.select({ id: s.enterprise.id }).from(s.enterprise).where(eq(s.enterprise.id, input.scope.enterpriseId)).get()) throw new Error('Rule release enterprise not found')
  const prior = db.select({ factDigest: s.evidenceRevision113.factDigest }).from(s.evidenceRevision113).where(and(eq(s.evidenceRevision113.sourceKey, `rule_release:${input.ruleId}:${input.scope.enterpriseId}:${input.scope.titleCode}:${input.scope.direction}`), eq(s.evidenceRevision113.sourceVersion, input.version))).get()
  if (prior && prior.factDigest !== input.evaluationDigest) throw new Error('Rule release version already identifies different evaluated evidence')
  // A release with identical evaluated material must not manufacture review work.
  if (input.previousEvaluationDigest === input.evaluationDigest) return null
  return register(db, { sourceKind: 'rule_release', sourceKey: `${input.ruleId}:${input.scope.enterpriseId}:${input.scope.titleCode}:${input.scope.direction}`, sourceVersion: input.version,
    ...input.scope, beforeFactDigest: input.previousEvaluationDigest, factDigest: input.evaluationDigest, metadata: { ruleId: input.ruleId, ruleVersion: input.version },
  })
}

/** Explicit disjoint dependency partitions are not evidence against a scoped confirmed decision. */
function queryChangeRelevant113(db: EvidenceExecutor113, revision: typeof s.evidenceRevision113.$inferSelect, decision: { evidenceQueryId: number | null; status: string; titleCode: string }) {
  if (!decision.evidenceQueryId || decision.status === 'not_queried') return true
  const source = readDifferenceCollection(db, decision.evidenceQueryId)
  const scope = source ? readDifferenceCollectionScope(db, source.collection.id) : null
  const old = source && scope ? {
    interface: source.collection.interface, conditions: JSON.stringify(scope.conditions),
    pages: JSON.stringify(scope.pages.map(p => ({ rdjb: p.rdjb, page: p.pageNo }))), fullRange: source.collection.fullRange,
  } : null
  if (!old || old.interface !== revision.metadata.interface) return true
  const before = JSON.parse(old.conditions ?? '{}') as Record<string, unknown>, after = revision.metadata.conditions as Record<string, unknown>
  for (const field of ['whpcyear','whpc','szq','sqsj','rddqrq']) if (before[field] != null && after[field] != null && before[field] !== after[field]) return false
  if (old.fullRange === 0 && revision.metadata.fullRange === 0) {
    const rdjb = ({ innovative_sme: '1', specialized_sme: '2', little_giant: '3' } as Record<string, string>)[decision.titleCode]
    const pages = (JSON.parse(old.pages ?? '[]') as Array<{ rdjb: string | null; page: number }>).filter(p => p.rdjb === rdjb || p.rdjb == null)
    const positions = revision.metadata.pagePositions as number[]
    if (pages.length && positions.length && !pages.some(p => positions.includes(p.page))) return false
  }
  return true
}

export type ImpactDecision113 = { id: number; enterpriseId: number; titleCode: string; direction: string; status: string; evidenceQueryId: number | null; lifecycleAction?: string | null }
/** Same evaluator for #114 previews and the durable working view; no reason/decision writes. */
export function evaluateEvidenceImpact113(db: EvidenceExecutor113, revision: typeof s.evidenceRevision113.$inferSelect, decision: ImpactDecision113): 'premise_invalid' | 'evidence_changed' | 'no_review' {
  if (decision.id > revision.maxDecisionId || decision.lifecycleAction === 'withdraw' || revision.enterpriseId != null && decision.enterpriseId !== revision.enterpriseId || revision.titleCode != null && decision.titleCode !== revision.titleCode || revision.direction != null && decision.direction !== revision.direction) return 'no_review'
  if (revision.sourceKind === 'query_archive' && !queryChangeRelevant113(db, revision, decision)) return 'no_review'
  if (revision.sourceKind === 'selected_snapshot' && snapshotDigest(db, revision.metadata.before as Snapshot113 | null, decision.enterpriseId) === snapshotDigest(db, revision.metadata.after as Snapshot113, decision.enterpriseId)) return 'no_review'
  return revision.queryExecuted && decision.status === 'not_queried' ? 'premise_invalid' : revision.factChanged ? 'evidence_changed' : 'no_review'
}
export function readEvidenceRevision113(db: EvidenceExecutor113, revisionId: number) {
  return db.select().from(s.evidenceRevision113).where(eq(s.evidenceRevision113.id, revisionId)).get() ?? null
}
