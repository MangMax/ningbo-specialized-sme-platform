import { RDJB_TITLE_CODES } from './recognized-evidence'

/** A query scope is not a row title. Never borrow a title from another observation. */
export function platformRowTitle(queryRdjb: string | null | undefined, raw: Record<string, unknown> | null | undefined): string {
  const scope = (queryRdjb ?? '').split(',').filter(Boolean)
  // Preserve the single-title constraint; conflicting row facts remain visible to conflict readers.
  if (scope.length === 1 && RDJB_TITLE_CODES[scope[0]!]) return scope[0]!
  const value = raw?.rdjb
  const title = typeof value === 'string' || typeof value === 'number' ? String(value) : ''
  if (!RDJB_TITLE_CODES[title]) return ''
  return !scope.length || scope.includes(title) ? title : ''
}
