import { enterpriseProfileRoute } from '../../../utils/enterprise-profile-route'
defineRouteMeta({ openAPI: {
  tags: ['企业资料'], summary: '按稳定企业 ID 原子更正普通资料并保留旧名',
  description: '#96: name 为规范现名；city/district 为企业当前属地，null 显式清空，省略不改。expectedVersion 必须来自 GET profile。name 变更必须带 previousName 的精确旧名和 sameSubject:true；actor/basis 为调用方明确声明。统代、登记状态 regStatus、平台流程状态、差异/名录派生状态只读，身份补全/冲突/归并使用专门操作。详情见 docs/maintenance-96.md。',
  security: [{ bearerAuth: [] }],
  requestBody: { required: true, content: { 'application/json': { schema: {
    type: 'object', additionalProperties: false, required: ['idempotencyKey', 'expectedVersion', 'changes', 'actor', 'basis'],
    properties: {
      idempotencyKey: { type: 'string', ...{ minLength: 1, maxLength: 200 } }, expectedVersion: { type: 'string', ...{ pattern: '^[0-9a-f]{64}$' } },
      changes: { type: 'object', additionalProperties: false, ...{ minProperties: 1 }, properties: { name: { type: 'string', ...{ minLength: 1, maxLength: 300 } }, city: { type: 'string', nullable: true, ...{ minLength: 1, maxLength: 100 } }, district: { type: 'string', nullable: true, ...{ minLength: 1, maxLength: 100 } } } },
      expectedValues: { type: 'object', additionalProperties: false, properties: { name: { type: 'string' }, city: { type: 'string', nullable: true }, district: { type: 'string', nullable: true } } },
      previousName: { type: 'object', additionalProperties: false, required: ['name', 'sameSubject'], properties: { name: { type: 'string' }, sameSubject: { type: 'boolean', enum: [true] } } },
      actor: { type: 'object', additionalProperties: false, required: ['type', 'id'], properties: { type: { type: 'string', enum: ['user', 'agent'] }, id: { type: 'string', ...{ minLength: 1, maxLength: 200 } } } }, basis: { type: 'string', ...{ minLength: 1, maxLength: 2000 } },
    },
  } } } },
  responses: { 200: { description: 'auditId,profile,version,retainedAlias,committedAt；同键同请求返回原回执' }, 400: { description: '非法字段或请求' }, 401: { description: 'API token 缺失/错误/未配置' }, 404: { description: '企业不存在' }, 409: { description: '版本/旧值/同键异请求/身份/旧名生命周期冲突；无部分写入' }, 422: { description: '缺少明确同主体旧名确认或名称非法' } },
} })
export default enterpriseProfileRoute('patch')
