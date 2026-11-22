import { readBody, setHeader } from 'h3'
import { requireTaskCenterAccess } from '../../../../../core/server/utils/task-center-access'
import { refreshPostgresEnterpriseDifferences } from '../../../utils/enterprise-difference-refresh-postgres'
import { usePostgresRosterDb } from '../../../utils/postgres-roster-db'
defineRouteMeta({openAPI:{tags:['名录'],summary:'刷新企业当前差异比较',description:'可选 enterpriseIds（非空、不重复、存在）；省略刷新全部公布企业。复用当前资格平台比较；判断默认待核，业务输入未变保留当前判断。只写独立当前投影，不写资格、旧决定或任务队列。'}})
export default defineEventHandler(async event=>{
  requireTaskCenterAccess(event)
  setHeader(event,'cache-control','no-store')
  const input = await readBody(event)
  const postgres = usePostgresRosterDb(true)
  return refreshPostgresEnterpriseDifferences(postgres, input)
})
