/**
 * 测试用的**真实 HTTP 夹具启动器** —— RL-03 / RL-05 / RL-11 三处端到端夹具的共用底座。
 *
 * ── 为什么起真端口,而不是 `createNitro` / `nuxt dev` ─────────────────────
 * 契约验收要求「以真实 HTTP 契约测试」,不以直接函数调用或直写数据库代替。而本仓的 vitest
 * 跑在**裸 node** 下:`h3` 在测试进程里解析不到(只挂在 `.pnpm` 下、没有顶层入口),
 * Nuxt 的 `@db` 等别名也要 `nuxt build` 之后才在 `.nuxt` 成型 —— 所以进程内 `createNitro`
 * 拿不到业务路由(见 `tests/agent-http.test.ts` 里那个只用来「问路由表」的 `createNitro`)。
 * 办法是:`node:http` 起**真端口**,把 Nitro 路由也在调的**同一份**核心函数挂上去
 * (`server/utils/roster-import-http.ts` / `platform-snapshots-http.ts`,
 * 路由文件只是薄转调)。测的不是替身实现,契约只有一份。
 *
 * ── 这个文件负责的,就是那三份夹具里**逐字重复**的部分 ────────────────────
 * 读 body 的循环、`JSON.parse` 兜底、`listen(0,'127.0.0.1')` / `AddressInfo` / `close`、
 * `headerOf`、404/500 的 JSON 信封、query 的解析口径。各夹具只剩自己的**路由表**。
 *
 * ── 路由规则(一条,简单到不用记)────────────────────────────────────────
 * - `GET` → `getRoutes`;其余方法 → `postRoutes`;两者都按**不含 query 的路径**精确匹配。
 * - 没命中 ⇒ `404 {"message":"not found"}`;处理器抛异常 ⇒ `500 {"message":…}`。
 * - 两个核心函数自己会挡方法不对的请求(`405`),所以夹具不做方法白名单。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

/** 夹具交给处理器的请求:body 已读完并(尽力)解析成 JSON,query 已按 h3 口径展开。 */
export interface FixtureRequest {
  method: string
  /** 不含 query 的路径(即路由匹配用的键)。 */
  path: string
  url: URL
  /** 同名单值给字符串、重复给数组(与 h3 `getQuery` 的口径一致)。 */
  query: Record<string, unknown>
  /** 只转出夹具会看的那两个头;同名头多次出现时取第一个(与 `headerOf` 同口径)。 */
  headers: { authorization?: string; 'x-api-token'?: string }
  /** 请求体:能解析成 JSON 就是对象,解析不了就是原文,空 body 是 `null`。 */
  body: unknown
}

/** 处理器的返回:状态码 + 响应头 + JSON 体。 */
export interface FixtureResponse {
  status: number
  headers?: Record<string, string>
  body?: unknown
}

export type FixtureHandler = (request: FixtureRequest) => FixtureResponse

export interface FixtureRoutes {
  /** 非 GET 方法的路由表。 */
  postRoutes?: Record<string, FixtureHandler>
  /** GET 的路由表。 */
  getRoutes?: Record<string, FixtureHandler>
}

export interface HttpFixture {
  baseUrl: string
  close(): Promise<void>
}

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' }

/** 起一个挂 `routes` 的真实 HTTP 服务,返回基址与 `close()`(关端口并等它真的关上)。 */
export async function startHttpFixture(routes: FixtureRoutes): Promise<HttpFixture> {
  const server: Server = createServer((req, res) => {
    void dispatch(req, res, routes).catch((error: unknown) => {
      // 处理器抛出的东西也走同一条出口:状态码取 `statusCode`,否则 500。
      const status = (error as { statusCode?: number } | null)?.statusCode ?? 500
      sendJson(res, status, {}, { message: messageOf(error) })
    })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

async function dispatch(
  req: IncomingMessage,
  res: ServerResponse,
  routes: FixtureRoutes,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  const method = req.method ?? 'GET'
  const handler = (method === 'GET' ? routes.getRoutes : routes.postRoutes)?.[url.pathname]
  if (!handler) {
    sendJson(res, 404, {}, { message: 'not found' })
    return
  }
  const out = handler({
    method,
    path: url.pathname,
    url,
    query: queryOf(url),
    headers: {
      authorization: headerOf(req.headers.authorization),
      'x-api-token': headerOf(req.headers['x-api-token']),
    },
    body: method === 'GET' ? null : parseJson(await readBody(req)),
  })
  sendJson(res, out.status, out.headers ?? {}, out.body)
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

/** 能解析成 JSON 就给对象,否则**退回原文**(诊断用;绝不因此 500)。 */
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

function sendJson(res: ServerResponse, status: number, headers: Record<string, string>, body: unknown): void {
  res.writeHead(status, { ...JSON_HEADERS, ...headers })
  res.end(JSON.stringify(body ?? null))
}

function headerOf(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0]
  return value
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
