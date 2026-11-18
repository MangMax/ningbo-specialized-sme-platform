import { fileEventSyncRoute } from '../../../../../layers/sme-roster/server/utils/file-event-sync-route'
defineRouteMeta({
  openAPI: {
    tags: ['正式事件同步'],
    summary: '受鉴权公共preflight：按已保存分段补齐未知年月',
    description:
      '最多3000出处/1000声明，100事件每块；预检需idempotencyKey、basis、actor；提交需request原请求、planHash、chunk(0起顺序)。完整成员集合重验，跨块中断使用原请求续跑。仅补未知year/batchSeq，多出处未证一致保留待核；不修改资格规则。',
    parameters: [
      { in: 'path', name: 'id', required: true, schema: { type: 'integer', minimum: 1 } },
    ],
    security: [{ bearerAuth: [] }],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            additionalProperties: false,
            required: ['idempotencyKey', 'basis', 'actor'],
            properties: {
              idempotencyKey: { type: 'string' },
              basis: { type: 'string' },
              actor: {
                type: 'object',
                additionalProperties: false,
                required: ['type', 'id'],
                properties: {
                  type: { type: 'string', enum: ['user', 'agent'] },
                  id: { type: 'string' },
                },
              },
            },
          },
        },
      },
    },
    responses: {
      200: {
        description:
          'planHash,rows(企业/事件/前后值/原因),chunks,completed,counts(updated,unchanged,conflicts,failed,unexecuted)',
      },
      400: { description: '非法请求' },
      401: { description: '需API token' },
      403: { description: '浏览器门控或跨源拒绝' },
      409: { description: '计划成员、来源或版本已变化' },
      413: { description: '超出明确容量' },
    },
  },
})
export default fileEventSyncRoute('preflight', false)
