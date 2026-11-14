import { correspondenceRoute } from '~~/server/utils/record-correspondence-route'
defineRouteMeta({ openAPI: {
  tags: ['名录对应'], summary: '只读生成已选归档业务版本对应候选',
  description: '先过滤指定 queryIds/event/主体/称号/角色，再以同接口 recordId+versionId 分组。缺编号、冲突、无原文和未投影均按 relationId 隔离；不支持 asOf。每组保留全部 observationRefs、旧决定状态/revision/规则版本及冲突，不复制确认。edge.relationId 优先组内有旧对应的最小原ID，否则取最小原ID。导出候选仍逐行，total/分页在业务分组后计算。不抓取、不写入、不自动确认。',
  requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', additionalProperties: false, required: ['ruleVersion'], properties: { eventId: { type: 'integer' }, enterpriseId: { type: 'integer' }, titleCode: { type: 'string' }, queryIds: { type: 'array', items: { type: 'integer' } }, exportBatchIds: { type: 'array', items: { type: 'integer' } }, ruleVersion: { type: 'string' }, page: { type: 'integer' }, pageSize: { type: 'integer', maximum: 200 } } } } } },
  responses: {
    200: { description: '业务版本候选，导出仍为原行粒度；status 始终 candidate。', content: { 'application/json': { schema: {
      type: 'object', required: ['rows', 'total', 'page', 'pageSize', 'coverage', 'exportBatches'], properties: {
        total: { type: 'integer' }, page: { type: 'integer' }, pageSize: { type: 'integer' },
        coverage: { type: 'array', items: { type: 'object', description: '原选定查询覆盖；不含 rawResponse/归档行数组' } }, exportBatches: { type: 'array', items: { type: 'object' } },
        rows: { type: 'array', items: { type: 'object', required: ['edge', 'status', 'conflicts', 'existingCorrespondenceId', 'revision'], properties: {
          edge: { type: 'object', description: '沿用原观察/导出端点；不改旧指针', properties: { relationId: { type: 'integer' }, exportRowId: { type: 'integer' }, type: { type: 'string' }, role: { type: 'string' }, eventId: { type: 'integer' }, enterpriseId: { type: 'integer' }, titleCode: { type: 'string' } } },
          status: { type: 'string', enum: ['candidate'] }, ruleId: { type: 'string' }, ruleVersion: { type: 'string' }, evidence: { type: 'object', description: '代表观察原有证据；全部观察证据见 observationRefs' },
          conflicts: { type: 'array', items: { type: 'string' }, description: '组内冲突并集，含 correspondence_decision_conflict；multiple_candidate_rows 按业务版本候选组计数' },
          existingCorrespondenceId: { type: 'integer', nullable: true, description: '仅代表端点上匹配目标/type/role的旧对应，不传播到其他观察' }, revision: { type: 'integer', nullable: true }, representativeRelationId: { type: 'integer' },
          businessRecord: { type: 'object', required: ['recordId', 'versionId', 'interface', 'groupState'], properties: {
            recordId: { type: 'integer', nullable: true }, versionId: { type: 'integer', nullable: true }, interface: { type: 'string' }, platformKey: { type: 'string', nullable: true },
            groupState: { type: 'string', enum: ['verified', 'not_indexed', 'missing_key', 'conflict', 'unverifiable'] }, identityState: { type: 'string', enum: ['resolved', 'missing_key', 'conflict', 'not_indexed'] }, contentState: { type: 'string', enum: ['verified', 'unverifiable', 'not_indexed'] },
            keySource: { type: 'string', nullable: true }, projectionRuleVersion: { type: 'string', nullable: true }, hashAlgorithm: { type: 'string', nullable: true }, contentHash: { type: 'string', nullable: true },
          } },
          observationRefs: { type: 'array', description: '仅选中 scope 内全部原观察，各自保留决定/冲突，不含完整raw', items: { type: 'object', required: ['relationId', 'queryId', 'sequenceNo', 'queriedAt', 'businessRecord', 'existingCorrespondenceIds', 'existingCorrespondences', 'conflicts'], properties: {
            relationId: { type: 'integer' }, queryId: { type: 'integer' }, sequenceNo: { type: 'integer' }, queriedAt: { type: 'string' }, interface: { type: 'string' }, relationKey: { type: 'string', nullable: true }, queryStatus: { type: 'string' }, queryKey: { type: 'string' }, rdjb: { type: 'string' }, queryTitleCode: { type: 'string', nullable: true }, titleCode: { type: 'string' }, enterpriseId: { type: 'integer', nullable: true }, usccRaw: { type: 'string', nullable: true }, nameRaw: { type: 'string', nullable: true }, verificationStatus: { type: 'string' }, matchBasis: { type: 'string' }, target: { type: 'object' }, evidence: { type: 'object' }, businessRecord: { type: 'object', description: '每观察自己的业务metadata' }, conflicts: { type: 'array', items: { type: 'string' } }, existingCorrespondenceIds: { type: 'array', items: { type: 'integer' } }, existingCorrespondences: { type: 'array', items: { type: 'object', description: '每观察自己的旧决定引用，结构同组级 existingCorrespondences' } },
          } } },
          existingCorrespondenceIds: { type: 'array', items: { type: 'integer' } },
          existingCorrespondences: { type: 'array', description: '组内全部旧对应，包括不同目标/角色；不读取未选观察', items: { type: 'object', required: ['id', 'status', 'revision', 'ruleVersion'], properties: {
            id: { type: 'integer' }, relationId: { type: 'integer', nullable: true }, exportRowId: { type: 'integer', nullable: true }, eventId: { type: 'integer', nullable: true }, predecessorEventId: { type: 'integer', nullable: true }, enterpriseId: { type: 'integer', nullable: true }, titleCode: { type: 'string' }, type: { type: 'string' }, role: { type: 'string' }, status: { type: 'string', enum: ['candidate', 'confirmed', 'rejected', 'unlinked'] }, revision: { type: 'integer' }, ruleId: { type: 'string' }, ruleVersion: { type: 'string' }, createdAt: { type: 'string' }, decidedAt: { type: 'string', nullable: true }, endedAt: { type: 'string', nullable: true },
          } } },
        } } },
      },
    } } } },
    400: { description: 'Invalid source selection' }, 404: { description: 'Official event, enterprise or selected source not found' },
  },
} })
export default correspondenceRoute('candidates')
