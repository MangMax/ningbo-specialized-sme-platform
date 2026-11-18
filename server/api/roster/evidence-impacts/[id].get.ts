import { reviewRoute114 } from '../../../../layers/sme-roster/server/utils/evidence-review-114-route'

defineRouteMeta({ openAPI: { tags: ['解释复核'], summary: '精确复核详情', description: '只读无需 token，写入需 API token；所有响应 no-store。', "parameters":[{"name": "id", "in": "path", "required": true, "schema": {"type": "integer", "minimum": 1, "maximum": 9007199254740991}}], responses: { 200: { description: '有界公开复核结果；游标绑定过滤/as-of' }, 400: { description: 'invalid_request / invalid_cursor' }, 401: { description: '写入需配置 API token' }, 404: { description: 'not_found' }, 409: { description: 'idempotency_conflict / rule_version_conflict' }, 500: { description: 'transaction_failed，无部分提交' } } } })
export default reviewRoute114('get')
