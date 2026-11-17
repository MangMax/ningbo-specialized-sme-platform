// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { Toaster, toast } from 'vue-sonner'
import UploadDialog from '../../../components/files/UploadDialog.vue'
import type { UploadedFile } from '../../../lib/upload-register'
import type { UploadFailure } from '../../../lib/upload'

// Happy DOM lacks WAAPI; exercise vue-sonner's JS fallback (same setup as
// tests/ui/settings/credential-controls.ui.test.ts).
const nativeAnimate = Object.getOwnPropertyDescriptor(Element.prototype, 'animate')
beforeAll(() => { Reflect.deleteProperty(Element.prototype, 'animate') })
afterAll(() => { if (nativeAnimate) Object.defineProperty(Element.prototype, 'animate', nativeAnimate) })

function toastText() {
  return [...document.querySelectorAll('[data-sonner-toast]')].map(el => el.textContent ?? '').join('\n')
}
async function see(expected: string) {
  await vi.waitFor(() => expect(toastText()).toContain(expected))
}
function toastRetryButton() {
  return [...document.querySelectorAll('[data-sonner-toast] button')]
    .find(el => el.textContent?.includes('重试')) as HTMLButtonElement | undefined
}
/** 弹窗内容 teleport 到 body;在 body 里找替身按钮(与 physical.ui.test.ts 同一套路)。 */
const emitButton = (testid: string) =>
  document.body.querySelector<HTMLButtonElement>(`[data-testid="${testid}"]`)!

const uploaded: UploadedFile = {
  name: '名单.pdf',
  relPath: 'jxj/announcement/2024/1/名单.pdf',
  size: 123,
  meta: { source: 'jxj', kind: 'announcement', year: '2024', batch: '1', filename: '名单.pdf' },
}
const networkFailure: UploadFailure = { kind: 'network', message: '连接中断,字节没有送到服务端。' }
const invalidFailure: UploadFailure = { kind: 'invalid', message: '落位信息不合规,服务端拒绝了这次上传。' }

/**
 * 透传替身:用模块级 `payload` emit uploaded/error,等价于面板里
 * 真实的一次上传完成/失败;测试改 `payload` 字段即换失败类型。
 */
const payload = { uploaded, failure: networkFailure as UploadFailure }
const UploadPanelStub = {
  emits: ['uploaded', 'error'],
  setup(_: unknown, { emit }: { emit: (e: string, v?: unknown) => void }) {
    return {
      done: () => emit('uploaded', payload.uploaded),
      err: () => emit('error', { name: payload.uploaded.name, failure: payload.failure }),
    }
  },
  template: '<button data-testid="emit-uploaded" @click="done">done</button><button data-testid="emit-error" @click="err">err</button>',
}

describe('上传登记写路径操作反馈', () => {
  let view: ReturnType<typeof mount>
  let toaster: ReturnType<typeof mount>
  let fetch: ReturnType<typeof vi.fn>

  function open() {
    fetch = vi.fn(async () => ({}))
    vi.stubGlobal('$fetch', fetch)
    toaster = mount(Toaster, { attachTo: document.body })
    view = mount(UploadDialog, {
      attachTo: document.body,
      props: { open: true },
      global: { stubs: { UploadPanel: UploadPanelStub } },
    })
  }
  afterEach(() => { view?.unmount(); toast.dismiss(); toaster?.unmount(); document.body.innerHTML = ''; vi.unstubAllGlobals(); vi.restoreAllMocks() })

  it('登记成功给出成功 toast 并 emit registered;登记失败给出带「重试」的失败 toast', async () => {
    open()
    await flushPromises()
    payload.failure = networkFailure
    emitButton('emit-uploaded').click()
    await flushPromises()
    expect(fetch).toHaveBeenCalledWith('/api/files/register', expect.objectContaining({ method: 'POST' }))
    expect(view.emitted('registered')).toBeTruthy()
    await see('已上传文件「名单.pdf」')

    // 登记失败 → 失败 toast 带重试;点重试重发同一 register 请求
    fetch.mockRejectedValueOnce(Object.assign(new Error('db'), { data: { message: '写入失败' } }))
    emitButton('emit-uploaded').click()
    await flushPromises()
    await see('登记文件「名单.pdf」失败')
    expect(toastText()).toContain('写入失败')
    const retry = toastRetryButton()
    expect(retry, '失败 toast 必须带「重试」动作').toBeTruthy()
    fetch.mockResolvedValueOnce({})
    const before = fetch.mock.calls.length
    retry!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushPromises()
    expect(fetch.mock.calls.length).toBe(before + 1)
  })

  it('传输阶段失败给出失败 toast,网络类指引断点续传、落位被拒指引修正声明', async () => {
    open()
    await flushPromises()
    payload.failure = networkFailure
    emitButton('emit-error').click()
    await flushPromises()
    await see('上传文件「名单.pdf」失败')
    expect(toastText()).toContain('重试」从断点续传')
    toast.dismiss()

    // 落位被拒 → 指引改成「修正落位信息」,不引导续传
    payload.failure = invalidFailure
    emitButton('emit-error').click()
    await flushPromises()
    await vi.waitFor(() => expect(toastText()).toContain('修正落位信息'))
  })
})
