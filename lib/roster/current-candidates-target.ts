/** Explicit completed target candidate domain. Qualification/identity coverage remains R5. */
import { and, asc, count, desc, eq, isNotNull, isNull, max, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/sqlite-core'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { enterprise, record, differenceReason, recordCorrespondence } from '../../db/schema'
import { candidateScopeObservation as o } from '../platform/candidate-scope-schema'
import { platformObservationAssignment as a } from '../platform/target-schema'
import { PLATFORM_RETIREMENT_RULE, PLATFORM_RUNTIME_VERSION } from '../../db/schema-phase'
import { sqliteConnection } from '../platform/target-connection'
import { normalizeUscc } from '../domain'
import type { CurrentTitle } from './current-titles'
import type { CurrentCandidateReader } from './current-candidate-reader'
import { targetSchema } from '../platform/target-schema'

const newer=alias(a,'candidate_newer_assignment'), owner=alias(enterprise,'candidate_unassigned_owner')
const bits={innovative_sme:1,specialized_sme:2,little_giant:4} satisfies Record<CurrentTitle,number>
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
  const ownerJoin=()=>and(isNull(a.enterpriseId),isNotNull(owner.usccNorm),eq(owner.usccNorm,sql`roster84_uscc(${a.usccRaw})`))
  function gate() {
    if (!sqlite.prepare('SELECT 1 FROM platform_runtime_completion WHERE id=1 AND rule=? AND schema_version=?').get(PLATFORM_RETIREMENT_RULE, PLATFORM_RUNTIME_VERSION)) {
      throw new TargetCurrentCandidateGap(null,'completion','Completed runtime model required')
    }
  }
  function candidates(title:CurrentTitle) {
    const id=sql<number>`coalesce(${a.enterpriseId},${owner.id})`.as('id')
    return db.select({id:record.enterpriseId}).from(record).where(eq(record.titleCode,title))
      .union(db.select({id:differenceReason.enterpriseId}).from(differenceReason).where(eq(differenceReason.titleCode,title)))
      .union(db.select({id:sql<number>`${recordCorrespondence.enterpriseId}`.as('id')}).from(recordCorrespondence)
        .where(and(eq(recordCorrespondence.titleCode,title),isNotNull(recordCorrespondence.enterpriseId))))
      .union(db.select({id}).from(o).innerJoin(a,assignment())
        .leftJoin(owner,ownerJoin())
        .where(and(sql`(${o.candidateScopeMask} & ${bits[title]})<>0`,isNotNull(sql`coalesce(${a.enterpriseId},${owner.id})`))))
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
