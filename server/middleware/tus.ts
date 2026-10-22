import { appLog, requestLogContext, type TusLogContext } from '../../lib/logging'
import { TUS_PATH, getTus, withTusObservation, type TusObservation } from '../utils/tus'

/**
 * 把 `/api/uploads` 交给 tus `Server` 处理(web 标准入口)。
 *
 * 用**中间件**而非 catch-all 路由:`server/api/uploads/[...id].ts` 这类 catch-all
 * **匹配不到基路径 `/api/uploads` 本身**(只有子路径能匹配),而中间件按前缀判断
 * 一个入口同时覆盖基路径与子路径(见 `.research/tus-research.md` §2.5)。
 *
 * `sendWebResponse` 会把 `handleWeb` 返回的 `Response` 流式写回 Node `res`;
 * 其余路径**放行**(不返回、不消费)。
 *
 * 上传不是一次 HTTP:observation 只绑定本次 `handleWeb`,uploadId 来自 tus 回调,
 * 非终态 PATCH 成功不写事件;只有创建、终态完成或请求失败才落一条。
 */
export default defineEventHandler(async (event) => {
  // 精确匹配基路径与子路径:`/api/uploads`、`/api/uploads/<id>`
  // (既覆盖 catch-all 匹配不到的基路径,又不误伤 `/api/uploadsextra` 之类)。
  if (event.path !== TUS_PATH && !event.path.startsWith(`${TUS_PATH}/`)) return
  // 鉴权预留位:tus 协议本身不含鉴权(见 ADR)。真实登录体系未接入前,这里只做
  // 最小把关;上线前应在此校验会话/来源,再交给 tus(见 .research/tus-research.md §5.4)。
  const startedAt = Date.now()
  const observation: TusObservation = {}
  let logged = false
  try {
    const { result: response } = await withTusObservation(() =>
      getTus().handleWeb(toWebRequest(event)), observation,
    )
    const status = response.status
    // A client disconnect may surface as `Connection: close`; it is an observed
    // request failure, not a claim that already-written bytes were rolled back.
    const aborted = response.headers.get('connection')?.toLowerCase() === 'close'
    const failed = observation.failed === true || aborted || status >= 400
    const tus = tusContext(observation)
    if (failed) {
      const denied = !aborted && status >= 400 && status < 500
      appLog({
        source: 'file',
        operation: 'file.upload',
        outcome: denied ? 'denied' : 'failure',
        level: denied ? 'warn' : 'error',
        ...(status >= 400 ? { statusCode: status } : {}),
        errorCode: denied ? 'file_upload_rejected' : 'file_upload_failed',
        durationMs: Date.now() - startedAt,
        ...(tus ? { tus: { ...tus, phase: 'request-failed' } } : {}),
      }, requestLogContext(event))
      logged = true
    } else if (observation.completed === true) {
      // `onUploadFinish` completed its original mkdir/link/rm work before this flag.
      appLog({
        source: 'file', operation: 'file.upload', outcome: 'success', statusCode: status,
        durationMs: Date.now() - startedAt,
        ...(tus ? { tus: { ...tus, phase: 'completed' } } : {}),
      }, requestLogContext(event))
      logged = true
    } else if (observation.created === true && event.method === 'POST') {
      // A create response is not a completed upload. Keep the id for later PATCH/retry correlation.
      appLog({
        source: 'file', operation: 'file.upload', outcome: 'started', statusCode: status,
        durationMs: Date.now() - startedAt,
        ...(tus ? { tus: { ...tus, phase: 'created' } } : {}),
      }, requestLogContext(event))
      logged = true
    }
    // Successful HEAD/non-final PATCH/OPTIONS/DELETE stay out of semantic logs.
    return sendWebResponse(event, response)
  } catch (error) {
    if (!logged) {
      const tus = tusContext(observation)
      appLog({
        source: 'file', operation: 'file.upload', outcome: 'failure', level: 'error',
        errorCode: 'file_upload_failed', durationMs: Date.now() - startedAt,
        ...(tus ? { tus: { ...tus, phase: 'request-failed' } } : {}),
      }, requestLogContext(event))
    }
    throw error
  }
})

function tusContext(observation: TusObservation): TusLogContext | undefined {
  if (!observation.uploadId) return undefined
  return {
    uploadId: observation.uploadId,
    phase: 'request-failed',
    ...(observation.method ? { method: observation.method as TusLogContext['method'] } : {}),
    ...(observation.size !== undefined ? { size: observation.size } : {}),
    ...(observation.offset !== undefined ? { offset: observation.offset } : {}),
  }
}
