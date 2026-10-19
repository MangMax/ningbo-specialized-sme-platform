// @vitest-environment happy-dom
import { DOMWrapper, flushPromises, mount } from '@vue/test-utils'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import PlatformRecords from '../components/PlatformRecords.vue'
import { platformFailureForDisplay } from '../lib/roster/platform-records'

// Happy DOM creates unhandled WAAPI cancellation promises during teardown.
// Exercise Motion's JS fallback here; real browser acceptance checks native motion.
const nativeAnimate = Object.getOwnPropertyDescriptor(Element.prototype, 'animate')
beforeAll(() => { Reflect.deleteProperty(Element.prototype, 'animate') })
afterAll(() => { if (nativeAnimate) Object.defineProperty(Element.prototype, 'animate', nativeAnimate) })
const query = {id: 1,interface:'business_list',queryKey:'9133021274738281XA',rdjb:'2',queriedAt:'2026-10-16',status:'success',failureReason:null,relationCount:1}
const record = {id: 1,queryId:1,sequenceNo:1,relationKey:'SQ001',nameRaw:'平台原名',usccRaw:'9133021274738281XA',province:'宁波市',status:'待审核',batch:'2025-1',declareKind:'update',appliedAt:'2025-03-01',awardBatchLabel:'2022年第一批',year:2025,matchBasis:'uscc',verificationStatus:'confirmed'}
describe('面向用户的平台记录表',()=>{
 it('逐条表格展示原始企业、状态与批次，并将接口参数译成业务名称',()=>{
  const view=mount(PlatformRecords,{props:{queries:[query],relations:[record]}})
  expect(view.find('table').exists()).toBe(true)
  for(const text of ['关联记录','专精特新中小企业','平台原名','9133021274738281XA','待审核','2025-1','2025-03-01','更新']) expect(view.text()).toContain(text)
  expect(view.text()).not.toMatch(/business_list|businessList|rdjb|queryId|matchBasis/)
  view.unmount()
 })
 it.each([
  ['failed', '本次查询未完成'],
  ['no_record', '平台未返回记录'],
  ['not_queried', '尚未查询'],
 ])('查询状态 %s 保留独立空状态', (status, message)=>{
  const view=mount(PlatformRecords,{props:{queries:[{...query,status,relationCount:0}],relations:[]}})
  expect(view.get('[data-record-kind="business_list"]').text()).toContain(message)
  if(status === 'failed') expect(view.text()).not.toContain('平台未返回记录')
  view.unmount()
 })
 it('保留关联和申报两张表字段并独立显示未查询的第三来源',()=>{
  const view=mount(PlatformRecords,{props:{queries:[query,{...query,id:2,interface:'apply_list',rdjb:''}],relations:[record,{...record,id:2,queryId:2}]}})
  expect(view.findAll('table').map(table=>table.attributes('aria-label'))).toEqual(['关联记录','申报记录'])
  for(const table of view.findAll('table').slice(0,2)) {
   expect(table.findAll('thead th').map(th=>th.text())).toEqual(['序号','企业名称','信用代码','省份','申报类型','办理状态','申报时间','维护批次','出处 / 原字段'])
   expect(table.findAll('[data-testid="platform-relation"]')).toHaveLength(1)
   expect(table.findAll('tbody td').slice(1,8).map(td=>td.text())).toEqual(['平台原名','9133021274738281XA','宁波市','更新','待审核','2025-03-01','2025-1'])
  }
  expect(view.text()).not.toContain('查询企业')
  expect(view.text()).not.toMatch(/认定批次|核实状态|平台编号|匹配依据|2022年第一批|SQ001/)
  view.unmount()
 })
 it('全部Tab按称号树形分组，每组序号从1开始且不再嵌套折叠',async()=>{
  const view=mount(PlatformRecords,{props:{queries:[query,{...query,id:2,rdjb:'1'}],relations:[{...record,sequenceNo:4},{...record,id:2,sequenceNo:8},{...record,id:3,queryId:2,sequenceNo:7}]}})
  const table=view.get('table[aria-label="关联记录"]')
  expect(table.findAll('tbody[data-record-title]')).toHaveLength(2)
  expect(table.findAll('[data-testid="platform-title-group"]').map(group=>group.text())).toEqual(['创新型中小企业 1 条','专精特新中小企业 2 条'])
  expect(table.findAll('[data-testid="platform-title-group"] button')).toHaveLength(0)
  expect(table.findAll('tbody[data-record-title="2"] [data-testid="platform-relation"]').map(row=>row.find('td').text())).toEqual(['1','2'])
  expect(table.findAll('[data-testid="platform-relation"]')).toHaveLength(3)
  view.unmount()
})
it('单称号Tab不显示树分组，序号从1连续排列且不改原始查询序号',async()=>{
  const input=[{...record,sequenceNo:4},{...record,id:2,sequenceNo:9}]
  const view=mount(PlatformRecords,{props:{queries:[query],relations:input}})
  await view.findAll('[role="tab"]').find(tab=>tab.text()==='专精特新中小企业')!.trigger('keydown',{key:'Enter'})
  expect(view.findAll('[data-testid="platform-title-group"]')).toHaveLength(0)
  expect(view.findAll('[data-testid="platform-relation"]').map(row=>row.find('td').text())).toEqual(['1','2'])
  expect(input.map(record=>record.sequenceNo)).toEqual([4,9])
  view.unmount()
 })
 it('称号Tab筛选两张表，相同平台编号唯一对应时保留申报归属',async()=>{
  const view=mount(PlatformRecords,{props:{queries:[query,{...query,id:2,rdjb:'1'},{...query,id:3,interface:'apply_list',rdjb:''}],relations:[record,{...record,id:2,queryId:2,relationKey:'OTHER'},{...record,id:3,queryId:3}]}})
  await view.findAll('[role="tab"]').find(tab=>tab.text()==='专精特新中小企业')!.trigger('keydown', {key:'Enter'})
  expect(view.findAll('[data-testid="platform-relation"]').map(row=>row.attributes('data-record-id'))).toEqual(['1','3'])
  expect(view.findAll('table')).toHaveLength(2)
  await view.findAll('[role="tab"]').find(tab=>tab.text()==='创新型中小企业')!.trigger('keydown', {key:'Enter'})
  expect(view.findAll('[data-testid="platform-relation"]').map(row=>row.attributes('data-record-id'))).toEqual(['2'])
  view.unmount()
 })
 it('称号不明确的申报不猜测归属，全部Tab不丢原始行',async()=>{
  const view=mount(PlatformRecords,{props:{queries:[query,{...query,id:2,rdjb:'1'},{...query,id:3,interface:'apply_list',rdjb:''}],relations:[record,{...record,id:2,queryId:2},{...record,id:3,queryId:3},{...record,id:4,queryId:3,relationKey:'UNKNOWN'}]}})
  expect(view.findAll('[data-testid="platform-relation"]')).toHaveLength(4)
  await view.findAll('[role="tab"]').find(tab=>tab.text()==='称号未标注')!.trigger('keydown', {key:'Enter'})
  expect(view.findAll('[data-testid="platform-relation"]').map(row=>row.attributes('data-record-id'))).toEqual(['3','4'])
  view.unmount()
 })
 it('失败原因保留业务含义并隐藏开发错误细节',()=>{
  const view=mount(PlatformRecords,{props:{queries:[{...query,status:'failed',failureReason:'HTTP 401 session expired business_list rdjb=2',relationCount:0}],relations:[]}})
  expect(view.get('[data-testid="platform-query-failure"]').text()).toContain('平台登录已失效')
  expect(view.text()).not.toMatch(/HTTP|session|business_list|rdjb/)
  view.unmount()
 })
 it.each([
  ['HTTP 403 permission denied', '平台拒绝了本次查询，请检查登录状态或访问权限。'],
  ['HTTP 401 Unauthorized', '平台需要登录验证，请登录后查询。'],
  ['cookie parser error', '平台查询未完成，请稍后重试。'],
 ])('失败原因 %s 不猜测为登录过期', (raw, expected)=>{
  expect(platformFailureForDisplay(raw)).toBe(expected)
 })
 it.each(['business_list', 'recognized_list'])('每行操作保持 %s 的原行详情与反向来源身份', async (source)=>{
  const records=[{...record,id:101,aliasNameRaw:'原曾用名',rawFields:{customBusiness:'第一行原值'}},{...record,id:102,aliasNameRaw:null,rawFields:{customBusiness:'第二行原值'}}]
  const fetch=vi.fn(async()=>({source:{...records[1],query},correspondences:[]}))
  vi.stubGlobal('$fetch',fetch)
  const view=mount(PlatformRecords,{attachTo:document.body,props:{queries:[{...query,interface:source}],relations:records}})
  try {
   const table=view.get('table')
   const rows=table.findAll('[data-testid="platform-relation"]')
   expect(rows).toHaveLength(2)
   expect(table.get('thead').text()).toContain('曾用名')
   expect(rows[0]!.text()).toContain('原曾用名')
   for(let index=0;index<rows.length;index++) {
    const row=rows[index]!
    await row.get('[data-testid="platform-row-details-toggle"]').trigger('click')
    await flushPromises()
    const dialog=new DOMWrapper(document.querySelector('[data-testid="platform-row-details"]')!)
    expect(dialog.text()).toContain(`行 #${101+index} · 原始记录`)
    expect(dialog.text()).toContain(index===0?'第一行原值':'第二行原值')
    await dialog.get('[data-slot="dialog-close"]').trigger('click')
    await flushPromises()
   }
   await rows[1]!.findAll('button').find(button=>button.text()==='对应事件/出处')!.trigger('click')
   await flushPromises()
   expect(fetch).toHaveBeenLastCalledWith('/api/roster/correspondences/relations/102')
   expect(document.querySelector('[data-testid="platform-correspondence-dialog"]')?.textContent).toContain('第二行原值')
   expect(table.findAll('[data-testid="platform-relation"]')).toHaveLength(2)
  } finally { view.unmount(); vi.unstubAllGlobals() }
 })
 it('缺少查询记录时显示未查询，不编造平台空记录',()=>{
  const view=mount(PlatformRecords,{props:{queries:[],relations:[]}})
  expect(view.text()).toContain('尚无平台查询记录')
  expect(view.text()).not.toContain('平台未返回记录')
  expect(view.find('[data-slot="select-trigger"]').exists()).toBe(false)
  expect(view.find('[role="tablist"]').exists()).toBe(false)
  expect(view.findAll('table')).toHaveLength(0)
  view.unmount()
 })
})
