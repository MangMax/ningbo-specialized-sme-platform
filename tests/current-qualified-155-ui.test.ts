// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, expect, it, vi } from 'vitest'
import { createPinia } from 'pinia'
import { PiniaColada } from '@pinia/colada'
import { createMemoryHistory, createRouter, RouterLink } from 'vue-router'
import Page from '../pages/current-enterprises.vue'
import { Select } from '../components/ui/select'
import { Calendar } from '../components/ui/calendar'
import { CalendarDate } from '@internationalized/date'
import CurrentRecognitionDatePicker from '../components/CurrentRecognitionDatePicker.vue'

const mounted: ReturnType<typeof mount>[] = []
afterEach(() => { mounted.splice(0).forEach(wrapper => wrapper.unmount()); vi.unstubAllGlobals(); vi.restoreAllMocks() })

const row = {
  enterpriseId: 21, name: '宁波现名企业', uscc: '913302000000000021', district: '鄞州区',
  aliases: ['旧名企业'], publishedNames: ['宁波现名企业'], firstYear: 2019,
  recognition: { precision: 'year', year: 2024 }, matchedValidYears: [2027], matchedMaintenance: [{ year: 2023, batch: 2 }],
  basis: 'event:21555@1 award 2024/6 结论年:2024', reviews: '', publication: '已见本称号宁波公布记录',
  notes: ['已确认迁入宁波；原城市：杭州'], references: ['evidence:1'], group: 'eligible',
}
async function setup(query: Record<string,string> = {}, failOn?: (query: Record<string,string>) => boolean, narrow = false, metadata = true) {
  vi.spyOn(window, 'matchMedia').mockImplementation(query => ({
    matches: narrow && query === '(max-width: 639px)', media: query, onchange: null,
    addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
  } as MediaQueryList))
  const calls: any[] = []
  vi.stubGlobal('$fetch', vi.fn(async (_url: string, init: any) => {
    if (_url === '/api/roster/exports/current/capabilities') return { exports: [] }
    if (_url === '/api/task-center') return { authorized: false }
    calls.push(init.query)
    if (failOn?.(init.query)) throw new Error('synthetic target failure')
    return { rows: [metadata ? row : { ...row, matchedValidYears: [], matchedMaintenance: [] }], total: 1, uncertainTotal: 0, options: { recognitionYears: [2024], validYears: [2027], maintenanceYears: [2023,2025], maintenanceBatchesByYear: { 2023: [2], 2025: [1] } }, page: 1, pageSize: 25 }
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
  expect(wrapper.get('[data-testid="current-enterprise-card"]').text()).toContain('认定记录 2024 年（仅年份） · 已见宁波公布记录')
  expect(wrapper.get('[data-testid="current-enterprise-card"]').text()).toContain('有效年份 2027 年 · 维护记录 2023 年第 2 批')
  expect(wrapper.get('[data-testid="current-enterprise-card"] a').attributes('href')).toContain('/enterprises/21')
  expect(wrapper.text()).not.toContain('event:21555')
  expect(wrapper.text()).not.toContain('公布名：宁波现名企业')
  expect(wrapper.text()).toContain('已确认迁入宁波')
  expect(wrapper.findAll('table tbody tr').some(item => item.text().includes('认定记录 2024 年'))).toBe(true)
})

it.each([false, true])('retains new-filter source identity and detail return params after the target fails (narrow: %s)', async narrow => {
  const source = {recognitionFrom:'2024-01-01',recognitionTo:'2024-12-31',validYear:'2027',maintenanceYear:'2023',maintenanceBatch:'2',page:'2',pageSize:'1'}
  const {wrapper,router}=await setup(source, query => query.validYear === '2028', narrow)
  await router.replace({path:'/current-enterprises',query:{titleCode:'specialized_sme',recognitionFrom:'2023-01-01',recognitionTo:'2023-12-31',validYear:'2028',maintenanceYear:'2025',maintenanceBatch:'1'}})
  await flushPromises()
  expect(wrapper.text()).toContain('当前显示：专精特新中小企业；认定时间：2024-01-01 至 2024-12-31；有效年份：2027；维护年份：2023 第 2 批')
  expect(wrapper.text()).toContain('请求目标：专精特新中小企业；认定时间：2023-01-01 至 2023-12-31；有效年份：2028；维护年份：2025 第 1 批')
  const href=wrapper.get('[data-testid="current-enterprise-card"] a').attributes('href')!
  const back=new URL(href,'http://localhost').searchParams.get('currentBack')!
  expect(Object.fromEntries(new URLSearchParams(back))).toMatchObject({titleCode:'specialized_sme',...source,sort:'id_asc'})
})

it('applies a complete recognition range to the URL, removes its chip, and resets dependent filters', async () => {
  const {wrapper,router,calls}=await setup({validYear:'2027',maintenanceYear:'2023',maintenanceBatch:'2'})
  expect(wrapper.find('input[type="date"]').exists()).toBe(false)
  const pickers=wrapper.findAllComponents(CurrentRecognitionDatePicker)
  expect(pickers).toHaveLength(2)
  pickers[0]!.vm.$emit('update:modelValue','2024-01-01')
  pickers[1]!.vm.$emit('update:modelValue','2024-12-31')
  await flushPromises()
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

it('selects a date through the shared calendar popover and emits a date-only value', async () => {
  const wrapper=mount(CurrentRecognitionDatePicker,{props:{id:'pick-date',label:'认定时间起',modelValue:''}})
  mounted.push(wrapper)
  expect(wrapper.find('input[type="date"]').exists()).toBe(false)
  await wrapper.get('#pick-date').trigger('click')
  await flushPromises()
  const calendar=wrapper.findComponent(Calendar)
  expect(calendar.exists()).toBe(true)
  calendar.vm.$emit('update:modelValue',new CalendarDate(2024,2,29))
  expect(wrapper.emitted('update:modelValue')?.[0]).toEqual(['2024-02-29'])
})

it('clears the dependent batch when the existing maintenance-year select changes', async () => {
  const {wrapper,router}=await setup({maintenanceYear:'2023',maintenanceBatch:'2'})
  wrapper.findAllComponents(Select)[2]!.vm.$emit('update:modelValue','2025')
  await flushPromises()
  expect(router.currentRoute.value.query).toMatchObject({maintenanceYear:'2025'})
  expect(router.currentRoute.value.query.maintenanceBatch).toBeUndefined()
})

it('keeps current eligibility distinct from unverified validity and maintenance metadata', async () => {
  const { wrapper } = await setup({}, undefined, false, false)
  expect(wrapper.text()).toContain('按本库资格判定查询当前有效企业')
  expect(wrapper.get('[data-testid="current-enterprise-card"]').text()).toContain('有效年份未核实 · 维护信息未核实')
  expect(wrapper.text()).not.toContain('返回字段')
  expect(wrapper.text()).not.toContain('有效性：未证实')
})

it('discloses mobile filters, applies date and option URLs, keeps chips on collapse and restores route before reset', async () => {
  const { wrapper, router, calls } = await setup({}, undefined, true)
  const advanced = () => wrapper.findAll('button').find(button => button.text().startsWith('高级筛选与排序'))!
  expect(advanced().attributes('aria-expanded')).toBe('false')
  expect(advanced().text()).toContain('已选 0 项')
  expect(wrapper.find('[aria-label="按有效年份筛选"]').exists()).toBe(false)
  expect(wrapper.findAllComponents(CurrentRecognitionDatePicker)).toHaveLength(0)
  expect(wrapper.find('input[placeholder="名称、曾用名或信用代码"]').exists()).toBe(true)
  expect(wrapper.text()).toContain('未设筛选')
  expect(wrapper.text()).toContain('排序：稳定企业标识')
  await advanced().trigger('click'); await flushPromises()
  expect(advanced().attributes('aria-expanded')).toBe('true')
  expect(wrapper.findAll('[aria-label^="按"]').length).toBe(4)
  expect(wrapper.get('[aria-label="排序方式"]').text()).toBe('排序：稳定企业标识')
  wrapper.findAllComponents(Select)[1]!.vm.$emit('update:modelValue', '2027')
  await flushPromises()
  wrapper.findAllComponents(Select)[2]!.vm.$emit('update:modelValue', '2023')
  await flushPromises()
  wrapper.findAllComponents(Select)[3]!.vm.$emit('update:modelValue', '2')
  await flushPromises()
  wrapper.findAllComponents(Select)[4]!.vm.$emit('update:modelValue', 'name_asc')
  const pickers = wrapper.findAllComponents(CurrentRecognitionDatePicker)
  pickers[0]!.vm.$emit('update:modelValue', '2024-01-01')
  pickers[1]!.vm.$emit('update:modelValue', '2024-12-31')
  await flushPromises()
  await wrapper.findAll('button').find(button => button.text() === '应用时间')!.trigger('click')
  await flushPromises()
  const selected = { ...router.currentRoute.value.query }
  expect(selected).toMatchObject({ validYear: '2027', maintenanceYear: '2023', maintenanceBatch: '2', sort: 'name_asc', recognitionFrom: '2024-01-01', recognitionTo: '2024-12-31' })
  expect(calls.at(-1)).toMatchObject(selected)
  await advanced().trigger('click'); await flushPromises()
  expect(advanced().attributes('aria-expanded')).toBe('false')
  expect(advanced().text()).toContain('已选 4 项')
  const chips = () => wrapper.get('[aria-label="已选筛选条件"]')
  expect(chips().text()).toContain('有效年份：2027')
  expect(chips().text()).toContain('维护批次：第 2 批')
  expect(wrapper.text()).toContain('排序：企业名称升序')
  await chips().findAll('button').find(button => button.text().includes('有效年份：'))!.trigger('click')
  await flushPromises()
  expect(router.currentRoute.value.query.validYear).toBeUndefined()
  await router.push({ path: '/current-enterprises', query: selected }); await flushPromises()
  expect(chips().text()).toContain('有效年份：2027')
  expect(advanced().attributes('aria-expanded')).toBe('false')
  await advanced().trigger('click'); await flushPromises()
  expect(wrapper.findAllComponents(Select)[1]!.props('modelValue')).toBe('2027')
  expect(wrapper.findAllComponents(CurrentRecognitionDatePicker)[0]!.props('modelValue')).toBe('2024-01-01')
  await wrapper.findAll('button').find(button => button.text() === '清除筛选')!.trigger('click')
  await flushPromises()
  expect(router.currentRoute.value.query).toEqual({ titleCode: 'specialized_sme', sort: 'name_asc' })
  expect(wrapper.find('[aria-label="已选筛选条件"]').exists()).toBe(false)
  expect(advanced().text()).toContain('已选 0 项')
})
