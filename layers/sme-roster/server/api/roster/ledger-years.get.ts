import { useDb } from '@db'
import { readLedgerYears } from '#sme-roster/lib/roster/recognitions'

defineRouteMeta({
  openAPI: {
    tags: ['台账'],
    summary: '读取企业列表的年份选项',
    responses: {
      200: {
        description: '事件年份和首次正式认定年份，分别去重并按升序返回。',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['eventYears', 'firstRecognitionYears'],
              properties: {
                eventYears: { type: 'array', items: { type: 'integer' } },
                firstRecognitionYears: { type: 'array', items: { type: 'integer' } },
              },
            },
          },
        },
      },
    },
  },
})

export default defineEventHandler(() => readLedgerYears(useDb()))
