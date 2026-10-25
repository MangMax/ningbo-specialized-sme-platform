import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  BUSINESS_LIST_PATH,
  APPLY_LIST_PATH,
  type PlatformFetch,
  queryAllRdjb,
  queryPlatformSlots,
  hasPlatformCredential,
} from '../lib/platform'

const fixture = (name: string) =>
  readFileSync(join(import.meta.dirname, 'fixtures/platform', name), 'utf8')

afterEach(() => vi.unstubAllEnvs())

interface Call {
  url: string
  body: URLSearchParams
  cookie: string | undefined
}

/**
 * 可注入的假 fetch:按「接口 + rdjb」回不同的夹具,并记下每次请求的 URL/表单/cookie。
 * 这样适配层能在**不碰外网、不拿真实凭证**的前提下被完整测到。
 */
function fakeFetch(reply: (call: Call) => string) {
  const calls: Call[] = []
  const fetchImpl: PlatformFetch = async (url, init) => {
    const body = new URLSearchParams(init.body)
    const call: Call = { url, body, cookie: init.headers.Cookie }
    calls.push(call)
    const text = reply(call)
    return { ok: true, status: 200, text: async () => text }
  }
  return { fetchImpl, calls }
}

const normalReply = (call: Call) => {
  if (call.url.includes(BUSINESS_LIST_PATH)) {
    return call.body.get('rdjb') === '3' ? fixture('business-list-rdjb3.html') : fixture('business-list-rdjb1-empty.html')
  }
  return fixture('apply-list.json')
}

describe('queryAllRdjb:按 USCC 把 rdjb=1/2/3 全查再合并', () => {
  it('发 4 个 POST:businessList × rdjb 1/2/3 + queryList × 1,表单字段正确', async () => {
    const { fetchImpl, calls } = fakeFetch(normalReply)
    await queryAllRdjb({ uscc: '91330211255994457P', fetchImpl, cookie: 'zxqy_JSESSIONID=x' })

    expect(calls).toHaveLength(4)
    const business = calls.filter((c) => c.url.includes(BUSINESS_LIST_PATH))
    const apply = calls.filter((c) => c.url.includes(APPLY_LIST_PATH))
    expect(business.map((c) => c.body.get('rdjb')).sort()).toEqual(['1', '2', '3'])
    expect(apply).toHaveLength(1)
    for (const call of calls) {
      expect(call.body.get('tyshxydm')).toBe('91330211255994457P')
      expect(call.body.get('pageNum')).toBe('1')
      expect(call.body.get('numPerPage')).toBe('50')
      expect(call.cookie).toBe('zxqy_JSESSIONID=x')
    }
    // 申报接口不带 rdjb(每行自带)。
    expect(apply[0]!.body.get('rdjb')).toBeNull()
  })

  it('四个结果各自成一条:rdjb=3 的 6 行 success,rdjb=1/2 的 0 行是 no_record', async () => {
    const { fetchImpl } = fakeFetch(normalReply)
    const outcomes = await queryAllRdjb({ uscc: '91330211255994457P', fetchImpl, cookie: 'c' })
    const byKey = Object.fromEntries(outcomes.map((o) => [`${o.interface}:${o.rdjb || '-'}`, o]))

    expect(byKey['business_list:1']!.status).toBe('no_record')
    expect(byKey['business_list:2']!.status).toBe('no_record')
    expect(byKey['business_list:3']!.status).toBe('success')
    expect(byKey['business_list:3']!.rows).toHaveLength(6)
    expect(byKey['apply_list:-']!.status).toBe('success')
    expect(byKey['apply_list:-']!.rows).toHaveLength(2)
    // 每一次查询都是独立一行,rdjb 进键 —— 三次 businessList 不互相覆盖。
    expect(outcomes.filter((o) => o.interface === 'business_list')).toHaveLength(3)
  })

  it('会话过期的那一次是 failed,其余不受影响(逐次分档)', async () => {
    const { fetchImpl } = fakeFetch((call) =>
      call.body.get('rdjb') === '2' ? fixture('session-expired.json') : normalReply(call),
    )
    const outcomes = await queryAllRdjb({ uscc: '91330211255994457P', fetchImpl, cookie: 'c' })
    const rdjb2 = outcomes.find((o) => o.interface === 'business_list' && o.rdjb === '2')!
    expect(rdjb2.status).toBe('failed')
    expect(rdjb2.failureReason).toContain('登录超时')
    expect(outcomes.find((o) => o.interface === 'business_list' && o.rdjb === '3')!.status).toBe(
      'success',
    )
  })

  it('每次都带回原始响应原文,供 platform_query.raw_response 留证', async () => {
    const { fetchImpl } = fakeFetch(normalReply)
    const outcomes = await queryAllRdjb({ uscc: '91330211255994457P', fetchImpl, cookie: 'c' })
    for (const outcome of outcomes) {
      expect(outcome.raw.length).toBeGreaterThan(0)
    }
    expect(outcomes.find((o) => o.rdjb === '3')!.raw).toContain('SQ332022062212391')
  })

  it('没有凭据时不发请求,四次都记 failed(未查询 ≠ 无记录)', async () => {
    const { fetchImpl, calls } = fakeFetch(normalReply)
    const outcomes = await queryAllRdjb({ uscc: '91330211255994457P', fetchImpl, cookie: () => '' })
    expect(calls).toHaveLength(0)
    expect(outcomes).toHaveLength(4)
    for (const outcome of outcomes) {
      expect(outcome.status).toBe('failed')
      expect(outcome.failureReason).toContain('凭据')
    }
  })

  it('ignores a legacy credential file and makes no requests without an environment credential', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'platform-legacy-cookie-'))
    const path = join(dir, 'cookie.txt')
    writeFileSync(path, 'session=synthetic-file-cookie')
    vi.stubEnv('MIIT_COOKIE', '')
    vi.stubEnv('MIIT_COOKIE_FILE', path)
    try {
      const { fetchImpl, calls } = fakeFetch(normalReply)
      expect(hasPlatformCredential()).toBe(false)
      const outcomes = await queryAllRdjb({ uscc: '91330211255994457P', fetchImpl })
      expect(calls).toHaveLength(0)
      expect(outcomes).toHaveLength(4)
      expect(outcomes.every(outcome => outcome.status === 'failed' && outcome.failureReason?.includes('凭据'))).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('uses the environment credential for standalone calls', async () => {
    vi.stubEnv('MIIT_COOKIE', '  session=synthetic-env-cookie  ')
    const { fetchImpl, calls } = fakeFetch(normalReply)
    expect(hasPlatformCredential()).toBe(true)
    await queryAllRdjb({ uscc: '91330211255994457P', fetchImpl })
    expect(calls).toHaveLength(4)
    expect(calls.every(call => call.cookie === 'session=synthetic-env-cookie')).toBe(true)
  })

  it.each([
    { name: 'empty string', cookie: '' },
    { name: 'empty resolver', cookie: () => '' },
  ])('keeps an injected $name authoritative over an environment credential', async ({ cookie }) => {
    vi.stubEnv('MIIT_COOKIE', 'session=synthetic-env-cookie')
    const { fetchImpl, calls } = fakeFetch(normalReply)
    expect(hasPlatformCredential(cookie)).toBe(false)
    const outcomes = await queryAllRdjb({ uscc: '91330211255994457P', fetchImpl, cookie })
    expect(calls).toHaveLength(0)
    expect(outcomes).toHaveLength(4)
    expect(outcomes.every(outcome => outcome.status === 'failed')).toBe(true)
  })
})

it('freezes a query credential across slots and removes credential echoes from success and failure evidence', async () => {
  let current = 'session=synthetic-first'
  const seen: boolean[] = []
  const outcomes = await queryAllRdjb({ uscc: '91330211255994457P', cookie: () => current, retries: 0, fetchImpl: async (_url, init) => {
    seen.push(init.headers.Cookie === 'session=synthetic-first')
    current = 'session=synthetic-next'
    if (seen.length === 2) throw new Error('proxy echoed session=synthetic-first')
    if (seen.length === 3) return { ok: false, status: 403, text: async () => 'session=synthetic-first' }
    return { ok: true, status: 200, text: async () => fixture('business-list-rdjb1-empty.html') + '<!--session=synthetic-first-->' }
  } })
  expect(seen).toEqual([true, true, true, true])
  expect(JSON.stringify(outcomes).includes('session=synthetic-first')).toBe(false)
  expect(outcomes.map(o => o.status)).toEqual(['no_record', 'failed', 'failed', 'failed'])
})
it('redacts a session component echoed separately or JSON-escaped in successful raw evidence and long HTTP errors', async () => {
  const session = 'synthetic-secret-\"session\\39'
  const cookie = `JSESSIONID=${session}; route=synthetic-route`
  const good = fixture('business-list-rdjb1-empty.html') + `<!--${session}:${JSON.stringify(session)}:${encodeURIComponent(session)}-->`
  const result = await queryAllRdjb({ uscc: '91330211255994457P', cookie, retries: 0, fetchImpl: async (_url, init) => ({ ok: false, status: 403, text: async () => (init.headers.Cookie + ':' + session).repeat(30) }) })
  expect(JSON.stringify(result).includes(session)).toBe(false)
  const successful = await queryAllRdjb({ uscc: '91330211255994457P', cookie, fetchImpl: async () => ({ ok: true, status: 200, text: async () => good }) })
  expect(successful[0]?.status).toBe('no_record')
  expect(successful[0]?.raw.includes(session)).toBe(false)
  expect(successful[0]?.raw.includes(JSON.stringify(session).slice(1, -1))).toBe(false)
  expect(successful[0]?.raw.includes(encodeURIComponent(session))).toBe(false)
})
it('blocks credential echoes in structured business rows from becoming identity evidence', async () => {
  const secret = 'session=synthetic-row-credential'
  const raw = fixture('business-list-rdjb3.html').replace('宁波上航测绘股份有限公司', secret)
  const result = await queryAllRdjb({ uscc: '91330211255994457P', cookie: secret, fetchImpl: async () => ({ ok: true, status: 200, text: async () => raw }) })
  const first = result[0]!
  expect(first.status).toBe('failed')
  expect(first.rows).toEqual([])
  expect(JSON.stringify(result).includes(secret)).toBe(false)
})
it.each(['c', 'sid=.'])('preserves unrelated field names with a short Cookie and redacts its explicit echo (%s)', async cookie => {
  const raw = fixture('business-list-rdjb3.html') + `<!--${cookie}-->`
  const result = await queryAllRdjb({ uscc: '91330211255994457P', cookie, fetchImpl: async () => ({ ok: true, status: 200, text: async () => raw }) })
  expect(result[0]?.status).toBe('success')
  expect(result[0]?.rows).toHaveLength(6)
  expect(result[0]?.raw.includes(`<!--${cookie}-->`)).toBe(false)
})

function syntheticPage(n: number) {
  return JSON.stringify({ zrarData: { grid: { applyGrid: { page: n, pageSize: 50, maxCount: 51,
    pageSet: Array.from({ length: n === 1 ? 50 : 1 }, (_, i) => ({ id: `SQ${(n - 1) * 50 + i + 1}` })),
  } } } })
}

it.each([{ maxRequests: 1 }, { maxRows: 50 }])('legacy page budget %j leaves page two unfinished without discarding accepted rows', async limit => {
  const calls: number[] = []
  const [result] = await queryPlatformSlots({ uscc: '91330211255994457P', cookie: 'synthetic', ...limit,
    fetchImpl: async (_url, init) => {
      const page = Number(new URLSearchParams(init.body).get('pageNum')); calls.push(page)
      return { ok: true, status: 200, text: async () => syntheticPage(page) }
    },
  }, [{ interface: 'apply_list' }])
  expect(calls).toEqual([1])
  expect(result).toMatchObject({ status: 'partial', maxCount: 51, collection: { completeness: 'partial', declaredTotal: 51, requestCount: 1, unfinished: [{ page: 2 }] } })
  expect(result!.rows).toHaveLength(50)
})

it('legacy timeout includes retry backoff in the operation deadline and makes no later request', async () => {
  let time = 1000, calls = 0
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => time)
  const sleeps: number[] = []
  try {
    const [result] = await queryPlatformSlots({ uscc: '91330211255994457P', cookie: 'synthetic', maxDurationMs: 20,
      sleep: async ms => { sleeps.push(ms); time += ms },
      fetchImpl: async (_url, init) => {
        calls++
        if (new URLSearchParams(init.body).get('pageNum') === '2') throw new Error('transient network failure')
        return { ok: true, status: 200, text: async () => syntheticPage(1) }
      },
    }, [{ interface: 'apply_list' }])
    expect(calls).toBe(2)
    expect(sleeps).toEqual([20])
    expect(result).toMatchObject({ status: 'partial', collection: { declaredTotal: 51, unfinished: [{ page: 2 }], pages: [expect.any(Object), expect.objectContaining({ error: { code: 'timeout', message: expect.any(String) } })] } })
    expect(result!.rows).toHaveLength(50)
  } finally { clock.mockRestore() }
})

it('legacy client does not retry an HTTP 4xx or classify it as empty', async () => {
  let calls = 0
  const [result] = await queryPlatformSlots({ uscc: '91330211255994457P', cookie: 'synthetic',
    fetchImpl: async () => { calls++; return { ok: false, status: 400, text: async () => 'bad request' } },
  }, [{ interface: 'apply_list' }])
  expect(calls).toBe(1)
  expect(result).toMatchObject({ status: 'failed', collection: { completeness: 'partial', requestCount: 1, unfinished: [{ page: 1 }] } })
})
