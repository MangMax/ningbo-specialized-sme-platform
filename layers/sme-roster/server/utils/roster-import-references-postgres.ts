import { sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { describeRef, normalizeRef, type NormalizedRef } from './roster-import'

type Reader = Pick<NodePgDatabase,'execute'>
type ErrorResult = Extract<ReturnType<typeof normalizeRef>,{ok:false}>
type Query = { id:number; collectionId:number; interface:string }
export type PostgresImportRelation = { id:number; observationId:number; collectionId:number; interface:string;
  enterpriseId:number | null; usccRaw:string | null; nameRaw:string | null; queryId:number; key:string | null }

const fail = (code:string,field:string,message:string): ErrorResult => ({ ok:false,error:{code,field,message} })
function where(ref: NormalizedRef) {
  return sql`c.interface=${ref.interface} AND c.query_key=${ref.queryKey} AND c.rdjb=${ref.rdjb}
    ${ref.queriedAt ? sql`AND c.queried_at=${ref.queriedAt}` : sql.empty()}`
}

async function findQueries(db: Reader,ref: NormalizedRef) {
  return (await db.execute<Query>(sql`SELECT a.old_id::float8 AS id,c.id::float8 AS "collectionId",c.interface
    FROM platform_collection c JOIN platform_legacy_query_alias a ON a.collection_id=c.id WHERE ${where(ref)}`)).rows
}

export async function findPostgresImportQuery(db: Reader, raw: unknown, field: string) {
  const parsed = normalizeRef(raw,field)
  if (!parsed.ok) return parsed
  const queries = await findQueries(db,parsed.value)
  if (!queries.length) return fail('query_ref_not_found',field,'引用不到平台查询：'+describeRef(parsed.value))
  if (queries.length>1) return fail('query_ref_ambiguous',field,`引用不唯一：${describeRef(parsed.value)} 命中 ${queries.length} 次查询；请补 queriedAt`)
  return { ok:true,value:queries[0]! } as const
}

async function relations(db: Reader,condition: ReturnType<typeof sql>) {
  return (await db.execute<PostgresImportRelation>(sql`
    SELECT a.old_id::float8 AS id,o.id::float8 AS "observationId",c.id::float8 AS "collectionId",c.interface,
      owner.enterprise_id::float8 AS "enterpriseId",owner.uscc_raw AS "usccRaw",owner.name_raw AS "nameRaw",
      q.old_id::float8 AS "queryId",o.source_relation_key AS key
    FROM platform_collection c JOIN platform_legacy_query_alias q ON q.collection_id=c.id
    JOIN platform_business_observation o ON o.collection_id=c.id JOIN platform_legacy_relation_alias a ON a.observation_id=o.id
    JOIN LATERAL (SELECT enterprise_id,uscc_raw,name_raw FROM platform_observation_assignment
      WHERE observation_id=o.id ORDER BY revision DESC LIMIT 1) owner ON true
    WHERE ${condition}`)).rows
}

export async function findPostgresImportRelationById(db: Reader,id: number) {
  return (await relations(db,sql`a.old_id=${id}`))[0] ?? null
}

export async function findPostgresImportRelation(db: Reader,raw: unknown,field: string) {
  const parsed = normalizeRef(raw,field)
  if (!parsed.ok) return parsed
  const ref = parsed.value
  if (ref.sequenceNo===null || ref.sequenceNo<1) return fail('ref_sequence_no_required',field+'.sequenceNo',
    '关系引用缺少 sequenceNo（同一次查询内第几条，从 1 起）')
  const queries = await findQueries(db,ref)
  if (!queries.length) return fail('query_ref_not_found',field,'引用不到平台查询：'+describeRef(ref))
  const known = sql`c.id=ANY(${sql.param(queries.map(row=>row.collectionId))}::bigint[])`
  const rows = await relations(db,sql`${known} AND o.sequence_no=${ref.sequenceNo}`)
  if (!rows.length) return fail('relation_ref_not_found',field,
    `引用不到平台关系：${describeRef(ref)}（该查询里没有序号 ${ref.sequenceNo} 的关系）`)
  if (rows.length>1) return fail('relation_ref_ambiguous',field,
    `引用不唯一：${describeRef(ref)} 命中 ${rows.length} 条同序号关系；请补 queriedAt`)
  const value = rows[0]!
  if (ref.relationKey && ref.relationKey!==value.key) {
    const candidate = await db.execute(sql`SELECT 1 FROM platform_collection c JOIN platform_business_observation o ON o.collection_id=c.id
      WHERE ${known} AND o.source_relation_key=${ref.relationKey} LIMIT 1`)
    if (!candidate.rows.length) return fail('relation_ref_not_found',field+'.relationKey',
      `引用不到平台关系：该查询下没有 relationKey=${ref.relationKey} 的关系`)
    return fail('relation_ref_mismatch',field+'.relationKey',
      `序号与关系键不符：${describeRef(ref)} —— 序号 ${ref.sequenceNo} 那条的 relationKey 不是 ${ref.relationKey}。**按关系键为准、不猜**，请改用正确的序号，或只给 relationKey。`)
  }
  return { ok:true,value } as const
}
