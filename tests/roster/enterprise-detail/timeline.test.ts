import { describe, expect, it } from 'vitest'
import { reviewEventSuffix, reviewOutcomeLabel, timelineEventIdentity } from '../../../layers/sme-roster/lib/roster/enterprise-timeline'

describe('企业时间轴事件事实', () => {
  const review = {
    eventType: 'review',
    year: 2021,
    batchSeq: 1,
    decidedYear: 2024,
    reviewOutcome: 'passed',
  }

  it('只合并事实完全相同的事件，保留批次、原认定年和不同复核结论', () => {
    expect(timelineEventIdentity('specialized_sme', review)).toBe(
      timelineEventIdentity('specialized_sme', { ...review }),
    )
    expect(timelineEventIdentity('specialized_sme', review)).not.toBe(
      timelineEventIdentity('specialized_sme', { ...review, batchSeq: 2 }),
    )
    expect(timelineEventIdentity('specialized_sme', review)).not.toBe(
      timelineEventIdentity('specialized_sme', { ...review, year: 2022 }),
    )
    expect(timelineEventIdentity('specialized_sme', review)).not.toBe(
      timelineEventIdentity('specialized_sme', { ...review, decidedYear: 2025 }),
    )
    expect(timelineEventIdentity('specialized_sme', review)).not.toBe(
      timelineEventIdentity('specialized_sme', { ...review, reviewOutcome: 'failed' }),
    )
    expect(timelineEventIdentity('specialized_sme', review)).not.toBe(
      timelineEventIdentity('innovative_sme', review),
    )
  })

  it('把通过、未通过和未知结论分别显示出来', () => {
    expect(reviewOutcomeLabel('passed')).toBe('通过')
    expect(reviewOutcomeLabel('failed')).toBe('未通过')
    expect(reviewOutcomeLabel(null)).toBe('结论待核')
    expect(reviewEventSuffix('passed', 2021, true)).toBe('（通过 · 原认定 2021 · 结论年份待核）')
    expect(reviewEventSuffix(null, null, false)).toBe('（结论待核）')
  })
})
