import { expect, it } from 'vitest'
import type { EventArchiveCandidate } from '../../../lib/roster/event-archive-candidates'
import { platformDecisionSummary, replacementDecisionOptions } from '../../../components/record-correspondence/event-correspondence-presentation'

const row = (id: number, overrides = {}): EventArchiveCandidate => ({
  edge: { type: 'event_process', eventId: 7, relationId: id, role: 'context_only' },
  status: 'candidate', ruleId: 'test', ruleVersion: '1', conflicts: [], existingCorrespondenceId: null, revision: null, existingStatus: null, recommendation: 'candidate',
  evidence: {
    identity: { enterpriseId: 1, officialUsccRaw: null, rowUsccRaw: null },
    title: { official: 'specialized_sme', row: 'specialized_sme' },
    temporal: { eventYear: 2026, eventBatchSeq: null, relationYear: null, relationBatch: null, awardBatchLabel: null },
    process: { eventType: 'award', declareKind: 'review', appliedAt: '2026-03-02', status: '审核中' },
    source: { queryId: 2, relationId: id, sourceRdjb: null, interface: 'apply_list', status: 'success', queriedAt: '2026-10-23', sourcePage: 2, sequenceNo: id, ...overrides },
  },
} as EventArchiveCandidate & { evidence: { process: { status: string } } })

it('identifies replacement records by real business facts rather than internal query IDs', () => {
  const summary = platformDecisionSummary(row(41))
  expect(summary).toContain('复核 · 申报时间：2026-03-02 · 申报办理记录 · 状态：审核中')
  expect(replacementDecisionOptions([row(41)])[0]).toEqual({ id: '41', label: summary })
  expect(summary).not.toContain('41')
})

it('distinguishes repeated observations by capture and position before falling back to source ID', () => {
  const options = replacementDecisionOptions([row(41), row(42)])
  expect(options[0]!.label).toContain('采集：2026-10-23 · 第 2 页 / 第 41 行')
  expect(options[1]!.label).toContain('第 42 行')
  expect(options[0]!.label).not.toContain('来源编号')
  const ties = replacementDecisionOptions([row(41, { sequenceNo: 1 }), row(42, { sequenceNo: 1 })])
  expect(ties.map(option => option.label.split('来源编号 ')[1])).toEqual(['41', '42'])
})

it('preserves unrecognized legacy values and missing facts without inferring business meaning', () => {
  const unknown = row(41, { interface: 'old_api', status: '旧状态9' })
  unknown.evidence.process = { eventType: 'award', declareKind: '旧类型7', appliedAt: null }
  expect(platformDecisionSummary(unknown)).toContain('事项未识别（旧类型7） · 申报时间：未记录 · 接口未识别（old_api） · 状态：未记录 · 查询：旧状态9')
  expect(platformDecisionSummary()).toBe('事项未记录 · 申报时间：未记录 · 接口未记录 · 状态：未记录 · 查询：未记录')
})
