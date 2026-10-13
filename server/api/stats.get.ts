import { useDb } from '@db'
import { getStats } from '~~/lib/query'

export default defineEventHandler(() => getStats(useDb()))
