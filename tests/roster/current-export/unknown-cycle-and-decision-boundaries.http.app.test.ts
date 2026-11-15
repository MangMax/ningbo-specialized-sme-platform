import { afterAll, beforeAll, expect, it } from 'vitest'
import { specializedExportFixture } from './fixtures/specialized-export'
const f = specializedExportFixture()
beforeAll(() => f.start(), 90000)
afterAll(f.close)
it('公开能力发现只列实际已部署专用POST且不创建任务', async () => {
  const before = await f.json(await fetch(f.url('/api/jobs?kind=current-roster-export')))
  const response = await fetch(f.url('/api/roster/exports/current/capabilities'))
  expect(response.status).toBe(200)
  expect(response.headers.get('cache-control')).toBe('no-store')
  const capability = await response.json()
  expect(capability).toEqual({ exports: [
    {titleCode:'little_giant',path:'/api/roster/exports/current/little-giant',ready:true},
    {titleCode:'specialized_sme',path:'/api/roster/exports/current/specialized-sme',ready:true},
    {titleCode:'innovative_sme',path:'/api/roster/exports/current/innovative-sme',ready:true},
  ] })
  const after = await f.json(await fetch(f.url('/api/jobs?kind=current-roster-export')))
  expect(after.total).toBe(before.total)
},60000)
