import type { InjectionKey } from 'vue'
import type { ClientLibrarySignal } from './library-contract'

export type ClientLibraryReporter = (signal: ClientLibrarySignal) => void
export const clientLibraryReporterKey: InjectionKey<ClientLibraryReporter> = Symbol('clientLibraryReporter')
export const ignoreClientLibrarySignal: ClientLibraryReporter = () => {}

/** A diagnostic sink can never change a library callback's return/rejection. */
export function safeLibraryReporter(report: ClientLibraryReporter): ClientLibraryReporter {
  return signal => { try { report(signal) } catch { /* No recursive reporting. */ } }
}
