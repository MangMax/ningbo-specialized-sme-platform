import { expect, it } from 'vitest'
import { confirmedAnnualStep, orderedAnnualSteps, type AnnualTimelineView, type AnnualTimelineStep } from '../../../lib/roster/annual-process-presentation'

it('refuses a confirmed marker without an identified source generation or without the current latest step', () => {
  const view = { eventId: 7, generation: '', latestStepId: 'latest', qualification: { eventId: 7, generation: '', stepId: 'latest', status: 'confirmed' } } as AnnualTimelineView
  expect(confirmedAnnualStep(view)).toBeNull()
  view.generation = 'current'; view.qualification!.generation = 'current'; view.qualification!.stepId = 'early'
  expect(confirmedAnnualStep(view)).toBeNull()
})

it('orders application instants across normalized platform and offset times and keeps unknown dates visible last', () => {
  const steps = [
    { id: 'unknown', appliedAt: null },
    { id: 'late', appliedAt: '2024-03-01 12:00:00' },
    { id: 'first', appliedAt: '2024-03-01T14:00:00+08:00' },
    { id: 'middle', appliedAt: '2024-03-01T09:00:00Z' },
  ] as AnnualTimelineStep[]
  expect(orderedAnnualSteps(steps).map(step => step.id)).toEqual(['first', 'middle', 'late', 'unknown'])
  expect(steps.map(step => step.id)).toEqual(['unknown', 'late', 'first', 'middle'])
})
