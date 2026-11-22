import { and, eq, isNull, sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { enterprise, enterpriseDirectory, enterpriseMerge } from '../../../../db/postgresql/enterprise-tables'
import { normalizeName, normalizeUscc } from '../../../../layers/sme-roster/lib/domain'
import type { RosterImportRequest, SupplementAnnouncementRequest } from '../../../../layers/sme-roster/lib/roster-import-client'

/** Synthetic review decisions. Scenarios supply and assert their own source facts. */
export async function reviewPostgresFixtureRows(db: NodePgDatabase, sourceDigest: string, request: RosterImportRequest): Promise<SupplementAnnouncementRequest> {
  const previous = new Map<string, number>()
  const rows: SupplementAnnouncementRequest['rows'] = []
  for (const [index, { enterprise: subject }] of request.payload.announcement!.records.entries()) {
    const name = normalizeName(subject.name)
    const uscc = subject.uscc ? normalizeUscc(subject.uscc) : null
    const key = uscc ? 'uscc:' + uscc : 'name:' + name
    const earlier = previous.get(key)
    if (earlier !== undefined) {
      rows.push({ action: 'same_subject', row: earlier })
      continue
    }
    previous.set(key, index)
    const matches = await db.select({
      id: enterprise.id, revision: sql<number>`coalesce(${enterpriseDirectory.revision}, 1)`.mapWith(Number),
    }).from(enterprise)
      .leftJoin(enterpriseDirectory, eq(enterpriseDirectory.enterpriseId, enterprise.id))
      .leftJoin(enterpriseMerge, eq(enterpriseMerge.fromEnterpriseId, enterprise.id))
      .where(and(isNull(enterpriseMerge.fromEnterpriseId),
        uscc ? eq(enterprise.usccNorm, uscc) : eq(enterprise.nameNorm, name)))
      .limit(2)
    if (matches.length > 1) throw new Error('Synthetic fixture needs an explicit subject for row ' + index)
    const match = matches[0]
    rows.push(match ? { action: 'attach', enterpriseId: match.id, expectedRevision: match.revision }
      : { action: 'create', fields: { name: subject.name, ...(uscc ? { uscc } : {}) } })
  }
  return { sourceDigest, basis: 'Reviewed synthetic fixture identities', rows }
}
