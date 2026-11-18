import { describe, expect, it } from 'vitest'
import { taskCenterBrowserAllowed } from '../../../layers/core/server/utils/task-center-browser-auth'

const origin = 'http://127.0.0.1:3474'
const input = () => ({
  method: 'POST', serverOrigin: origin,
  headers: { 'x-task-center-browser': '1', 'sec-fetch-site': 'same-origin', origin, referer: `${origin}/tasks`, 'content-type': 'application/json' } as Record<string, string | undefined>,
})
describe('task page same-origin requests', () => {
  it('allows same-origin JSON commands without deployment config or API token', () => {
    expect(taskCenterBrowserAllowed(input())).toBe(true)
  })
  it('allows browser GET list, detail and artifact fetches without Origin', () => {
    const request = input(); request.method = 'GET'; delete request.headers.origin
    expect(taskCenterBrowserAllowed(request)).toBe(true)
  })
  it.each([
    ['x-task-center-browser', undefined], ['x-task-center-browser', '0'],
    ['sec-fetch-site', undefined], ['sec-fetch-site', 'same-site'], ['sec-fetch-site', 'cross-site'],
    ['origin', undefined], ['origin', 'null'], ['origin', 'http://evil.invalid'],
    ['origin', `${origin}/`], ['origin', 'http://127.0.0.1:3475'],
    ['content-type', 'text/plain'], ['content-type', undefined],
  ])('rejects commands with invalid %s=%s', (header, value) => {
    const request = input(); request.headers[header!] = value
    expect(taskCenterBrowserAllowed(request)).toBe(false)
  })
  it.each([undefined, 'invalid', 'http://evil.invalid/tasks'])('requires same-origin Referer for GET (%s)', referer => {
    const request = input(); request.method = 'GET'; delete request.headers.origin; request.headers.referer = referer
    expect(taskCenterBrowserAllowed(request)).toBe(false)
  })
  it('does not let a matching Referer override a cross-origin GET Origin', () => {
    const request = input(); request.method = 'GET'; request.headers.origin = 'http://evil.invalid'
    expect(taskCenterBrowserAllowed(request)).toBe(false)
  })
  it('does not open arbitrary HTTP methods', () => {
    expect(taskCenterBrowserAllowed({ ...input(), method: 'DELETE' })).toBe(false)
  })
})
