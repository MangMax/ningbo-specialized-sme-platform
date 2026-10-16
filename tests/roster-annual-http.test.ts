/**
 * RL-07 的 HTTP 面验收 —— 走**真实 HTTP**(`tests/helpers/roster-http-server.ts` 起真端口,
 * 挂的是 Nitro 路由也在调的同一份核心实现),不用替身。
 *
 * 盯三件事:
 *  1. 形状:预览 200 + 三块(逐项 / 总表增减 / 计数)、批次流水 200;
 *  2. 方法守卫:两条都只认自己的方法(405),非法载荷 400;
 *  3. **预览不鉴权、一行不写**,而**应用仍然要走带 token 的 `/commit`** ——
 *     即在「写面关闭」(未配 token)的部署里,预览照样能用,但谁也写不进去。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { useDb } from '../db'
import { commitRosterImport, rosterRowCounts } from '../server/utils/roster-import'
import { startRosterApi } from './helpers/roster-http-server'

const TOKEN = 'rl07-annual-token-value'
const dirs: string[] = []

function makeDb() {
  const dir = mkdtempSync(join(tmpdir(), 'spztx-annual-http-'))
  dirs.push(dir)
  return useDb({ dbPath: join(dir, 'roster.db') })
}

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

const U = { platformOnly: '91330200000000001A', announced: '91330200000000002B' } as const

/** 一批最小的年度更新:一份公布文件 + 一张平台导出表。 */
function bundle() {
  return {
    year: 2026,
    entries: [
      {
        idempotencyKey: 'rl07-http/announcement',
        sourceKind: 'announcement',
        sourceIdentity: 'jxj/announcement/2026/1号.pdf',
        payload: {
          announcement: {
            sourceDocument: { source: 'jxj', title: '2026 认定', docNumber: '甬经信中小〔2026〕1号' },
            records: [
              {
                enterprise: { name: '宁波年度新企业有限公司', uscc: '91330200000000007G' },
                titleCode: 'specialized_sme',
                events: [{ eventType: 'award', year: 2026, batchSeq: 1 }],
              },
            ],
          },
        },
      },
      {
        idempotencyKey: 'rl07-http/export',
        sourceKind: 'platform_export',
        sourceIdentity: 'miit/export/2026/specialized_sme.xlsx',
        payload: {
          exportSnapshot: {
            titleCode: 'specialized_sme',
            year: 2026,
            collectedOn: '2026-10-01',
            originalFilename: 'specialized_sme-2026.xlsx',
            sha256: 'rl07-http-sha',
            rows: [{ sourceRowNo: 1, usccRaw: U.announced, nameRaw: '宁波有公布历史企业有限公司' }],
          },
        },
      },
    ],
  }
}

async function post(baseUrl: string, path: string, body: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
  return { status: response.status, body: (await response.json()) as Record<string, unknown> }
}

describe('RL-07 · 年度增量预览的 HTTP 面', () => {
  it('POST 预览:200 + 三块形状;同一次预览**一行都不写**', async () => {
    const db = makeDb()
    const server = await startRosterApi({ db, apiToken: TOKEN })
    try {
      const before = rosterRowCounts(db)
      const first = await post(server.baseUrl, '/api/roster/import/annual/preview', bundle())
      expect(first.status).toBe(200)
      expect(Object.keys(first.body).sort()).toEqual(['applyable', 'blockedReason', 'entries', 'roster', 'totals'])
      expect(first.body.applyable).toBe(true)
      const entries = first.body.entries as Array<Record<string, unknown>>
      expect(entries).toHaveLength(2)
      expect(entries[0]!.batchStatus).toBe('none')
      const roster = first.body.roster as { counts: Record<string, number> }
      expect(roster.counts).toMatchObject({ removed: 0, blocked: 0, keptByAnnouncement: 0 })
      expect(rosterRowCounts(db)).toEqual(before)

      // 幂等:再预览一次,形状与数字一模一样(预览是纯函数式投影)。
      const second = await post(server.baseUrl, '/api/roster/import/annual/preview', bundle())
      expect(second.body).toEqual(first.body)
    } finally {
      await server.close()
    }
  })

  it('单条 §8.1 请求也可直接给(只更新一份文件时的简写)', async () => {
    const db = makeDb()
    const server = await startRosterApi({ db, apiToken: TOKEN })
    try {
      const single = await post(server.baseUrl, '/api/roster/import/annual/preview', bundle().entries[0])
      expect(single.status).toBe(200)
      expect((single.body.entries as unknown[])).toHaveLength(1)
    } finally {
      await server.close()
    }
  })

  it('方法守卫与载荷校验', async () => {
    const db = makeDb()
    const server = await startRosterApi({ db, apiToken: TOKEN })
    try {
      const get = await fetch(`${server.baseUrl}/api/roster/import/annual/preview`)
      expect(get.status).toBe(405)
      const empty = await post(server.baseUrl, '/api/roster/import/annual/preview', { entries: [] })
      expect(empty.status).toBe(400)
      const bad = await post(server.baseUrl, '/api/roster/import/annual/preview', { entries: [{ idempotencyKey: 'x' }] })
      expect(bad.status).toBe(400)
      expect(String(bad.body.message)).toContain('entries[0]')
    } finally {
      await server.close()
    }
  })

  it('**写面关闭时预览照常可用,但应用仍然写不进去**(预览不鉴权、应用才鉴权)', async () => {
    const db = makeDb()
    const server = await startRosterApi({ db, apiToken: '' })
    try {
      const preview = await post(server.baseUrl, '/api/roster/import/annual/preview', bundle())
      expect(preview.status).toBe(200)

      const commit = await post(server.baseUrl, '/api/roster/import/commit', bundle().entries[0])
      expect(commit.status).toBe(401)
      const commitWithToken = await post(server.baseUrl, '/api/roster/import/commit', bundle().entries[0], {
        authorization: `Bearer ${TOKEN}`,
      })
      // token 不匹配也不行(服务端配的是空 token ⇒ 写面整体关闭)。
      expect(commitWithToken.status).toBe(401)
      expect(rosterRowCounts(db).enterprise).toBe(0)
    } finally {
      await server.close()
    }
  })

  it('批次流水:提交过之后能看到来源、摘要与状态(可追溯的那一半)', async () => {
    const db = makeDb()
    const server = await startRosterApi({ db, apiToken: TOKEN })
    try {
      const bundleValue = bundle()
      for (const request of bundleValue.entries) {
        const committed = commitRosterImport(db, request)
        expect(committed.status).toBe('committed')
      }
      const response = await fetch(`${server.baseUrl}/api/roster/import/batches?limit=10`)
      expect(response.status).toBe(200)
      const body = (await response.json()) as { batches: Array<Record<string, unknown>> }
      expect(body.batches).toHaveLength(2)
      expect(body.batches[0]!.sourceKind).toBe('platform_export')
      expect(body.batches[0]!.status).toBe('committed')
      expect(body.batches[0]!.summary).toMatchObject({ failed: 0 })
      expect(body.batches[1]!.idempotencyKey).toBe('rl07-http/announcement')

      const limited = await fetch(`${server.baseUrl}/api/roster/import/batches?limit=1`)
      expect(((await limited.json()) as { batches: unknown[] }).batches).toHaveLength(1)

      const wrongMethod = await post(server.baseUrl, '/api/roster/import/batches', {})
      expect(wrongMethod.status).toBe(404) // 读面只挂 GET ⇒ POST 落到 404(夹具就这么分)
    } finally {
      await server.close()
    }
  })

  it('已提交的幂等键:预览如实报零并说明要走 /replay', async () => {
    const db = makeDb()
    const server = await startRosterApi({ db, apiToken: TOKEN })
    try {
      const bundleValue = bundle()
      expect(commitRosterImport(db, bundleValue.entries[0]!).status).toBe('committed')
      const preview = await post(server.baseUrl, '/api/roster/import/annual/preview', bundleValue)
      const entries = preview.body.entries as Array<Record<string, unknown>>
      expect(entries[0]!.batchStatus).toBe('committed')
      expect(entries[0]!.willApply).toBe(false)
      expect(entries[0]!.counts).toMatchObject({ add: 0, update: 0, merge: 0, review: 0, evidenceRepoints: 0 })
    } finally {
      await server.close()
    }
  })
})
