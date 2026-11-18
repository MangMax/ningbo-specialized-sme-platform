import { expect, it } from 'vitest'
import { selectBusinessTests } from '../../../scripts/select-business-tests.mjs'
import { matrices } from '../../../scripts/business-test-groups.mjs'

it('selects the owning business for a test without running unrelated groups', () => {
  const result = selectBusinessTests(['tests/logging/core/foundation.test.ts'])
  expect(result.full).toBe(false)
  expect(result.native.map(row => row.business)).toEqual(['日志 · 审计'])
  expect(result.app.map(row => row.business)).toEqual(['日志 · 审计'])
  expect(result.upgrade).toBe(false)
})

it('keeps platform qualification facts in the existing qualification business group', () => {
  const result = selectBusinessTests(['tests/roster/platform-qualification/facts.test.ts'])
  expect(result.full).toBe(false)
  expect(result.native.map(row => row.business)).toEqual(['名录 · 资格与认定读取'])
  expect(result.app.map(row => row.business)).toEqual(['名录 · 资格与认定读取'])
})

it('keeps shared qualification consumers and unknown or deleted paths in full coverage', () => {
  for (const path of ['layers/sme-roster/lib/roster/qualification-cycles.ts', 'db/schema.ts', 'tests/support/new-helper.ts', 'server/api/statistics/deleted.get.ts', 'new-module.ts', 'pnpm-lock.yaml']) {
    const result = selectBusinessTests([path])
    expect(result.full, path).toBe(true)
    expect(result.native).toEqual(matrices(true).native)
    expect(result.ttl).toBe(true)
    expect(result.watcher).toBe(true)
  }
})

it('selects statistics HTTP behavior with interface and logging coverage', () => {
  const result = selectBusinessTests(['server/api/statistics/annual.get.ts'])
  expect(result.full).toBe(false)
  expect(new Set(result.app.map(row => row.business))).toEqual(new Set(['统计 · 称号统计', '运行环境 · 界面与基础设施', '日志 · 审计', '名录 · 导入与证据', '名录 · 资格与认定读取', '文件 · 存储、OCR识别、解析与预览']))
  expect(result.skipped).toContain('应用进程 · 名录 · 工作簿导出')
})

it('keeps full coverage on main, nightly and manual runs even with no changed paths', () => {
  for (const event of ['push', 'schedule', 'workflow_dispatch']) {
    const result = selectBusinessTests([], event)
    expect(result.native).toEqual(matrices(true).native)
    expect(result.app.length).toBe(matrices(true).app.length + 2)
    expect(result.skipped).toEqual([])
  }
})

it('leaves documentation-only PR test matrices empty and unions separate business edits', () => {
  const docs = selectBusinessTests(['docs/agents/testing.md'])
  expect(docs.native).toEqual([])
  expect(docs.app).toEqual([])
  const mixed = selectBusinessTests(['tests/logging/core/foundation.test.ts', 'server/api/statistics/annual.get.ts'])
  expect(mixed.app.filter(row => row.business === '日志 · 审计')).toHaveLength(1)
  expect(mixed.app.some(row => row.business === '统计 · 称号统计')).toBe(true)
})
