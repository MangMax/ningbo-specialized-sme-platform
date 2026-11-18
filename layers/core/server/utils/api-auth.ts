import { tokenMatches } from './mcp-auth'

/**
 * HTTP 能力面的**鉴权判据**(票 19)。
 *
 * ── 口径 ────────────────────────────────────────────────────────────────
 * **读不鉴权,写/任务类鉴权。** 与 MCP 面(票 18)同一套分法:查询是读,提交任务 /
 * 取消任务是**改库 + 占资源**(一次 `render-pages` 能把 CPU 钉住几秒到几分钟),
 * 两者风险不对称,不该共用一个开关。
 *
 * **token 未配置 ⇒ 写入整体关闭**(而不是「无 token 也能写」)。反向的默认
 * (空 = 放行)会让一次忘记配置变成一次静默的公开写入口。与 `NUXT_MCP_TOKEN`
 * 同一条反向默认,理由见 `server/utils/mcp-auth.ts` 顶部。
 *
 * ── 为什么是**另一个** env 变量(`NUXT_API_TOKEN`)──────────────────────────
 * 两个面各有一把钥匙,可以各自吊销:代理的 HTTP 技能失效时,不必连带停掉 MCP 的写入。
 * 想把两把设成同一个值是完全可以的(`.env.example` 里就是这么写的),但那是**配置时的
 * 选择**,不该由代码替人决定。反过来若共用一个变量,「只想给 curl 开个口子」就得连
 * MCP 一起开 —— 权限只会变宽,不会变窄。
 *
 * ── 与 RSS/CSRF 的关系 ──────────────────────────────────────────────────
 * 本仓是**单机开发工具**(SPA + 本地 Nitro),没有跨用户的会话概念;这个 token 挡的是
 * 「本机上的别的程序 / 页面上跑的脚本顺手提交任务」。它不是多用户鉴权 —— 别把它当
 * 生产环境的身份系统用(生产暴露面前必读 `.env.example` 的警告)。
 */

/** 认这两种头。`Authorization: Bearer <t>` 是 HTTP 惯例;`X-API-Token` 给不方便改
 *  `Authorization` 的客户端留的退路(与 MCP 面的 `X-MCP-Token` 同一个用意)。 */
export const API_TOKEN_HEADERS = ['authorization', 'x-api-token'] as const

export type ApiAuthReason =
  /** 带了 token 且匹配。 */
  | 'authorized'
  /** 服务端**没配** `NUXT_API_TOKEN` —— 写/任务类整体关闭。 */
  | 'no-token-configured'
  /** 服务端配了,但请求没带。 */
  | 'token-missing'
  /** 带了,但不匹配。 */
  | 'token-invalid'

export interface ApiAuthState {
  /** 本次请求是否可以做**写/任务类**操作。 */
  writeAuthorized: boolean
  reason: ApiAuthReason
}

/**
 * 从请求头里取 token。认 `Bearer <token>`(大小写不敏感)、裸 token、`X-API-Token`。
 *
 * 与 `readMcpToken`(票 18)**逐行同构**,只是换了一组头名 —— 照抄而不是抽公共件,
 * 理由同 `server/utils/pdf-pages.ts` 的 `sha256Of`:抽公共件要改票 18 的文件,
 * 而这个文件本身只有十几行。合流留给后续清理。
 *
 * 只写了 `Bearer` 而没有值 → 当**没带**:否则「Bearer」会被当成一个 token 去比对,
 * 报出来的错会是「token 不匹配」而不是「未带」,误导排查。
 */
export function readApiToken(
  headers: Record<string, string | undefined> | undefined,
): string | null {
  for (const name of API_TOKEN_HEADERS) {
    const raw = headers?.[name]
    if (typeof raw !== 'string') continue
    const value = raw.trim()
    if (!value) continue
    if (/^bearer$/i.test(value)) continue
    const bearer = /^bearer\s+(.*)$/i.exec(value)
    const token = (bearer ? bearer[1]! : value).trim()
    if (token) return token
  }
  return null
}

/** 把「请求带来的 token」与「服务端配置的 token」折成鉴权状态。 */
export function resolveApiAuth(input: {
  given: string | null
  configured: string | null | undefined
}): ApiAuthState {
  if (!input.configured) return { writeAuthorized: false, reason: 'no-token-configured' }
  if (!input.given) return { writeAuthorized: false, reason: 'token-missing' }
  // 比较沿用票 18 的恒定时间实现(先 SHA-256 再比,长度不等也走完整比较)。
  if (!tokenMatches(input.given, input.configured)) {
    return { writeAuthorized: false, reason: 'token-invalid' }
  }
  return { writeAuthorized: true, reason: 'authorized' }
}

/** 鉴权失败时的中文文案。四种情形分开说 —— 让人一眼看出该去改哪里。 */
export function unauthorizedApiMessage(reason: ApiAuthReason): string {
  switch (reason) {
    case 'no-token-configured':
      return '写/任务类接口未启用:服务端没有配置 NUXT_API_TOKEN。只读接口不受影响。'
    case 'token-missing':
      return '需要鉴权:请求未带 token(Authorization: Bearer <token> 或 X-API-Token)。'
    case 'token-invalid':
      return '需要鉴权:提供的 token 不匹配。'
    default:
      return '需要鉴权。'
  }
}

/**
 * **密钥不进 spec** 的判据(票 19 硬约束)。
 *
 * spec 是从各路由的 `defineRouteMeta({ openAPI })` 抽出来的,那些块是**源码**、
 * 也会被人复制粘贴 —— 一旦有人把真 token 当 `example` 写进去,`/_openapi.json`
 * 就成了密钥的公开副本。这条判据把「spec 里有没有出现这个密钥」变成一个可测的函数,
 * 而不是靠人肉 review。
 *
 * 空 / 未配置的 token 一律返回 `false`(空串在 JSON 里到处都是,拿它比会全是误报)。
 * 只做**字面包含**(不做正则/模糊匹配):密钥是随机串,出现了就是出现了,
 * 不需要「像不像」的判断 —— 而模糊匹配会把 `Bearer <token>` 这种**占位文案**
 * 也判成泄露,那条判据就没人会去修了。
 */
export function specLeaksToken(spec: unknown, token: string | null | undefined): boolean {
  if (!token) return false
  return JSON.stringify(spec ?? null).includes(token)
}
