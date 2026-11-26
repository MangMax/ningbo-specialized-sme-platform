// @vitest-environment jsdom
import { DOMWrapper, flushPromises, mount } from '@vue/test-utils'
import { PiniaColada } from '@pinia/colada'
import { createPinia } from 'pinia'
import { afterEach, expect, it, vi } from 'vitest'
import Page from '../../../layers/sme-roster/app/pages/sme-roster/announcement-intakes.vue'

const endpoint = '/api/roster/import/intake'
const digest = 'a'.repeat(64)
const planHash = 'b'.repeat(64)
const records = [
  { enterprise: { name: '同一企业' }, titleCode: 'specialized_sme',
    events: [{ eventType: 'award', year: 2025, batchSeq: 2, evidence: [{ sourceFile: '合成.pdf', page: 3 }] }] },
  { enterprise: { name: '同一  企业' }, titleCode: 'little_giant' },
]
afterEach(() => vi.unstubAllGlobals())

async function render(writeEnabled: boolean, announcementRows = records) {
  let supplemented = false
  let preflights = 0
  let commits = 0
  const fetch = vi.fn(async (url: string, options?: { body?: Record<string, unknown> }): Promise<unknown> => {
    if (url === endpoint + '/browser') return [
      { id: 1, status: supplemented ? 'supplemented' : 'staged', sourceName: '合成公告', sourceIdentity: '合成.pdf', rowCount: announcementRows.length },
      { id: 2, status: 'removed', sourceName: '已撤公告', sourceIdentity: '撤下.pdf', rowCount: 1 },
    ]
    if (url === endpoint + '/1/browser') return {
      intakeId: 1, status: 'staged', sourceDigest: digest, officialEvidencePreflightRequired: true,
      announcement: { sourceDocument: { title: '合成公告' }, records: announcementRows },
    }
    if (url === '/api/roster/browser-context') return { writeEnabled }
    if (url.startsWith('/api/core/dictionaries/')) return []
    if (url === '/api/core/enterprises/match-candidates') {
      const rows = options?.body?.rows as { key: string }[]
      if (rows.length > 200) throw new Error('Candidate request exceeds 200 rows')
      return { rows: rows.map(({ key }) => ({ key, status: 'unmatched', candidates: [] })) }
    }
    if (url === endpoint + '/1/browser-supplement') {
      if (options?.body?.preflight) {
        if (++preflights === 1) return { status: 'preflighted', conflicts: [{ ref: 'record:0', error: { message: '合成出处冲突' } }] }
        return { status: 'preflighted', officialEvidencePlanHash: planHash, conflicts: [] }
      }
      if (++commits === 1) throw { data: { message: '合成网络异常' } }
      supplemented = true
      return { status: 'supplemented', owners: [10, 10] }
    }
    throw new Error('Unexpected request ' + url)
  })
  vi.stubGlobal('$fetch', fetch)
  vi.stubGlobal('useHead', () => {})
  const view = mount(Page, { attachTo: document.body, global: {
    plugins: [createPinia(), PiniaColada], stubs: { NuxtLink: true },
  } })
  await flushPromises()
  const page = new DOMWrapper(document.body)
  const button = (label: string) => {
    const control = page.findAll('button').find(item => item.text() === label)
    if (!control) throw new Error('Missing button ' + label)
    return control
  }
  return { view, page, fetch, button }
}

it('shows original evidence in the shared drawer and retries without losing review inputs', async () => {
  const { view, page, fetch, button } = await render(true)
  try {
    expect(page.text()).not.toContain('已撤公告')
    await button('核对名单').trigger('click')
    await flushPromises()
    expect(page.text()).toContain('2025 年 · 第 2 批 · 合成.pdf 第 3 页')
    expect(page.findAll('article h3').map(heading => heading.text())).toEqual(['同一企业', '同一  企业'])
    expect(button('执行预检').attributes('disabled')).toBeDefined()
    const basis = page.get('textarea')
    await basis.setValue('核对原件')
    await button('执行预检').trigger('click')
    await flushPromises()
    expect(page.text()).toContain('合成出处冲突')
    expect(button('确认提交入库').attributes('disabled')).toBeDefined()
    await button('重试预检').trigger('click')
    await flushPromises()
    expect(page.text()).toContain(planHash)
    expect(button('确认提交入库').attributes('disabled')).toBeUndefined()

    await basis.setValue('复核原件')
    expect(page.text()).not.toContain(planHash)
    expect(button('确认提交入库').attributes('disabled')).toBeDefined()
    await button('执行预检').trigger('click')
    await flushPromises()
    await button('编辑资料').trigger('click')
    const name = page.get('article input[maxlength="300"]')
    await name.setValue('同一企业新名')
    await flushPromises()
    expect(page.text()).not.toContain(planHash)
    expect(button('确认提交入库').attributes('disabled')).toBeDefined()
    await name.setValue('同一企业')
    await button('执行预检').trigger('click')
    await flushPromises()
    await button('确认提交入库').trigger('click')
    await flushPromises()
    expect(page.text()).toContain('合成网络异常')
    expect((basis.element as HTMLTextAreaElement).value).toBe('复核原件')
    await button('重试提交入库').trigger('click')
    await flushPromises()

    const bodies = fetch.mock.calls.filter(([url]) => url.endsWith('/browser-supplement')).map(([, options]) => options?.body)
    expect(bodies.slice(-2)).toEqual(Array(2).fill({
      sourceDigest: digest, basis: '复核原件', officialEvidencePlanHash: planHash,
      rows: [{ action: 'create', fields: expect.objectContaining({ name: '同一企业' }) }, { action: 'same_subject', row: 0 }],
    }))
    expect(page.text()).toContain('已提交入库，共关联 1 家企业。')
    expect(page.text()).toContain('已入库')
    expect(page.find('textarea').exists()).toBe(false)
  } finally {
    view.unmount()
  }
})

it('shows original rows in read-only mode with both write steps disabled', async () => {
  const { view, page, fetch, button } = await render(false)
  try {
    await button('核对名单').trigger('click')
    await flushPromises()
    expect(page.text()).toContain('当前为只读模式')
    expect(page.text()).toContain('同一企业')
    expect(page.get('textarea').attributes('disabled')).toBeDefined()
    expect(button('执行预检').attributes('disabled')).toBeDefined()
    expect(button('确认提交入库').attributes('disabled')).toBeDefined()
    expect(fetch.mock.calls.some(([url]) => url.endsWith('/browser-supplement'))).toBe(false)
  } finally {
    view.unmount()
  }
})


it('matches more than 200 rows without dropping or reordering the final row', async () => {
  const rows = Array.from({ length: 201 }, (_, index) => ({
    enterprise: { name: '合成企业 ' + (index + 1) }, titleCode: 'specialized_sme',
  }))
  const { view, page, button } = await render(true, rows)
  try {
    await button('核对名单').trigger('click')
    await flushPromises()
    expect(page.findAll('article h3').map(heading => heading.text())).toEqual(rows.map(row => row.enterprise.name))
    await page.get('textarea').setValue('核对全部名单行')
    expect(button('执行预检').attributes('disabled')).toBeUndefined()
  } finally {
    view.unmount()
  }
})
