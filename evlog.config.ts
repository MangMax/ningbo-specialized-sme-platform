import { defineEvlog } from 'evlog'
import { applicationLogRedaction } from './layers/core/lib/logging/privacy'
import { drainApplicationEvent } from './layers/core/lib/logging'
export default defineEvlog({
  redact: applicationLogRedaction,
  service: 'ningbo-sme', enabled: true, silent: true, pretty: false,
  include: ['/api/**', '/mcp'], exclude: ['/api/logs', '/api/logs/**'],
  sampling: { rates: { debug: 100, info: 100, warn: 100, error: 100 } },
  // Raw evlog console/transport/stream are disabled. Only the allowlisted drain writes output.
  drain: ctx => { drainApplicationEvent(ctx.event) },
})
