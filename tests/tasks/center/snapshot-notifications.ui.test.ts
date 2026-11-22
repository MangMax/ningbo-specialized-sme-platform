// @vitest-environment jsdom
import { mount, type VueWrapper } from '@vue/test-utils'
import { defineComponent, h, ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useTaskSnapshot } from '#core/app/composables/useTaskSnapshot'

class TaskEvents extends EventTarget {
  static connections: TaskEvents[] = []
  close = vi.fn()

  constructor(readonly url: string) {
    super()
    TaskEvents.connections.push(this)
  }

  send(type: 'ready' | 'changed' | 'error' | 'open') {
    this.dispatchEvent(new Event(type))
  }
}

const mounted: VueWrapper[] = []
type Snapshot = { status: string; expiresAt?: number }

function view(load: (signal: AbortSignal) => Promise<Snapshot>, initialKey = 'current') {
  const key = ref(initialKey)
  const wrapper = mount(defineComponent({
    setup() {
      const { data, failed, refresh } = useTaskSnapshot(key, load, result => result.expiresAt ?? Infinity)
      return () => h('div', [
        h('output', data.value?.status),
        failed.value ? h('button', { onClick: refresh }, '重新读取') : null,
      ])
    },
  }))
  mounted.push(wrapper)
  return { wrapper, key }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  vi.stubGlobal('EventSource', TaskEvents)
  TaskEvents.connections = []
})

afterEach(() => {
  mounted.splice(0).reverse().forEach(wrapper => wrapper.unmount())
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('task snapshot notifications', () => {
  it('shares one stream on demand and resumes polling until the next ready event', async () => {
    const listRead = vi.fn().mockResolvedValue({ status: '排队中' })
    const detailRead = vi.fn().mockResolvedValue({ status: '运行中' })
    view(listRead, '')
    expect(TaskEvents.connections).toHaveLength(0)
    view(listRead)
    view(detailRead)
    expect(TaskEvents.connections.map(source => source.url)).toEqual(['/api/task-center/events'])
    const source = TaskEvents.connections[0]!
    source.send('open')
    await vi.advanceTimersByTimeAsync(3000)
    expect(listRead).toHaveBeenCalledTimes(2)
    expect(detailRead).toHaveBeenCalledTimes(2)

    source.send('ready')
    await vi.advanceTimersByTimeAsync(9000)
    expect(listRead).toHaveBeenCalledTimes(3)
    expect(detailRead).toHaveBeenCalledTimes(3)
    source.send('error')
    await vi.advanceTimersByTimeAsync(2500)
    source.send('error')
    await vi.advanceTimersByTimeAsync(500)
    expect(listRead).toHaveBeenCalledTimes(4)

    source.send('ready')
    await vi.advanceTimersByTimeAsync(9000)
    expect(listRead).toHaveBeenCalledTimes(5)
    mounted.pop()!.unmount()
    expect(source.close).not.toHaveBeenCalled()
    window.dispatchEvent(new Event('pagehide'))
    expect(source.close).toHaveBeenCalledOnce()
    source.send('ready')
    await vi.advanceTimersByTimeAsync(9000)
    expect(listRead).toHaveBeenCalledTimes(5)
    window.dispatchEvent(new Event('pageshow'))
    await vi.advanceTimersByTimeAsync(0)
    expect(TaskEvents.connections).toHaveLength(2)
    expect(listRead).toHaveBeenCalledTimes(6)
  })

  it('coalesces bursts and reads again after invalidation during a request', async () => {
    const read = vi.fn<(signal: AbortSignal) => Promise<Snapshot>>()
    let resolve!: (value: Snapshot) => void
    read.mockResolvedValueOnce({ status: '排队中' })
      .mockImplementationOnce(() => new Promise(done => { resolve = done }))
      .mockResolvedValue({ status: '已完成' })
    const { wrapper } = view(read)
    const source = TaskEvents.connections[0]!
    source.send('ready')
    for (let i = 0; i < 10; i++) source.send('changed')
    await vi.advanceTimersByTimeAsync(250)
    expect(read).toHaveBeenCalledTimes(2)
    expect(wrapper.text()).toBe('排队中')

    for (let i = 0; i < 10; i++) source.send('changed')
    await vi.advanceTimersByTimeAsync(3000)
    expect(read).toHaveBeenCalledTimes(2)
    expect(read.mock.calls[1]![0].aborted).toBe(false)
    resolve({ status: '运行中' })
    await vi.advanceTimersByTimeAsync(250)
    expect(read).toHaveBeenCalledTimes(3)
    expect(wrapper.text()).toBe('已完成')
  })

  it('keeps the last result on failure and allows manual and automatic retries', async () => {
    const read = vi.fn().mockResolvedValueOnce({ status: '排队中' })
      .mockRejectedValueOnce(Error('read failed'))
      .mockRejectedValueOnce(Error('retry failed'))
      .mockResolvedValue({ status: '已完成' })
    const { wrapper } = view(read)
    const source = TaskEvents.connections[0]!
    source.send('ready')
    await vi.advanceTimersByTimeAsync(250)
    expect(wrapper.get('output').text()).toBe('排队中')
    await wrapper.get('button').trigger('click')
    await vi.advanceTimersByTimeAsync(0)
    expect(wrapper.get('output').text()).toBe('排队中')
    source.send('changed')
    await vi.advanceTimersByTimeAsync(3999)
    expect(read).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(1)
    expect(wrapper.text()).toBe('已完成')
    expect(wrapper.find('button').exists()).toBe(false)
  })

  it('refreshes at artifact expiry without a task event or periodic polling', async () => {
    const expiresAt = Date.now() + 8000
    const read = vi.fn().mockImplementation(async () => Date.now() < expiresAt
      ? { status: '可下载', expiresAt }
      : { status: '已过期' })
    const { wrapper } = view(read)
    TaskEvents.connections[0]!.send('ready')
    await vi.advanceTimersByTimeAsync(7999)
    expect(read).toHaveBeenCalledTimes(2)
    expect(wrapper.text()).toBe('可下载')
    await vi.advanceTimersByTimeAsync(1)
    expect(wrapper.text()).toBe('已过期')
    await vi.advanceTimersByTimeAsync(9000)
    expect(read).toHaveBeenCalledTimes(3)
  })

  it('retains polling when the browser has no EventSource', async () => {
    vi.stubGlobal('EventSource', undefined)
    const read = vi.fn().mockResolvedValueOnce({ status: '排队中' }).mockResolvedValue({ status: '已完成' })
    const { wrapper } = view(read)
    await vi.advanceTimersByTimeAsync(3000)
    expect(wrapper.text()).toBe('已完成')
    expect(read).toHaveBeenCalledTimes(2)
  })
})
