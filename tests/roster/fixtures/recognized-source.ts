import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '../../../db/schema'
import { platformQueryResultShape } from '../../../lib/platform/live-query'
import type { RosterImportPlatformQuery } from '../../../lib/roster-import-client'
import { archiveQueryKey } from '../../../lib/platform/recognized-evidence'
import { submitNativePlatformQuery } from '../../platform/fixtures/native-query'

// This is a synthetic original source envelope, with exactly the supplied rows.
// It never imports a staged legacy relation or invents historical source evidence.
export function submitSyntheticRecognizedCollection(db: BetterSQLite3Database<typeof schema>, input: {
  rdjb: string; queriedAt: string;
  rows: Array<{ raw: Record<string, unknown>; enterpriseId: number | null }>;
  conditions?: Record<string, string>;
  partial?: boolean;
}) {
  const rows = input.rows.map(({ raw }) => Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, value == null ? '' : typeof value === 'string' ? value : JSON.stringify(value)])))
  const scope = input.rdjb.split(',')
  const collectionEvidence = {
    source: 'queryBusList' as const, status: input.partial ? 'partial' as const : rows.length ? 'success' as const : 'no_record' as const,
    effectiveConditions: { combination: 'and' as const, ...input.conditions }, titleScope: { mode: 'selected' as const, rdjb: scope },
    queriedAt: input.queriedAt, completedAt: input.queriedAt, rows, dataRows: platformQueryResultShape.dataRows.parse(input.rows.map(row => row.raw)),
    pages: scope.map(rdjb => ({ source: 'queryBusList' as const, rdjb, page: 1, maxPage: input.partial ? 2 : 1, status: 'success' as const, fetchedCount: rows.filter(row => scope.length === 1 || row.rdjb === rdjb).length, declaredTotal: input.partial ? 2 : rows.filter(row => scope.length === 1 || row.rdjb === rdjb).length, error: null })),
    fetchedCount: rows.length, declaredTotal: input.partial ? 2 : rows.length, completeness: input.partial ? 'partial' as const : 'complete' as const, fullRange: !input.partial, unfinished: input.partial ? scope.map(rdjb => ({ source: 'queryBusList' as const, rdjb, page: 2 })) : [], error: null,
    limits: { maxRequests: scope.length, maxRows: 50, maxDurationMs: 1000, pageSize: input.partial ? 1 : 50 },
  }
  const query: RosterImportPlatformQuery = { interface: 'recognized_list', queryKey: archiveQueryKey(collectionEvidence), rdjb: input.rdjb, titleCode: scope.length === 1 ? ({ '1': 'innovative_sme', '2': 'specialized_sme', '3': 'little_giant' }[input.rdjb] ?? null) : null,
    queriedAt: input.queriedAt, status: input.partial ? 'partial' : rows.length ? 'success' : 'no_record', collectionEvidence,
    relations: rows.map((rawFields, i) => ({ sequenceNo: i + 1, relationKey: rawFields.id ?? null, nameRaw: rawFields.qymc ?? null, usccRaw: rawFields.tyshxydm ?? null, rawFields: input.rows[i]!.raw, enterpriseId: input.rows[i]!.enterpriseId, matchBasis: input.rows[i]!.enterpriseId == null ? 'none' : 'uscc', verificationStatus: input.rows[i]!.enterpriseId == null ? 'pending' : 'confirmed' })),
  }
  return submitNativePlatformQuery(db, query)
}
