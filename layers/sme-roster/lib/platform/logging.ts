import { appLog, type LogContext, type LogInput } from '../../../core/lib/logging'
import type { PlatformQueryStatus } from './live-query'

// Only application enums enter the operation vocabulary, never a URL or query text.
const sources = { queryList: 'query_list', businessList: 'business_list', queryBusList: 'query_bus_list' } as const
export function platformOperation(source: keyof typeof sources, phase: 'query' | 'page' | 'slot' | 'retry' | 'item', title: string | null = null) {
  const scope = title === '1' || title === '2' || title === '3' ? `.title_${title}` : ''
  return `platform.${sources[source]}.${phase}${scope}`
}
export function platformQueryOperation(source: keyof typeof sources, titles: (string | null)[]) {
  if (titles.length === 1) return platformOperation(source, 'query', titles[0])
  return `${platformOperation(source, 'query')}.titles_${['1', '2', '3'].filter(title => titles.includes(title)).join('')}`
}
export function platformOutcome(status: PlatformQueryStatus): LogInput['outcome'] {
  return status === 'failed' ? 'failure' : status === 'auth_failed' ? 'denied' : status === 'not_queried' ? 'skipped' : status
}
/** Runtime diagnostics only; failure codes are existing fixed domain discriminators. */
export function logPlatformResult(operation: string, status: PlatformQueryStatus, context: LogContext, counts: LogInput['counts'], durationMs: number, errorCode?: string) {
  appLog({ module: 'sme-roster', source: 'platform', operation, outcome: status === 'failed' && errorCode === 'timeout' ? 'timeout' : platformOutcome(status),
    level: status === 'failed' || status === 'auth_failed' ? 'error' : status === 'partial' || status === 'not_queried' ? 'warn' : 'info',
    counts, durationMs, ...(errorCode ? { errorCode } : {}) }, context)
}
