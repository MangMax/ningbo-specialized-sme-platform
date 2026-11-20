import { createError, readBody, setResponseStatus, type H3Event } from 'h3'
import { useDb } from '@db'
import { versionInput } from '../../lib/contracts'
import { registerLeadVersion } from './versions'
import { registerPostgresLeadVersion, usePostgresLeadDb } from './postgres-versions'

export async function registerLeadVersionRequest(event: H3Event) {
  const parsed = versionInput.safeParse(await readBody(event))
  if (!parsed.success) throw createError({ statusCode: 400, message: '名单版本资料有误', data: parsed.error.issues })
  const postgres = usePostgresLeadDb()
  if (postgres && process.env.NUXT_POSTGRES_DIRECTORY_WRITE !== '1') {
    throw createError({ statusCode: 503, message: '线索名单处于只读验收模式。' })
  }
  const root = useRuntimeConfig(event).filesDir
  const result = await (postgres
    ? registerPostgresLeadVersion(postgres, root, parsed.data)
    : registerLeadVersion(useDb(), root, parsed.data))
  if (result.created) setResponseStatus(event, 201)
  return result
}
