/**
 * 一个**真实**的名录导入 HTTP 服务（RL-11 的验收夹具）。
 *
 * 契约验收要求「以真实 HTTP 契约测试预检、提交、重复重放、失败恢复及完整性，不以直接
 * 数据库写入代替 API 验收」。本仓的 vitest 跑在裸 node 下、`h3` 解析不到（只挂在
 * `.pnpm` 下、没有顶层入口），所以这里用 `node:http` 起一个真端口，把**同一份**
 * `handleRosterImportRequest`（Nitro 路由也调它）挂上去 —— 测的不是替身实现。
 *
 * 只认两条路径：`/api/roster/import/preflight` 与 `/commit`；其余一律 404。
 */

import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '../../db/schema'
import { handleRosterImportRequest } from '../../server/utils/roster-import-http'

type Db = BetterSQLite3Database<typeof schema>

export interface RosterApiServer {
  baseUrl: string
  close(): Promise<void>
}

export async function startRosterApi(options: { db: Db; apiToken: string | null | undefined }): Promise<RosterApiServer> {
  const server: Server = createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(chunk as Buffer)
      const raw = Buffer.concat(chunks).toString('utf8')
      let body: unknown = null
      try {
        body = raw ? JSON.parse(raw) : null
      } catch {
        body = raw
      }

      const path = (req.url ?? '').split('?')[0] ?? ''
      if (path !== '/api/roster/import/preflight' && path !== '/api/roster/import/commit') {
        res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ message: 'not found' }))
        return
      }

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
      res.writeHead(out.status, out.headers)
      res.end(JSON.stringify(out.body ?? null))
    })().catch((error: unknown) => {
      res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ message: error instanceof Error ? error.message : String(error) }))
    })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

function headerOf(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0]
  return value
}
