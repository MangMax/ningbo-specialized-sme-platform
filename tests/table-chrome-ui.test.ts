// @vitest-environment happy-dom
import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import TablePagination from '../components/TablePagination.vue'
import TableLoadingStatus from '../components/TableLoadingStatus.vue'
import { Select } from '../components/ui/select'

const mounted: ReturnType<typeof mount>[] = []
afterEach(() => { for (const view of mounted.splice(0)) view.unmount() })
function pagination(extra: Record<string, unknown> = {}) {
  const view = mount(TablePagination, { props: { page: 2, pageSize: 25, total: 160, unit: '条', ...extra }, attachTo: document.body })
  mounted.push(view)
  return view
}

describe('统一表格分页', () => {
  it('每页数量和总数与数字分页在同一栏，点击页码发出目标页', async () => {
    const view = pagination()
    expect(view.text()).toContain('每页')
    expect(view.get('[data-testid="table-total"]').text()).toBe('共 160 条')
    expect(view.findAll('[data-slot="pagination-item"]').length).toBeGreaterThan(1)
    await view.get('[data-slot="pagination-next"]').trigger('click')
    expect(view.emitted('update:page')).toEqual([[3]])
  })
  it('预设数量与自定义输入使用同一个数量事件，限制为1到200的整数', async () => {
    const view = pagination()
    view.getComponent(Select).vm.$emit('update:modelValue', '50')
    await view.vm.$nextTick()
    expect(view.emitted('update:pageSize')).toEqual([[50]])
    view.getComponent(Select).vm.$emit('update:modelValue', 'custom')
    await view.vm.$nextTick()
    const input = view.get<HTMLInputElement>('[aria-label="自定义每页条数"]')
    for (const value of ['301', '3.8', '0', '']) {
      input.element.value = value
      await input.trigger('change')
    }
    expect(view.emitted('update:pageSize')).toEqual([[50], [200], [3]])
  })
  it('非预设数量直接显示输入，空结果仍可调数量但无无效页码', () => {
    const view = pagination({ page: 1, pageSize: 37, total: 0, unit: '个文件' })
    expect(view.get<HTMLInputElement>('[aria-label="自定义每页条数"]').element.value).toBe('37')
    expect(view.get('[data-testid="table-total"]').text()).toBe('共 0 个文件')
    expect(view.find('[data-slot="pagination"]').exists()).toBe(false)
  })
  it('边界页和请求中禁用导航，不发出越界页码', async () => {
    const view = pagination({ page: 1, loading: true })
    expect(view.get('[data-slot="pagination-previous"]').attributes('disabled')).toBeDefined()
    expect(view.get('[data-slot="pagination-next"]').attributes('disabled')).toBeDefined()
    await view.get('[data-slot="pagination-next"]').trigger('click')
    expect(view.emitted('update:page')).toBeUndefined()
    await view.setProps({ loading: false, page: 7 })
    expect(view.get('[data-slot="pagination-next"]').attributes('disabled')).toBeDefined()
    expect(view.get('[data-slot="pagination-previous"]').attributes('disabled')).toBeUndefined()
  })
})

describe('统一表顶加载提示', () => {
  it('三页仅在加载中显示状态字及进度条，空闲不留占位内容', async () => {
    for (const kind of ['ledger', 'files', 'comparison'] as const) {
      const view = mount(TableLoadingStatus, { props: { kind, loading: false, label: '正在加载…' } })
      mounted.push(view)
      expect(view.attributes('data-testid')).toBe(`${kind}-loading-status`)
      expect(view.text()).toBe('')
      expect(view.find('.table-progress').exists()).toBe(false)
      await view.setProps({ loading: true })
      expect(view.text()).toBe('正在加载…')
      expect(view.find(`.${kind}-progress`).exists()).toBe(true)
      expect(view.attributes('aria-live')).toBe('polite')
    }
  })
})
