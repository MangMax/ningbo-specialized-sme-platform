import { isPageCapable } from '../../layers/sme-roster/lib/roster/evidence-page'
import type { RosterImportItemResult, RosterImportRequest } from '../../lib/roster-import-client'
import { readPdfPageCount } from '../../layers/core/server/utils/pdf-pages'

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function pageFailure(
  ref: string,
  code: 'page_invalid' | 'page_count_unknown',
  message: string,
): RosterImportItemResult {
  return {
    ok: false,
    kind: 'record_evidence',
    ref,
    error: { code, field: 'evidence.page', message },
  }
}

/**
 * Check every supplied announcement PDF page against the source document itself.
 * The configured file root is mandatory for a requested page; rendered page images
 * are not a page-count source because they may be partial.
 */
export async function validateRosterImportPageCounts(
  request: RosterImportRequest,
  filesRoot: string | undefined,
): Promise<RosterImportItemResult[]> {
  const original = request.payload?.announcement?.records
  const records: unknown[] = Array.isArray(original) ? [...original] : []
  const appends = request.payload?.officialEvidenceAppends
  if (Array.isArray(appends)) records.push({ events: [{ evidence: appends.map(op => op?.evidence) }] })
  const operations = request.payload?.officialEvidenceCorrections?.operations
  if (Array.isArray(operations)) records.push({ events: [{ evidence: operations.map(op => op?.coordinate) }] })

  const errors: RosterImportItemResult[] = []
  const counts = new Map<string, Promise<number | null>>()
  for (const [recordIndex, record] of records.entries()) {
    const events = isObject(record) && Array.isArray(record.events) ? record.events : []
    for (const [eventIndex, event] of events.entries()) {
      const evidence = isObject(event) && Array.isArray(event.evidence) ? event.evidence : []
      for (const [evidenceIndex, item] of evidence.entries()) {
        if (!isObject(item) || item.page === null || item.page === undefined) continue
        const sourceFile = typeof item.sourceFile === 'string' ? item.sourceFile.trim() : ''
        if (!sourceFile || !isPageCapable(sourceFile)) continue
        const page = item.page
        if (typeof page !== 'number' || !Number.isFinite(page) || !Number.isInteger(page) || page < 1) continue

        const ref = `record:${recordIndex}#${eventIndex}/e${evidenceIndex}`
        if (!filesRoot) {
          errors.push(
            pageFailure(ref, 'page_count_unknown', `无法读取 ${sourceFile} 的源 PDF 页数，页码留待核对`),
          )
          continue
        }

        let count = counts.get(sourceFile)
        if (!count) {
          count = readPdfPageCount(filesRoot, sourceFile)
          counts.set(sourceFile, count)
        }
        const pageCount = await count
        if (pageCount === null) {
          errors.push(
            pageFailure(ref, 'page_count_unknown', `无法读取 ${sourceFile} 的源 PDF 页数，页码留待核对`),
          )
        } else if (page > pageCount) {
          errors.push(
            pageFailure(
              ref,
              'page_invalid',
              `${sourceFile} 共 ${pageCount} 页，page=${page} 超出源 PDF 页数范围`,
            ),
          )
        }
      }
    }
  }

  return errors
}
