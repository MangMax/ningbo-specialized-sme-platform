/**
 * 经**契约 §8 的统一名单写入 API** 提交平台证据(RL-03)。
 *
 * ⚠️ 本模块**不写 SQL、不建第二套写路径** —— 它只是 RL-11 那条
 * `POST /api/roster/import/{preflight,commit}` 的**客户端**。SPEC「一切写入走应用公开 API」
 * 在这里的落法就是:适配层产出 §8.3 载荷(见 `payload.ts`),由统一批次 API 事务提交。
 *
 * **阻塞说明(交付时如实报告)**:RL-11 尚未合入集成分支,这条端点目前不存在 ——
 * 所以真实落库在 RL-11 就位前是**不可执行的**;本客户端与载荷构造已完成并离线可测,
 * 端点一就绪即可直接调用,不另造写入通道。
 *
 * 「未配置 token ⇒ 整体关闭」沿用既有分法(见 `server/utils/api-auth.ts`):
 * 反向的默认(空 = 放行)会让一次忘记配置变成一次静默的公开写入口。
 */
import type { PlatformWriteRequest } from './payload'

export const ROSTER_PREFLIGHT_PATH = '/api/roster/import/preflight'
export const ROSTER_COMMIT_PATH = '/api/roster/import/commit'

/** 统一写入 API 的响应(契约 §8.1/§8.2)。 */
export interface RosterBatchResponse {
  batchId: number
  status: string
  summary?: Record<string, unknown>
  preflight?: Record<string, unknown>
  items?: RosterBatchItem[]
}

/** 逐项结果 / 失败形状(契约 §8.2):`{ ok, kind, ref, error? }`。 */
export interface RosterBatchItem {
  ok: boolean
  kind: string
  ref: string
  error?: { code: string; field?: string; message?: string }
}

/** 服务端没配 token ⇒ 写入口整体关闭。 */
export class RosterWriteDisabledError extends Error {
  constructor(message = '名单写入未启用:没有可用的 API token。仅构造载荷,不提交。') {
    super(message)
    this.name = 'RosterWriteDisabledError'
  }
}

/** 提交被拒(4xx/5xx)。`items` 带逐项失败,可逐条修复后重放。 */
export class RosterWriteError extends Error {
  readonly status: number
  readonly items: RosterBatchItem[]
  constructor(message: string, status: number, items: RosterBatchItem[] = []) {
    super(message)
    this.name = 'RosterWriteError'
    this.status = status
    this.items = items
  }
}

export interface SaveRosterBatchOptions {
  /** 注入的 fetch(测试用);缺省用全局 fetch。 */
  fetchImpl?: typeof fetch
  /** `NUXT_API_TOKEN`。未配置时**不提交**。 */
  token: string | null | undefined
  /** 应用基址(如 `http://localhost:3000`);缺省用相对路径。 */
  baseUrl?: string
}

async function post(
  path: string,
  request: PlatformWriteRequest,
  options: SaveRosterBatchOptions,
): Promise<RosterBatchResponse> {
  if (!options.token) throw new RosterWriteDisabledError()
  const fetchImpl = options.fetchImpl ?? fetch
  const url = `${options.baseUrl ?? ''}${path}`
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${options.token}`,
    },
    body: JSON.stringify(request),
  })
  const text = await response.text()
  if (!response.ok) {
    let items: RosterBatchItem[] = []
    let message = `名单写入失败:HTTP ${response.status}`
    try {
      const parsed = JSON.parse(text) as { error?: string; message?: string; items?: RosterBatchItem[] }
      if (Array.isArray(parsed.items)) items = parsed.items
      const detail = parsed.error ?? parsed.message
      if (detail) message = `${message}:${detail}`
    } catch {
      if (text.trim()) message = `${message}:${text.slice(0, 200)}`
    }
    throw new RosterWriteError(message, response.status, items)
  }
  return JSON.parse(text) as RosterBatchResponse
}

/** 只读预检:算「这次提交会发生什么」,不落库(契约 §8.1)。 */
export function preflightRosterBatch(
  request: PlatformWriteRequest,
  options: SaveRosterBatchOptions,
): Promise<RosterBatchResponse> {
  return post(ROSTER_PREFLIGHT_PATH, request, options)
}

/** 事务提交(契约 §8.2)。幂等键在 `request.idempotencyKey`。 */
export function commitRosterBatch(
  request: PlatformWriteRequest,
  options: SaveRosterBatchOptions,
): Promise<RosterBatchResponse> {
  return post(ROSTER_COMMIT_PATH, request, options)
}
