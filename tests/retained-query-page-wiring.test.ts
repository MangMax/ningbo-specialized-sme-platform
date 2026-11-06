import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const pages = [
  { name: '文件列表', path: 'pages/files.vue', namespace: 'files' },
] as const

describe('列表查询快照接入', () => {
  it.each(pages)('$name 将响应绑定到发起请求时的查询参数', ({ path, namespace }) => {
    const source = readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

    expect(source).toContain(`captureQueryRequest('${namespace}', entry.key[1]`)
    expect(source).toContain('{ query: request.params }')
    expect(source).toContain('return { ...response, request }')
    expect(source).toContain('useRetainedQuerySnapshot<')
  })

  it.each(pages)('$name 的行、页码、计数和失败来源来自同一成功快照', ({ path }) => {
    const source = readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

    expect(source).toContain('displayedResult.value')
    expect(source).toContain('displayedResult.value?.request.page')
    expect(source).toContain('displayedResult.value?.request.pageSize')
    expect(source).toContain(':description="failureDescription"')
    expect(source).toContain(':loading="paginationDisabled"')
    expect(source).toContain(':page="displayedPage"')
    expect(source).toContain(':page-size="displayedPageSize"')
  })
})
