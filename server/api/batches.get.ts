import { useDb } from '@db'
import { listBatches } from '~~/lib/query'

/** 全部导入快照,最新在前。见票 11。 */
export default defineEventHandler(() => listBatches(useDb()))
