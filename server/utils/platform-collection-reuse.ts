import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { sql } from 'drizzle-orm'
import type * as schema from '../../db/schema'
import type { PlatformLiveQueryResult } from '../../lib/platform/live-query'
import { platformResultToImport } from '../../lib/platform/recognized-evidence'
import { canonicalPlatformJson } from './platform-business-record'

type Db = BetterSQLite3Database<typeof schema>
function contents(result: PlatformLiveQueryResult) {
  const rows = result.dataRows ?? result.rawData?.rows
  if (!result.pages.length || result.pages.some((page, index) => page.page !== index + 1 || page.status !== 'success')) return null
  if (!rows || result.completeness !== 'complete' || !result.fullRange || !['success', 'no_record'].includes(result.status)) return null
  return canonicalPlatformJson({
    source: result.source, conditions: result.effectiveConditions, scope: result.titleScope,
    status: result.status, rows: rows.map(canonicalPlatformJson).sort(),
  })
}
/** Reuse only the latest complete result in this exact query scope. Partial
 * segments and unresolved identities still need normal import validation. */
export function reuseCollectedPlatformResult(db: Db, result: PlatformLiveQueryResult, enterpriseId: number): boolean {
  const content = contents(result)
  if (content === null) return false
  const query = platformResultToImport(result)
  const previous = db.get(sql`select id,status,collection_evidence,queried_at,last_collected_at from platform_query
    where interface=${query.interface} and query_key=${query.queryKey} and rdjb=${query.rdjb ?? ''} and title_code is ${query.titleCode ?? null}
    order by queried_at desc,id desc limit 1`) as {id:number;status:string;collection_evidence:string|null;queried_at:string;last_collected_at:string|null}|undefined
  if (!previous?.collection_evidence || previous.status !== query.status) return false
  if (contents(JSON.parse(previous.collection_evidence)) !== content) return false
  const projection = { apply_list: 'platform_apply_projection', business_list: 'platform_business_projection', recognized_list: 'platform_recognized_projection' }[query.interface]
  const incomplete = db.get(sql`select 1 from platform_relation r left join platform_business_observation o on o.relation_id=r.id
    left join ${sql.identifier(projection)} p on p.version_id=o.version_id
    where r.query_id=${previous.id} and (r.enterprise_id is not ${enterpriseId} or o.record_id is null or o.version_id is null or p.version_id is null) limit 1`)
  if (incomplete) return false
  if (Date.parse(result.queriedAt) > Date.parse(previous.last_collected_at ?? previous.queried_at)) {
    db.run(sql`update platform_query set last_collected_at=${result.queriedAt} where id=${previous.id}`)
  }
  return true
}
