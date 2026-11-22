import { and, asc, count, eq, exists, gt, isNull, sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { alias } from 'drizzle-orm/pg-core'
import { enterprise, enterpriseAddress, enterpriseDirectory, enterpriseIndustry, enterpriseMerge, enterpriseRegion } from '../../../../db/postgresql/enterprise-tables'
import { enterpriseSource, enterpriseSourceChannel, enterpriseSourceLink, enterpriseSourceListType } from '../../../../db/postgresql/enterprise-source-tables'
import { storedFile } from '../../../../db/postgresql/file-tables'
import type { EnterpriseLibrarySortField, EnterpriseLibrarySource } from '../../lib/core/enterprise-library'
import { normalizeEnterpriseName } from '../../lib/enterprise-name'
import type { DirectoryQuery, DirectoryRow } from './enterprise-directory-query'

const district = alias(enterpriseRegion, 'district')
const township = alias(enterpriseRegion, 'township')
const industry = alias(enterpriseIndustry, 'industry')
const industryGroup = alias(enterpriseIndustry, 'industry_group')
const registered = alias(enterpriseAddress, 'registered')
const operating = alias(enterpriseAddress, 'operating')

// Drizzle lacks builders for COALESCE and NULLIF.
const directoryText = {
  district: sql<string | null>`coalesce(${district.name}, nullif(${enterprise.district}, ''), ${enterpriseDirectory.districtCode})`,
  township: sql<string | null>`coalesce(${township.name}, ${enterpriseDirectory.townshipCode})`,
  industry: sql<string | null>`coalesce(${industry.name}, ${enterpriseDirectory.industryCode})`,
}
const fields = {
  id: enterprise.id,
  name: enterprise.name,
  uscc: enterprise.usccNorm,
  city: enterprise.city,
  district: enterprise.district,
  districtCode: enterpriseDirectory.districtCode,
  townshipCode: enterpriseDirectory.townshipCode,
  industryCode: enterpriseDirectory.industryCode,
  industryDivisionCode: industryGroup.parentCode,
  removedReason: enterpriseDirectory.removedReason,
  revision: sql<number>`coalesce(${enterpriseDirectory.revision}, 1)`.mapWith(Number),
  mergedInto: enterpriseMerge.intoEnterpriseId,
  districtName: directoryText.district,
  townshipName: directoryText.township,
  industryName: directoryText.industry,
  registeredAddress: registered.address,
  operatingAddress: operating.address,
}
const sortable = {
  name: enterprise.nameNorm,
  uscc: sql`nullif(${enterprise.usccNorm}, '')`,
  ...directoryText,
  registeredAddress: registered.address,
  operatingAddress: operating.address,
} satisfies Record<EnterpriseLibrarySortField, unknown>

function directoryQuery(db: NodePgDatabase) {
  return db.select(fields).from(enterprise)
    .leftJoin(enterpriseDirectory, eq(enterpriseDirectory.enterpriseId, enterprise.id))
    .leftJoin(enterpriseMerge, eq(enterpriseMerge.fromEnterpriseId, enterprise.id))
    .leftJoin(district, eq(district.code, enterpriseDirectory.districtCode))
    .leftJoin(township, eq(township.code, enterpriseDirectory.townshipCode))
    .leftJoin(industry, eq(industry.code, enterpriseDirectory.industryCode))
    .leftJoin(industryGroup, eq(industryGroup.code, industry.parentCode))
    .leftJoin(registered, and(eq(registered.enterpriseId, enterprise.id), eq(registered.kind, 'registered')))
    .leftJoin(operating, and(eq(operating.enterpriseId, enterprise.id), eq(operating.kind, 'operating')))
}

function literalPattern(term: string) {
  return '%' + term.replace(/[!%_]/g, '!$&') + '%'
}

export async function listPostgresDirectoryEnterprises(db: NodePgDatabase, query: DirectoryQuery) {
  const predicates = [isNull(enterpriseMerge.fromEnterpriseId)]
  // Drizzle LIKE has no collation or custom ESCAPE parameter, and no STRPOS builder.
  if (query.name !== undefined) {
    predicates.push(sql`${enterprise.nameNorm} COLLATE "C" LIKE ${literalPattern(normalizeEnterpriseName(query.name))} ESCAPE '!'`)
  }
  if (query.uscc !== undefined) predicates.push(eq(enterprise.usccNorm, query.uscc))
  if (query.districtCode !== undefined) predicates.push(eq(enterpriseDirectory.districtCode, query.districtCode))
  if (query.townshipCode !== undefined) predicates.push(eq(enterpriseDirectory.townshipCode, query.townshipCode))
  if (query.industryDivisionCode !== undefined) predicates.push(eq(industryGroup.parentCode, query.industryDivisionCode))
  if (query.industryCode !== undefined) predicates.push(eq(enterpriseDirectory.industryCode, query.industryCode))
  if (query.registeredAddress !== undefined) predicates.push(gt(sql`strpos(${registered.address}, ${query.registeredAddress})`, 0))
  if (query.operatingAddress !== undefined) predicates.push(gt(sql`strpos(${operating.address}, ${query.operatingAddress})`, 0))
  if (query.sourceId !== undefined) {
    predicates.push(exists(db.select({ sourceId: enterpriseSourceLink.sourceId }).from(enterpriseSourceLink)
      .where(and(eq(enterpriseSourceLink.enterpriseId, enterprise.id), eq(enterpriseSourceLink.sourceId, query.sourceId)))))
  }
  if (!query.includeRemoved) predicates.push(isNull(enterpriseDirectory.removedReason))
  if (query.page !== undefined || query.sorts?.length) {
    // Fold ASCII case only and keep missing names last in either sort direction.
    const order = (query.sorts ?? []).map(({ field, direction }) => sql`
      translate(${sortable[field]}, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz')
        COLLATE "C" ${direction === 'desc' ? sql`DESC` : sql`ASC`} NULLS LAST`)
    return db.transaction(async tx => {
      const matching = directoryQuery(tx).where(and(...predicates))
      const [counted] = await tx.select({ total: count() }).from(matching.as('matching_enterprises'))
      const total = counted!.total
      const page = Math.min(query.page ?? 1, Math.max(1, Math.ceil(total / query.limit)))
      const rows = await matching
        .orderBy(...order, asc(enterprise.id)).limit(query.limit).offset((page - 1) * query.limit)
      return { rows, page, total }
    }, { isolationLevel: 'repeatable read', accessMode: 'read only' })
  }
  const result = await directoryQuery(db).where(and(...predicates, gt(enterprise.id, query.after ?? 0)))
    .orderBy(asc(enterprise.id)).limit(query.limit + 1)
  const rows = result.slice(0, query.limit)
  return { rows, nextAfter: result.length > query.limit ? rows[query.limit - 1]!.id : null }
}

export async function readPostgresEnterpriseDetails(db: NodePgDatabase, id: number): Promise<DirectoryRow | undefined> {
  const [row] = await directoryQuery(db).where(eq(enterprise.id, id))
  return row
}

export function listPostgresEnterpriseSources(db: NodePgDatabase, id: number): Promise<EnterpriseLibrarySource[]> {
  return db.select({
    id: enterpriseSource.id,
    module: enterpriseSource.module,
    businessTable: enterpriseSource.businessTable,
    versionKey: enterpriseSource.versionKey,
    channel: enterpriseSourceChannel.name,
    listType: enterpriseSourceListType.name,
    acquiredOn: enterpriseSource.acquiredOn,
    series: enterpriseSource.series,
    fileId: enterpriseSource.fileId,
    sha256: enterpriseSource.sha256,
    filePath: storedFile.relPath,
  }).from(enterpriseSourceLink)
    .innerJoin(enterpriseSource, eq(enterpriseSource.id, enterpriseSourceLink.sourceId))
    .innerJoin(enterpriseSourceChannel, eq(enterpriseSourceChannel.code, enterpriseSource.channelCode))
    .innerJoin(enterpriseSourceListType, eq(enterpriseSourceListType.code, enterpriseSource.listTypeCode))
    .leftJoin(storedFile, and(eq(storedFile.id, enterpriseSource.fileId), eq(storedFile.sha256, enterpriseSource.sha256), isNull(storedFile.removedAt)))
    .where(eq(enterpriseSourceLink.enterpriseId, id)).orderBy(asc(enterpriseSource.id))
}
