// @vitest-environment happy-dom
import { getLocalTimeZone, today } from '@internationalized/date'
import { PiniaColada } from '@pinia/colada'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { expect, it, vi } from 'vitest'
import LeadListRegistration from '../../../layers/lead-lists/app/components/LeadListRegistration.vue'

it('keeps file search and shared pagination on one surface and selects a date with the shared calendar inside the dialog', async () => {
  const fetchFiles = vi.fn(async (_path: string, options: { query: { page: number } }) => {
    const page = options.query.page
    return { total: 11, rows: [{ id: page, displayName: `原件 ${page}.xlsx`, relPath: `走访/原件 ${page}.xlsx` }] }
  })
  vi.stubGlobal('$fetch', fetchFiles)
  const view = mount(LeadListRegistration, {
    attachTo: document.body,
    props: {
      open: true,
      catalog: { versions: [], channels: [{ code: 'research', name: '调研走访' }], listTypes: [{ code: 'lead', name: '线索名单' }] },
    },
    global: { plugins: [createPinia(), PiniaColada], stubs: { NuxtLink: true } },
  })
  try {
    await flushPromises()
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!
    expect(dialog.querySelector('[data-slot="dialog-title"]')?.textContent).toBe('新增名单')
    expect(dialog.querySelector('#lead-series-name')?.tagName).toBe('INPUT')
    expect(dialog.querySelector('#lead-series')).toBeNull()
    const search = dialog.querySelector('[aria-label="搜索原文件"]')!
    const surface = search.closest('.bg-card')!
    await vi.waitFor(() => {
      expect(surface.querySelector('[aria-label="匹配的原文件"]')?.textContent).toContain('原件 1.xlsx')
      expect(surface.querySelector('[data-slot="pagination-next"]')).not.toBeNull()
    })
    const pagination = surface.querySelector('[data-slot="pagination-content"]')!
    expect(Array.from(pagination.children, item => item.getAttribute('aria-label'))).toEqual(['上一页', '下一页'])
    surface.querySelector<HTMLButtonElement>('[data-slot="pagination-next"]')!.click()
    await vi.waitFor(() => {
      expect(surface.querySelector('[aria-label="匹配的原文件"]')?.textContent).toContain('原件 2.xlsx')
    })
    expect(fetchFiles).toHaveBeenLastCalledWith('/api/file-library', { query: { q: '', page: 2, pageSize: 10 } })

    const dateTrigger = dialog.querySelector<HTMLButtonElement>('#lead-date')!
    expect(dateTrigger.dataset.slot).toBe('popover-trigger')
    expect(dateTrigger.dataset.variant).toBe('outline')
    expect(dialog.querySelector('input[type="date"]')).toBeNull()
    dateTrigger.click()
    await flushPromises()
    const date = today(getLocalTimeZone()).toString()
    const day = document.querySelector<HTMLButtonElement>(`[data-value="${date}"]`)
    expect(day).not.toBeNull()
    day!.click()
    await flushPromises()
    expect(dateTrigger.textContent).toContain(date)
    expect(dialog.isConnected).toBe(true)
  } finally {
    view.unmount()
    vi.unstubAllGlobals()
  }
})

it('offers each existing series once and reveals the name field only for a new series', async () => {
  const version = {
    id: 1, series: '年度走访', channel: 'research', listType: 'lead', acquiredOn: '2026-11-19',
    fileId: 1, fileName: '名单.xlsx', filePath: '名单.xlsx', fileAvailable: true,
  }
  vi.stubGlobal('$fetch', vi.fn().mockResolvedValue({ rows: [], total: 0 }))
  const view = mount(LeadListRegistration, {
    attachTo: document.body,
    props: {
      open: true,
      catalog: { versions: [version, { ...version, id: 2 }, { ...version, id: 3, series: '专项调研' }], channels: [], listTypes: [] },
    },
    global: { plugins: [createPinia(), PiniaColada], stubs: { NuxtLink: true } },
  })
  try {
    await flushPromises()
    const trigger = document.querySelector<HTMLButtonElement>('#lead-series')!
    async function openSeries() {
      trigger.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))
      await flushPromises()
      return [...document.querySelectorAll<HTMLElement>('[data-slot="select-content"] [role="option"]')]
    }
    async function select(option: HTMLElement) {
      option.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      await flushPromises()
    }
    expect(document.querySelector('#lead-series-name')).toBeNull()
    const options = await openSeries()
    expect(options.map(option => option.textContent?.trim())).toEqual(['年度走访', '专项调研', '新建系列'])
    await select(options[0]!)
    expect(trigger.textContent?.trim()).toBe('年度走访')
    expect(document.querySelector('#lead-series-name')).toBeNull()
    const beforeNew = await openSeries()
    await select(beforeNew[2]!)
    expect(document.querySelector('label[for="lead-series-name"]')?.textContent?.trim()).toBe('新系列名称')
    expect(document.querySelector('#lead-series-name')?.tagName).toBe('INPUT')
  } finally {
    view.unmount()
    vi.unstubAllGlobals()
  }
})
