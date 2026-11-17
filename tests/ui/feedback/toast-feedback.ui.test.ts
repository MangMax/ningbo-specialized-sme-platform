// @vitest-environment happy-dom
import { mount } from '@vue/test-utils'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { Toaster, toast } from 'vue-sonner'
import { useToastFeedback } from '../../../composables/useToastFeedback'

// Happy DOM lacks WAAPI; exercise vue-sonner's JS fallback (same setup as
// tests/ui/settings/credential-controls.ui.test.ts).
const nativeAnimate = Object.getOwnPropertyDescriptor(Element.prototype, 'animate')
beforeAll(() => { Reflect.deleteProperty(Element.prototype, 'animate') })
afterAll(() => { if (nativeAnimate) Object.defineProperty(Element.prototype, 'animate', nativeAnimate) })

let toaster: ReturnType<typeof mount>
function text() { return [...document.querySelectorAll('[data-sonner-toast]')].map(el => el.textContent ?? '').join('\n') }
async function see(expected: string) {
  await vi.waitFor(() => expect(text()).toContain(expected))
}

describe('写路径统一操作反馈', () => {
  beforeAll(() => { toaster = mount(Toaster, { attachTo: document.body }) })
  afterAll(() => toaster.unmount())
  afterEach(() => toast.dismiss())

  it('成功提示按「动词+对象+结果」行文', async () => {
    const feedback = useToastFeedback()
    feedback.succeed('上传', '文件')
    await see('已上传文件')
    expect(text()).not.toContain('失败')
  })

  it('失败提示给出说明与「重试」动作,点击重跑同一回调', async () => {
    const feedback = useToastFeedback()
    const retry = vi.fn()
    feedback.fail('保存', '文件信息', '网络连接中断', retry)
    await see('保存文件信息失败')
    expect(text()).toContain('网络连接中断')
    const button = [...document.querySelectorAll('[data-sonner-toast] button')]
      .find(el => el.textContent?.includes('重试'))
    expect(button, '失败 toast 必须带「重试」动作').toBeTruthy()
    button!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(retry).toHaveBeenCalledTimes(1)
  })

  it('失败说明为空时给默认排查指引', async () => {
    const feedback = useToastFeedback()
    feedback.fail('删除', '文件')
    await see('删除文件失败')
    expect(text()).toContain('重试')
  })
})
