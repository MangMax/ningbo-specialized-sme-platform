import { useDb } from '@db'
import { getQuality } from '~~/lib/query'

export default defineEventHandler(() => getQuality(useDb()))
