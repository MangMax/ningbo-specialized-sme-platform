import { setEnterpriseRemoved } from '../../../../utils/enterprise-directory-postgres-write'
import { z } from 'zod'
import { requireApiToken } from '../../../../utils/api-guard'
import { directoryInput, directoryResult, usePostgresDirectoryWriteDb, enterpriseId } from '../../../../utils/enterprise-directory-route'

defineRouteMeta({ openAPI: {
  tags: ['企业基础库'], summary: '移出或恢复企业基础库在库状态', security: [{ bearerAuth: [] }],
  requestBody: { required: true, content: { 'application/json': { schema: {
    type: 'object', required: ['expectedRevision', 'removedReason'], properties: {
      expectedRevision: { type: 'integer' }, removedReason: { type: 'string', nullable: true },
    },
  } } } },
  responses: { 200: { description: '更新后的基础库状态' }, 409: { description: '资料版本或合并目标已改变' } },
} })
const membership = z.strictObject({ expectedRevision: z.number().int().positive(), removedReason: z.string().trim().min(1).max(4000).nullable() })
export default defineEventHandler(async event => {
  requireApiToken(event)
  const id = directoryInput(enterpriseId, getRouterParam(event, 'id'))
  const body = directoryInput(membership, await readBody(event))
  return directoryResult(() => {
    const db = usePostgresDirectoryWriteDb()
    return setEnterpriseRemoved(db, id, body.expectedRevision, body.removedReason)
  })
})
