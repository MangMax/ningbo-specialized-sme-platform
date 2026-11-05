import type { NitroDiscoverySchema } from '../../../utils/nitro-discovery-schema'
import { physicalRecoveryRoute } from '../../../utils/file-physical-route'
defineRouteMeta({ openAPI: {
  tags: ['文件库'], summary: '从物理删除隔离区恢复同一文件',
  description: 'API token + intentId + 完整维护封套。核验登记 SHA-256 和字节数，不覆盖原路径已有文件。失败不宣称 SQL 回滚恢复了字节；GET 同路径读取待处理状态。',
  requestBody: { content: { 'application/json': { schema: {
    type: 'object', additionalProperties: false, required: ['intentId', 'expectedRevision', 'idempotencyKey', 'actor', 'basis'],
    properties: { intentId: { type: 'string', maxLength: 100 }, expectedRevision: { type: 'integer', minimum: 0 }, idempotencyKey: { type: 'string', maxLength: 200 }, actor: { type: 'string', maxLength: 200 }, basis: { type: 'string', maxLength: 2000 } },
  } as NitroDiscoverySchema } } }, responses: { 200: { description: '恢复完成回执；同键重放原回执。' }, 400: { description: '非法封套。' }, 401: { description: '缺少 API token。' }, 404: { description: '意图不存在。' }, 409: { description: '修订、字节、路径或幂等冲突。' } },
} })
export default physicalRecoveryRoute('recover')
