// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter, RouterLink, useRoute, useRouter } from 'vue-router'
import PreviewPage from '../../../pages/preview.vue'
import PageHeader from '../../../layers/core/app/components/PageHeader.vue'

afterEach(() => { vi.unstubAllGlobals(); document.body.innerHTML = '' })

it.each(['notice.md', 'jxj/announcement/2026/notice.md'])('text source %s shows one filename, keeps distinct provenance and returns to its caller', async (file) => {
  const back = '/ocr?file=notice.pdf&page=7'
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/preview', component: PreviewPage }, { path: '/ocr', component: { template: '<p>校对返回位置</p>' } }] })
  await router.push({ path: '/preview', query: { file, back } })
  await router.isReady()
  vi.stubGlobal('useRoute', useRoute)
  vi.stubGlobal('useRouter', useRouter)
  vi.stubGlobal('useRequestURL', () => new URL('http://localhost'))
  vi.stubGlobal('useHead', () => {})
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('# 来源正文')))
  const wrapper = mount(PreviewPage, { attachTo: document.body, global: { plugins: [router], components: { PageHeader, NuxtLink: RouterLink } } })
  await flushPromises()
  expect(wrapper.get('header h1').text()).toBe('notice.md')
  expect(wrapper.get('[role="toolbar"]').text()).not.toContain('notice.md')
  expect(wrapper.find('header a[download]').exists()).toBe(false)
  expect(wrapper.text()).toContain('来源正文')
  if (file.includes('/')) expect(wrapper.get('header').text()).toContain(file)
  else expect(wrapper.get('header').text().split('notice.md')).toHaveLength(2)
  const returnLink = wrapper.findAll('a').find(a => a.text() === '返回OCR 工作台')!
  expect(returnLink.attributes('href')).toBe(back)
  await returnLink.trigger('click')
  await flushPromises()
  expect(router.currentRoute.value.fullPath).toBe(back)
  wrapper.unmount()
})
