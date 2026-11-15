// @vitest-environment happy-dom
import { createServer, get } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { PiniaColada } from '@pinia/colada'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { initializeDb, schema } from '../../../db/client'
import { captureIdentityRevision113, processEvidenceImpacts113 } from '../../../server/utils/evidence-impact-113'
import { closeReviewSnapshots114, impactList114, listImpacts114 } from '../../../server/utils/evidence-review-114'
import EvidenceReviewList from '../../../components/evidence-review/EvidenceReviewList.vue'
import { Select } from '../../../components/ui/select'

const dir = mkdtempSync(join(tmpdir(), 'review-275-'))
const db = initializeDb({ create: true,  dbPath: join(dir, 'synthetic.db') })
const enterprise = db.insert(schema.enterprise).values({ name: '合成目标企业', nameNorm: '合成目标企业' }).returning().get()
const other = db.insert(schema.enterprise).values({ name: '合成其他企业', nameNorm: '合成其他企业' }).returning().get()
captureIdentityRevision113(db, { enterpriseId: other.id, sourceKey: '275-other', sourceVersion: '1', before: {}, after: { name: other.name } })
const row = { id: 4, enterpriseId: enterprise.id, titleCode: 'specialized_sme', direction: 'missing_in_miit', decisionId: 82, latestRevisionId: 9, reviewedRevisionId: null, classification: 'premise_invalid', pending: true, lineage: 'current', oldDecision: { id: 82, status: 'not_queried', reasonNote: '合成原依据保留' } }
let mode: 'real' | 'rows' | 'failure' = 'real'
let release: (() => void) | undefined
let hold = false
let base: string
const requests: { method: string; url: string }[] = []
const server = createServer(async (req, res) => {
  requests.push({ method: req.method!, url: req.url! })
  if (hold) await new Promise<void>(resolve => { release = resolve })
  res.setHeader('content-type', 'application/json')
  res.setHeader('cache-control', 'no-store')
  if (mode === 'failure') { res.statusCode = 503; res.end(JSON.stringify({ secret: 'private upstream detail' })); return }
  const url = new URL(req.url!, 'http://local.invalid')
  if (url.pathname.endsWith('/profile')) { res.end(JSON.stringify({ profile: { enterpriseId: enterprise.id, name: enterprise.name } })); return }
  const input = Object.fromEntries([...url.searchParams].map(([key, value]) => [key, ['enterpriseId', 'limit'].includes(key) ? Number(value) : value]))
  const page = listImpacts114(db, impactList114.parse(input))
  res.end(JSON.stringify(mode === 'rows' ? { ...page, rows: [row], nextCursor: 'synthetic-page-2' } : page))
})
let view: VueWrapper
beforeAll(async () => {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})
beforeEach(() => {
  mode = 'real'; hold = false; requests.length = 0
  vi.stubGlobal('$fetch', async (path: string, options?: { query?: Record<string, string | number> }) => {
    const url = new URL(path, base)
    for (const [key, value] of Object.entries(options?.query ?? {})) url.searchParams.set(key, String(value))
    return new Promise((resolve, reject) => {
      get(url, response => {
        let body = ''
        response.setEncoding('utf8')
        response.on('data', chunk => { body += chunk })
        response.on('end', () => {
          if (response.statusCode !== 200) { reject(new Error('private upstream detail')); return }
          try { resolve(JSON.parse(body)) } catch (error) { reject(error) }
        })
      }).on('error', reject)
    })
  })
})
afterEach(() => { release?.(); release = undefined; view?.unmount(); vi.unstubAllGlobals() })
afterAll(async () => {
  closeReviewSnapshots114()
  await new Promise<void>(resolve => server.close(() => resolve()))
  db.$client.close(); rmSync(dir, { recursive: true, force: true })
})
function render() {
  view = mount(EvidenceReviewList, { props: { enterpriseId: enterprise.id }, global: { plugins: [createPinia(), PiniaColada], stubs: { NuxtLink: { props: ['to'], template: '<a :href="to"><slot /></a>' } } } })
  return view
}
async function settled(text: string) { await vi.waitFor(() => expect(view.text()).toContain(text)); await flushPromises() }
function button(text: string) { return view.findAll('button').find(b => b.text() === text)! }
function choose(label: string, value: string) {
  view.findAllComponents(Select).find(s => s.find(`[aria-label="${label}"]`).exists())!.vm.$emit('update:modelValue', value)
}
it('distinguishes HTTP 200 global unready from failure and a ready exact scope without implying enterprise readiness', async () => {
  render(); await settled('复核记录尚不能确认')
  expect(view.get('[data-testid="review-read-feedback"]').text()).toMatch(/已读取清单.*影响检查尚未完成/)
  expect(view.text()).toContain('检查条件可能超出当前企业范围')
  expect(view.text()).toContain('有权限的维护人员')
  expect(view.text()).not.toContain('尚未成功读取')
  expect(view.text()).not.toContain('读取失败')
  choose('称号筛选', 'little_giant'); choose('方向筛选', 'missing_in_miit')
  await view.get('form').trigger('submit'); await settled('当前筛选下没有复核项')
  expect(view.text()).not.toContain('该企业没有复核记录')
  expect(view.text()).not.toContain('影响检查尚未完成')
  choose('称号筛选', 'all'); choose('方向筛选', 'all')
  await view.get('form').trigger('submit'); await settled('检查条件可能超出当前企业范围')
  expect(requests.every(r => r.method === 'GET')).toBe(true)
  expect(db.select().from(schema.evidenceImpactProgress113).all().every(p => !p.done)).toBe(true)
})
it('makes repeated rereads observable while HTTP success remains unready', async () => {
  render(); await settled('复核记录尚不能确认')
  hold = true
  await button('重新读取清单').trigger('click')
  await settled('正在重新读取清单')
  expect(view.text()).not.toContain('该企业没有复核记录')
  await vi.waitFor(() => expect(release).toBeTypeOf('function'))
  hold = false; release!(); release = undefined
  await settled('第 2 次成功读取')
  expect(view.text()).toContain('影响检查仍未完成')
  expect(view.text()).not.toContain('尚未成功读取')
  await button('重新读取清单').trigger('click'); await settled('第 3 次成功读取')
})
it('keeps original rows and source page on failed target then recovers without exposing private errors', async () => {
  mode = 'rows'; render(); await settled('合成原依据保留')
  expect(view.text()).toContain('检查条件可能超出当前企业范围')
  mode = 'failure'
  await view.get('[aria-label="下一页复核项"]').trigger('click'); await settled('复核清单读取失败')
  expect(view.text()).toContain('合成原依据保留')
  expect(view.text()).toContain('显示来源：第 1 页')
  expect(view.text()).toContain('保留上次成功读取的内容')
  expect(view.text()).not.toContain('private upstream detail')
  mode = 'rows'
  // Recovery begins at page one because the synthetic second-page cursor is not a real API cursor.
  await button('从第一页重新读取').trigger('click'); await settled('第 2 次成功读取')
  expect(view.text()).not.toContain('复核清单读取失败')
  expect(view.text()).toContain('合成原依据保留')
})
it('does not invent a retained page or empty result on initial HTTP failure and recovers to a ready empty scope', async () => {
  mode = 'failure'; render(); await settled('复核清单读取失败')
  expect(view.text()).toContain('尚无成功读取的清单')
  expect(view.text()).not.toContain('显示上次成功')
  expect(view.find('[data-testid="review-empty"]').exists()).toBe(false)
  mode = 'real'; choose('称号筛选', 'little_giant'); choose('方向筛选', 'missing_in_miit')
  await view.get('form').trigger('submit'); await settled('当前筛选下没有复核项')
  expect(view.text()).not.toContain('复核清单读取失败')
})

it('reports enterprise empty only after the actual global check is ready', async () => {
  processEvidenceImpacts113(db, { limit: 100 })
  render(); await settled('该企业没有复核记录')
  expect(view.text()).toContain('当前、历史、撤回与归并均未返回记录')
  expect(view.text()).not.toContain('复核记录尚不能确认')
  expect(view.text()).not.toContain('读取失败')
  expect(requests.every(r => r.method === 'GET')).toBe(true)
})
