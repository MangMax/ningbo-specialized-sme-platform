import { expect, it } from 'vitest'
import type { PlatformBusinessGroup, PlatformBusinessObservationRef, PlatformCorrespondenceRef } from '../../../layers/sme-roster/lib/platform/business-record'
import { presentAnnualSources } from '../../../lib/roster/annual-process-presentation'

it('keeps every interface version and observation decision local instead of copying a group confirmation', () => {
  const decision = { id: 41, relationId: 22, status: 'confirmed', revision: 3, endedAt: null } as PlatformCorrespondenceRef
  const observation = (id: number, own: PlatformCorrespondenceRef[]) => ({ relationId: id, queryId: id + 100, sequenceNo: id - 20, queriedAt: '2026-10-20', existingCorrespondences: own }) as PlatformBusinessObservationRef
  const groups = [
    { businessRecord: { interface: 'business_list', recordId: 2, versionId: 3, groupState: 'verified' }, representativeRelationId: 22, existingCorrespondences: [decision], observationRefs: [observation(22, [decision]), observation(23, [])] },
    { businessRecord: { interface: 'apply_list', recordId: 4, versionId: 5, groupState: 'verified' }, representativeRelationId: 24, existingCorrespondences: [], observationRefs: [observation(24, [])] },
  ] as PlatformBusinessGroup[]
  const result = presentAnnualSources(groups)
  expect(result).toHaveLength(2)
  expect(result[0]!.recordLabel).toContain('业务记录 2 · 版本 3')
  expect(result[1]!.recordLabel).toContain('业务记录 4 · 版本 5')
  expect(result[0]!.observations[0]).toMatchObject({ relationId: 22, queryId: 122, row: 2, revision: 3 })
  expect(result[0]!.observations[0]!.decision).toContain('已确认')
  expect(result[0]!.observations[1]!.decision).toBe('未登记决定')
  expect(result[1]!.observations[0]!.decision).toBe('未登记决定')
})

it('retains rejection unlink and historical confirmation without describing unindexed observations as verified', () => {
  const refs = ['rejected', 'unlinked', 'confirmed'].map((status, index) => ({ id: 10 + index, relationId: 22, status, revision: index + 1, endedAt: index === 2 ? '2026-10-21' : null })) as PlatformCorrespondenceRef[]
  const group = { businessRecord: { interface: 'business_list', recordId: null, versionId: null, groupState: 'not_indexed' }, representativeRelationId: 22, observationRefs: [{ relationId: 22, queryId: 12, sequenceNo: 2, queriedAt: '2026-10-20', existingCorrespondences: refs }] } as PlatformBusinessGroup
  const result = presentAnnualSources([group])[0]!
  expect(result.recordLabel).toContain('未索引')
  expect(result.recordLabel).not.toContain('已核实')
  expect(result.observations[0]!.decision).toContain('已否定对应')
  expect(result.observations[0]!.decision).toContain('已取消对应')
  expect(result.observations[0]!.decision).toContain('历史已确认')
  expect(result.observations[0]!.revision).toBeNull()
})
