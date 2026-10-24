// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils'
import { ref } from 'vue'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import SourceReader from '../components/record-correspondence/SourceReader.vue'
import SourceRowDetail from '../components/record-correspondence/SourceRowDetail.vue'
import { platformPresentationFields } from '../lib/roster/platform-records'
import type { RelationSource } from '../lib/roster/correspondence-view'

const query = { id: 20, interface: 'business_list', queryKey: 'PRIVATE-QUERY', rdjb: '2', titleCode: 'specialized_sme', queriedAt: '2026-10-18T06:52:23.017Z', status: 'success', failureReason: null, relationCount: 1, collectionEvidence: null }
const relation: RelationSource = { id: 30, queryId: 20, sequenceNo: 4, relationKey: 'INTERNAL-KEY', enterpriseId: 42, usccRaw: '913300000000000004', nameRaw: '企业原名', province: null, status: null, batch: null, declareKind: null, appliedAt: null, awardBatchLabel: null, year: null, sourceRdjb: '2', sourcePage: 3, rawFields: { id: 'RAW-ID', qymc: '企业原名', cszt: '终审通过', sqsj: '2026-05-08 10:32:24', whpc: '2026-1', rdtime: '2026-05-25 19:20:54', zsrxm: '未核姓名', cz: '未核操作', rdsj: '', rdrq: null, nested: { retained: [false, 0, null] } }, query, correspondences: [] }
const mounted: ReturnType<typeof mount>[] = []
const stubs = { NuxtLink: { props: ['to'], template: '<a><slot /></a>' } }
function renderRow(value = relation) {
  const wrapper = mount(SourceRowDetail, { props: { relation: value, presentation: 'business' }, global: { stubs } })
  mounted.push(wrapper)
  return wrapper
}
async function open(wrapper: ReturnType<typeof mount>, title: string) {
  await wrapper.findAll('button').find(button => button.text() === title)!.trigger('click')
  await flushPromises()
}
beforeEach(() => vi.stubGlobal('useState', () => ref(false)))
afterEach(() => { mounted.splice(0).forEach(wrapper => wrapper.unmount()); vi.unstubAllGlobals() })

it('selects only verified nonempty business fields without mutating raw and retains false and zero', () => {
  const raw = { ...relation.rawFields, sfty: false, zyzb: 0, qylx: '   ', rddqrq: '', unknown: 'unknown' }
  const before = JSON.stringify(raw)
  const fields = platformPresentationFields(raw)
  expect(fields.map(field => [field.key, field.value])).toEqual([
    ['qymc', '企业原名'], ['sqsj', '2026-05-08 10:32:24'], ['cszt', '终审通过'], ['whpc', '2026-1'], ['sfty', 'false'], ['zyzb', '0'],
  ])
  expect(JSON.stringify(raw)).toBe(before)
})

it.each(['business_list', 'apply_list', 'recognized_list'])('shows Chinese business facts from the selected %s observation and folds technical and complete raw data', async (source) => {
  const recognized = source === 'recognized_list'
  const value = { ...relation, query: { ...query, interface: source }, rawFields: { ...relation.rawFields, ...(recognized ? { sqsj: '', cszt: '', rddqrq: '2029-05-25', szqmc: '高新区', szsmc: '宁波市', sshy: '34 通用设备制造业', zdcpmc: '工业机器人及其专用机械'.repeat(8) } : {}) } }
  const wrapper = renderRow(value)
  const main = wrapper.get('[data-testid="platform-business-facts"]')
  expect(main.text()).toContain('企业原名')
  expect(main.text()).toContain('维护批次')
  expect(main.text()).toContain('2026-1')
  expect(wrapper.text()).toContain('平台办理人：未记录或尚未核实')
  expect(wrapper.text()).toContain('采集时间')
  expect(main.text()).not.toContain(query.queriedAt)
  expect(wrapper.text()).not.toMatch(/RAW-ID|INTERNAL-KEY|PRIVATE-QUERY|查询 #|原行 4|rdtime|zsrxm|认定时间|认定日期/)
  expect(main.text()).not.toMatch(/qymc|whpc|sqsj|cszt/)
  if (recognized) {
    expect(main.text()).toContain('2029-05-25')
    expect(main.text()).toContain('高新区')
    expect(main.text()).toContain('宁波市')
    expect(main.text()).not.toMatch(/申报时间|办理状态|2026-05-08/)
  } else expect(main.text()).toContain('2026-05-08 10:32:24')
  await open(wrapper, '技术出处与完整原文')
  expect(wrapper.text()).toContain('查询 #20')
  expect(JSON.parse(wrapper.get('[data-testid="platform-complete-raw"]').text())).toEqual(value.rawFields)
})

it('shows only reliable original recognition dates and keeps empty or missing fields distinct in raw', async () => {
  const wrapper = renderRow({ ...relation, rawFields: { rdsj: '2024-05-01 10:11:12', rdrq: '2024-05-01', rddqrq: '2027', zyzb: 0, sfty: false, sqsj: '', cszt: null } })
  const main = wrapper.get('[data-testid="platform-business-facts"]')
  for (const text of ['平台认定时间（原值）', '平台认定日期（原值）', '有效期（原值）', '2027', 'false', '0']) expect(main.text()).toContain(text)
  expect(main.text()).not.toMatch(/申报时间|办理状态/)
  await open(wrapper, '技术出处与完整原文')
  const raw = JSON.parse(wrapper.get('[data-testid="platform-complete-raw"]').text())
  expect(raw.sqsj).toBe(''); expect(raw.cszt).toBeNull(); expect(raw).not.toHaveProperty('rdtime')
})

it('keeps missing and hundreds of empty fields out of the business view while preserving complete raw', async () => {
  const raw = { ...Object.fromEntries(Array.from({ length: 300 }, (_, index) => [`unknown${index}`, ''])), sqsj: '', rddqrq: null }
  const wrapper = renderRow({ ...relation, rawFields: raw })
  expect(wrapper.get('[data-testid="platform-business-facts"]').findAll('dt')).toHaveLength(3)
  expect(wrapper.text()).toContain('未提供已核实的业务字段')
  expect(wrapper.text()).not.toMatch(/unknown0|有效期|认定时间|申报时间/)
  await open(wrapper, '技术出处与完整原文')
  expect(JSON.parse(wrapper.get('[data-testid="platform-complete-raw"]').text())).toEqual(raw)
})

it('keeps this observations correspondence read only and removes its decision when the next observation has none', async () => {
  const event = { id: 9, recordId: 2, eventType: 'award', year: 2022, decidedYear: 2022, reviewOutcome: null, record: { id: 2, enterpriseId: 42, titleCode: 'specialized_sme' }, evidence: [], correspondences: [] }
  const edge = { id: 1, type: 'event_process', role: 'supports_award', status: 'confirmed', revision: 1, requiresRevalidation: false, eventId: 9, predecessorEventId: null, relationId: 30, exportRowId: null, enterpriseId: 42, titleCode: 'specialized_sme', event, predecessorEvent: null, relation, exportRow: null }
  const fetch = vi.fn().mockResolvedValueOnce({ source: relation, correspondences: [edge] })
    .mockResolvedValueOnce({ source: { ...relation, id: 31, query: { ...query, interface: 'apply_list' }, rawFields: { qymc: '下一观察' } }, correspondences: [] })
  vi.stubGlobal('$fetch', fetch)
  const wrapper = mount(SourceReader, { props: { kind: 'relation', id: 30, presentation: 'business' }, global: { stubs } })
  mounted.push(wrapper)
  await flushPromises()
  expect(wrapper.text()).not.toContain('已确认')
  await open(wrapper, '相关认定与复核记录（只读）')
  expect(wrapper.text()).toContain('已确认')
  expect(wrapper.find('a').exists()).toBe(true)
  expect(wrapper.find('[data-testid="event-correspondence-decision"]').exists()).toBe(false)
  await wrapper.setProps({ id: 31 }); await flushPromises()
  await open(wrapper, '相关认定与复核记录（只读）')
  expect(wrapper.text()).toContain('尚无登记的对应关系')
  expect(wrapper.text()).not.toMatch(/已确认|终审通过/)
  expect(fetch).toHaveBeenCalledTimes(2)
})

it('marks retained content as the old source during switching and failure, retries, and isolates late responses without merging observations', async () => {
  let finishSlow!: (value: unknown) => void
  const fetch = vi.fn().mockResolvedValueOnce({ source: relation, correspondences: [] })
    .mockImplementationOnce(() => new Promise(resolve => { finishSlow = resolve }))
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValueOnce({ source: { ...relation, id: 32, query: { ...query, interface: 'recognized_list' }, rawFields: { qymc: '新观察企业', rddqrq: '2029-05-25' } }, correspondences: [] })
  vi.stubGlobal('$fetch', fetch)
  const wrapper = mount(SourceReader, { props: { kind: 'relation', id: 30, presentation: 'business' }, global: { stubs } })
  mounted.push(wrapper)
  await flushPromises()
  expect(fetch).toHaveBeenCalledTimes(1)
  await wrapper.setProps({ id: 31 }); await flushPromises()
  expect(wrapper.get('[data-testid="retained-business-source"]').text()).toContain('旧来源（非当前业务）')
  await wrapper.setProps({ id: 32 }); await flushPromises()
  expect(wrapper.text()).toContain('未能读取')
  expect(wrapper.get('[data-testid="retained-business-source"]').text()).toContain('企业原名')
  await wrapper.findAll('button').find(button => button.text() === '重试读取')!.trigger('click'); await flushPromises()
  finishSlow({ source: { ...relation, rawFields: { qymc: '过时请求企业' } }, correspondences: [] }); await flushPromises()
  expect(fetch.mock.calls.map(call => call[0])).toEqual([30, 31, 32, 32].map(id => `/api/roster/correspondences/relations/${id}`))
  expect(wrapper.text()).toContain('新观察企业')
  expect(wrapper.text()).not.toMatch(/旧来源|过时请求企业|终审通过|2026-05-08/)
  expect(wrapper.find('[data-testid="event-correspondence-decision"]').exists()).toBe(false)
})


it('maps known designation code two without repeating the identical source designation or showing its code', async () => {
  const wrapper = renderRow({ ...relation, rawFields: { qymc: '企业原名', rdjb: '2' } })
  const facts = wrapper.get('[data-testid="platform-business-facts"]')
  expect(facts.text().match(/专精特新中小企业/g)).toHaveLength(1)
  expect(facts.text()).not.toContain('平台称号原值')
  expect(facts.findAll('dd').map(node => node.text())).not.toContain('2')
  await open(wrapper, '技术出处与完整原文')
  expect(JSON.parse(wrapper.get('[data-testid="platform-complete-raw"]').text()).rdjb).toBe('2')
})

it('keeps an unknown designation code only in complete technical raw without guessing its meaning', async () => {
  const wrapper = renderRow({ ...relation, sourceRdjb: 'X99', query: { ...query, rdjb: 'X99' }, rawFields: { rdjb: 'X99' } })
  expect(wrapper.get('[data-testid="platform-business-facts"]').text()).toContain('未标注')
  expect(wrapper.text()).not.toContain('X99')
  await open(wrapper, '技术出处与完整原文')
  expect(JSON.parse(wrapper.get('[data-testid="platform-complete-raw"]').text()).rdjb).toBe('X99')
})

it('preserves different source and raw designations and the existing real field conflict', () => {
  const wrapper = renderRow({ ...relation, sourceRdjb: '2', normalizationConflicts: [{ field: 'status', storedValue: '退回', rawValue: '终审通过' }], rawFields: { rdjb: '1', cszt: '终审通过' } })
  const facts = wrapper.get('[data-testid="platform-business-facts"]').text()
  expect(facts).toContain('来源称号专精特新中小企业')
  expect(facts).toContain('平台称号创新型中小企业')
  expect(wrapper.text()).toContain('字段冲突，待核')
  expect(wrapper.text()).toContain('已存：退回 · 原档：终审通过')
})

it('keeps default source mode designation fields and original sizing unchanged', () => {
  const wrapper = mount(SourceRowDetail, { props: { relation: { ...relation, rawFields: { rdjb: '2' } } }, global: { stubs } })
  mounted.push(wrapper)
  expect(wrapper.classes()).toContain('text-[13px]')
  expect(wrapper.text()).toContain('称号原值（rdjb）2')
  expect(wrapper.text()).toContain('查询 #20')
})
