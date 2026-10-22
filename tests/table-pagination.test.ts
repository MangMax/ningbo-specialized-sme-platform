// @vitest-environment happy-dom
import { mount } from '@vue/test-utils'
import { expect, it } from 'vitest'
import TablePagination from '../components/TablePagination.vue'

it('offers bounded cursor navigation without a total or last-page claim', async () => {
  const wrapper = mount(TablePagination, { props: { mode: 'cursor', page: 2, pageSize: 25, unit: '条', hasNext: true, maxPageSize: 100 } })
  expect(wrapper.text()).not.toContain('共 ')
  expect(wrapper.find('[aria-label="最后一页"]').exists()).toBe(false)
  await wrapper.get('[aria-label="下一页"]').trigger('click')
  await wrapper.get('[aria-label="上一页"]').trigger('click')
  expect(wrapper.emitted('next')).toHaveLength(1)
  expect(wrapper.emitted('previous')).toHaveLength(1)
  await wrapper.setProps({ hasNext: false, page: 1 })
  expect(wrapper.get('[aria-label="下一页"]').attributes('disabled')).toBeDefined()
  expect(wrapper.get('[aria-label="上一页"]').attributes('disabled')).toBeDefined()
  await wrapper.setProps({ page: 2, hasNext: true, loading: true })
  expect(wrapper.get('[aria-label="下一页"]').attributes('disabled')).toBeDefined()
  expect(wrapper.get('[aria-label="上一页"]').attributes('disabled')).toBeDefined()
  wrapper.unmount()
})
it('preserves numbered navigation, totals and custom page sizes for existing callers', async () => {
  const wrapper = mount(TablePagination, { props: { page: 2, pageSize: 30, total: 1000, unit: '家' } })
  expect(wrapper.get('[data-testid="table-total"]').text()).toContain('1,000')
  expect(wrapper.find('[aria-label="最后一页"]').exists()).toBe(true)
  await wrapper.get('[aria-label="下一页"]').trigger('click')
  expect(wrapper.emitted('update:page')).toEqual([[3]])
  await wrapper.get('input').setValue('42'); await wrapper.get('input').trigger('change')
  expect(wrapper.emitted('update:pageSize')?.at(-1)).toEqual([42])
  wrapper.unmount()
})
