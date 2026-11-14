import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { initializeDb } from '../../db/client'
import { handlePlatformBatchRequest } from '../../server/utils/platform-batch-http'
import { runPlatformLiveQuery } from '../../server/utils/platform-live-query'
import { platformQueryCapabilities } from '../../lib/platform/live-query'
/** Public HTTP fixture forwards the same core as Nitro. Unknown paths (including
 * credential endpoints) fail closed and are audited by workflow acceptance. */
export async function startPlatformBatchApi(ctx: { db: ReturnType<typeof initializeDb>; apiToken: string; filesDir: string }) {
  const paths: string[] = []
  const server = createServer(async (req, res) => {
    const path = new URL(req.url!, 'http://localhost').pathname
    paths.push(path)
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk)
      const raw = Buffer.concat(chunks).toString('utf8')
      const body = raw ? JSON.parse(raw) : undefined
      let out: { status: number; headers: Record<string, string>; body: unknown }
      if (path === '/api/platform/capabilities') out = { status: 200, headers: { 'cache-control': 'no-store' }, body: platformQueryCapabilities }
      else if (path === '/api/platform/query') out = { status: 200, headers: { 'cache-control': 'no-store' }, body: await runPlatformLiveQuery(body) }
      else {
        const match = path.match(/^\/api\/platform\/batches(?:\/([^/]+))?(?:\/(retry|items)(?:\/([^/]+))?)?$/)
        if (!match) { res.writeHead(404); res.end(); return }
        const action = !match[1] ? 'submit' : match[2] === 'retry' ? 'retry' : match[2] === 'items' ? 'item' : 'status'
        out = await handlePlatformBatchRequest(action, { body, batchId: match[1], itemId: match[3], headers: { authorization: req.headers.authorization } }, ctx)
      }
      res.writeHead(out.status, { 'content-type': 'application/json', ...out.headers }); res.end(JSON.stringify(out.body))
    } catch { res.writeHead(500); res.end('{}') }
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  return { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, paths, close: () => new Promise<void>(r => server.close(() => r())) }
}
