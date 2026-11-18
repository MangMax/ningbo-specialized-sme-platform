import { decisionRoute102 } from '../../../utils/decision-lifecycle-102-route'
defineRouteMeta({ openAPI: { tags: ['差异决定'], summary: '按稳定 ID 读取差异决定版本', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }], responses: { 200: { description: '历史版本与 isCurrent，不含平台原文' }, 404: { description: '版本不存在' } } } })
export default decisionRoute102('get')
