import { candidateJobRoute } from '../../../../../layers/sme-roster/server/utils/candidate-job-route'
defineRouteMeta({
  openAPI: {
    tags: ['记录对应'],
    summary: '异步生成公布事件归档候选',
    description:
      '范围恰选 eventIds(最多200)/titleCode/queryId；clientRequestId 幂等。每片200事件，每页25行；生成候选不自动确认。任务中心管理取消与失败续跑。',
    security: [{ bearerAuth: [] }],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['clientRequestId'],
            additionalProperties: false,
            properties: {
              clientRequestId: { type: 'string', description: '1–120字符，同一请求重试须保持不变' },
              eventIds: {
                type: 'array',
                description: '1–200个正式事件ID',
                items: { type: 'integer' },
              },
              titleCode: {
                type: 'string',
                enum: ['specialized_sme', 'innovative_sme', 'little_giant'],
              },
              queryId: { type: 'integer' },
              afterEventId: { type: 'integer' },
              throughEventId: { type: 'integer' },
            },
          },
        },
      },
    },
    responses: {
      202: { description: '后台任务已受理' },
      400: { description: '范围无效' },
      401: { description: '未授权' },
      409: { description: '幂等冲突' },
    },
  },
})
export default candidateJobRoute('submit')
