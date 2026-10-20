import { useQueryCache } from '@pinia/colada'
/** Prefixes also invalidate inactive detail variants (drawer IDs may be numbers or strings). */
export function useEvidenceReviewRefresh() {
  const cache = useQueryCache()
  return () => Promise.all([
    'evidence-impacts', 'evidence-impact', 'evidence-impact-sources', 'evidence-revision-events',
    'decision-history', 'decision-version', 'roster-enterprise', 'ledger-drawer',
    'ledger-enterprises', 'roster-differences', 'comparison', 'stats',
  ].map(key => cache.invalidateQueries({ key: [key] })))
}
