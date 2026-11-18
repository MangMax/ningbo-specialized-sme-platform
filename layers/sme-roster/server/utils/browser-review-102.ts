import { getHeader, getRequestURL, type H3Event } from 'h3'

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
 * 写请求的同源闸门。顺序有意义：先拒绝跨站提示，再要求并精确匹配
 * `Origin`，最后才看 JSON content-type。任何一步失败都不会读 body、更不会写库。
 *
 * 缺 `Origin` 的请求（curl、MCP、旧客户端）一律拒绝，不为非浏览器调用留豁免。
 */
export function checkBrowserReviewRequest(
  event: H3Event,
  options: { write: boolean },
): BrowserReviewGate {
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
