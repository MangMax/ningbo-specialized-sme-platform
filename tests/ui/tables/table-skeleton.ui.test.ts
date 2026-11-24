// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { defineComponent, h } from 'vue'
import { afterEach, describe, expect, it } from 'vitest'
import WorkspacePage from '../../../layers/core/app/components/WorkspacePage.vue'
import DataTableCard from '../../../layers/core/app/components/DataTableCard.vue'
import ActiveFilterBar from '../../../layers/core/app/components/ActiveFilterBar.vue'
import SectionCard from '../../../layers/core/app/components/SectionCard.vue'
import DetailDrawer from '../../../layers/core/app/components/DetailDrawer.vue'
import SingleSelectFilter from '../../../layers/core/app/components/SingleSelectFilter.vue'
import Input from '../../../layers/core/app/components/ui/input/Input.vue'
import PageHeader from '../../../layers/core/app/components/PageHeader.vue'
import TablePagination from '../../../layers/core/app/components/TablePagination.vue'

const mounted: ReturnType<typeof mount>[] = []
afterEach(() => {
  for (const view of mounted.splice(0)) view.unmount()
})
function track<T extends ReturnType<typeof mount>>(view: T) {
  mounted.push(view)
  return view
}

describe('WorkspacePage 建页骨架', () => {
  it('viewport 模式占满剩余高度，内置页头并透传 actions', () => {
    const view = track(
      mount(WorkspacePage, {
        props: { title: '企业列表', description: '这一页回答哪些企业符合条件。' },
        slots: {
          actions: '<button data-testid="page-action">新增</button>',
          default: '<div data-testid="page-body">主体</div>',
        },
      }),
    )
    const root = view.element as HTMLElement
    expect(root.classList.contains('workspace-list')).toBe(true)
    expect(root.classList.contains('flex-1')).toBe(true)
    expect(root.classList.contains('min-h-0')).toBe(true)
    const header = view.getComponent(PageHeader)
    expect(header.props('title')).toBe('企业列表')
    expect(header.props('description')).toBe('这一页回答哪些企业符合条件。')
    expect(view.find('[data-testid="page-action"]').exists()).toBe(true)
    expect(view.find('[data-testid="page-body"]').exists()).toBe(true)
  })

  it('scroll 模式跟随文档滚动，busy 标到页面根上', () => {
    const view = track(
      mount(WorkspacePage, { props: { title: '详情', mode: 'scroll', busy: true } }),
    )
    const root = view.element as HTMLElement
    expect(root.classList.contains('workspace-list')).toBe(false)
    expect(root.getAttribute('aria-busy')).toBe('true')
  })
})

describe('DataTableCard 结果卡', () => {
  it('工具栏、正文、分页各在其位，分页在滚动区外', () => {
    const view = track(
      mount(DataTableCard, {
        props: { toolbarLabel: '企业列表筛选与操作', bodyBusy: true },
        slots: {
          toolbar: '<input data-testid="toolbar-input" />',
          default: '<div data-testid="table-body">行</div>',
          footer: '<div data-testid="card-footer">分页</div>',
        },
      }),
    )
    const toolbar = view.get('[role="region"]')
    expect(toolbar.attributes('aria-label')).toBe('企业列表筛选与操作')
    expect(toolbar.classes()).toContain('table-toolbar')
    expect(toolbar.find('[data-testid="toolbar-input"]').exists()).toBe(true)

    const body = view.get('.paginated-table-body')
    expect(body.attributes('aria-busy')).toBe('true')
    expect(body.find('[data-testid="table-body"]').exists()).toBe(true)

    // 分页是卡片的直接子元素，不在正文滚动容器里。
    const footer = view.get('[data-testid="card-footer"]')
    expect(footer.element.parentElement?.classList.contains('paginated-table-body')).toBe(false)
  })

  it('有 sidebar 插槽时启用双栏，无插槽时单栏', () => {
    const withSidebar = track(
      mount(DataTableCard, {
        slots: { sidebar: '<nav data-testid="catalog">目录</nav>', default: '结果' },
      }),
    )
    expect((withSidebar.element as HTMLElement).className).toContain('lg:grid-cols-[minmax(13rem,16rem)_minmax(0,1fr)]')
    expect(withSidebar.find('[data-testid="catalog"]').exists()).toBe(true)
    withSidebar.unmount()

    const single = track(mount(DataTableCard, { slots: { default: '结果' } }))
    expect((single.element as HTMLElement).className).not.toContain('lg:grid-cols')
  })

  it('filterScroll 让工具栏成为可聚焦的滚动区域', () => {
    const view = track(
      mount(DataTableCard, { props: { filterScroll: true }, slots: { toolbar: '筛选' } }),
    )
    const toolbar = view.get('.table-toolbar')
    expect(toolbar.classes()).toContain('workspace-list-filter')
    expect(toolbar.attributes('tabindex')).toBe('0')
  })

  it('footer 可放 TablePagination 的 in-card 样式', () => {
    const view = track(
      mount(DataTableCard, {
        slots: {
          default: '结果',
          footer: () =>
            h(TablePagination, { inCard: true, page: 1, pageSize: 25, total: 30, unit: '家' }),
        },
      }),
    )
    expect(view.findComponent(TablePagination).exists()).toBe(true)
    expect(view.get('[data-testid="table-total"]').text()).toContain('共 30 家')
  })
})

describe('ActiveFilterBar 已生效条件', () => {
  const items = [
    { key: 'title', label: '称号：小巨人' },
    { key: 'district', label: '属地：海曙区' },
  ]

  it('没有条件时整条不渲染', () => {
    const view = track(mount(ActiveFilterBar, { props: { items: [] } }))
    expect(view.find('[role="group"]').exists()).toBe(false)
  })

  it('逐项撤掉与整体清除各自发出事件', async () => {
    const view = track(mount(ActiveFilterBar, { props: { items } }))
    const group = view.get('[role="group"]')
    expect(group.attributes('aria-label')).toBe('已应用筛选')
    const chips = view.findAll('[data-testid="filter-chip"]')
    expect(chips.map((chip) => chip.text())).toEqual(['称号：小巨人', '属地：海曙区'])

    await chips[0]!.find('button').trigger('click')
    expect(view.emitted('remove')).toEqual([['title']])

    const clear = view.findAll('button').find((button) => button.text() === '清除筛选')!
    await clear.trigger('click')
    expect(view.emitted('clear')).toEqual([[]])
  })

  it('条件数达到 showClearMin 才出现清除按钮，且可整体禁用', () => {
    const one = track(mount(ActiveFilterBar, { props: { items: [items[0]!], showClearMin: 2 } }))
    expect(one.text()).not.toContain('清除筛选')
    one.unmount()

    const disabled = track(
      mount(ActiveFilterBar, { props: { items, disabled: true, clearLabel: '全部清空' } }),
    )
    const clear = disabled.findAll('button').find((button) => button.text() === '全部清空')!
    expect(clear.attributes('disabled')).toBeDefined()
    for (const chip of disabled.findAll('[data-testid="filter-chip"]')) {
      expect(chip.find('button').attributes('disabled')).toBeDefined()
    }
  })
})

describe('SingleSelectFilter 单值筛选', () => {
  const options = [
    { value: 'little_giant', label: '小巨人' },
    { value: 'specialized_sme', label: '专精特新' },
  ]

  it('未筛选时显示占位文案，不标激活态', () => {
    const view = track(
      mount(SingleSelectFilter, {
        props: { modelValue: 'all', options, placeholder: '全部称号', ariaLabel: '按称号筛选' },
        attachTo: document.body,
      }),
    )
    const trigger = view.get('[data-slot="select-trigger"]')
    expect(trigger.attributes('aria-label')).toBe('按称号筛选')
    expect(trigger.attributes('data-active')).toBe('false')
    expect(trigger.attributes('data-size')).toBe('sm')
    expect(trigger.classes().join(' ')).toContain('bg-card')
    expect(view.text()).toContain('全部称号')
  })

  it('有值时高亮并显示「字段：值」，切换发出新值', async () => {
    const view = track(
      mount(SingleSelectFilter, {
        props: {
          modelValue: 'little_giant',
          options,
          placeholder: '全部称号',
          ariaLabel: '按称号筛选',
          summaryPrefix: '称号',
        },
        attachTo: document.body,
      }),
    )
    const trigger = view.get('[data-slot="select-trigger"]')
    expect(trigger.attributes('data-active')).toBe('true')
    expect(trigger.text()).toContain('称号：小巨人')

    // Reka 的根组件负责写回 v-model；直接驱动它验证透传。
    view.getComponent({ name: 'SelectRoot' }).vm.$emit('update:modelValue', 'specialized_sme')
    await view.vm.$nextTick()
    expect(view.emitted('update:modelValue')).toEqual([['specialized_sme']])
  })
})

describe('SectionCard 分区卡片', () => {
  it('标题、说明、操作与正文按区渲染', () => {
    const view = track(
      mount(SectionCard, {
        props: { title: '运行设置', description: '决定任务如何调度。' },
        slots: { actions: '<button data-testid="section-action">编辑</button>', default: '<p data-testid="section-body">内容</p>' },
      }),
    )
    expect(view.get('h2').text()).toBe('运行设置')
    expect(view.text()).toContain('决定任务如何调度。')
    expect(view.find('[data-testid="section-action"]').exists()).toBe(true)
    expect(view.find('[data-testid="section-body"]').exists()).toBe(true)
    expect(view.get('[data-testid="section-body"]').element.parentElement?.className).toContain('p-4')
  })

  it('没有标题也没有插槽时不渲染头部，padded=false 去掉正文内边距', () => {
    const view = track(
      mount(SectionCard, { props: { padded: false }, slots: { default: '<div data-testid="bare">内容</div>' } }),
    )
    expect(view.find('h2').exists()).toBe(false)
    expect(view.get('[data-testid="bare"]').element.parentElement?.className ?? '').not.toContain('p-4')
  })
})

describe('DetailDrawer 抽屉结构', () => {
  // SheetContent 通过 DialogPortal 传送到 body，断言直接读 DOM。
  const mountDrawer = (props: Record<string, unknown> = {}, slots: Record<string, unknown> = {}) =>
    track(
      mount(DetailDrawer, {
        props: { open: true, title: '企业详情', description: '查看这家企业的全部认定历史。', ...props },
        slots: { default: '<p data-testid="drawer-body">正文</p>', ...slots },
        attachTo: document.body,
      }),
    )
  const content = () => document.querySelector<HTMLElement>('[data-slot="sheet-content"]')!
  const body = () => document.querySelector<HTMLElement>('[data-testid="drawer-body"]')!

  it('头部固定、正文独立滚动、底栏可选', async () => {
    const view = mountDrawer({}, { footer: '<button data-testid="drawer-footer">保存</button>' })
    await view.vm.$nextTick()
    expect(document.querySelector('[data-slot="sheet-title"]')?.textContent).toBe('企业详情')
    expect(document.querySelector('[data-slot="sheet-description"]')?.textContent).toContain('全部认定历史')

    const scrollArea = body().parentElement!
    expect(scrollArea.className).toContain('overflow-y-auto')
    expect(scrollArea.className).toContain('overscroll-contain')
    expect(scrollArea.className).toContain('flex-1')
    expect(scrollArea.className).toContain('min-h-0')

    const footer = document.querySelector('[data-testid="drawer-footer"]')!.parentElement!
    expect(footer.className).toContain('border-t')
    expect(scrollArea.contains(footer)).toBe(false)
  })

  it('宽度档位透传给 SheetContent，hideDescription 隐藏说明', async () => {
    const view = mountDrawer({ floatingSize: 'detail', hideDescription: true })
    await view.vm.$nextTick()
    expect(content().getAttribute('data-floating-drawer')).toBe('detail')
    // 视觉上隐藏，但仍留给读屏一个描述节点。
    const description = document.querySelector('[data-slot="sheet-description"]')!
    expect(description.className).toContain('sr-only')
    expect(description.textContent).toContain('全部认定历史')
  })

  it('preventClose 时关闭按钮收起，Esc 不触发关闭', async () => {
    const view = mountDrawer({ preventClose: true })
    await view.vm.$nextTick()
    expect(content().querySelector('button[aria-label="关闭"]')).toBeNull()

    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    document.dispatchEvent(escape)
    await view.vm.$nextTick()
    // 拦截体现在 cancelable 的 Esc 上：默认行为被阻止，Sheet 就不会关闭。
    expect(escape.defaultPrevented).toBe(true)
    expect(view.emitted('update:open')).toBeUndefined()
  })

  it('关闭时把状态写回调用方', async () => {
    const view = mountDrawer()
    await view.vm.$nextTick()
    const close = content().querySelector<HTMLElement>('button[aria-label="关闭"]')!
    expect(close).not.toBeNull()
    close.click()
    await view.vm.$nextTick()
    expect(view.emitted('update:open')).toEqual([[false]])
  })
})

describe('Input 尺寸档', () => {
  it('默认 36px，size="sm" 为 32px', () => {
    const normal = track(mount(Input, { props: { ariaLabel: '搜索' } }))
    expect(normal.classes()).toContain('h-9')
    expect(normal.attributes('data-size')).toBe('default')
    normal.unmount()

    const small = track(mount(Input, { props: { size: 'sm', ariaLabel: '搜索' } }))
    expect(small.classes()).toContain('h-8')
    expect(small.classes()).toContain('text-xs')
    expect(small.attributes('data-size')).toBe('sm')
  })
})
