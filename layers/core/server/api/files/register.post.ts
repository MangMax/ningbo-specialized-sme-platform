import { useDb } from '@db'
import { requestLogContext } from '../../../lib/logging'
import { UploadRegistrationError } from '../../utils/file-store'
import { registerUploadedFile } from '../../../../../server/utils/stored-files'

defineRouteMeta({
  openAPI: {
    tags: ['文件库'],
    summary: '登记已落位的上传',
    description: '使用 tus 返回的路径登记文件。大小和 SHA-256 由服务端从磁盘读取，分类声明由已注册的分类贡献校验。',
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['relPath'],
            additionalProperties: true,
            properties: {
              relPath: { type: 'string', description: '从 X-Upload-Path 解码的库内相对路径。' },
              fileCategory: { type: 'string', description: '已注册的文件分类。省略时根据落位路径或默认登记策略选择。' },
            },
          },
        },
      },
    },
    responses: {
      200: { description: '已有登记的文件行。' },
      201: { description: '新登记的文件行。' },
      400: { description: '声明、分类或落位路径无效，或文件不符合分类的入库规则。' },
      409: { description: '磁盘内容与已有登记身份不符。' },
    },
  },
})

export default defineEventHandler(async (event) => {
  let input: unknown
  try {
    input = await readBody(event)
  } catch (error) {
    throw createError({ statusCode: 400, message: (error as Error).message })
  }

  try {
    const { row, created } = await registerUploadedFile(useDb(), useRuntimeConfig().filesDir, input, requestLogContext(event))
    if (created) setResponseStatus(event, 201)
    return row
  } catch (error) {
    if (error instanceof UploadRegistrationError) {
      throw createError({ statusCode: error.statusCode, message: error.message, ...(error.reason ? { data: { reason: error.reason } } : {}) })
    }
    throw error
  }
})
