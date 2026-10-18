import { describe, expect, it } from 'vitest'
import { comparisonRequest, comparisonSelectionFromQuery, comparisonSelectionQuery, sourceSelectionKey } from '../lib/roster/record-comparison-view'

describe('record comparison client request', () => {
  it('requires the explicit source set and retains independent source kinds', () => {
    const selected = comparisonSelectionFromQuery({ queryIds: '3,4', exportBatchIds: '8', officialSourceDocumentIds: '2' })
    expect(selected).toEqual({ queryIds: [3, 4], exportBatchIds: [8], officialSourceDocumentIds: [2] })
    expect(comparisonSelectionQuery(selected)).toEqual({ queryIds: '3,4', exportBatchIds: '8', officialSourceDocumentIds: '2' })
    expect(comparisonRequest(selected, 2, 25, 'unresolved')).toMatchObject({ queryIds: [3, 4], exportBatchIds: [8], officialSourceDocumentIds: [2], classification: 'unresolved', page: 2 })
    expect(sourceSelectionKey('query')).toBe('queryIds')
    expect(sourceSelectionKey('official_document')).toBe('officialSourceDocumentIds')
  })

  it('rejects malformed URL identities rather than forwarding guesses', () => {
    expect(comparisonSelectionFromQuery({ queryIds: '3,not-an-id', exportBatchIds: '0', officialSourceDocumentIds: '2,2' })).toEqual({ queryIds: [], exportBatchIds: [], officialSourceDocumentIds: [2] })
  })
})
