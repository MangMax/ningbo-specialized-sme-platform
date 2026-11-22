// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils'
import { expect, it, vi } from 'vitest'
import { RouterLink, createMemoryHistory, createRouter, useRoute, useRouter } from 'vue-router'
import LeadListExport from '../../../layers/lead-lists/app/components/LeadListExport.vue'

it('shows the CSV download when an export notification refreshes progress', async () => {
  const id = '01M5BEPVCXD5619ZW4C6CATMWX'
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/lead-lists', component: LeadListExport },
      { path: '/tasks', component: { template: '<div />' } },
    ],
  })
  await router.push({ path: '/lead-lists', query: { version: '1', exportJob: id } })
  let state = 'running'
  const read = vi.fn(async () => ({ id, kind: 'lead-lists-version-export', params: { versionId: 1 }, state, error: null }))
  const closed = vi.fn()
  let source!: EventTarget
  vi.stubGlobal('EventSource', class extends EventTarget {
    constructor() {
      super()
      source = this
    }

    close() { closed() }
  })
  vi.stubGlobal('$fetch', read)
  vi.stubGlobal('useRoute', useRoute)
  vi.stubGlobal('useRouter', useRouter)
  const wrapper = mount(LeadListExport, {
    props: { versionId: 1, disabled: false },
    global: { plugins: [router], components: { NuxtLink: RouterLink } },
  })
  try {
    await flushPromises()
    expect(read).toHaveBeenCalledWith(`/api/jobs/${id}`, expect.objectContaining({ retry: 0 }))
    expect(wrapper.text()).toContain('运行中')
    expect(wrapper.text()).not.toContain('下载 CSV')
    source.dispatchEvent(new Event('ready'))
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2))
    state = 'done'
    source.dispatchEvent(new Event('changed'))
    await vi.waitFor(() => expect(wrapper.text()).toContain('下载 CSV'))
    await router.replace({ path: '/lead-lists', query: { version: '1' } })
    await flushPromises()
    expect(wrapper.text()).not.toContain('下载 CSV')
    expect(closed).toHaveBeenCalledOnce()
  } finally {
    wrapper.unmount()
    vi.unstubAllGlobals()
  }
})
