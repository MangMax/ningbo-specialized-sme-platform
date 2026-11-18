import { defineEventHandler, getQuery, getRouterParam, setHeader } from 'h3'
import { useDb } from '@db'
import { readPlatformQueryEvidence, type PlatformEvidenceInput } from '../../../../../layers/sme-roster/lib/platform/evidence-read'

defineRouteMeta({
  openAPI: {
    tags: ['比对'], summary: '按查询ID精确分段读取平台原档',
    description: '只读，不查询外部平台。legacyProvenance读取独立legacy采集原档，保留typed未知；rawResponse/collectionEvidence/legacyProvenance/relation 为最多65536 UTF-8字节的base64分块；先拼接全部字节再解码。relations 按原序分页列出所有关系ID，随后按relationId读取原始关系JSON。null 与空值可区分，不截断或重判证据。',
    parameters: [
      { name: 'queryId', in: 'path', required: true, schema: { type: 'integer', minimum: 1 } },
      { name: 'field', in: 'query', required: true, schema: { type: 'string', enum: ['rawResponse', 'collectionEvidence', 'legacyProvenance', 'relations', 'relation'] } },
      { name: 'relationId', in: 'query', schema: { type: 'integer', minimum: 1 }, description: 'field=relation 时必填，须属于 queryId。' },
      { name: 'offset', in: 'query', schema: { type: 'integer', minimum: 0, default: 0 } },
      { name: 'length', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 65536, default: 65536 } },
      { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1, default: 1 } },
      { name: 'pageSize', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 200, default: 100 } },
    ],
    responses: {
      200: { description: '分块 {queryId,field,encoding:base64,offset,byteLength,totalBytes,isNull,hasMore,data}；relations 返回 {queryId,field,rows:[{id,sequenceNo}],total,page,pageSize}。原始关系JSON含所有持久化列（camelCase，含rawFields），展示用matchedName/sourcePage请使用完整列表或原采集段。' },
      400: { description: '字段、ID或范围非法。' }, 404: { description: '查询或该查询下关系不存在。' },
    },
  },
})
export default defineEventHandler(event => {
  setHeader(event, 'cache-control', 'no-store')
  const q = getQuery(event)
  const num = (key: string) => q[key] === undefined ? undefined : Number(q[key])
  return readPlatformQueryEvidence(useDb(), {
    queryId: Number(getRouterParam(event, 'queryId')), field: q.field as PlatformEvidenceInput['field'],
    relationId: num('relationId'), offset: num('offset'), length: num('length'), page: num('page'), pageSize: num('pageSize'),
  })
})
