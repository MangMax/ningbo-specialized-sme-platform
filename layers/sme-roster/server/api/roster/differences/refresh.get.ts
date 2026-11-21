import { getQuery, setHeader } from 'h3'
import { useDb } from '@db'
import { requireTaskCenterAccess } from '../../../../../core/server/utils/task-center-access'
import { parseEnterpriseDifferenceRefreshQuery, readEnterpriseDifferenceComparisons } from '../../../utils/enterprise-difference-refresh'
import { usePostgresRosterDb } from '../../../utils/postgres-roster-db'
import { readPostgresEnterpriseDifferenceComparisons } from '../../../utils/enterprise-difference-refresh-postgres'
defineRouteMeta({openAPI:{tags:['名录'],summary:'读取企业当前差异比较',description:'enterpriseIds 为逗号分隔正整数，省略取全部公布企业。读取刷新投影及较新的原有差异判断，不采集、不刷新、不编排代理。'}})
export default defineEventHandler(event=>{
  requireTaskCenterAccess(event)
  setHeader(event,'cache-control','no-store')
  const input = parseEnterpriseDifferenceRefreshQuery(getQuery(event))
  const postgres = usePostgresRosterDb()
  return postgres ? readPostgresEnterpriseDifferenceComparisons(postgres, input) : readEnterpriseDifferenceComparisons(useDb(), input)
})
