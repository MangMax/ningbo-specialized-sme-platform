// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, expect, it, vi } from 'vitest'
import CandidateTaskCreate from '../components/tasks/CandidateTaskCreate.vue'
const mounted: ReturnType<typeof mount>[] = []
afterEach(() => {
  for (const view of mounted.splice(0)) view.unmount()
  vi.unstubAllGlobals()
})
it('retains the selected scope and request identity after failure and opens the accepted task on explicit retry', async () => {
  const fetch = vi
    .fn()
    .mockRejectedValueOnce(new Error('network'))
    .mockResolvedValueOnce({ jobId: '01M5BEPVCXD5619ZW4C6CATMWX' })
  vi.stubGlobal('$fetch', fetch)
  const view = mount(CandidateTaskCreate)
  mounted.push(view)
  const button = () =>
    view.findAll('button').find((b) => b.text().includes('生成候选'))!
  await button().trigger('click')
  await flushPromises()
  expect(view.text()).toContain('未确认受理')
  expect(view.emitted('created')).toBeUndefined()
  await button().trigger('click')
  await flushPromises()
  expect(fetch.mock.calls[0]![1].body).toEqual(fetch.mock.calls[1]![1].body)
  expect(fetch.mock.calls[1]![1].body.titleCode).toBe('specialized_sme')
  expect(view.emitted('created')).toEqual([['01M5BEPVCXD5619ZW4C6CATMWX']])
})
