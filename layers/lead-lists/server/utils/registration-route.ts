import { createError, readBody, setResponseStatus, type H3Event } from 'h3'
import { versionInput } from '../../lib/contracts'
import { registerPostgresLeadVersion, usePostgresLeadWriteDb } from './postgres-versions'

export async function registerLeadVersionRequest(event: H3Event) {
  const parsed = versionInput.safeParse(await readBody(event))
  if (!parsed.success) throw createError({ statusCode: 400, message: '名单版本资料有误', data: parsed.error.issues })
  const db = usePostgresLeadWriteDb()
  const root = useRuntimeConfig(event).filesDir
  const result = await registerPostgresLeadVersion(db, root, parsed.data)
  if (result.created) setResponseStatus(event, 201)
  return result
}
