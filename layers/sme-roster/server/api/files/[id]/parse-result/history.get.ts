import { parseRoute105 } from '../../../../utils/parse-maintenance-route'
defineRouteMeta({ openAPI: {
  tags: ['Files'], summary: '#105 有界解析维护审计及回执点读',
  description: '默认20最多50条,按receiptId升序,afterId游标。列表不含before/after快照;receiptId显式点读完整回执(不得混分页)。保留全部历史,不含OCR/名录原文。',
  parameters: [
    { in: 'path', name: 'id', required: true, schema: { type: 'integer', minimum: 1 } },
    { in: 'query', name: 'afterId', schema: { type: 'integer', minimum: 0 } }, { in: 'query', name: 'limit', schema: { type: 'integer', minimum: 1, maximum: 50, default: 20 } }, { in: 'query', name: 'receiptId', schema: { type: 'integer', minimum: 1 } },
  ], responses: { 200: { description: '{fileId,rows,nextAfterId} 或指定回执 {id,fileId,idempotencyKey,operation,actor,reason,before,after,createdAt}' }, 400: { description: '非法参数' }, 404: { description: '文件/回执不存在' } },
} })
export default parseRoute105('history')
