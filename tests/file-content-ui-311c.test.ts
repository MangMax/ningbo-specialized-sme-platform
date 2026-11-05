import { expect, it } from 'vitest'
import { describeFetchError } from '../lib/upload-register'
import { describeLoadError } from '../lib/preview'
it('content conflict and unknown are human messages through upload and preview seams', () => {
  expect(describeFetchError({ data: { data: { code: 'file_content_conflict' } } })).toContain('内容已变化')
  expect(describeLoadError(new Error('409'))).toContain('内容已变化')
  expect(describeFetchError({ data: { message: 'file_content_unknown' } })).toContain('待核实')
})

import { currentContentMessage, historicalContentMessage } from '../lib/file-content-status'
it('current verification never certifies unknown or captured historical provenance', () => {
  expect(currentContentMessage({ status: 'verified' })).toBe('当前文件内容与登记一致。')
  expect(historicalContentMessage()).toContain('原始内容绑定未知')
  expect(historicalContentMessage({ status: 'captured' })).toContain('不证明完整历史文件内容')
  expect(currentContentMessage({ status: 'missing' })).toContain('源文件不存在')
  expect(currentContentMessage({ status: 'unavailable' })).toContain('检查读取权限')
})
