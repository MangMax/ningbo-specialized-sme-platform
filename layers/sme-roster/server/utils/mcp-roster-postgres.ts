import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { and, count, desc, eq, sql } from 'drizzle-orm'
import type { differenceReason as DifferenceReasonTable } from '../../../../db/postgresql/roster-selection-tables'
import { enterprise } from '../../../../db/postgresql/enterprise-tables'
import { platformCollection } from '../../../../db/postgresql/platform-tables'
import { differenceReason } from '../../../../db/postgresql/roster-selection-tables'
import { readPostgresQueryAssessments } from '../../lib/roster/query-assessment-postgres'
import type { QueryAssessment } from '../../lib/roster/query-assessment'
import type { RosterEnterpriseRow, RosterEnterprisesResult } from '../../lib/roster/enterprise-roster-projection'
import type { FirstRecognitionStatus } from '../../lib/roster/first-recognition'

export interface ListEnterprisesInput {
  /** 名称/曾用名关键词（走契约 §5 搜索口径：现名 + **已确认**曾用名）。 */
  q?: string
  /** 称号过滤（等值）。 */
  title?: string | string[]
  district?: string
  rosterState?: 'current' | 'removed_platform_only'
  /** 首次正式认定年份(多值,不同于事件年份)。 */
  firstYear?: number[]
  /** 首次认定状态(多值,使用共享首次认定判定)。 */
  firstStatus?: FirstRecognitionStatus[]
  page?: number
  pageSize?: number
}

/** MCP 与 REST 共享企业总表的完整行形状。 */
export type ListEnterpriseRow = RosterEnterpriseRow
export type ListEnterprisesResult = RosterEnterprisesResult

const PAGE_SIZE_MAX = 200

function pageOf(input: { page?: number; pageSize?: number }): { page: number; pageSize: number } {
  const page = Number.isInteger(input.page) && (input.page as number) > 0 ? (input.page as number) : 1
  const rawSize = Number.isInteger(input.pageSize) && (input.pageSize as number) > 0 ? (input.pageSize as number) : 50
  return { page, pageSize: Math.min(rawSize, PAGE_SIZE_MAX) }
}

export function enterpriseListFilter(input: ListEnterprisesInput = {}) {
  return {
    q: input.q,
    title: input.title == null ? undefined : Array.isArray(input.title) ? input.title : [input.title],
    district: input.district,
    rosterState: input.rosterState,
    firstYear: input.firstYear,
    firstStatus: input.firstStatus,
    page: input.page,
    pageSize: input.pageSize,
  }
}

export interface ListDifferencesInput {
  title?: string
  direction?: 'missing_in_miit' | 'extra_in_miit'
  status?: string
  page?: number
  pageSize?: number
}

export interface ListDifferenceRow extends QueryAssessment {
  enterpriseId: number
  name: string
  titleCode: string
  direction: string
  status: string
  reasonCode: string | null
  measureCode: string | null
  movedIn: { city: string | null; titleCode: string | null; year: number | null; batch: number | null } | null
  factReferences?: NonNullable<typeof DifferenceReasonTable.$inferSelect.factReferences>
  verificationStatus: string
  recordedAt: string
  evidence: { queryId: number; queriedAt: string; interface: string; status: string } | null
}

export type ListDifferencesResult = {
  rows: ListDifferenceRow[]
  counts: Record<string, Record<string, number>>
}

type DifferenceRow = Pick<typeof DifferenceReasonTable.$inferSelect, 'enterpriseId' | 'titleCode' | 'direction' | 'status' |
  'reasonCode' | 'measureCode' | 'verificationStatus' | 'recordedAt' | 'factReferences' | 'movedInCity' | 'movedInTitleCode' | 'movedInYear' | 'movedInBatch'>
  & { name: string; queryId: number | null; queriedAt: string | null; queryInterface: string | null; queryStatus: string | null }

export function projectListDifferences(rows: DifferenceRow[], assessments: QueryAssessment[]): ListDifferenceRow[] {
  return rows.map((row, index) => {
    const { movedInCity,movedInTitleCode,movedInYear,movedInBatch,queryId,queriedAt,queryInterface,queryStatus,factReferences,...summary } = row
    return { ...summary, ...(factReferences?.length ? { factReferences } : {}), ...assessments[index]!, movedIn: [movedInCity,movedInTitleCode,movedInYear,movedInBatch].some(v => v != null) ? { city: movedInCity,titleCode: movedInTitleCode,year: movedInYear,batch: movedInBatch } : null,
      evidence: queryId != null ? { queryId, queriedAt: queriedAt!, interface: queryInterface!, status: queryStatus! } : null }
  })
}

export async function listPostgresDifferences(db: NodePgDatabase, input: ListDifferencesInput = {}): Promise<ListDifferencesResult> {
  return db.transaction(async tx => {
    const key = [differenceReason.enterpriseId, differenceReason.titleCode, differenceReason.direction]
    const head = tx.$with('difference_heads').as(tx.selectDistinctOn(key).from(differenceReason)
      .orderBy(...key, desc(differenceReason.recordedAt), desc(differenceReason.id)))
    const scope = and(
      input.title ? eq(head.titleCode, input.title) : undefined,
      input.direction ? eq(head.direction, input.direction) : undefined,
      input.status ? eq(sql<string>`${head.status}`, input.status) : undefined,
    )
    const groups = await tx.with(head).select({ titleCode: head.titleCode, direction: head.direction, n: count() })
      .from(head).where(scope).groupBy(head.titleCode, head.direction)
    const counts: ListDifferencesResult['counts'] = {}
    for (const group of groups) {
      counts[group.titleCode] ??= {}
      counts[group.titleCode]![group.direction] = group.n
    }
    const { page, pageSize } = pageOf(input)
    const stored = await tx.with(head).select({
      enterpriseId: head.enterpriseId, name: enterprise.name, titleCode: head.titleCode, direction: head.direction,
      status: head.status, reasonCode: head.reasonCode, measureCode: head.measureCode, verificationStatus: head.verificationStatus,
      recordedAt: head.recordedAt, factReferences: head.factReferences, movedInCity: head.movedInCity,
      movedInTitleCode: head.movedInTitleCode, movedInYear: head.movedInYear, movedInBatch: head.movedInBatch,
      queryId: platformCollection.publicId, queriedAt: platformCollection.queriedAt,
      queryInterface: platformCollection.interface, queryStatus: platformCollection.status,
    }).from(head).innerJoin(enterprise, eq(enterprise.id, head.enterpriseId))
      .leftJoin(platformCollection, eq(platformCollection.id, head.evidenceQueryId))
      .where(scope)
      // Drizzle 0.45 has no expression-level collation modifier.
      .orderBy(head.enterpriseId, sql`${head.titleCode} COLLATE "C"`, sql`${head.direction} COLLATE "C"`)
      .limit(pageSize).offset(Math.min(Number.MAX_SAFE_INTEGER, (page - 1) * pageSize))
    const rows: DifferenceRow[] = stored.map(row => ({
      ...row, factReferences: row.factReferences === null ? null : JSON.parse(row.factReferences),
    }))
    const assessments = await readPostgresQueryAssessments(tx, rows)
    return { rows: projectListDifferences(rows, assessments), counts }
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' })
}
