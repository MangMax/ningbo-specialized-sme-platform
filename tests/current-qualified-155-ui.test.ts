// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, expect, it, vi } from 'vitest'
import { createPinia } from 'pinia'
import { PiniaColada } from '@pinia/colada'
import { createMemoryHistory, createRouter, RouterLink } from 'vue-router'
import Page from '../pages/current-enterprises.vue'

const mounted: ReturnType<typeof mount>[] = []
afterEach(() => { mounted.splice(0).forEach(wrapper => wrapper.unmount()); vi.unstubAllGlobals() })

const row = {
  enterpriseId: 21, name: '宁波现名企业', uscc: '913302000000000021', district: '鄞州区',
  aliases: ['旧名企业'], publishedNames: ['宁波现名企业'], firstYear: 2019,
  recognition: { precision: 'year', year: 2024 }, validYears: [2027], maintenanceFacts: [{ year: 2023, batch: 2 }],
  basis: 'event:21555@1 award 2024/6 结论年:2024', reviews: '', publication: '已见本称号宁波公布记录',
  notes: ['已确认迁入宁波；原城市：杭州'], references: ['evidence:1'], group: 'eligible',
}
async function setup(query: Record<string,string> = {}) {
  const calls: any[] = []
  vi.stubGlobal('$fetch', vi.fn(async (_url: string, init: any) => {
    calls.push(init.query)
    return { rows: [row], total: 1, uncertainTotal: 0, options: { recognitionYears: [2024], validYears: [2027], maintenanceYears: [2023,2025], maintenanceBatchesByYear: { 2023: [2], 2025: [1] } }, page: 1, pageSize: 25 }
  }))
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/current-enterprises', component: Page }, { path: '/enterprises/:id', component: { template:'<p>企业详情</p>' } }] })
  await router.push({path:'/current-enterprises',query:{titleCode:'specialized_sme',...query}})
  ;(globalThis as any).__routerBridge = {current:router}
  const wrapper = mount(Page, { global: { plugins:[createPinia(),PiniaColada,router], components:{NuxtLink:RouterLink} } })
  mounted.push(wrapper)
  await flushPromises()
  return {wrapper,router,calls}
}

it('shows the same readable qualification and source link in desktop and mobile rows without parsing raw basis', async () => {
  const {wrapper}=await setup()
  expect(wrapper.get('[data-testid="current-enterprise-card"]').text()).toContain('当前认定 2024 年（年份精度） · 已见宁波公布记录')
  expect(wrapper.get('[data-testid="current-enterprise-card"]').text()).toContain('有效年份 2027 年 · 维护 2023 年第 2 批')
  expect(wrapper.get('[data-testid="current-enterprise-card"] a').attributes('href')).toContain('/enterprises/21')
  expect(wrapper.text()).not.toContain('event:21555')
  expect(wrapper.text()).not.toContain('公布名：宁波现名企业')
  expect(wrapper.text()).toContain('已确认迁入宁波')
  expect(wrapper.findAll('table tbody tr').some(item => item.text().includes('当前认定 2024 年'))).toBe(true)
})

it('applies a complete recognition range to the URL, removes its chip, and resets dependent filters', async () => {
  const {wrapper,router,calls}=await setup({validYear:'2027',maintenanceYear:'2023',maintenanceBatch:'2'})
  await wrapper.get('#recognition-from').setValue('2024-01-01')
  await wrapper.get('#recognition-to').setValue('2024-12-31')
  const apply=wrapper.findAll('button').find(button => button.text()==='应用时间')!
  await apply.trigger('click'); await flushPromises()
  expect(router.currentRoute.value.query).toMatchObject({recognitionFrom:'2024-01-01',recognitionTo:'2024-12-31',validYear:'2027',maintenanceYear:'2023',maintenanceBatch:'2'})
  expect(calls.at(-1)).toMatchObject({recognitionFrom:'2024-01-01',recognitionTo:'2024-12-31',validYear:'2027',maintenanceYear:'2023',maintenanceBatch:'2'})
  const chip=wrapper.findAll('button').find(button => button.text().includes('认定时间：'))!
  await chip.trigger('click'); await flushPromises()
  expect(router.currentRoute.value.query.recognitionFrom).toBeUndefined()
  const reset=wrapper.findAll('button').find(button => button.text()==='清除筛选')!
  await reset.trigger('click'); await flushPromises()
  expect(router.currentRoute.value.query).not.toHaveProperty('validYear')
  expect(router.currentRoute.value.query).not.toHaveProperty('maintenanceYear')
  expect(router.currentRoute.value.query).not.toHaveProperty('maintenanceBatch')
})
