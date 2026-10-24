import { afterEach, describe, expect, it, vi } from 'vitest'
import { comparisonRequest, comparisonRouteFromQuery, comparisonRouteKey, comparisonRouteQuery, comparisonSelectionFromQuery, comparisonSelectionQuery, instantFromLocalDateTime, localDateTimeForInstant, sourceSelectionKey } from '../lib/roster/record-comparison-view'

afterEach(() => vi.unstubAllEnvs())

describe('record comparison client request', () => {
  it('requires the explicit source set and retains independent source kinds', () => {
    const selected = comparisonSelectionFromQuery({ queryIds: '3,4', exportBatchIds: '8', officialSourceDocumentIds: '2', proofIds: '9' })
    expect(selected).toEqual({ queryIds: [3, 4], exportBatchIds: [8], officialSourceDocumentIds: [2], proofIds: [9] })
    expect(comparisonSelectionQuery(selected)).toEqual({ queryIds: '3,4', exportBatchIds: '8', officialSourceDocumentIds: '2', proofIds: '9' })
    expect(comparisonRequest(selected, 2, 25, 'unresolved')).toMatchObject({ queryIds: [3, 4], exportBatchIds: [8], officialSourceDocumentIds: [2], classification: 'unresolved', page: 2 })
    expect(sourceSelectionKey('query')).toBe('queryIds')
    expect(sourceSelectionKey('official_document')).toBe('officialSourceDocumentIds')
  })

  it('rejects malformed URL identities rather than forwarding guesses', () => {
    expect(comparisonSelectionFromQuery({ queryIds: '3,not-an-id', exportBatchIds: '0', officialSourceDocumentIds: '2,2', proofIds: '9,bad' })).toEqual({ queryIds: [], exportBatchIds: [], officialSourceDocumentIds: [2], proofIds: [] })
  })

  it('roundtrips a URL instant through a Shanghai datetime-local input without changing its instant', () => {
    vi.stubEnv('TZ', 'Asia/Shanghai')
    const original = '2026-10-18T10:00:00.000Z'
    const local = localDateTimeForInstant(original)
    expect(local).toBe('2026-10-18T18:00:00.000')
    expect(instantFromLocalDateTime(local, original)).toBe(original)
    expect(instantFromLocalDateTime('2026-10-18T19:00:00.000', original)).toBe('2026-10-18T11:00:00.000Z')
  })

  it('keeps source set, proof, classification, page and page size in a canonical return URL', () => {
    const state = comparisonRouteFromQuery({ queryIds: '7', exportBatchIds: '8', officialSourceDocumentIds: '3', proofIds: '12', classification: 'unresolved', asOf: '2026-10-18T18:00:00+08:00', page: '2', pageSize: '50' })
    expect(state).toMatchObject({ selection: { queryIds: [7], exportBatchIds: [8], officialSourceDocumentIds: [3], proofIds: [12] }, classification: 'unresolved', asOf: '2026-10-18T10:00:00.000Z', page: 2, pageSize: 50 })
    expect(comparisonRouteQuery(state)).toMatchObject({ mode: 'record', queryIds: '7', exportBatchIds: '8', officialSourceDocumentIds: '3', proofIds: '12', classification: 'unresolved', asOf: '2026-10-18T10:00:00.000Z', page: '2', pageSize: '50' })
    expect(comparisonRouteKey(comparisonRouteFromQuery(comparisonRouteQuery(state)))).toBe(comparisonRouteKey(state))
  })
})

it('restores read-only official evidence references without accepting negative query or proof IDs', () => {
  const selection = comparisonSelectionFromQuery({ queryIds: '7', exportBatchIds: '', officialSourceDocumentIds: '-9,3', proofIds: '-2' })
  expect(selection).toEqual({ queryIds: [7], exportBatchIds: [], officialSourceDocumentIds: [-9, 3], proofIds: [] })
  expect(comparisonSelectionFromQuery(comparisonSelectionQuery(selection))).toEqual(selection)
  expect(comparisonSelectionFromQuery({ queryIds: '-7', officialSourceDocumentIds: '0' })).toMatchObject({ queryIds: [], officialSourceDocumentIds: [] })
})

it('roundtrips independent business pagination without changing event pagination or source selection', () => {
  const state = comparisonRouteFromQuery({ queryIds: '7', officialSourceDocumentIds: '3', page: '4', pageSize: '50', businessPage: '2', businessPageSize: '1' })
  const query = comparisonRouteQuery(state)
  expect(query).toMatchObject({ page: '4', pageSize: '50', businessPage: '2', businessPageSize: '1' })
  expect(comparisonRouteKey(comparisonRouteFromQuery(query))).toBe(comparisonRouteKey(state))
  expect(comparisonRouteKey({ ...state, businessPage: 3 })).not.toBe(comparisonRouteKey(state))
  expect(comparisonRouteFromQuery({ businessPage: '-1', businessPageSize: '201' })).toMatchObject({ businessPage: 1, businessPageSize: 25 })
})
