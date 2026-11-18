// @vitest-environment happy-dom
import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import TablePagination from '../../../layers/core/app/components/TablePagination.vue'
import TableLoadingStatus from '../../../layers/core/app/components/TableLoadingStatus.vue'
import TableFailureState from '../../../layers/core/app/components/TableFailureState.vue'
import { Select } from '../../../layers/core/app/components/ui/select'

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
  it('自定义每页条数后，触发器显示实际数量而不是被截断的“自定义…”', async () => {
    const view = pagination()
    // Reka fills the trigger's value from the item text that is mounted with it.
    await view.vm.$nextTick()
    const trigger = () => view.get('[aria-label="每页条数"]').text()
    expect(trigger()).toBe('25')
    view.getComponent(Select).vm.$emit('update:modelValue', 'custom')
    await view.vm.$nextTick()
    // Choosing 自定义… keeps the current size visible until a number is typed.
    expect(trigger()).toBe('25')
    expect(view.text()).not.toContain('自定义…')
    await view.setProps({ pageSize: 3 })
    await view.vm.$nextTick()
    expect(view.getComponent(Select).props('modelValue')).toBe('3')
    // A size that is not a preset opens the input directly and still shows the number.
    await view.setProps({ pageSize: 37 })
    await view.vm.$nextTick()
    expect(view.getComponent(Select).props('modelValue')).toBe('37')
    expect(view.get<HTMLInputElement>('[aria-label="自定义每页条数"]').element.value).toBe('37')
  })
  it('非预设的每页条数在触发器上显示真实数字，而不是空白控件', async () => {
    // A deep link such as ?pageSize=10 carries a size that is not one of the
    // presets. The trigger a person reads must show that number itself.
    const view = pagination({ page: 1, pageSize: 10, total: 100, unit: '个任务' })
    await view.vm.$nextTick()
    const trigger = view.get('[aria-label="每页条数"]')
    // The real Reka trigger, not a hand-written control.
    expect(trigger.attributes('data-slot')).toBe('select-trigger')
    expect(trigger.find('[data-slot="select-value"]').exists()).toBe(true)
    // The trigger's own text is the number — not merely the model value, and not
    // only the number sitting in the neighbouring input.
    expect(trigger.text()).toBe('10')
    expect(view.get<HTMLInputElement>('[aria-label="自定义每页条数"]').element.value).toBe('10')
  })
  it('选“自定义…”后改值、再选回预设，触发器上的数字始终跟着走', async () => {
    const view = pagination({ page: 1, pageSize: 25, total: 100, unit: '个任务' })
    await view.vm.$nextTick()
    const triggerText = () => view.get('[aria-label="每页条数"]').text()
    expect(triggerText()).toBe('25')

    // Choose 自定义…: the size stays until a number is typed.
    view.getComponent(Select).vm.$emit('update:modelValue', 'custom')
    await view.vm.$nextTick()
    expect(triggerText()).toBe('25')
    expect(view.get<HTMLInputElement>('[aria-label="自定义每页条数"]').element.value).toBe('25')

    // Type a size that is not a preset: the trigger shows it too.
    const input = view.get<HTMLInputElement>('[aria-label="自定义每页条数"]')
    input.element.value = '10'
    await input.trigger('change')
    expect(view.emitted('update:pageSize')).toContainEqual([10])
    await view.setProps({ pageSize: 10 })
    await view.vm.$nextTick()
    expect(triggerText()).toBe('10')

    // Back to a preset: the number follows and the custom input closes.
    view.getComponent(Select).vm.$emit('update:modelValue', '50')
    await view.vm.$nextTick()
    expect(view.emitted('update:pageSize')).toContainEqual([50])
    await view.setProps({ pageSize: 50 })
    await view.vm.$nextTick()
    expect(triggerText()).toBe('50')
    expect(view.find('[aria-label="自定义每页条数"]').exists()).toBe(false)
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
    expect(view.get('[aria-label="每页条数"]').attributes('disabled')).toBeDefined()
    await view.get('[data-slot="pagination-next"]').trigger('click')
    expect(view.emitted('update:page')).toBeUndefined()
    await view.setProps({ loading: false, page: 7 })
    expect(view.get('[data-slot="pagination-next"]').attributes('disabled')).toBeDefined()
    expect(view.get('[data-slot="pagination-previous"]').attributes('disabled')).toBeUndefined()
    expect(view.get('[aria-label="每页条数"]').attributes('disabled')).toBeUndefined()
  })

  it('请求失败时也锁定自定义每页数量,重试仍对应失败目标', () => {
    const view = pagination({ page: 1, pageSize: 37, loading: true })
    expect(view.get<HTMLInputElement>('[aria-label="自定义每页条数"]').attributes('disabled')).toBeDefined()
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

describe('表格内失败态', () => {
  it('首次失败保留筛选说明和独立重试入口，不出现空结果文案', async () => {
    const view = mount(TableFailureState, { props: { title: '企业列表暂时无法加载' } })
    mounted.push(view)
    expect(view.attributes('role')).toBe('status')
    expect(view.attributes('data-compact')).toBe('false')
    expect(view.text()).toContain('筛选条件已保留')
    expect(view.text()).not.toContain('没有匹配')
    await view.get('[data-testid="table-retry"]').trigger('click')
    expect(view.emitted('retry')).toEqual([[]])
  })
  it('已有数据刷新失败明确提示旧结果，重试中按钮禁用且区域保持', async () => {
    const view = mount(TableFailureState, { props: { title: '文件列表暂时无法加载', compact: true } })
    mounted.push(view)
    expect(view.attributes('data-compact')).toBe('true')
    expect(view.text()).toContain('显示的是上次加载的结果')
    await view.setProps({ pending: true })
    const button = view.get('[data-testid="table-retry"]')
    expect(button.text()).toBe('正在重试')
    expect(button.attributes('disabled')).toBeDefined()
    expect(view.attributes('aria-busy')).toBe('true')
    await button.trigger('click')
    expect(view.emitted('retry')).toBeUndefined()
    await view.setProps({ pending: false })
    expect(button.text()).toBe('重新加载')
    expect(button.attributes('disabled')).toBeUndefined()
  })

  it('分页目标失败时明确标出旧结果来源页与失败目标页', () => {
    const view = mount(TableFailureState, {
      props: {
        title: '企业列表暂时无法加载',
        compact: true,
        description: '显示上次成功的第 1 页；当前筛选请求的第 2 页未加载成功。',
      },
    })
    mounted.push(view)
    expect(view.text()).toContain('上次成功的第 1 页')
    expect(view.text()).toContain('第 2 页未加载成功')
  })
})
