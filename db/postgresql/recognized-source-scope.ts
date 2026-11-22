export type RecognizedYearCondition = string | null | false

type SourceError = { state: 'error'; name: string | null; message: string | null }
type SourceGap = { state: 'gap'; reason: string }

export type RecognizedSourceScope =
  | { state: 'not_applicable' | 'uncaptured' }
  | { state: 'captured'; conditions: { validYear: RecognizedYearCondition; maintenanceYear: RecognizedYearCondition } | null }
  | SourceError
  | SourceGap

export type RecognizedSourcePosition =
  | { state: 'matched'; rdjbKey: string | null }
  | { state: 'unmatched' | 'rejected' }
  | SourceError
  | SourceGap

export function recognizedYearCondition(value: string | null | undefined): RecognizedYearCondition {
  return value == null ? null : /^[1-9][0-9]{3}$/.test(value) ? value : false
}
