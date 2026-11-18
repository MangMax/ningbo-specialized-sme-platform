/** Necessary target evidence seam for the existing qualification/effect reader.
 * No qualification rule or candidate admission rule is defined here. */
import { and, eq, inArray, or, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/sqlite-core'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as s from '../../db/schema'
import { targetSchema } from '../platform/target-schema'
import { storedProcessProjection } from '../platform/process-stored-schema'
import { currentDifferenceAssignment } from '../platform/difference-sources'
import { normalizeUscc } from '../../layers/sme-roster/lib/domain'
import { RDJB_TITLE_CODES } from '../platform/recognized-evidence'
import { candidateScopeObservation } from '../platform/candidate-scope-schema'
import { CANDIDATE_SCOPE_RULE } from '../platform/candidate-scope-capture'
import { CURRENT_TITLES, type CurrentTitle } from '../../layers/sme-roster/lib/roster/current-titles'
type Db = BetterSQLite3Database<typeof s>
const o = candidateScopeObservation, a = targetSchema.platformObservationAssignment
const original = alias(a, 'effect_original')
const c = s.platformCollection, qa = s.platformLegacyQueryAlias, ra = targetSchema.platformLegacyRelationAlias
function prepareEffectRows(db:Db,currentIdentity:boolean) {
  return db.select({ id: ra.oldId, queryId: qa.oldId, interface: c.interface, queriedAt: c.queriedAt,
    collectionId: c.id, rdjb: c.rdjb, titleCode: c.titleCode, sequenceNo: o.sequenceNo,
    scopeMask: candidateScopeObservation.candidateScopeMask,
    scopeState: candidateScopeObservation.candidateScopeState,
    scopeRule: candidateScopeObservation.candidateScopeRule,
    // Original stored facts are owned by each source's observation projection.
    status: sql<string | null>`case ${c.interface} when 'business_list' then ${storedProcessProjection.exactStatus} when 'apply_list' then ${targetSchema.platformApplyProjection.storedStatus} else ${targetSchema.platformRecognizedProjection.storedStatus} end`,
    year: sql<number | null>`case ${c.interface} when 'business_list' then ${storedProcessProjection.exactYear} when 'apply_list' then ${targetSchema.platformApplyProjection.storedYear} else ${targetSchema.platformRecognizedProjection.storedYear} end`,
    batch: sql<string | null>`case ${c.interface} when 'business_list' then ${storedProcessProjection.exactBatch} when 'apply_list' then ${targetSchema.platformApplyProjection.storedBatch} else ${targetSchema.platformRecognizedProjection.storedBatch} end`,
  }).from(o).innerJoin(c, eq(c.id, o.collectionId)).innerJoin(qa, eq(qa.collectionId, c.id)).innerJoin(ra, eq(ra.observationId, o.id))
    .innerJoin(a, currentDifferenceAssignment(db)).innerJoin(original, and(eq(original.observationId, o.id), eq(original.revision, 1)))
    .leftJoin(storedProcessProjection, eq(storedProcessProjection.observationId, o.id))
    .leftJoin(targetSchema.platformApplyProjection, eq(targetSchema.platformApplyProjection.observationId, o.id))
    .leftJoin(targetSchema.platformRecognizedProjection, eq(targetSchema.platformRecognizedProjection.observationId, o.id))
    .where(or(eq(a.enterpriseId, sql.placeholder('enterpriseId')), and(sql`${a.enterpriseId} is null`, sql`${sql.placeholder('uscc')} is not null`,sql`roster84_uscc(${currentIdentity ? a.usccRaw : original.usccRaw})=${sql.placeholder('uscc')}`)))
    .orderBy(ra.oldId).prepare()
}
function prepareEffectReader(db:Db) {
  return {enterprise:db.select({uscc:s.enterprise.usccNorm}).from(s.enterprise).where(eq(s.enterprise.id,sql.placeholder('enterpriseId'))).prepare(),
    current:prepareEffectRows(db,true),original:prepareEffectRows(db,false)}
}
const effectReaders=new WeakMap<Db,ReturnType<typeof prepareEffectReader>>()
function readEffectRows(db: Db, enterpriseId: number, currentIdentity = false) {
  let reader=effectReaders.get(db)
  if(!reader){reader=prepareEffectReader(db);effectReaders.set(db,reader)}
  const e=reader.enterprise.get({enterpriseId})
  return (currentIdentity?reader.current:reader.original).all({enterpriseId,uscc:(currentIdentity?normalizeUscc(e?.uscc):e?.uscc)?normalizeUscc(e?.uscc):null})
}
function effectReference({ id, queryId, interface: kind, queriedAt, status, year, batch }: ReturnType<typeof readEffectRows>[number]) {
  return { id, queryId, interface: kind, queriedAt, status, year, batch }
}
/** One request-owned enterprise read for full three-title T2 hydration.
 * Candidate scope is the captured exact legacy SQL predicate, not normalized
 * page metadata. Source owners continue to supply all business cells. */
export function readDifferencePlatformEffectsByTitle(db: Db, enterpriseId: number) {
  const rows=readEffectRows(db,enterpriseId,true)
  const byTitle=new Map<CurrentTitle, ReturnType<typeof effectReference>[]>(CURRENT_TITLES.map(title=>[title,[]]))
  const bits={innovative_sme:1,specialized_sme:2,little_giant:4} satisfies Record<CurrentTitle,number>
  for(const row of rows) {
    if(row.scopeState!=='captured'||row.scopeRule!==CANDIDATE_SCOPE_RULE||row.scopeMask===null)throw new Error('Current hydration candidate capture unavailable')
    for(const title of CURRENT_TITLES)if(row.scopeMask & bits[title])byTitle.get(title)!.push(effectReference(row))
  }
  return byTitle
}
export function readDifferencePlatformEffects(db: Db, enterpriseId: number, title: string) {
  const rows=readEffectRows(db,enterpriseId)
  if (!rows.length) return []
  const pages = db.select().from(s.platformCollectionPage).where(inArray(s.platformCollectionPage.collectionId, [...new Set(rows.map(r => r.collectionId))])).orderBy(s.platformCollectionPage.ordinal).all()
  return rows.filter(r => {
    let rowTitle = r.titleCode ?? RDJB_TITLE_CODES[r.rdjb] ?? null
    if (r.rdjb.includes(',')) {
      const page = pages.find(p => p.collectionId === r.collectionId && p.status === 'success' && p.sequenceStart !== null && p.sequenceEnd !== null && r.sequenceNo >= p.sequenceStart && r.sequenceNo <= p.sequenceEnd)
      rowTitle = page?.rdjb ? RDJB_TITLE_CODES[page.rdjb] ?? r.titleCode : r.titleCode
    }
    return rowTitle === title || rowTitle === null && r.rdjb.split(',').includes(({ innovative_sme: '1', specialized_sme: '2', little_giant: '3' } as Record<string, string>)[title]!)
  }).map(effectReference)
}
