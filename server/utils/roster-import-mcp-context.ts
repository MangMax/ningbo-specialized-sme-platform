import { AsyncLocalStorage } from 'node:async_hooks'
import type { LogContext } from '../../lib/logging'

// Scoped to the two import tools; the request hook supplies only server-owned context.
export const rosterImportMcpContext = new AsyncLocalStorage<LogContext>()
