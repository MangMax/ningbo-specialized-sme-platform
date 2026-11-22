import { inArray } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { chunk } from 'es-toolkit'
import { readCuration, projectCuratedComparison } from './curation-model'
import { getPostgresComparison } from './comparison-heads-postgres'
import { filterComparisonRows, type ComparisonRowFilter } from './comparison-filter'
import { enterprise, enterpriseAlias } from '../../../db/postgresql/enterprise-tables'

type ComparisonReader = Pick<NodePgDatabase, 'select' | '$with' | 'with'>
type Subject = { id: number; nameNorm: string; uscc: string | null }
// inArray binds each ID separately. Keep queries below PostgreSQL's 65,535-parameter limit.
const ownerBatchSize = 32_768

async function readPostgresCuratedComparison(db: ComparisonReader, curatedPath: string) {
  const base = await getPostgresComparison(db)
  const ownerIds = [...new Set(base.rows.map(row => row.enterpriseId))]
  const enterprises: Subject[] = []
  for (const batch of chunk(ownerIds, ownerBatchSize)) {
    enterprises.push(...await db.select({
      id: enterprise.id,
      nameNorm: enterprise.nameNorm,
      uscc: enterprise.usccNorm,
    }).from(enterprise).where(inArray(enterprise.id, batch)))
  }
  const names = new Map(enterprises.map(row => [row.id, row.nameNorm]))
  return { curated: projectCuratedComparison(base, readCuration(curatedPath), names), enterprises }
}

async function readPostgresComparisonAliases(db: Pick<NodePgDatabase, 'select'>, owners: number[]) {
  const rows: Pick<typeof enterpriseAlias.$inferSelect, 'enterpriseId' | 'name' | 'verificationStatus'>[] = []
  for (const batch of chunk([...new Set(owners)], ownerBatchSize)) {
    const aliases = await db.select({
      enterpriseId: enterpriseAlias.enterpriseId,
      name: enterpriseAlias.name,
      verificationStatus: enterpriseAlias.verificationStatus,
    }).from(enterpriseAlias).where(inArray(enterpriseAlias.enterpriseId, batch))
    for (const alias of aliases) rows.push(alias)
  }
  return Map.groupBy(rows, row => row.enterpriseId)
}

export function readPostgresComparisonExport(db: NodePgDatabase, curatedPath: string, filter: ComparisonRowFilter) {
  return db.transaction(async tx => {
    const { curated, enterprises } = await readPostgresCuratedComparison(tx, curatedPath)
    const aliases = await readPostgresComparisonAliases(tx, enterprises.map(row => row.id))
    return filterComparisonRows(curated.rows.map(row => ({
      ...row, platform: { aliases: aliases.get(row.enterpriseId) ?? [] },
    })), filter)
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' })
}
