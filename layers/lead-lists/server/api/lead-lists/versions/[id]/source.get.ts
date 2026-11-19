import { createReadStream } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { relative } from 'node:path'
import { useDb } from '@db'
import { verifyFileRead } from '#core/server/utils/file-read-identity'
import { resolveInsideRoot } from '#core/server/utils/file-store'
import { leadListId } from '../../../../../lib/contracts'
import { readLeadVersionSource } from '../../../../utils/versions'

defineRouteMeta({ openAPI: {
  tags: ['线索名单'], summary: '下载名单版本登记的原文件',
  responses: { 200: { description: '已核验的源文件字节' }, 409: { description: '文件身份与登记版本不一致' } },
} })

export default defineEventHandler(async event => {
  const id = leadListId.safeParse(Number(getRouterParam(event, 'id')))
  if (!id.success) throw createError({ statusCode: 400, message: '名单版本编号有误' })
  const db = useDb()
  const source = readLeadVersionSource(db, id.data)
  const root = useRuntimeConfig(event).filesDir
  const path = resolveInsideRoot(root, source.relPath)
  if (!path) throw createError({ statusCode: 403, message: '原文件位置无效' })
  let actualPath: string
  try {
    const actualRoot = await realpath(root)
    actualPath = await realpath(path)
    if (!resolveInsideRoot(actualRoot, relative(actualRoot, actualPath))) {
      throw createError({ statusCode: 403, message: '原文件位置无效' })
    }
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') throw createError({ statusCode: 404, message: '原文件不存在' })
    throw error
  }
  const { status, registered } = await verifyFileRead(db, root, source.relPath)
  if (status !== 'verified' || registered?.fileId !== source.fileId || registered.sha256 !== source.sha256) {
    throw createError({ statusCode: 409, message: '原文件与版本登记不符' })
  }
  setHeader(event, 'Content-Type', 'application/octet-stream')
  setHeader(event, 'Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(source.filename).replaceAll("'", '%27')}`)
  setHeader(event, 'X-Content-Type-Options', 'nosniff')
  setHeader(event, 'Cache-Control', 'private, no-store')
  setHeader(event, 'Content-Length', registered.bytes)
  return sendStream(event, createReadStream(actualPath))
})
