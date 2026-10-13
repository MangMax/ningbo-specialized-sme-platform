import { createServer, type Server as HttpServer, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Readable } from 'node:stream'
import type { Server as TusServer } from '@tus/server'

/**
 * 起一个**最小 HTTP 服务器**把 `@tus/server` 暴露在网络端口上,供 Node 端
 * `tus-js-client` 走真实协议上传(它自带 Node http stack,不走 fetch)。
 *
 * 桥接方式和生产里的 `server/middleware/tus.ts` **完全一致**:
 *   1. 收 Node `IncomingMessage` → 组一个 web `Request`(带 `duplex:'half'` 的流式 body),
 *      这正是 h3 `toWebRequest(event)` 干的事;
 *   2. 调 `tus.handleWeb(req)` 拿 web `Response`;
 *   3. 把 `Response` 写回 Node `ServerResponse` —— 对应 h3 `sendWebResponse(event, res)`。
 *
 * 端口用 `0`(系统分配),不与 dev 端口冲突;测试里只关心 origin。
 */
export interface MiniTusServer {
  /** 形如 `http://127.0.0.1:<port>`,把它拼上 `TUS_PATH` 即 tus 端点。 */
  origin: string
  /** 关服务(等在途连接收尾)。 */
  close(): Promise<void>
}

/** 把 web `Response` 写回 Node 响应(对应 h3 的 `sendWebResponse`)。 */
async function sendWeb(res: ServerResponse, web: Response): Promise<void> {
  res.statusCode = web.status
  web.headers.forEach((value, key) => res.setHeader(key, value))
  if (!web.body) {
    res.end()
    return
  }
  await new Promise<void>((resolve, reject) => {
    Readable.fromWeb(web.body as Parameters<typeof Readable.fromWeb>[0])
      .pipe(res)
      .on('finish', resolve)
      .on('error', reject)
  })
}

/** 在本地随机端口起 tus 端点。 */
export function startTusServer(tus: TusServer): Promise<MiniTusServer> {
  const server: HttpServer = createServer((req, res) => {
    const { port } = server.address() as AddressInfo
    // 组 web Request:方法与头原样透传;非 GET/HEAD 带流式 body(duplex:'half')。
    const hasBody = req.method !== 'GET' && req.method !== 'HEAD'
    const request = new Request(`http://127.0.0.1:${port}${req.url}`, {
      method: req.method,
      headers: req.headers as Record<string, string>,
      body: hasBody ? (req as unknown as BodyInit) : undefined,
      // @ts-expect-error undici 的流式请求体需要 duplex:'half'
      duplex: 'half',
    })
    Promise.resolve(tus.handleWeb(request))
      .then((web) => sendWeb(res, web))
      .catch((error: unknown) => {
        res.statusCode = 500
        res.end(String(error))
      })
  })

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo
      resolve({
        origin: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise<void>((res2) => {
            server.closeAllConnections()
            server.close(() => res2())
          }),
      })
    })
  })
}
