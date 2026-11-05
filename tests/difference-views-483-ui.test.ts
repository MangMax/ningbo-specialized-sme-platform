// @vitest-environment happy-dom
import {mount,flushPromises} from '@vue/test-utils'
import {it,expect,vi,afterEach} from 'vitest'
import Queue from '../components/tasks/SnapshotDifferenceQueue.vue'
import TablePagination from '../components/TablePagination.vue'
import TableFailureState from '../components/TableFailureState.vue'
const wrappers:ReturnType<typeof mount>[]=[]
afterEach(()=>{wrappers.forEach(w=>w.unmount());vi.unstubAllGlobals()})
it('switches judged results, labels no difference, and retains source rows after failure until retry',async()=>{
 let fail=false
 vi.stubGlobal('$fetch',vi.fn(async(_url:string,options:{query:{view:string}})=>{
 if(fail)throw Error('synthetic failure')
 return {page:1,pageSize:25,total:1,unfinished:[99],rows:[{enterpriseId:1,titleCode:'innovative_sme',direction:'missing_in_miit',status:options.query.view==='judged'?'confirmed_no_diff':'not_queried',reasonCode:null}]}
 }))
 const wrapper=mount(Queue,{props:{id:'01M5BEPVCXD5619ZW4C6CAT483'},global:{components:{TablePagination,TableFailureState},stubs:{NuxtLink:{template:'<a><slot /></a>'}}}});wrappers.push(wrapper)
 await flushPromises();expect(wrapper.text()).toContain('未查询');expect(wrapper.text()).toContain('1 家企业的覆盖或记录信息未完成')
 await wrapper.findAll('[role=tab]')[1]!.trigger('mousedown', {button:0});await flushPromises();expect(wrapper.text()).toContain('无差异');expect(wrapper.text()).not.toContain('暂无待核候选')
 fail=true
 await wrapper.findAll('[role=tab]')[0]!.trigger('mousedown', {button:0});await flushPromises();expect(wrapper.text()).toContain('队列暂不可读');expect(wrapper.text()).toContain('无差异');expect(wrapper.text()).toContain('上次成功读取')
 fail=false
 await wrapper.findAll('button').find(b=>b.attributes('data-testid')==='table-retry')!.trigger('click');await flushPromises();expect(wrapper.text()).toContain('未查询');expect(wrapper.text()).not.toContain('队列暂不可读')
})
