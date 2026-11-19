// @vitest-environment happy-dom
import { mount, flushPromises } from '@vue/test-utils'
import { afterEach, expect, it, vi } from 'vitest'
import EnterpriseDifferenceRefresh from '../../../layers/sme-roster/app/components/EnterpriseDifferenceRefresh.vue'
afterEach(()=>vi.unstubAllGlobals())
it('refreshes exactly the displayed enterprises and emits success with counts', async()=>{
 const fetcher=vi.fn().mockResolvedValue({refreshed:2,unchanged:4});vi.stubGlobal('$fetch',fetcher)
 const w=mount(EnterpriseDifferenceRefresh,{props:{enterpriseIds:[1,2970]}})
 await w.get('button').trigger('click');await flushPromises()
 expect(fetcher).toHaveBeenCalledWith('/api/roster/differences/refresh',{method:'POST',headers:{'x-task-center-browser':'1'},body:{enterpriseIds:[1,2970]}})
 expect(w.get('[role=status]').text()).toBe('已刷新 2 家企业：2 项更新，4 项未变化')
 expect(w.emitted('refreshed')).toHaveLength(1);w.unmount()
})
it('keeps failed refresh retryable without claiming success and disables stale results',async()=>{
 const fetcher=vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue({refreshed:0,unchanged:3});vi.stubGlobal('$fetch',fetcher)
 const w=mount(EnterpriseDifferenceRefresh,{props:{enterpriseIds:[1],disabled:true}})
 expect(w.get('button').attributes('disabled')).toBeDefined()
 await w.setProps({disabled:false});await w.get('button').trigger('click');await flushPromises()
 expect(w.get('[role=status]').text()).toBe('刷新差异失败，请重试');expect(w.emitted('refreshed')).toBeUndefined()
 await w.get('button').trigger('click');await flushPromises();expect(w.emitted('refreshed')).toHaveLength(1);w.unmount()
})
