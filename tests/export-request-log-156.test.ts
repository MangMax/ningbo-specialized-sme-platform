// @vitest-environment happy-dom
import { mount } from '@vue/test-utils'
import { createSSRApp, defineComponent, h } from 'vue'
import { renderToString } from 'vue/server-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { useExportRequestLog } from '../composables/useExportRequestLog'

const KEY = 'task-center-export-requests-v1'
const REQUEST = '11111111-1111-4111-8111-111111111111'
const NEW_REQUEST = '22222222-2222-4222-8222-222222222222'
const JOB = '01M5BEPVCXD5619ZW4C6CATRET'
const mounted: ReturnType<typeof mount>[] = []
afterEach(() => { mounted.splice(0).forEach(w => w.unmount()); vi.unstubAllGlobals(); vi.restoreAllMocks(); sessionStorage.clear() })
function log() {
  let requestLog!: ReturnType<typeof useExportRequestLog>
  const wrapper = mount(defineComponent({ setup() { requestLog = useExportRequestLog(); return () => h('div') } }))
  mounted.push(wrapper)
  return requestLog
}

it('failed forget leaves the in-memory UUID and durable intent available', () => {
  const requests = log()
  requests.remember('little_giant:initial', { clientRequestId: REQUEST })
  const storage = sessionStorage
  vi.stubGlobal('sessionStorage', { getItem: storage.getItem.bind(storage), setItem: () => { throw new Error('quota') } })
  expect(() => requests.forget('little_giant:initial', REQUEST)).toThrow('quota')
  expect(requests.entries.value['little_giant:initial']).toEqual({ clientRequestId: REQUEST })
  expect(JSON.parse(storage.getItem(KEY)!)['little_giant:initial']).toEqual({ clientRequestId: REQUEST })
})

it('stale writes preserve newer identities and accepted job receipts from other logs', () => {
  const stale = log(), newer = log()
  stale.remember('little_giant:initial', { clientRequestId: REQUEST })
  newer.forget('little_giant:initial', REQUEST)
  newer.remember('little_giant:initial', { clientRequestId: NEW_REQUEST, jobId: JOB })
  stale.remember('little_giant:initial', { clientRequestId: REQUEST, jobId: '01M5BEPVCXD5619ZW4C6CATREV' })
  expect(log().entries.value['little_giant:initial']).toEqual({ clientRequestId: NEW_REQUEST, jobId: JOB })
  stale.remember('little_giant:initial', { clientRequestId: NEW_REQUEST })
  expect(log().entries.value['little_giant:initial']).toEqual({ clientRequestId: NEW_REQUEST, jobId: JOB })
})

it('SSR requests start empty without accessing browser storage or sharing a mounted client log', async () => {
  log().remember('little_giant:initial', { clientRequestId: REQUEST, jobId: JOB })
  const read = vi.fn(() => { throw new Error('browser storage on server') })
  vi.stubGlobal('sessionStorage', { getItem: read })
  const App = defineComponent({ setup() {
    const requests = useExportRequestLog()
    return () => h('p', JSON.stringify(requests.entries.value))
  } })
  expect(await Promise.all([renderToString(createSSRApp(App)), renderToString(createSSRApp(App))])).toEqual(['<p>{}</p>', '<p>{}</p>'])
  expect(read).not.toHaveBeenCalled()
})
