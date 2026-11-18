import type { NitroDiscoverySchema } from '../../../utils/nitro-discovery-schema'
import { physicalRecoveryRoute } from '../../../utils/file-physical-route'
defineRouteMeta({ openAPI: {
  tags: ['文件库'], summary: '读取文件物理删除意图和完成回执',
  description: '按文件 ID 读取最新一条意图；可指定 intentId。pending/recovering 表示须重试或显式恢复，不能推断磁盘原路径可用。',
  parameters: [{ name: 'intentId', in: 'query', schema: { type: 'string', maxLength: 100 } as NitroDiscoverySchema }],
  responses: { 200: { description: '有界状态、登记 SHA+bytes、删除和恢复完成回执；不读取原文。' }, 404: { description: '无意图。' } },
} })
export default physicalRecoveryRoute('read')
