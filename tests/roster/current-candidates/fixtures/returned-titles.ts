import { writeNewCollectionTarget } from '../../../../lib/platform/collection-target-command'
import { platformResultToImport } from '../../../../lib/platform/recognized-evidence'
import type { PlatformLiveQueryResult } from '../../../../lib/platform/live-query'

/** Real source writer: request scope and returned row title are deliberately independent. */
export function captureReturnedTitles(db: Parameters<typeof writeNewCollectionTarget>[0], source: PlatformLiveQueryResult['source'], rows: Record<string, string>[], owners: (number | null)[], requested = ['1', '2', '3'], queriedAt = '2026-11-17T00:00:00Z') {
  const scope = source === 'queryList' ? [] : requested
  const evidence: PlatformLiveQueryResult = {
    source, status: 'success', effectiveConditions: source === 'businessList' ? { uscc: rows[0]!.tyshxydm, combination: 'and' } : { name: '实际称号候选', combination: 'and' },
    titleScope: { mode: source === 'queryList' ? 'source_default' : 'selected', rdjb: scope }, queriedAt, completedAt: queriedAt,
    rows, dataRows: rows, pages: (scope.length ? scope : [null]).map((rdjb, index) => {
      const count = scope.length && rows.length >= scope.length ? (index === 0 ? rows.length-scope.length+1 : 1) : (index === 0 ? rows.length : 0)
      return { source, rdjb, page: 1, maxPage: 1, status: 'success', fetchedCount: count, declaredTotal: count, error: null }
    }),
    fetchedCount: rows.length, declaredTotal: rows.length, completeness: 'complete', fullRange: true, unfinished: [], error: null,
    limits: { maxRequests: 100, maxRows: 5000, maxDurationMs: 60000, pageSize: 50 },
  }
  const query = platformResultToImport(evidence)
  return writeNewCollectionTarget(db, { queryText: JSON.stringify(query), evidenceText: JSON.stringify(evidence), createdAt: queriedAt,
    assignments: (query.relations ?? []).map((row, index) => ({ enterpriseId: owners[index] ?? null, matchBasis: owners[index] == null ? 'none' : 'uscc', verificationStatus: owners[index] == null ? 'pending' : 'confirmed', nameRaw: row.nameRaw ?? null, usccRaw: row.usccRaw ?? null, origin: 'command', actor: { type: 'agent', id: 'candidate-test' }, basis: 'explicit source identity', recordedAt: null })),
  })
}
