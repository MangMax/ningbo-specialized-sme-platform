// @vitest-environment happy-dom
import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import PageImageGallery from '../components/preview/PageImageGallery.vue'
import { DPI_PRESETS } from '../lib/page-gallery'

/**
 * 页图库的**分辨率下拉**(组件级;与同目录的 `page-gallery.test.ts` 分开 ——
 * 那份是纯规则、跑在 node 环境,这份要挂组件)。
 *
 * 缺陷(盲 UI 复核):磁盘清单的 DPI 可以是 **72–600 的任意整数**,而下拉只列 150/200/300。
 * 组件 `load()` 会把 `dpi.value` 设成磁盘值,于是「当前值不在预设里」时
 * **`SelectValue` 在选项里找不到匹配项、触发器空着** —— 用户看不到「现在是多少」。
 * 选一个预设后触发器才正常。
 *
 * 修法:当前值不在预设里时,选项表**多列一条同值的只读项**(`120 DPI(当前)`),
 * 只用于显示,**不给选**;`dpi.value` 保持 120,不改写成默认值。
 */

const file = 'jxj/announcement/2022/公布.pdf'

/** 一份最小现状(与 `loadPageGalleryState` 返回的 `state` 同形)。 */
function stateAt(dpi: number) {
  return {
    file,
    pageCount: 1,
    dpi,
    rendered: 1,
    upToDate: true,
    manifest: { dpi, renderedAt: '2026-10-15T00:00:00.000Z' },
    pages: [
      {
        page: 1,
        relPath: 'jxj/announcement/2022/.公布.pdf.pages/p001.png',
        url: '/api/files/jxj/announcement/2022/.%E5%85%AC%E5%B8%83.pdf.pages/p001.png',
        width: 1653,
        height: 2339,
        bytes: 100,
      },
    ],
  }
}

/** 挂出页图库;取图走全局 `$fetch`,测试里给一个最小桩。 */
async function openGallery(dpi: number) {
  vi.stubGlobal('$fetch', vi.fn(async () => stateAt(dpi)))
  const gallery = mount(PageImageGallery, { props: { file }, attachTo: document.body })
  await new Promise((r) => setTimeout(r, 0))
  await gallery.vm.$nextTick()
  return gallery
}

afterEach(() => {
  vi.unstubAllGlobals()
})

/**
 * 打开下拉并读选项。
 *
 * reka-ui 的 `SelectTrigger` 是 **`pointerdown`** 打开的(via `click` 在 happy-dom 下不会展开),
 * 而且内容在 portal 里 —— 所以要 `attachTo` 到 body,再查**文档**而不是组件包装器。
 */
async function openSelect(gallery: Awaited<ReturnType<typeof openGallery>>) {
  const trigger = gallery.find('[aria-label="页图分辨率"]')
  trigger.element.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, ctrlKey: false }))
  await new Promise((r) => setTimeout(r, 10))
  await gallery.vm.$nextTick()
  return [...document.querySelectorAll<HTMLElement>('[role="option"]')]
}

/** 触发器当前显示的文本(读屏与视觉都看它)。 */
function triggerText(gallery: Awaited<ReturnType<typeof openGallery>>): string {
  const trigger = gallery.find('[aria-label="页图分辨率"]')
  return trigger.exists() ? trigger.text() : ''
}

describe('页图库分辨率下拉:非预设的当前 DPI', () => {
  it('当前是预设(200)时:触发器显示 200 DPI,选项只有三个预设', async () => {
    const gallery = await openGallery(200)
    expect(triggerText(gallery)).toContain('200 DPI')

    const items = await openSelect(gallery)
    expect(items).toHaveLength(DPI_PRESETS.length)
    expect(items.map((i) => i.textContent?.trim())).toEqual(DPI_PRESETS.map((d) => `${d} DPI`))
  })

  it('当前是**非预设**(120)时:触发器**不空**,明确显示 120 DPI', async () => {
    const gallery = await openGallery(120)
    // 缺陷就出在这里:选项里没有 120,触发器会渲染成空串。
    expect(triggerText(gallery)).toContain('120')
    expect(triggerText(gallery)).not.toBe('')
  })

  it('非预设时选项表多一条**只读**的「120 DPI(当前)」,三个预设都还在', async () => {
    const gallery = await openGallery(120)
    const items = await openSelect(gallery)
    const labels = items.map((i) => i.textContent?.trim())
    expect(labels).toHaveLength(DPI_PRESETS.length + 1)
    // 三个预设原样都在。
    for (const d of DPI_PRESETS) expect(labels).toContain(`${d} DPI`)
    // 当前值那条带 `(当前)` 后缀,且**被禁用**(只显示、不给选)。
    const current = items.find((i) => i.textContent?.includes('(当前)'))!
    expect(current.textContent?.trim()).toBe('120 DPI(当前)')
    expect(current.getAttribute('data-disabled')).not.toBeNull()
  })

  it('`pickDpi` 仍然只认预设 —— 程序化塞一个任意值不会改动 dpi', async () => {
    const gallery = await openGallery(120)
    const vm = gallery.vm as unknown as { dpi: number; pickDpi: (v: unknown) => void }

    vm.pickDpi('137')
    await gallery.vm.$nextTick()
    expect(vm.dpi).toBe(120) // 任意值被拒,当前值**没被悄悄改写成默认**

    vm.pickDpi('300')
    await gallery.vm.$nextTick()
    expect(vm.dpi).toBe(300) // 预设照常生效
  })
})
