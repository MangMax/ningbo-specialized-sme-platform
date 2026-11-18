// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import { createMemoryHistory, createRouter, RouterLink, useRoute } from 'vue-router'
import AppSidebar from '../../../layers/core/app/components/AppSidebar.vue'
import { SidebarProvider } from '../../../layers/core/app/components/ui/sidebar'

afterEach(() => vi.unstubAllGlobals())

it('shows ordered business and platform menus and follows the current route', async () => {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/:pathMatch(.*)*', component: { render: () => null } }],
  })
  await router.push('/platform-business-processes')
  vi.stubGlobal('useRoute', useRoute)
  vi.stubGlobal('useAppColorMode', () => 'light')
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener() {},
    removeEventListener() {},
  }))

  const sidebar = mount(defineComponent({
    setup: () => () => h(SidebarProvider, null, () => h(AppSidebar)),
  }), {
    global: { plugins: [router], components: { NuxtLink: RouterLink } },
  })

  try {
    const business = sidebar.get('[aria-label="业务模块"]')
    const platform = sidebar.get('[aria-label="平台管理"]')
    expect(business.text()).toContain('业务模块')
    expect(platform.text()).toContain('平台管理')
    expect(sidebar.get('a[aria-label="返回平台工作台"]').attributes('href')).toBe('/')
    expect(business.get('button').text()).toBe('工信部查询')
    expect(business.findAll('a').map(link => [link.text(), link.attributes('href')])).toEqual([
      ['企业列表', '/roster'],
      ['优质中小企业查询', '/current-enterprises'],
      ['申报记录', '/platform-declarations'],
      ['关联办理', '/platform-business-processes'],
      ['平台认定目录', '/platform-recognized-directory'],
      ['统计', '/stats'],
      ['数据质量', '/quality'],
    ])
    expect(platform.findAll('a').map(link => [link.text(), link.attributes('href')])).toEqual([
      ['文件管理', '/files'],
      ['识别校对', '/ocr'],
      ['后台任务', '/tasks'],
      ['运行日志', '/logs'],
      ['密钥配置', '/settings'],
    ])
    expect(business.get('a[aria-current="page"]').text()).toBe('关联办理')

    await platform.get('a[href="/logs"]').trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.path).toBe('/logs')
    expect(platform.get('a[aria-current="page"]').text()).toBe('运行日志')
    expect(business.find('a[aria-current="page"]').exists()).toBe(false)
  } finally {
    sidebar.unmount()
  }
})
