// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import CandidateTaskCreate from '../../../components/tasks/CandidateTaskCreate.vue'
const mounted: ReturnType<typeof mount>[] = []
beforeEach(() => {
  // Bare Vue mounting has no Nuxt injection; the diagnostic plugin is optional.
  vi.stubGlobal('useNuxtApp', () => ({}))
})
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
it('shows a checkpointed running event as unfinished when its task has been cancelled',async()=>{
  const {default:TaskDetail}=await import('../../../components/tasks/TaskDetail.vue')
  vi.stubGlobal('$fetch',vi.fn(async()=>({id:'01M5BEPVCXD5619ZW4C6CATMWX',kind:'event-archive-candidates',label:'公布事件候选发现',group:'platform',state:'cancelled',createdAt:'2026-10-23T00:00:00Z',startedAt:null,finishedAt:'2026-10-23T00:01:00Z',progress:{done:0,total:1,unit:'项',stage:'执行结束'},error:null,outcome:null,links:[],capabilities:{cancel:false,retry:true,retryItemIds:[],reason:'从检查点重试'},discovery:{ruleVersion:'event-archive-212-v1',scope:'指定1条事件',attempt:1,titleCode:null,throughEventId:1,nextAfterEventId:null,continuationJobId:null,counts:{succeeded:0,needsReview:0,failed:0,created:1,existing:0},items:[{eventId:1,enterpriseId:1,status:'running',created:1,existing:0,errorCode:null}]}})))
  const view=mount(TaskDetail,{props:{id:'01M5BEPVCXD5619ZW4C6CATMWX'},global:{components:{NuxtLink:{template:'<a><slot /></a>'}}}});mounted.push(view);await flushPromises()
  const results=view.get('[aria-label="逐事件处理结果"]')
  expect(results.text()).toContain('未完成')
  expect(results.text()).not.toContain('处理中')
})

it('reports retained candidates when a later source row fails within the same event', async () => {
  const { default: TaskDetail } = await import('../../../components/tasks/TaskDetail.vue')
  vi.stubGlobal('$fetch', vi.fn(async () => ({
    id: '01M5BEPVCXD5619ZW4C6CATMWX', kind: 'event-archive-candidates',
    label: '公布事件候选发现', group: 'platform', state: 'failed',
    createdAt: '2026-10-23T00:00:00Z', startedAt: null, finishedAt: '2026-10-23T00:01:00Z',
    progress: { done: 1, total: 1, unit: '项', stage: '执行结束' },
    error: '部分事件失败；已完成候选保留，可重试未完成项。', outcome: null, links: [],
    capabilities: { cancel: false, retry: true, retryItemIds: [], reason: '从检查点重试' },
    discovery: {
      ruleVersion: 'event-archive-212-v1', scope: '指定1条事件', attempt: 1,
      titleCode: null, throughEventId: 1, nextAfterEventId: null, continuationJobId: null,
      counts: { succeeded: 0, needsReview: 0, failed: 1, created: 1, existing: 0 },
      items: [{ eventId: 1, enterpriseId: 1, status: 'failed', created: 1, existing: 0, errorCode: 'source_materialization_limit' }],
    },
  })))
  const view = mount(TaskDetail, { props: { id: '01M5BEPVCXD5619ZW4C6CATMWX' },
    global: { components: { NuxtLink: { template: '<a><slot /></a>' } } },
  })
  mounted.push(view)
  await flushPromises()
  const results = view.get('[aria-label="逐事件处理结果"]')
  expect(results.text()).toContain('失败 · 新增 1 · 保留 0')
  expect(results.text()).toContain('此原行未写入，已完成候选保留')
  expect(results.text()).not.toContain('本项未写入')
})
