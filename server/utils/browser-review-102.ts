import { getHeader, getRequestURL, type H3Event } from 'h3'

/**
 * **#108 页面复核写入口的部署闸门**（不是登录、不是会话、不是 RBAC）。
 *
 * 日常业务表单不再让复核人填写写入凭证、操作人和规则版本。为了让这台机器上的
 * **同源页面**仍能完成 `maintain` / `replace`，部署方必须同时做两件事：
 *
 *  1. `NUXT_API_TOKEN` 非空（沿用既有写开关；空 = 写整体关闭，反向默认不变）；
 *  2. 显式设置 `NUXT_BROWSER_REVIEW_ENABLED=true`。
 *
 * 这个开关只表示“允许该应用的页面发起人工复核”，**不识别是谁**。它不把 token
 * 返回给浏览器、不写 cookie/localStorage，也不把“同源”本身当身份：没有这个显式
 * 开关时，同源请求同样被拒绝。#127 会用真实权限体系替换它。
 *
 * token 只作为既有写能力是否配置的判据；这里从不用它比对请求头，所以浏览器既不
 * 需要、也无法从页面拿到它。
 */
export interface BrowserReviewRuntime {
  browserReviewEnabled?: boolean | string
  apiToken?: string
}

export function browserReviewWriteEnabled(config: BrowserReviewRuntime): boolean {
  return config.browserReviewEnabled === true
    && typeof config.apiToken === 'string'
    && config.apiToken.trim().length > 0
}

/**
 * 规范化一个**纯 origin**：只接受 `scheme://host[:port]`，拒绝 userinfo、路径、查询和
 * 片段，避免把 `https://host/anything` 或 `https://host@evil` 误当成同源。
 */
export function normalizeOrigin(value: string | undefined | null): string | null {
  const text = value?.trim()
  if (!text) return null
  try {
    const url = new URL(text)
    if (url.username || url.password) return null
    if (url.pathname !== '/' || url.search || url.hash) return null
    return url.origin
  } catch {
    return null
  }
}

/**
 * 服务端看到的请求 origin。
 *
 * 明确关闭 h3 对 `X-Forwarded-Host` / `X-Forwarded-Proto` 的读取：这些头可被任意客户端
 * 伪造，拿它们比对 Origin 等于让攻击者自己决定“服务端是谁”。这里只信本次连接的
 * `Host` 与传输是否加密，再与浏览器自动发送的 `Origin` 做**精确**比较。
 */
export function requestOrigin(event: H3Event): string | null {
  try {
    return normalizeOrigin(getRequestURL(event, { xForwardedHost: false, xForwardedProto: false }).origin)
  } catch {
    return null
  }
}

export type BrowserReviewGate =
  | { ok: true }
  | { ok: false; status: number; code: string; message: string }

/**
 * 写请求的同源闸门。顺序有意义：先确认部署开关，再拒绝跨站提示，再要求并精确匹配
 * `Origin`，最后才看 JSON content-type。任何一步失败都不会读 body、更不会写库。
 *
 * 缺 `Origin` 的请求（curl、MCP、旧客户端）一律拒绝，不为非浏览器调用留豁免。
 */
export function checkBrowserReviewRequest(
  event: H3Event,
  config: BrowserReviewRuntime,
  options: { write: boolean },
): BrowserReviewGate {
  if (!browserReviewWriteEnabled(config)) {
    return {
      ok: false,
      status: 403,
      code: 'browser_review_disabled',
      message: 'Browser review commands are disabled; enable the explicit deployment switch and configure the write token.',
    }
  }
  const site = getHeader(event, 'sec-fetch-site')?.trim().toLowerCase()
  if (site && site !== 'same-origin') {
    return { ok: false, status: 403, code: 'cross_site_request', message: 'Cross-site browser review requests are not allowed' }
  }
  const originHeader = getHeader(event, 'origin')
  if (!originHeader) {
    return { ok: false, status: 403, code: 'origin_required', message: 'An exact same-origin Origin header is required' }
  }
  const given = normalizeOrigin(originHeader)
  const expected = requestOrigin(event)
  // Require the canonical serialization itself, not merely a URL that parses to the same origin.
  if (!given || originHeader.trim() !== given || !expected || given !== expected) {
    return { ok: false, status: 403, code: 'origin_mismatch', message: 'Origin does not exactly match this server origin' }
  }
  if (options.write) {
    const contentType = getHeader(event, 'content-type')?.trim() ?? ''
    if (!/^application\/json(?:\s*;|$)/i.test(contentType)) {
      return { ok: false, status: 415, code: 'unsupported_media_type', message: 'Browser review commands require application/json' }
    }
  }
  return { ok: true }
}
