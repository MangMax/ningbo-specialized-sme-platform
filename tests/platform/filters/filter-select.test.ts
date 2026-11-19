// @vitest-environment happy-dom
import { mount } from '@vue/test-utils'
import { expect, it } from 'vitest'
import PlatformFilterSelect from '../../../layers/sme-roster/app/components/PlatformFilterSelect.vue'
import { Select } from '../../../layers/core/app/components/ui/select'

it('selects literal candidates and clears without colliding with a source value named all', async () => {
 const w=mount(PlatformFilterSelect,{props:{modelValue:'all',options:['all','other:value'],label:'状态',placeholder:'全部状态'}})
 expect(w.get('[role=combobox]').text()).toBe('all')
 w.findComponent(Select).vm.$emit('update:modelValue','value:other:value')
 w.findComponent(Select).vm.$emit('update:modelValue','value:all')
 w.findComponent(Select).vm.$emit('update:modelValue','all')
 expect(w.emitted('update:modelValue')).toEqual([['other:value'],['all'],['']])
 expect(w.get('[role=combobox]').attributes('data-size')).toBe('sm')
 w.unmount()
})
it('shows known labels while preserving literal unknown source values', async () => {
 const w=mount(PlatformFilterSelect,{props:{modelValue:'review',options:['review','unknown'],label:'事项',placeholder:'全部事项',formatLabel:(v:string)=>v==='review'?'复核':v}})
 expect(w.get('[role=combobox]').text()).toBe('复核')
 await w.setProps({modelValue:'unknown'});expect(w.get('[role=combobox]').text()).toBe('unknown');w.unmount()
})
it('does not invent missing years and still lets an active old selection be cleared', async()=>{
 const w=mount(PlatformFilterSelect,{props:{modelValue:'',options:[],label:'业务年',placeholder:'全部业务年'}})
 expect(w.get('[role=combobox]').text()).toBe('暂无业务年')
 expect(w.get('[role=combobox]').attributes('disabled')).toBeDefined()
 await w.setProps({modelValue:'2024'})
 expect(w.get('[role=combobox]').attributes('disabled')).toBeUndefined()
 expect(w.get('[role=combobox]').text()).toBe('2024');w.unmount()
})
it('does not mislabel loading or failed options as absent business data',()=>{
 const w=mount(PlatformFilterSelect,{props:{modelValue:'',options:[],disabled:true,label:'年度',placeholder:'全部年度'}})
 expect(w.get('[role=combobox]').text()).toBe('全部年度');w.unmount()
})
