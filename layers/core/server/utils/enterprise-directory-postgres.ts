import { sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import type { EnterpriseLibrarySource } from '../../lib/core/enterprise-library'
import { normalizeEnterpriseName } from '../../lib/enterprise-name'
import { directoryColumns, directoryOrder, directorySource, enterpriseSourcesSelection, type DirectoryQuery, type DirectoryRow } from './enterprise-directory-query'

type PgDirectoryRow = Omit<DirectoryRow, 'id' | 'revision' | 'mergedInto'> & {
  id: string
  revision: string
  mergedInto: string | null
}

function asDirectoryRow(row: PgDirectoryRow): DirectoryRow {
  return {
    ...row,
    id: Number(row.id),
    revision: Number(row.revision),
    mergedInto: row.mergedInto === null ? null : Number(row.mergedInto),
  }
}

function literalPattern(term: string) {
  return '%' + term.replace(/[!%_]/g, '!$&') + '%'
}

export async function listPostgresDirectoryEnterprises(db: NodePgDatabase, query: DirectoryQuery) {
  const predicates = [sql`m.from_enterprise_id IS NULL`]
  if (query.name !== undefined) {
    predicates.push(sql`e.name_norm COLLATE "C" LIKE ${literalPattern(normalizeEnterpriseName(query.name))} ESCAPE '!'`)
  }
  if (query.uscc !== undefined) predicates.push(sql`e.uscc_norm = ${query.uscc}`)
  if (query.districtCode !== undefined) predicates.push(sql`d.district_code = ${query.districtCode}`)
  if (query.townshipCode !== undefined) predicates.push(sql`d.township_code = ${query.townshipCode}`)
  if (query.industryDivisionCode !== undefined) predicates.push(sql`ig.parent_code = ${query.industryDivisionCode}`)
  if (query.industryCode !== undefined) predicates.push(sql`d.industry_code = ${query.industryCode}`)
  if (query.registeredAddress !== undefined) predicates.push(sql`strpos(ra.address, ${query.registeredAddress}) > 0`)
  if (query.operatingAddress !== undefined) predicates.push(sql`strpos(oa.address, ${query.operatingAddress}) > 0`)
  if (query.sourceId !== undefined) {
    predicates.push(sql`EXISTS (SELECT 1 FROM enterprise_source_link l WHERE l.enterprise_id = e.id AND l.source_id = ${query.sourceId})`)
  }
  if (!query.includeRemoved) predicates.push(sql`d.removed_reason IS NULL`)
  const conditions = sql`${sql.raw(directorySource)} WHERE ${sql.join(predicates, sql` AND `)}`
  const selection = sql`SELECT ${sql.raw(directoryColumns)} ${conditions}`
  if (query.page !== undefined || query.sorts?.length) {
    // Match SQLite NOCASE, which only folds ASCII, including deterministic tie-breaking.
    const order = (query.sorts ?? []).map(({ field, direction }) => sql`
      translate(${sql.raw(directoryOrder[field])}, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz')
        COLLATE "C" ${direction === 'desc' ? sql`DESC` : sql`ASC`} NULLS LAST`)
    order.push(sql`e.id`)
    return db.transaction(async tx => {
      const count = await tx.execute<{ total: string }>(sql`SELECT count(*) AS total ${conditions}`)
      const total = Number(count.rows[0]!.total)
      const page = Math.min(query.page ?? 1, Math.max(1, Math.ceil(total / query.limit)))
      const result = await tx.execute<PgDirectoryRow>(sql`${selection}
        ORDER BY ${sql.join(order, sql`, `)} LIMIT ${query.limit} OFFSET ${(page - 1) * query.limit}`)
      return { rows: result.rows.map(asDirectoryRow), page, total }
    }, { isolationLevel: 'repeatable read', accessMode: 'read only' })
  }
  const result = await db.execute<PgDirectoryRow>(sql`${selection}
    AND e.id > ${query.after ?? 0} ORDER BY e.id LIMIT ${query.limit + 1}`)
  const rows = result.rows.slice(0, query.limit).map(asDirectoryRow)
  return { rows, nextAfter: result.rows.length > query.limit ? rows[query.limit - 1]!.id : null }
}

export async function readPostgresEnterpriseDetails(db: NodePgDatabase, id: number) {
  const result = await db.execute<PgDirectoryRow>(sql`SELECT ${sql.raw(directoryColumns)} ${sql.raw(directorySource)} WHERE e.id = ${id}`)
  const row = result.rows[0]
  return row && asDirectoryRow(row)
}

type PgEnterpriseSource = Omit<EnterpriseLibrarySource, 'id'> & {
  id: string
  module: string
  businessTable: string
  versionKey: string
  fileId: string | null
  sha256: string | null
}

export async function listPostgresEnterpriseSources(db: NodePgDatabase, id: number) {
  const result = await db.execute<PgEnterpriseSource>(sql`${sql.raw(enterpriseSourcesSelection)}
    WHERE l.enterprise_id = ${id} ORDER BY s.id`)
  return result.rows.map(row => ({ ...row, id: Number(row.id), fileId: row.fileId === null ? null : Number(row.fileId) }))
}
