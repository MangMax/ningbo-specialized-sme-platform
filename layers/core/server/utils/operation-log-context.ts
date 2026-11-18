import { AsyncLocalStorage } from 'node:async_hooks'
import type { LogContext } from '../../lib/logging'

/** Only the module's server-owned request metadata, never public tool arguments.
 * Tool handlers pass snapshots explicitly into tasks and subprocesses. */
export const operationLogContext = new AsyncLocalStorage<LogContext>()
