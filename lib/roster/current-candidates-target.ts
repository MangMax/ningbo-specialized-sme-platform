/** Candidates have a local title link or an actual returned platform title row. */
import { and, asc, count, desc, eq, inArray, isNotNull, isNull, max, or, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/sqlite-core'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { enterprise, record, differenceReason, recordCorrespondence } from '../../db/schema'
import { platformObservationAssignment as a, platformBusinessObservation as o, targetSchema } from '../platform/target-schema'
import { PLATFORM_RETIREMENT_RULE, PLATFORM_RUNTIME_VERSION } from '../../db/schema-phase'
import { sqliteConnection } from '../platform/target-connection'
import { normalizeUscc } from '../domain'
import { TITLE_RDJB_CODES } from '../platform/recognized-evidence'
import type { CurrentTitle } from './current-titles'
import type { CurrentCandidateReader } from './current-candidate-reader'

const newer=alias(a,'candidate_newer_assignment')
export class TargetCurrentCandidateGap extends Error {
  constructor(readonly observationId:number|null,readonly state:string,readonly reason:string|null) {
    super(`Current candidate gap: observation ${observationId ?? 'unknown'}, ${state}${reason ? ': '+reason : ''}`)
  }
}
/** Construct before SQLite iterators are active. No request result is cached. */
export function createTargetCurrentCandidateReader(db:BetterSQLite3Database<typeof targetSchema>):CurrentCandidateReader & {
  count(title:CurrentTitle):number
  page(title:CurrentTitle,offset:number,limit:number,sort?:'id_asc'|'name_asc'|'name_desc'):{total:number;rows:{id:number}[]}
} {
  const sqlite=sqliteConnection(db)
  sqlite.function('roster84_uscc',{deterministic:true},normalizeUscc)
  const assignment=()=>and(eq(a.observationId,o.id),eq(a.revision,
    db.select({revision:max(newer.revision)}).from(newer).where(eq(newer.observationId,o.id))))
  const ownerRows=db.select({id:enterprise.id,normalizedKey:sql<string>`roster84_uscc(${enterprise.usccNorm})`.as('normalized_key')})
    .from(enterprise).where(isNotNull(enterprise.usccNorm))
  // Drizzle's SQLite $with API has no MATERIALIZED option. This narrow fence
  // evaluates each stored owner once and lets SQLite index the computed key,
  // rather than normalizing every enterprise for every unassigned observation.
  const owners=db.$with('candidate_normalized_owners',{}).as(sql`
    with normalized_owners as materialized (${ownerRows.getSQL()})
    select id,normalized_key from normalized_owners`)
  const ownerId=sql<number>`"candidate_normalized_owners"."id"`
  const ownerJoin=()=>and(isNull(a.enterpriseId),eq(sql`"candidate_normalized_owners"."normalized_key"`,sql`roster84_uscc(${a.usccRaw})`))
  function gate() {
    if (sqlite.pragma('user_version',{simple:true})!==PLATFORM_RUNTIME_VERSION || !sqlite.prepare('SELECT 1 FROM platform_runtime_completion WHERE id=1 AND rule=? AND schema_version=?').get(PLATFORM_RETIREMENT_RULE, PLATFORM_RUNTIME_VERSION)) {
      throw new TargetCurrentCandidateGap(null,'completion','Completed runtime model required')
    }
  }
  function candidates(title:CurrentTitle) {
    const titles: CurrentTitle[] = title === 'innovative_sme' ? ['innovative_sme','specialized_sme','little_giant'] : title === 'specialized_sme' ? ['specialized_sme','little_giant'] : ['little_giant']
    const id=sql<number>`coalesce(${a.enterpriseId},${ownerId})`.as('id')
    const returnedTitles = titles.map(title => TITLE_RDJB_CODES[title]!)
    type Projection = typeof targetSchema.platformRecognizedProjection | typeof targetSchema.platformBusinessProjection | typeof targetSchema.platformApplyProjection
    const returnedObservations = (projection: Projection) => db.select({observationId:o.id}).from(projection)
      .innerJoin(o,or(eq(projection.versionId,o.versionId),eq(projection.observationId,o.id)))
      .where(inArray(projection.titleRaw,returnedTitles))
    const returned = db.$with('candidate_returned_observations').as(
      returnedObservations(targetSchema.platformRecognizedProjection)
        .union(returnedObservations(targetSchema.platformBusinessProjection))
        .union(returnedObservations(targetSchema.platformApplyProjection)))
    // Requested query scope is not returned title data. Resolve owners once
    // after collecting matching observations, preserving shared-version owners.
    return db.with(owners,returned).select({id:record.enterpriseId}).from(record).where(inArray(record.titleCode,titles))
      .union(db.select({id:differenceReason.enterpriseId}).from(differenceReason).where(inArray(differenceReason.titleCode,titles)))
      .union(db.select({id:sql<number>`${recordCorrespondence.enterpriseId}`.as('id')}).from(recordCorrespondence)
        .where(and(inArray(recordCorrespondence.titleCode,titles),isNotNull(recordCorrespondence.enterpriseId))))
      .union(db.select({id}).from(returned).innerJoin(o,eq(o.id,returned.observationId))
        .innerJoin(a,assignment()).leftJoin(owners,ownerJoin())
        .where(isNotNull(sql`coalesce(${a.enterpriseId},${ownerId})`)))
      .as('current_candidates')
  }
  function ordered(title:CurrentTitle,sort?:'id_asc'|'name_asc'|'name_desc') {
    const c=candidates(title)
    if(sort==='name_asc'||sort==='name_desc')return db.select({id:sql<number>`${c.id}`.as('id')}).from(c).innerJoin(enterprise,eq(enterprise.id,c.id))
      .orderBy(sort==='name_asc'?asc(sql`${enterprise.name} collate nocase`):desc(sql`${enterprise.name} collate nocase`),asc(c.id))
    return db.select({id:sql<number>`${c.id}`.as('id')}).from(c).orderBy(asc(c.id))
  }
  return {
    connection:sqlite,
    *iterate(title,sort) {
      // The workbook/list already own a snapshot. Direct callers get one too;
      // early return/throw finalizes SQLite's iterator before releasing it.
      const own=!sqlite.inTransaction
      if(own)db.run(sql`BEGIN`)
      try {
        gate()
        // Drizzle0.45.4 better-sqlite3 has no streaming SELECT executor. Only
        // execution uses the native driver; the complete query is ORM-built.
        const query=ordered(title,sort).toSQL()
        yield* sqlite.prepare(query.sql).iterate(...query.params) as Iterable<{id:number}>
        if(own)db.run(sql`COMMIT`)
      } finally { if(own&&sqlite.inTransaction)db.run(sql`ROLLBACK`) }
    },
    count(title) {return db.transaction(()=>{gate();return db.select({n:count()}).from(candidates(title)).get()!.n})},
    page(title,offset,limit,sort) {
      if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1)throw new RangeError('Candidate offset/limit must be safe nonnegative/positive integers')
      return db.transaction(()=>{gate();return {total:db.select({n:count()}).from(candidates(title)).get()!.n,rows:ordered(title,sort).limit(limit).offset(offset).all()}})
    },
  }
}
