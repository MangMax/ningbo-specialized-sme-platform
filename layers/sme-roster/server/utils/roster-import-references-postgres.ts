import { and, desc, eq, type SQL } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import {
  platformBusinessObservation as observation,
  platformCollection as collection,
  platformObservationAssignment as assignment,
} from '../../../../db/postgresql/platform-tables'
import { describeRef, normalizeRef, type NormalizedRef } from './roster-import-model'

type Reader = Pick<NodePgDatabase, 'select'>
type ErrorResult = Extract<ReturnType<typeof normalizeRef>,{ok:false}>
type Query = { id:number; collectionId:number; interface:string }
export type PostgresImportRelation = { id:number; observationId:number; collectionId:number; interface:string;
  enterpriseId:number | null; usccRaw:string | null; nameRaw:string | null; queryId:number; key:string | null }

const fail = (code:string,field:string,message:string): ErrorResult => ({ ok:false,error:{code,field,message} })
async function findQueries(db: Reader, ref: NormalizedRef): Promise<Query[]> {
  return db.select({ id: collection.publicId, collectionId: collection.id, interface: collection.interface })
    .from(collection)
    .where(and(eq(collection.interface, ref.interface), eq(collection.queryKey, ref.queryKey),
      eq(collection.rdjb, ref.rdjb), ref.queriedAt ? eq(collection.queriedAt, ref.queriedAt) : undefined))
}

export async function findPostgresImportQuery(db: Reader, raw: unknown, field: string) {
  const parsed = normalizeRef(raw,field)
  if (!parsed.ok) return parsed
  const queries = await findQueries(db,parsed.value)
  if (!queries.length) return fail('query_ref_not_found',field,'引用不到平台查询：'+describeRef(parsed.value))
  if (queries.length>1) return fail('query_ref_ambiguous',field,`引用不唯一：${describeRef(parsed.value)} 命中 ${queries.length} 次查询；请补 queriedAt`)
  return { ok:true,value:queries[0]! } as const
}

async function relations(db: Reader, condition: SQL | undefined): Promise<PostgresImportRelation[]> {
  const owner = db.select({ observationId: assignment.observationId, enterpriseId: assignment.enterpriseId, usccRaw: assignment.usccRaw, nameRaw: assignment.nameRaw })
    .from(assignment).where(eq(assignment.observationId, observation.id))
    .orderBy(desc(assignment.revision)).limit(1).as('owner')
  return db.select({
    id: observation.publicId, observationId: observation.id, collectionId: collection.id, interface: collection.interface,
    enterpriseId: owner.enterpriseId, usccRaw: owner.usccRaw, nameRaw: owner.nameRaw,
    queryId: collection.publicId, key: observation.sourceRelationKey,
  }).from(collection)
    .innerJoin(observation, eq(observation.collectionId, collection.id))
    .innerJoinLateral(owner, eq(owner.observationId, observation.id)).where(condition)
}

export async function findPostgresImportRelationById(db: Reader, id: number) {
  return (await relations(db, eq(observation.publicId, id)))[0] ?? null
}

export async function findPostgresImportRelation(db: Reader,raw: unknown,field: string) {
  const parsed = normalizeRef(raw,field)
  if (!parsed.ok) return parsed
  const ref = parsed.value
  if (ref.sequenceNo===null || ref.sequenceNo<1) return fail('ref_sequence_no_required',field+'.sequenceNo',
    '关系引用缺少 sequenceNo（同一次查询内第几条，从 1 起）')
  const queries = await findQueries(db,ref)
  if (!queries.length) return fail('query_ref_not_found',field,'引用不到平台查询：'+describeRef(ref))
  if (queries.length>1) return fail('relation_ref_ambiguous',field,`引用不唯一：${describeRef(ref)} 命中 ${queries.length} 次查询；请补 queriedAt`)
  const known = eq(observation.collectionId, queries[0]!.collectionId)
  const rows = await relations(db,and(known, eq(observation.sequenceNo, ref.sequenceNo)))
  if (!rows.length) return fail('relation_ref_not_found',field,
    `引用不到平台关系：${describeRef(ref)}（该查询里没有序号 ${ref.sequenceNo} 的关系）`)
  if (rows.length>1) return fail('relation_ref_ambiguous',field,
    `引用不唯一：${describeRef(ref)} 命中 ${rows.length} 条同序号关系；请补 queriedAt`)
  const value = rows[0]!
  if (ref.relationKey && ref.relationKey!==value.key) {
    const [candidate] = await db.select({ id: observation.id }).from(observation)
      .where(and(known, eq(observation.sourceRelationKey, ref.relationKey))).limit(1)
    if (!candidate) return fail('relation_ref_not_found',field+'.relationKey',
      `引用不到平台关系：该查询下没有 relationKey=${ref.relationKey} 的关系`)
    return fail('relation_ref_mismatch',field+'.relationKey',
      `序号与关系键不符：${describeRef(ref)} —— 序号 ${ref.sequenceNo} 那条的 relationKey 不是 ${ref.relationKey}。**按关系键为准、不猜**，请改用正确的序号，或只给 relationKey。`)
  }
  return { ok:true,value } as const
}
