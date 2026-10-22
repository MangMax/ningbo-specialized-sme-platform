import { requestLogContext } from '../../../lib/logging'
import { useDb } from '@db'
import {
  parseUploadDeclaration,
  registerStoredFile,
  UploadRegistrationError,
} from '../../utils/stored-files-upload'

/**
 * 登记一次 **已落位**的上传。`POST /api/files/register`
 *
 * 上传本身是 tus(`/api/uploads`)的事 —— 这条路由只做「传完之后把它记进库」:
 * 客户端从 tus 响应头 `X-Upload-Path` 拿到**服务端算出的**落位路径,连同用户填的
 * 来源/年份/批次一起送过来;磁盘事实(大小 / SHA-256)由服务端从盘上读。
 *
 * 为什么不让 tus 的 `onUploadFinish` 直接写库:见
 * `server/utils/stored-files-upload.ts` 的文件头 —— 落位规则保持成纯函数、
 * 写库失败时不会因为「文件已落盘」而无法回滚,且登记本身**幂等**、可重试。
 *
 * 请求体(全部必填 `relPath`,其余可空 —— 没填就是 `null` + `category_state='unset'`,票 12 回写):
 * ```json
 * { "relPath": "jxj/announcement/2024/1/xxx.pdf", "source": "jxj", "kind": "announcement",
 *   "year": "2024", "batch": "1" }
 * ```
 * 校验不通过一律 **400 且不落库**(白名单 / 四位年份 / 正整数批次 / 路径锁根 / 磁盘存在性)。
 */
export default defineEventHandler(async (event) => {
  let input
  try {
    input = parseUploadDeclaration(await readBody(event))
  } catch (error) {
    throw createError({ statusCode: 400, message: (error as Error).message })
  }

  try {
    const { row, created } = await registerStoredFile(useDb(), useRuntimeConfig().filesDir, input, requestLogContext(event))
    if (created) setResponseStatus(event, 201)
    return row
  } catch (error) {
    if (error instanceof UploadRegistrationError) {
      // 用 `message` 而不是 `statusMessage`:h3 会对较长的 statusMessage 告警
      // (它将被按 HTTP 语义净化)。前端从 `data.message` 取这句话。
      throw createError({ statusCode: error.statusCode, message: error.message })
    }
    throw error
  }
})
