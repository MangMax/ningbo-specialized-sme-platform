/** Offline migration oracle for the indexed requested-title membership only.
 * No runtime reader, relation hydration, or write path is retained here. */
import { and, eq, sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '../../../../upgrade/legacy-schema'
import type { PlatformQueryFilter } from '../../../../lib/platform/read'
export function readMigratedTitleScope(db: BetterSQLite3Database<typeof schema>, filter: PlatformQueryFilter) {
  const q=schema.platformQuery, conditions=[]
  if(filter.queryId!=null)conditions.push(eq(q.id,filter.queryId))
  if(filter.queryKey)conditions.push(eq(q.queryKey,filter.queryKey))
  if(filter.status)conditions.push(eq(q.status,filter.status))
  if(filter.titleCode){
    const base=conditions.length?and(...conditions):sql`1`
    const errors=db.all<{archive:string}>(sql`select collection_evidence as archive from platform_query where id in (select query_id from platform_query_title_scope_error) and ${base} and (title_code is null or title_code<>${filter.titleCode}) limit 1`)
    if(errors.length)db.all(sql`select value from json_each(json_extract(${errors[0]!.archive}, '$.titleScope.rdjb'))`)
    const rdjb=({innovative_sme:'1',specialized_sme:'2',little_giant:'3'} as Record<string,string>)[filter.titleCode]??''
    conditions.push(sql`${q.id} in (select id from platform_query where title_code=${filter.titleCode} union select query_id from platform_query_title_scope where rdjb=${rdjb})`)
  }
  const where=conditions.length?and(...conditions):sql`1`
  const countRows=db.all<{status:string;count:number}>(sql`select status,count(*) as count from platform_query indexed by platform_query_status_time_idx where ${where} group by status`)
  const page=filter.page??1,pageSize=filter.pageSize??100,offset=(page-1)*pageSize
  const ids=filter.status
    ?db.all<{id:number}>(sql`select id from platform_query indexed by platform_query_status_time_idx where ${where} order by queried_at desc,id desc limit ${pageSize} offset ${offset}`)
    :db.all<{id:number}>(sql`select id from platform_query indexed by platform_query_time_idx where ${where} order by queried_at desc,id desc limit ${pageSize} offset ${offset}`)
  return {rows:ids.map(query=>({query})),total:countRows.reduce((n,row)=>n+row.count,0),counts:Object.fromEntries(countRows.map(row=>[row.status,row.count]))}
}
