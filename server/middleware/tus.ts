import { TUS_PATH, getTus } from '../utils/tus'

/**
 * 把 `/api/uploads` 交给 tus `Server` 处理(web 标准入口)。
 *
 * 用**中间件**而非 catch-all 路由:`server/api/uploads/[...id].ts` 这类 catch-all
 * **匹配不到基路径 `/api/uploads` 本身**(只有子路径能匹配),而中间件按前缀判断
 * 一个入口同时覆盖基路径与子路径(见 `.research/tus-research.md` §2.5)。
 *
 * `sendWebResponse` 会把 `handleWeb` 返回的 `Response` 流式写回 Node `res`;
 * 其余路径**放行**(不返回、不消费)。
 */
export default defineEventHandler(async (event) => {
  // 精确匹配基路径与子路径:`/api/uploads`、`/api/uploads/<id>`
  // (既覆盖 catch-all 匹配不到的基路径,又不误伤 `/api/uploadsextra` 之类)。
  if (event.path !== TUS_PATH && !event.path.startsWith(`${TUS_PATH}/`)) return
  // 鉴权预留位:tus 协议本身不含鉴权(见 ADR)。真实登录体系未接入前,这里只做
  // 最小把关;上线前应在此校验会话/来源,再交给 tus(见 .research/tus-research.md §5.4)。
  return sendWebResponse(event, await getTus().handleWeb(toWebRequest(event)))
})
