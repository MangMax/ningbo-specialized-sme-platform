// @vitest-environment happy-dom
// A cancel request is only a request.
//
// The detail card used to report the *moment* the request was accepted
// ("任务尚未进入取消终态") and keep that sentence on screen for ever, so a task
// that had already reached the cancelled terminal state still looked like it was
// waiting. These cases drive the real component with a mocked server and check
// that the card's report agrees with the terminal state the server reports.
//
// The seam is the card a person reads: the mocked server only decides *what the
// server says*, never the component's internals — no private ref is written.
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import TaskDetail from '../../../components/tasks/TaskDetail.vue'
import TableFailureState from '../../../components/TableFailureState.vue'
import TaskProgress from '../../../components/tasks/TaskProgress.vue'
import type { TaskSummary } from '~~/lib/task-center'

const TASK_ID = '01M5BEPVCXD5619ZW4C6CATMWX'

function platformTask(state: TaskSummary['state']): TaskSummary {
  return {
    id: TASK_ID,
    kind: 'platform-query-batch',
    label: '平台批量查询',
    module: 'sme-roster', group: 'platform',
    state,
    createdAt: '2026-10-20T01:27:12.029Z',
    startedAt: '2026-10-20T01:27:12.030Z',
    finishedAt: state === 'running' ? null : '2026-10-20T01:27:12.515Z',
    progress: { done: 1, total: 10, unit: '项', stage: '平台批量查询' },
    error: null,
    outcome: null,
    capabilities: { cancel: state === 'queued' || state === 'running', retry: false, retryItemIds: [], reason: '可请求取消；实际状态以服务端终态为准。' },
    links: [],
  }
}

/** What the server currently says, and how many reads have landed. */
let serverTask: TaskSummary
let reads: number
let cancelPosts: number

function installFetch() {
  vi.stubGlobal('$fetch', vi.fn(async (url: string, options: { method?: string } = {}) => {
    if (options.method === 'POST') {
      cancelPosts++
      // The server accepts the request; the running task keeps running until its
      // next checkpoint. The card must not claim a terminal state here.
      return { cancelRequested: true }
    }
    reads++
    return serverTask
  }))
}

const mounted: ReturnType<typeof mount>[] = []
beforeEach(() => {
  HTMLElement.prototype.scrollIntoView = vi.fn()
  // Nuxt supplies this composable in the app; this isolated mount has no app plugins.
  vi.stubGlobal('useNuxtApp', () => ({}))
  serverTask = platformTask('running')
  reads = 0
  cancelPosts = 0
  installFetch()
})
afterEach(() => {
  for (const view of mounted.splice(0)) view.unmount()
  vi.unstubAllGlobals()
})

function mountDetail() {
  const view = mount(TaskDetail, {
    props: { id: TASK_ID, token: 'admin-key' },
    global: {
      components: {
        TableFailureState,
        TaskProgress,
        NuxtLink: { template: '<a><slot /></a>' },
      },
    },
    attachTo: document.body,
  })
  mounted.push(view)
  return view
}

/** The card's own report line (the one a screen reader would read out). */
function report(view: ReturnType<typeof mount>): string {
  const node = view.find('[data-testid="task-notice"]')
  if (node.exists()) return node.text()
  // The notice paragraph carries its own test id; before it does, the report is
  // still findable by its role, so a failure shows the real sentence.
  return view.findAll('p[role="status"]')
    .filter(paragraph => !/正在读取/.test(paragraph.text()))
    .map(paragraph => paragraph.text())
    .join(' ')
}

/** Wait for a condition, flushing the DOM after every tick. */
async function until(predicate: () => boolean, timeoutMs = 8000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    await flushPromises()
    if (predicate()) return true
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  await flushPromises()
  return predicate()
}

async function requestCancel(view: ReturnType<typeof mount>) {
  const button = view.findAll('button').find(candidate => candidate.text().includes('请求取消'))
  if (!button) throw new Error(`请求取消按钮不存在：${view.findAll('button').map(candidate => candidate.text()).join(' | ')}`)
  await button.trigger('click')
  await flushPromises()
}

describe('取消请求后的状态说明', () => {
  it('请求取消被受理后如实等待检查点，任务到达已取消终态时不再说“尚未进入取消终态”', async () => {
    const view = mountDetail()
    await until(() => reads > 0)
    expect(view.text()).toContain('运行中')

    // The person asks for a cancel; the server accepts the request but the task
    // keeps running until its next checkpoint.
    await requestCancel(view)
    expect(cancelPosts).toBe(1)
    expect(report(view)).toContain('尚未进入取消终态')
    // The button says the request is in, and the task is still running.
    expect(view.findAll('button').some(button => button.text() === '已请求取消')).toBe(true)
    expect(view.text()).toContain('运行中')

    // The checkpoint arrives: the server now reports the cancelled terminal state.
    serverTask = platformTask('cancelled')
    const readsBefore = reads
    await until(() => reads > readsBefore)
    await until(() => view.text().includes('已取消'))

    // The stale sentence is gone and the terminal state is stated truthfully.
    expect(report(view)).not.toContain('尚未进入取消终态')
    expect(report(view)).toContain('已取消')
    expect(view.text()).not.toContain('尚未进入取消终态')
  })

  it('任务先结束而不是被取消时，不谎称已取消', async () => {
    const view = mountDetail()
    await until(() => reads > 0)

    await requestCancel(view)
    expect(report(view)).toContain('尚未进入取消终态')

    // The race went the other way: the task finished before the checkpoint.
    serverTask = platformTask('done')
    const readsBefore = reads
    await until(() => reads > readsBefore)
    await until(() => view.text().includes('已完成'))

    // Nothing on the card claims the task was cancelled.
    expect(view.text()).not.toContain('已取消')
    expect(view.text()).not.toContain('尚未进入取消终态')
    expect(report(view)).toMatch(/取消/)
  })

  it('失败的任务也不会被说成已取消', async () => {
    const view = mountDetail()
    await until(() => reads > 0)

    await requestCancel(view)
    serverTask = platformTask('failed')
    const readsBefore = reads
    await until(() => reads > readsBefore)
    await until(() => view.text().includes('失败'))

    expect(view.text()).not.toContain('已取消')
    expect(view.text()).not.toContain('尚未进入取消终态')
  })
})
