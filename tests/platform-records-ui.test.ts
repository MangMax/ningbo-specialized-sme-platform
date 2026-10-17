// @vitest-environment happy-dom
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import PlatformRecords from '../components/PlatformRecords.vue'
import { platformFailureForDisplay } from '../lib/roster/platform-records'
const query = {id: 1,interface:'business_list',queryKey:'9133021274738281XA',rdjb:'2',queriedAt:'2026-10-16',status:'success',failureReason:null,relationCount:1}
const record = {id: 1,queryId:1,sequenceNo:1,relationKey:'SQ001',nameRaw:'平台原名',usccRaw:'9133021274738281XA',province:'宁波市',status:'待审核',batch:'2025-1',declareKind:'update',appliedAt:'2025-03-01',awardBatchLabel:'2022年第一批',year:2025,matchBasis:'uscc',verificationStatus:'confirmed'}
describe('面向用户的平台记录表',()=>{
 it('逐条表格展示原始企业、状态与批次，并将接口参数译成业务名称',()=>{
  const view=mount(PlatformRecords,{props:{queries:[query],relations:[record]}})
  expect(view.find('table').exists()).toBe(true)
  for(const text of ['称号查询记录','专精特新中小企业','平台原名','9133021274738281XA','待审核','2025-1','2022年第一批','2025-03-01','更新','SQ001']) expect(view.text()).toContain(text)
  expect(view.text()).not.toMatch(/business_list|businessList|rdjb|queryId|matchBasis/)
  view.unmount()
 })
 it('查询失败、返回空和未查询分别显示，不把失败当作无记录',()=>{
  const view=mount(PlatformRecords,{props:{queries:[{...query,id:2,status:'failed',relationCount:0},{...query,id:3,status:'no_record',relationCount:0},{...query,id:4,status:'not_queried',relationCount:0}],relations:[]}})
  expect(view.text()).toContain('查询失败')
  expect(view.text()).toContain('本次查询未完成')
  expect(view.text()).toContain('平台未返回记录')
  expect(view.text()).toContain('尚未查询')
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
 it('缺少查询记录时显示未查询，不编造平台空记录',()=>{
  const view=mount(PlatformRecords,{props:{queries:[],relations:[]}})
  expect(view.text()).toContain('尚无平台查询记录')
  expect(view.text()).not.toContain('平台未返回记录')
  view.unmount()
 })
})
