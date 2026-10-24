import { appLog, type LogContext } from '../../lib/logging'
import { clientLogReport, clientReportKey } from '../../lib/client-logging/report'
import { CLIENT_LIBRARY_SIGNALS } from '../../lib/client-logging/library-contract'

/** Process-local ceilings; not distributed quotas or authenticated client identities. */
export function createClientLogIntake(now = Date.now) {
  const peers = new Map<string, { start: number; requests: number; seen: Map<string, number> }>()
  let start = now(), requests = 0
  return {
    accept(body: unknown, peer: string, context: LogContext) {
      const time = now()
      if (time - start >= 60000) { start = time; requests = 0; peers.clear() }
      if (requests++ >= 120) return { status: 429, accepted: 0, duplicates: 0 }
      let state = peers.get(peer)
      if (!state) {
        // Global quota also bounds this map to 120 peers/window.
        state = { start: time, requests: 0, seen: new Map() }; peers.set(peer, state)
      }
      if (time - state.start >= 60000) { state.start = time; state.requests = 0; state.seen.clear() }
      if (state.requests++ >= 30) return { status: 429, accepted: 0, duplicates: 0 }
      if (!Array.isArray(body) || body.length < 1 || body.length > 8) return { status: 400, accepted: 0, duplicates: 0 }
      const reports = body.map(item => clientLogReport(item?.event))
      if (reports.some(report => !report)) return { status: 400, accepted: 0, duplicates: 0 }
      let accepted = 0, duplicates = 0
      for (const report of reports) {
        const key = clientReportKey(report!)
        const previous = state.seen.get(key)
        if (previous !== undefined && time - previous < 10000) { duplicates++; continue }
        // Keys are from a finite vocabulary, never raw error text or library arguments.
        state.seen.set(key, time)
        if (report!.kind === 'library_signal') {
          const signal = CLIENT_LIBRARY_SIGNALS[report!.signal]
          appLog({ origin: { runtime: 'browser', integration: signal.integration, capture: 'hook', execution: 'page' },
            source: 'client', operation: signal.operation, outcome: signal.outcome, level: signal.level,
          }, { requestId: context.requestId, traceId: context.traceId })
        } else appLog({ origin: { runtime: 'browser', integration: report!.kind === 'vue_error' ? 'vue' : report!.kind === 'interaction_failure' ? 'application' : 'browser', capture: report!.kind === 'interaction_failure' ? 'manual' : 'hook', execution: 'page' }, source: 'client', operation: `client.${report!.page}.${report!.kind}`,
          errorCode: report!.interaction, outcome: 'failure', level: report!.level, untrustedRelatedRequestId: report!.relatedRequestId,
        }, { requestId: context.requestId, traceId: context.traceId })
        accepted++
      }
      return { status: 202, accepted, duplicates }
    },
  }
}
