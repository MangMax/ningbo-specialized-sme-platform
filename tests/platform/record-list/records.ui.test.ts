// @vitest-environment happy-dom
import { mount, flushPromises } from '@vue/test-utils'
import { expect, it } from 'vitest'
const query = { id: 1, interface: 'business_list', queryKey: 'SYN246', rdjb: '2', queriedAt: '2026-11-06T02:08:47.038Z', status: 'success', relationCount: 7, failureReason: null }
it('legacy provenance shows pagination without claiming typed original evidence', async()=>{
 const {default:Provenance}=await import('../../../layers/sme-roster/app/components/PlatformQueryProvenance.vue')
 const view=mount(Provenance,{props:{sourceLabel:'关联记录',queries:[{...query,collectionEvidence:null,legacyProvenance:{kind:'legacy_pagination',collection:{completedAt:'2026-11-06T02:08:47.038Z',completeness:'complete',fullRange:true,fetchedCount:7,declaredTotal:7,titleScope:{mode:'selected',rdjb:['1','2','3']},effectiveConditions:{uscc:query.queryKey,combination:'and'},pages:[{rdjb:'3',page:2,status:'success',fetchedCount:7,declaredTotal:7}],unfinished:[],error:null}}} as any]}})
 try {
  await view.get('button').trigger('click');await flushPromises()
  expect(view.text()).toContain('旧采集分页来源已补证；原始字段类型仍未记录')
  expect(view.text()).toContain('第 2 页');expect(view.text()).toContain('已采集 7 条')
  expect(view.text()).not.toContain('完整性未知')
 }finally{view.unmount()}
})
