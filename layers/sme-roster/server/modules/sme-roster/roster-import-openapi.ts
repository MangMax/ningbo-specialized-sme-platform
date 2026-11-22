import { z } from 'zod'
import { rosterImportMcpPayloadSchema } from '../../utils/roster-import-schema'

const actions = ['preflight', 'commit'] as const
type ImportPath = `/api/roster/import/${typeof actions[number]}`
type JsonSchema = z.core.JSONSchema.JSONSchema

function createImportRequestBody() {
  const { properties } = structuredClone(z.toJSONSchema(rosterImportMcpPayloadSchema, { io: 'input' }))
  const {
    differences, platformQueries, announcement, officialEvidenceAppends, officialEvidenceCorrections,
    officialEvidencePlanHash, aliases, exportSnapshot, usccBackfills, merges,
  } = properties!
  const queries = platformQueries as { items: { properties: { relations: { items: { properties: { year: { anyOf: JsonSchema[] } } } } } } }
  // Nitro's literal extractor omitted the unary negative minimum in the published REST schema.
  const year = queries.items.properties.relations.items.properties.year
  delete year.anyOf[0]!.minimum

  return {
    required: true,
    content: {
      'application/json': {
        schema: {
          type: 'object',
          required: ['idempotencyKey', 'sourceKind', 'sourceIdentity', 'payload'],
          properties: {
            idempotencyKey: { type: 'string', description: '幂等键（库层面唯一）。' },
            sourceKind: { type: 'string', enum: ['announcement', 'platform_export', 'platform_archive', 'alias_evidence'] },
            sourceIdentity: { type: 'string', description: '来源身份：文件相对路径 / 逻辑标识（不含凭证）。' },
            sourceSha256: { type: 'string', nullable: true },
            payload: {
              type: 'object',
              description: '统一写入载荷。新采集提交来源字段，已有采集以 reuseExisting:true 引用坐标或行序。历史原始资料通过离线归档处理。',
              properties: {
                differences, platformQueries, announcement, officialEvidenceAppends, officialEvidenceCorrections,
                officialEvidencePlanHash, aliases, exportSnapshot, usccBackfills, merges,
              },
              additionalProperties: true,
            },
          },
        },
      },
    },
  }
}

const requestBody = createImportRequestBody()
export type RosterImportOpenApiDocument = {
  paths?: Partial<Record<ImportPath, { post?: { requestBody?: typeof requestBody } }>>
}

export function extendRosterImportOpenApi(document: RosterImportOpenApiDocument) {
  for (const action of actions) {
    const operation = document.paths?.[`/api/roster/import/${action}`]?.post
    if (operation) operation.requestBody = requestBody
  }
}
