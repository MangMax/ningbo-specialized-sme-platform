import { useDb } from '@db'
import { listEnterpriseSources } from '../../../../utils/enterprise-kernel'
import { directoryInput, enterpriseId } from '../../../../utils/enterprise-directory-route'

defineRouteMeta({ openAPI: {
  tags: ['企业基础库'], summary: '按企业读取已登记的来源', responses: { 200: { description: '来源、系列和文件版本列表' } },
} })
export default defineEventHandler(event => listEnterpriseSources(useDb(), directoryInput(enterpriseId, getRouterParam(event, 'id'))))
