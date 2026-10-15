import { describe, expect, it } from 'vitest'
import {
  ROSTER_COMMIT_PATH,
  ROSTER_PREFLIGHT_PATH,
  RosterWriteDisabledError,
  RosterWriteError,
  commitRosterBatch,
  preflightRosterBatch,
  type SaveRosterBatchOptions,
} from '../lib/platform/write'
import type { PlatformWriteRequest } from '../lib/platform/payload'

const REQUEST: PlatformWriteRequest = {
  idempotencyKey: 'alias_evidence:x#abcdef',
  sourceKind: 'alias_evidence',
  sourceIdentity: 'platform/91330211255994457P.json',
  payload: { platformQueries: [], aliases: [], differences: [], merges: [] },
}

interface Captured {
  url: string
  method: string
  headers: Record<string, string>
  body: unknown
}

function fakeFetch(response: { ok: boolean; status: number; body: string }) {
  const calls: Captured[] = []
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({
      url: String(url),
      method: init.method ?? 'GET',
      headers: (init.headers ?? {}) as Record<string, string>,
      body: init.body ? JSON.parse(String(init.body)) : null,
    })
    return {
      ok: response.ok,
      status: response.status,
      text: async () => response.body,
      json: async () => JSON.parse(response.body),
    }
  }) as unknown as SaveRosterBatchOptions['fetchImpl']
  return { fetchImpl, calls }
}

const ok = (body: unknown) => ({ ok: true, status: 200, body: JSON.stringify(body) })

describe('commitRosterBatch:经契约 §8.2 的统一 API 落库(不直写 SQL)', () => {
  it('POST 到 /api/roster/import/commit,带鉴权头,请求体就是 §8.1 形状', async () => {
    const { fetchImpl, calls } = fakeFetch(ok({ batchId: 12, status: 'committed', summary: { written: 15 } }))
    const result = await commitRosterBatch(REQUEST, { fetchImpl, token: 'secret', baseUrl: 'http://localhost:3000' })

    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe(`http://localhost:3000${ROSTER_COMMIT_PATH}`)
    expect(calls[0]!.method).toBe('POST')
    expect(calls[0]!.headers.authorization).toBe('Bearer secret')
    expect(calls[0]!.body).toEqual(REQUEST)
    expect(result).toEqual({ batchId: 12, status: 'committed', summary: { written: 15 } })
  })

  it('预检走同一个请求体,只是换了路径', async () => {
    const { fetchImpl, calls } = fakeFetch(ok({ batchId: 12, status: 'preflight', preflight: { add: 15 } }))
    await preflightRosterBatch(REQUEST, { fetchImpl, token: 'secret', baseUrl: 'http://localhost:3000' })
    expect(calls[0]!.url).toBe(`http://localhost:3000${ROSTER_PREFLIGHT_PATH}`)
    expect(calls[0]!.body).toEqual(REQUEST)
  })

  it('未配置 token ⇒ 整体关闭,不发请求(与写口「未配置即关闭」同一条反向默认)', async () => {
    const { fetchImpl, calls } = fakeFetch(ok({}))
    await expect(commitRosterBatch(REQUEST, { fetchImpl, token: null })).rejects.toBeInstanceOf(
      RosterWriteDisabledError,
    )
    expect(calls).toHaveLength(0)
  })

  it('非 2xx 抛 RosterWriteError,并带上逐项失败(可逐条修复)', async () => {
    const { fetchImpl } = fakeFetch({
      ok: false,
      status: 422,
      body: JSON.stringify({
        error: 'batch rejected',
        items: [{ ok: false, kind: 'platform_relation', ref: 'row:3', error: { code: 'unknown_title' } }],
      }),
    })
    await expect(commitRosterBatch(REQUEST, { fetchImpl, token: 'secret' })).rejects.toMatchObject({
      name: 'RosterWriteError',
      status: 422,
    })
    try {
      await commitRosterBatch(REQUEST, { fetchImpl, token: 'secret' })
    } catch (error) {
      expect(error).toBeInstanceOf(RosterWriteError)
      expect((error as RosterWriteError).items).toHaveLength(1)
    }
  })

  it('后端还没实现这条路径(404)时,报错如实说明是未就绪,而不是假装写入成功', async () => {
    const { fetchImpl } = fakeFetch({ ok: false, status: 404, body: 'Not Found' })
    await expect(commitRosterBatch(REQUEST, { fetchImpl, token: 'secret' })).rejects.toMatchObject({
      name: 'RosterWriteError',
      status: 404,
    })
  })
})
