import { sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { enterpriseDifferenceComparison as comparison } from '../../../../../db/postgresql/roster-selection-tables'
import { readPostgresRefreshFingerprints } from './platform-refresh-fingerprints'
import { CURRENT_TITLES } from '../../../../../layers/sme-roster/lib/roster/current-titles'
import { readLegacyPlatformRefreshFacts } from './read-legacy-platform-refresh'

export async function installPlatformRefreshV2(db: NodePgDatabase) {
  return db.transaction(async tx => {
    await tx.execute(sql`LOCK TABLE business.enterprise_difference_comparison,
      business.platform_collection, business.platform_business_observation IN ACCESS EXCLUSIVE MODE`)
    const { rows: [shape] } = await tx.execute<{ legacyColumns: number; hasNativeState: boolean }>(sql`
      SELECT count(*) FILTER (WHERE attname IN ('refresh_metadata','refresh_facts'))::int AS "legacyColumns",
        coalesce(bool_or(attname='state_fingerprint'), false) AS "hasNativeState"
      FROM pg_attribute
      WHERE NOT attisdropped AND (
        (attrelid='business.platform_collection'::regclass AND attname='refresh_metadata') OR
        (attrelid='business.platform_business_observation'::regclass AND attname='refresh_facts') OR
        (attrelid='business.enterprise_difference_comparison'::regclass AND attname='state_fingerprint')
      )`)
    const stored = await tx.select({
      enterpriseId: comparison.enterpriseId, title: comparison.titleCode, digest: comparison.businessFingerprint,
    }).from(comparison).orderBy(comparison.enterpriseId, comparison.titleCode)
    if (shape?.legacyColumns === 0 && shape.hasNativeState) return { status: 'already_native', existing: stored.length }
    if (shape?.legacyColumns !== 2) throw new Error('Incomplete legacy platform refresh schema')

    await tx.execute(sql`ALTER TABLE business.enterprise_difference_comparison
      ADD COLUMN IF NOT EXISTS state_fingerprint text`)
    const unresolved: { enterpriseId: number; title: string; reason: 'stale' | 'unverifiable' }[] = []
    let retained = 0
    const byEnterprise = Map.groupBy(stored, row => row.enterpriseId)
    const ids = [...byEnterprise.keys()]
    for (let offset = 0; offset < ids.length; offset += 100) {
      const block = ids.slice(offset, offset + 100)
      const current = new Map((await readPostgresRefreshFingerprints(tx, block)).map(row => [row.subject.id, row.fingerprints]))
      let historical: Awaited<ReturnType<typeof readPostgresRefreshFingerprints>>
      try {
        historical = await readPostgresRefreshFingerprints(tx, block, readLegacyPlatformRefreshFacts)
      } catch (error) {
        if (!(error instanceof Error) || error.message !== 'Difference refresh cannot hash a binary relation field') throw error
        historical = []
        for (const id of block) {
          try { historical.push(...await readPostgresRefreshFingerprints(tx, [id], readLegacyPlatformRefreshFacts)) }
          catch (error) {
            if (!(error instanceof Error) || error.message !== 'Difference refresh cannot hash a binary relation field') throw error
          }
        }
      }
      const verified = new Map(historical.map(row => [row.subject.id, row.fingerprints]))
      const approved: { enterprise_id: number; title_code: string; fingerprint: string }[] = []
      for (const id of block) {
        for (const row of byEnterprise.get(id)!) {
          const title = CURRENT_TITLES.find(title => title === row.title)
          const old = title === undefined ? undefined : verified.get(id)?.get(title)
          const fingerprint = title === undefined ? undefined : current.get(id)?.get(title)
          if (old === undefined || fingerprint === undefined || old !== row.digest) {
            unresolved.push({ enterpriseId: id, title: row.title, reason: old === undefined || fingerprint === undefined ? 'unverifiable' : 'stale' })
            continue
          }
          approved.push({ enterprise_id: id, title_code: row.title, fingerprint })
        }
      }
      if (approved.length) {
        await tx.execute(sql`UPDATE business.enterprise_difference_comparison c SET state_fingerprint=a.fingerprint
          FROM jsonb_to_recordset(${JSON.stringify(approved)}::jsonb) a(enterprise_id bigint, title_code text, fingerprint text)
          WHERE c.enterprise_id=a.enterprise_id AND c.title_code=a.title_code`)
        retained += approved.length
      }
    }
    await tx.execute(sql`ALTER TABLE business.platform_collection DROP COLUMN refresh_metadata`)
    await tx.execute(sql`ALTER TABLE business.platform_business_observation DROP COLUMN refresh_facts`)
    return { status: 'installed', existing: stored.length, retained, unresolved }
  }, { isolationLevel: 'repeatable read' })
}
