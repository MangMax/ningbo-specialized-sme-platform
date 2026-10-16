/**
 * 一个**真实**的 HTTP 服务:同时挂名录导入写面(RL-11)与平台快照读面(RL-05)。
 *
 * ── 为什么起真端口而不是起 `nuxt dev` / 起 `createNitro` ─────────────────
 * 契约验收要求「经真实 HTTP 调 `POST /api/roster/import/commit`」并「回到读侧闭环」。
 * 本仓的 vitest 跑在裸 node 下,`h3` 在测试进程里解析不到(只挂在 `.pnpm` 下、没有顶层
 * 入口)—— 见 `server/utils/api-guard.ts` 顶部;而 Nuxt 的 `@db` 等别名只有 `nuxt build`
 * 之后才在 `.nuxt` 里成型,进程内 `createNitro` 拿不到。所以这里与 RL-11 的
 * `roster-http-server.ts` 同一套办法:`node:http` 起真端口,把**同一份** handler
 * (`handleRosterImportRequest` / `handlePlatformSnapshotRequest`,Nitro 路由也只是薄薄地
 * 转调它们)挂上去 —— 测的不是替身实现,契约只有一份。
 */

import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '../../db/schema'
import { handleRosterImportRequest } from '../../server/utils/roster-import-http'
import { handlePlatformSnapshotRequest } from '../../server/utils/platform-snapshots-http'

type Db = BetterSQLite3Database<typeof schema>

export interface RosterPlatformServer {
  baseUrl: string
  close(): Promise<void>
}

const IMPORT_PATHS = ['/api/roster/import/preflight', '/api/roster/import/commit']
const READ_PATHS = ['/api/platform/snapshots', '/api/platform/snapshots/diff']

export async function startRosterPlatformApi(options: {
  db: Db
  apiToken: string | null | undefined
}): Promise<RosterPlatformServer> {
  const server: Server = createServer((req, res) => {
    void (async () => {
      const raw = await readBody(req)
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const path = url.pathname

      if (IMPORT_PATHS.includes(path)) {
        const body = parseJson(raw)
        const out = handleRosterImportRequest(
          path.endsWith('/commit') ? 'commit' : 'preflight',
          {
            method: req.method ?? 'GET',
            headers: {
              authorization: headerOf(req.headers.authorization),
              'x-api-token': headerOf(req.headers['x-api-token']),
            },
            body,
          },
          { db: options.db, apiToken: options.apiToken },
        )
        send(res, out.status, out.headers, out.body)
        return
      }

      if (READ_PATHS.includes(path)) {
        const out = handlePlatformSnapshotRequest(
          path.endsWith('/diff') ? 'diff' : 'snapshots',
          { method: req.method ?? 'GET', query: queryOf(url) },
          { db: options.db },
        )
        send(res, out.status, out.headers, out.body)
        return
      }

      send(res, 404, { 'content-type': 'application/json; charset=utf-8' }, { message: 'not found' })
    })().catch((error: unknown) => {
      send(res, 500, { 'content-type': 'application/json; charset=utf-8' }, {
        message: error instanceof Error ? error.message : String(error),
      })
    })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

async function readBody(req: import('node:http').IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

function parseJson(raw: string): unknown {
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

/** 查询参数:同名单值给字符串、重复给数组(与 h3 `getQuery` 的口径一致)。 */
function queryOf(url: URL): Record<string, unknown> {
  const query: Record<string, unknown> = {}
  for (const key of new Set(url.searchParams.keys())) {
    const all = url.searchParams.getAll(key)
    query[key] = all.length > 1 ? all : all[0]
  }
  return query
}

function send(res: import('node:http').ServerResponse, status: number, headers: Record<string, string>, body: unknown): void {
  res.writeHead(status, headers)
  res.end(JSON.stringify(body ?? null))
}

function headerOf(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0]
  return value
}
