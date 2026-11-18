import { clientErrorReport, type ClientErrorReport } from './contract'
import { clientLibraryReport, type ClientLibraryReport } from './library-contract'

export type ClientLogReport = ClientErrorReport | ClientLibraryReport
export function clientLogReport(value: unknown): ClientLogReport | null {
  return clientLibraryReport(value) ?? clientErrorReport(value)
}
/** Finite vocabulary only; lifecycle success/failure signals never suppress each other. */
export function clientReportKey(report: ClientLogReport): string {
  return report.kind === 'library_signal'
    ? `${report.page}.${report.kind}.${report.signal}`
    : `${report.page}.${report.kind}.${report.level}.${report.interaction ?? ''}`
}
