import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  BUSINESS_LIST_PATH,
  APPLY_LIST_PATH,
  type PlatformFetch,
  queryAllRdjb,
} from '../lib/platform'

const fixture = (name: string) =>
  readFileSync(join(import.meta.dirname, 'fixtures/platform', name), 'utf8')

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
})
