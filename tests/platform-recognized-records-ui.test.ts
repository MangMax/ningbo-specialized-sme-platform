// @vitest-environment happy-dom
import { mount, DOMWrapper, flushPromises } from '@vue/test-utils'
import { afterAll, beforeAll, afterEach, expect, it } from 'vitest'
import PlatformRecords from '../components/PlatformRecords.vue'
import type { PlatformRecord, PlatformRecordQuery } from '../lib/roster/platform-records'
const nativeAnimate = Object.getOwnPropertyDescriptor(Element.prototype, 'animate')
beforeAll(() => { Reflect.deleteProperty(Element.prototype, 'animate') })
afterAll(() => { if (nativeAnimate) Object.defineProperty(Element.prototype, 'animate', nativeAnimate) })
afterEach(() => { document.body.innerHTML = '' })
async function openDetails(view: ReturnType<typeof mount>) {
 await view.get('[data-testid="platform-row-details-toggle"]').trigger('click')
 await flushPromises()
 return new DOMWrapper(document.querySelector('[data-testid="platform-row-details"]')!)
}
async function openHistory(view: ReturnType<typeof mount>) {
 await view.get('[data-record-kind="recognized_list"] [data-slot="accordion-trigger"]').trigger('click')
 await flushPromises()
 return view.get('[data-record-kind="recognized_list"] [data-testid="platform-query-history"]')
}
const query: PlatformRecordQuery = { id: 60, interface: 'recognized_list', queryKey: '913300000000000004', rdjb: '1,2,3', queriedAt: '2025-02-03T01:02:03.000Z', status: 'success', relationCount: 4, failureReason: null }
const rows: PlatformRecord[] = ['1', '1', '2', '3'].map((sourceRdjb, i) => ({ id: 100+i, queryId: 60, sequenceNo: i+1, relationKey: 'same-id', usccRaw: query.queryKey, nameRaw: '合成企业', province: null, status: null, batch: null, declareKind: null, appliedAt: null, awardBatchLabel: null, year: null, matchBasis: 'uscc', verificationStatus: 'pending', sourceRdjb, sourcePage: i===1 ? 2 : 1, rawFields: { id:'same-id', qymc:'合成企业', tyshxydm:query.queryKey, whpcyear:'2024', whpc:'2', rddqrq:'2027', szq:'原始属地', rdxx:'原认定说明' } }))
it('已认定三称号保留同码同编号的每行且单称号不混入其他行', async () => {
 const view=mount(PlatformRecords,{props:{queries:[query],relations:rows}})
 const table=view.get('table[aria-label="已认定企业列表"]')
 expect(table.findAll('[data-testid="platform-relation"]')).toHaveLength(4)
 expect(table.findAll('tbody[data-record-title]').map(g=>g.attributes('data-record-title'))).toEqual(['1','2','3'])
 await view.get('[data-title-value="1"]').trigger('keydown',{key:'Enter'})
 expect(view.findAll('[data-testid="platform-relation"]').map(r=>r.attributes('data-record-id'))).toEqual(['100','101'])
 expect(view.text()).toContain('已认定企业列表 2 条')
 view.unmount()
})

const evidence = {
 source: 'queryBusList' as const, status: 'success' as const,
 effectiveConditions: { uscc: query.queryKey, name:'原查询名称', combination:'and' as const, whpcyear:'2024', whpc:'2', szq:'33020000', rddqrq:'2027', sqsj:'2024/01/01 - 2024/12/31' },
 titleScope: { mode:'selected' as const, rdjb:['1','2','3'] }, queriedAt:query.queriedAt, completedAt:'2025-02-03T01:03:00.000Z',
 rows:[], pages:[{source:'queryBusList' as const,rdjb:'1',page:2,status:'success' as const,fetchedCount:2,declaredTotal:null,maxPage:2,error:null}],
 fetchedCount:4,declaredTotal:null,completeness:'complete' as const,fullRange:true,unfinished:[],error:null,
 limits:{pageSize:2,maxRequests:100,maxRows:5000,maxDurationMs:60000},
}
it('业务列保留维护与有效期原值，逐行详情可引用且不渲染会话或调试信封', async () => {
 const view=mount(PlatformRecords,{props:{queries:[query],relations:[{...rows[0]!,rawFields:{...rows[0]!.rawFields, cookie:'synthetic-secret', session:{token:'hidden'}, debug:'internal-only'}}]}})
 const table=view.get('table[aria-label="已认定企业列表"]')
 expect(table.findAll('thead th').map(t=>t.text())).toEqual(['序号','企业名称','信用代码','平台属地（原值/代码）','平台认定信息','有效期（原值）','维护年份','维护批次','出处 / 原字段'])
 expect(table.get('[data-testid="platform-relation"]').findAll('td').slice(1,8).map(t=>t.text())).toEqual(['合成企业',query.queryKey,'原始属地','原认定说明','2027','2024','2'])
 const details=await openDetails(view)
 for(const text of ['行 #100','查询引用#60','原行序号1','来源页1','whpcyear','2024']) expect(details.text()).toContain(text)
 expect(details.text()).not.toMatch(/synthetic-secret|hidden|internal-only|cookie|session|debug/)
 await details.get('[data-slot="dialog-close"]').trigger('click')
 const history=await openHistory(view)
 expect(history.text()).toContain('维护年份与批次不作为正式认定事件')
 expect(view.get('[data-record-kind="recognized_list"]').findAll(':scope > p')).toHaveLength(0)
 view.unmount()
})
it('出处保留每次历史查询、实际条件、页范围和未知总数', async () => {
 const view=mount(PlatformRecords,{props:{queries:[{...query,collectionEvidence:evidence},{...query,id:61,status:'no_record',relationCount:0,queriedAt:'2026-01-01T00:00:00Z',collectionEvidence:{...evidence,queriedAt:'2026-01-01T00:00:00Z',fetchedCount:0,declaredTotal:0}}],relations:rows}})
 const history=await openHistory(view)
 expect(history.findAll('article')).toHaveLength(2)
 for(const text of ['查询 #60','查询 #61','2025-02-03','2026-01-01','原查询名称','33020000','2024/01/01 - 2024/12/31','总数：未知','第 2 页','末页 2','指定称号']) expect(history.text()).toContain(text)
 expect(view.findAll('[data-testid="platform-relation"]')).toHaveLength(4)
 view.unmount()
})
it.each([
 ['partial','仅有部分查询证据，不能判断完整有无记录'], ['failed','本次查询未完成'], ['not_queried','尚未查询'], ['no_record','平台未返回记录'],
])('第三来源 %s 与完整零记录分开表达', (status,message) => {
 const view=mount(PlatformRecords,{props:{queries:[{...query,status,relationCount:0}],relations:[]}})
 const section=view.get('[data-record-kind="recognized_list"]')
 expect(section.text()).toContain(message)
 if(status!=='no_record') expect(section.text()).not.toContain('平台未返回记录')
 view.unmount()
})
it('partial 的失败页和未完成范围不被成功页覆盖，续页不冒充全范围', async () => {
 const view=mount(PlatformRecords,{props:{queries:[{...query,status:'partial',collectionEvidence:{...evidence,completeness:'partial',fullRange:false,unfinished:[{source:'queryBusList',rdjb:'3',page:4}],pages:[...evidence.pages,{source:'queryBusList',rdjb:'3',page:4,status:'failed',fetchedCount:0,declaredTotal:null,error:{code:'timeout',message:'timeout'}}]}}],relations:rows}})
 const history=await openHistory(view)
 for(const text of ['完整性：部分','续页范围，非全范围','第 4 页 · 失败','失败 · 未完成','平台响应超时']) expect(history.text()).toContain(text)
 view.unmount()
})
it('旧双来源缺少新来源和完整性元数据时保持未知与未查询', async () => {
 const view=mount(PlatformRecords,{props:{queries:[{...query,interface:'business_list',rdjb:'2',collectionEvidence:null}],relations:[]}})
 expect(view.get('[data-record-kind="recognized_list"]').text()).toContain('尚未查询此来源 / 称号')
 await view.get('[data-testid="platform-query-history"] button').trigger('click')
 expect(view.get('[data-testid="platform-query-history"]').text()).toContain('完整性未知')
 view.unmount()
})
it('来源切换只改变显示，不丢历史与原始行', async () => {
 const view=mount(PlatformRecords,{props:{queries:[query],relations:rows}})
 view.getComponent({ name: 'Select' }).vm.$emit('update:modelValue', 'recognized_list')
 await flushPromises()
 expect(view.findAll('table').map(t=>t.attributes('aria-label'))).toEqual(['已认定企业列表'])
 expect(view.findAll('[data-testid="platform-relation"]')).toHaveLength(4)
 view.getComponent({ name: 'Select' }).vm.$emit('update:modelValue', 'all')
 await flushPromises()
 expect(view.findAll('[data-record-kind]')).toHaveLength(3)
 expect(view.findAll('table')).toHaveLength(1)
 expect(view.findAll('[data-testid="platform-relation"]')).toHaveLength(4)
 view.unmount()
})
it('原字段扩展逐项保留，空值未知且不从维护字段猜认定', async () => {
 const view=mount(PlatformRecords,{props:{queries:[query],relations:[{...rows[0]!,rawFields:{qymc:'原名',whpcyear:'2024',whpc:'2023-2',rddqrq:null,customBusiness:'原始扩展值',cookie:'synthetic-secret',headers:'internal',_debug:'internal'}}]}})
 const row=view.get('[data-testid="platform-relation"]')
 expect(row.findAll('td').slice(3,8).map(t=>t.text())).toEqual(['未提供','未提供','未提供','2024','2023-2'])
 const details=await openDetails(view)
 expect(details.text()).toContain('customBusiness')
 expect(details.text()).toContain('原始扩展值')
 expect(details.text()).not.toMatch(/synthetic-secret|headers|internal|_debug/)
 view.unmount()
})
it('原认定字段逐项保持原值，不把不同字段合成一项', async () => {
 const view=mount(PlatformRecords,{props:{queries:[query],relations:[{...rows[0]!,rawFields:{rdxx:'原认定说明',rdsj:'2022-01-01',rdrq:'2022-01-02'}}]}})
 const details=await openDetails(view)
 expect(details.findAll('dd').slice(-3).map(d=>d.text())).toEqual(['原认定说明','2022-01-01','2022-01-02'])
 view.unmount()
})

it('归档未匹配主体行保留引用和全部称号，切换后仍明确身份待核', async () => {
 const unmatched = rows.map(row => ({...row, enterpriseId:null, matchBasis:'none', verificationStatus:'pending'}))
 const view=mount(PlatformRecords,{props:{queries:[query],relations:unmatched}})
 view.getComponent({ name: 'Select' }).vm.$emit('update:modelValue', 'recognized_list')
 await flushPromises()
 expect(view.findAll('[data-testid="platform-relation"]')).toHaveLength(4)
 for(const row of view.findAll('[data-testid="platform-relation"]')) expect(row.text()).toContain('未匹配主体')
 expect(view.text()).toContain('已认定企业列表 4 条')
 await view.get('[data-title-value="1"]').trigger('keydown',{key:'Enter'})
 expect(view.findAll('[data-testid="platform-relation"]').map(row=>row.attributes('data-record-id'))).toEqual(['100','101'])
 const details=await openDetails(view)
 expect(details.text()).toContain('主体归属未匹配主体')
 expect(details.text()).toContain('查询引用#60')
 view.unmount()
})

it('来源筛选用共享下拉，键盘打开后 Escape 只关闭菜单并恢复触发器焦点', async () => {
 const view=mount(PlatformRecords,{attachTo:document.body,props:{queries:[query],relations:rows}})
 const trigger=view.get('[aria-label="记录来源"]')
 expect(trigger.element.tagName).toBe('BUTTON')
 expect(view.find('select').exists()).toBe(false)
 ;(trigger.element as HTMLElement).focus()
 await trigger.trigger('keydown',{key:'ArrowDown'})
 await flushPromises()
 const options=[...document.querySelectorAll('[role="option"]')]
 expect(options.map(option=>option.textContent?.trim())).toEqual(['全部来源','关联记录','申报记录','已认定企业列表'])
 await new DOMWrapper(document.querySelector('[role="listbox"]')!).trigger('keydown',{key:'Escape'})
 await flushPromises()
 expect(trigger.attributes('aria-expanded')).toBe('false')
 expect(document.activeElement).toBe(trigger.element)
 expect(view.find('[data-testid="platform-records"]').exists()).toBe(true)
 await trigger.trigger('keydown',{key:'Enter'})
 await flushPromises()
 await new DOMWrapper(document.querySelectorAll('[role="option"]')[3]!).trigger('keydown',{key:'Enter'})
 await flushPromises()
 expect(view.findAll('[data-record-kind]').map(section=>section.attributes('data-record-kind'))).toEqual(['recognized_list'])
 expect(view.findAll('[data-testid="platform-relation"]')).toHaveLength(4)
 view.unmount()
})

it('状态顺序与输入排列无关，每个状态独立呈现且来源空态不生成空表', () => {
 const statuses=['success','partial','no_record','failed','not_queried']
 const queries=statuses.map((status,index)=>({...query,id:70+index,status,relationCount:0}))
 const first=mount(PlatformRecords,{props:{queries,relations:[]}})
 const second=mount(PlatformRecords,{props:{queries:[...queries].reverse(),relations:[]}})
 const selector='[data-testid="platform-query-summary"] [data-slot="badge"]'
 expect(first.findAll(selector).map(badge=>badge.text())).toEqual(['未查询','查询失败','无记录','查询成功','部分结果'])
 expect(second.findAll(selector).map(badge=>badge.text())).toEqual(first.findAll(selector).map(badge=>badge.text()))
 expect(first.findAll('table')).toHaveLength(0)
 expect(first.findAll('[data-record-kind]')).toHaveLength(3)
 first.unmount(); second.unmount()
})

it('历史按查询去重称号和错误，同时保留未完成位置与不相同的实际条件', async () => {
 // 用独立 Intl oracle 按宿主本地时区展示原时点，不隐含固定 UTC+08。
 const parts=new Intl.DateTimeFormat('en-GB',{
  year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23',
 }).formatToParts(new Date(evidence.completedAt))
 const part=(type:Intl.DateTimeFormatPartTypes)=>parts.find(part=>part.type===type)!.value
 const completedAt=`${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')}`
 const error={code:'timeout' as const,message:'timeout'}
 const failed={...query,status:'failed',failureReason:'timeout',relationCount:0,collectionEvidence:{...evidence,completeness:'partial' as const,fullRange:false,error,
 pages:[{source:'queryBusList' as const,rdjb:'3',page:4,status:'failed' as const,fetchedCount:0,declaredTotal:null,maxPage:null,error}],
 unfinished:[{source:'queryBusList' as const,rdjb:'3',page:4},{source:'queryBusList' as const,rdjb:'2',page:5}]}}
 const view=mount(PlatformRecords,{props:{queries:[failed],relations:[]}})
 const history=await openHistory(view)
 const article=history.get('article')
 expect(article.text().match(/平台响应超时/g)).toHaveLength(1)
 for(const title of ['创新型中小企业','专精特新中小企业','专精特新“小巨人”']) expect(article.text().split(title)).toHaveLength(2)
 expect(article.text()).toContain('称号 3 · 第 4 页 · 失败 · 未完成')
 expect(article.text()).toContain('未完成：称号 2 · 第 5 页')
 for(const text of ['原查询时点','2025-02-03','完成时点',`完成时点：${completedAt}`,'总数：未知','续页范围，非全范围','原查询名称','33020000','属地筛选代码（原值）']) expect(article.text()).toContain(text)
 expect(article.text()).not.toContain('条件同时满足')
 view.unmount()
})

it('行详情在表格外的命名弹层中保留未知原字段、空值、引用和未匹配身份，关闭后保留行', async () => {
 const view=mount(PlatformRecords,{attachTo:document.body,props:{queries:[query],relations:[{...rows[0]!,enterpriseId:null,rawFields:{unknownBusiness:'原始扩展',unknownEmpty:null,szq:'133028100'}}]}})
 const details=await openDetails(view)
 expect(details.element.closest('table')).toBeNull()
 expect(details.attributes('role')).toBe('dialog')
 expect(document.getElementById(details.attributes('aria-labelledby')!)?.textContent).toContain('行 #100')
 for(const text of ['未匹配主体','查询引用#60','原行序号1','来源页1','unknownBusiness','原始扩展','平台属地（原值/代码）','133028100']) expect(details.text()).toContain(text)
 expect(details.text()).not.toContain('unknownEmpty')
 await details.get('[data-testid="platform-empty-fields"] button').trigger('click')
 await flushPromises()
 expect(details.text()).toContain('unknownEmpty')
 expect(details.text()).toContain('null（原值）')
 await details.get('[data-slot="dialog-close"]').trigger('click')
 await flushPromises()
 expect(view.get('[data-testid="platform-row-details-toggle"]').attributes('aria-expanded')).toBe('false')
 expect(view.findAll('[data-testid="platform-relation"]')).toHaveLength(1)
 view.unmount()
})

it('查询标注与实际请求称号不同仍分别保留，不同失败原因保留页关联且不重复', async () => {
 const view=mount(PlatformRecords,{props:{queries:[{...query,status:'partial',collectionEvidence:{...evidence,titleScope:{mode:'selected',rdjb:['1']},error:{code:'upstream_failed',message:'network'},pages:[
  {...evidence.pages[0]!,status:'failed',error:{code:'timeout',message:'timeout'}},
  {...evidence.pages[0]!,page:3,status:'failed',error:{code:'upstream_failed',message:'network'}},
 ]}}],relations:[]}})
 const history=await openHistory(view)
 expect(history.text()).toContain('称号范围：指定称号 · 创新型中小企业（1）')
 expect(history.text()).toContain('查询标注称号：创新型中小企业、专精特新中小企业、专精特新“小巨人”')
 expect(history.text().match(/平台响应超时/g)).toHaveLength(1)
 expect(history.text().match(/暂时无法连接平台/g)).toHaveLength(1)
 expect(history.get('li:nth-child(1)').text()).toContain('原因 1')
 expect(history.get('li:nth-child(2)').text()).toContain('原因 2')
 view.unmount()
})

it('旧行缺少主体归属仍保留身份标签并明确未知', async () => {
 const view=mount(PlatformRecords,{props:{queries:[query],relations:[rows[0]!]}})
 const details=await openDetails(view)
 const labels=details.findAll('dt').map(label=>label.text())
 expect(labels).toContain('主体归属')
 expect(details.findAll('dd')[labels.indexOf('主体归属')]!.text()).toBe('未提供')
 view.unmount()
})
